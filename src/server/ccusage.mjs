// Fetches historical usage from the `ccusage` CLI (https://github.com/ccusage/ccusage).
// ccusage reads the local ~/.claude (and other agent) logs and reports cost +
// token usage grouped by day.
//
// Performance: we do NOT run `npx -y ccusage@latest` on every call — that hits
// the npm registry to resolve `@latest` (and re-downloads when the npx cache is
// cold), so each modal open waited seconds. Instead we keep our OWN managed
// install under ~/.agents-deck/ccusage and invoke it directly with
// `node <pkg>/src/cli.js` (no npx, no registry round-trip). A throttled
// once-per-day background check upgrades it when a newer ccusage ships, while
// the current call always serves from the already-installed copy. If the
// managed install is missing/broken we fall back to the old npx path so the
// feature still works on a fresh machine.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { killTree, pathLookup, shimPath, spawnSpec } from "./exec.mjs";
import { oneLine, termColumns } from "./term.mjs";
import { PRODUCT } from "./brand.mjs";

const CACHE_MS = 120_000; // 2 min — modal is manual-open; cheap to keep warm
const TIMEOUT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 120_000; // first-run npm install can be slow
const UPDATE_CHECK_MS = 24 * 3600_000; // check npm for a newer ccusage once/day

const CACHE_DIR = path.join(os.homedir(), ".agents-deck", "ccusage");
const PKG_DIR = path.join(CACHE_DIR, "node_modules", "ccusage");
const MARKER = path.join(CACHE_DIR, ".last-update-check");

const _cache = new Map(); // key `${since}|${until}` → { result, at }

/**
 * The name to hand cmd.exe for one of npm's Windows shims: its full path when
 * one can be found, and the bare name only when none can.
 *
 * The full path is not a tidiness preference, it is the fix for #456. A shim
 * launched by bare name computes `%~dp0` — which is where it looks for
 * npm-prefix.js, npm-cli.js and npx-cli.js — from the deck's WORKING DIRECTORY
 * rather than from its own, so on a deck started from `C:\Users\vceban` both
 * shims died with `Cannot find module 'C:\Users\vceban\node_modules\npm\bin\…'`
 * on a machine whose npm was perfectly healthy. shimPath in exec.mjs carries
 * the whole account; what matters here is that BOTH the managed install and the
 * npx fallback are launched this way, so both failed, and diagnosing either
 * half alone could never have explained the other.
 *
 * Falling back to the bare name is deliberate: it is exactly what this did
 * before, so a layout shimPath cannot see is no worse off than it was, and on
 * such a machine cmd.exe's own PATH search still gets its turn.
 */
const winShim = (name, deps) => shimPath(name, deps) ?? name;

// npm is a .cmd shim on Windows, which spawn can only launch through cmd.exe.
// `shell: true` is the tempting way to get there and the wrong one: Node then
// joins file and args with single spaces and no quoting, so on a profile like
// C:\Users\John Smith the `--prefix <CACHE_DIR>` below arrived as
// `--prefix C:\Users\John` plus a bogus package spec `Smith\.agents-deck\...`,
// npm exited non-zero, and the managed install never materialised. spawnSpec
// routes the .cmd through cmd.exe with every argument quoted, and hands back
// the argument vector untouched everywhere else.
//
// POSIX is untouched by any of this: `npm` there is a real executable on PATH,
// not a batch file, so isBatch is false, viaCmd never runs, and the vector goes
// to spawn exactly as it always has.
function npmSpec(args, platform = process.platform, deps) {
  return spawnSpec(platform === "win32" ? winShim("npm.cmd", deps) : "npm", args, platform);
}

/**
 * What `spawn` gets for `npm install ccusage@<spec>`.
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS, and `deps` stands in for the Windows filesystem
 * the shim lookup asks about.
 */
export const installSpec = (spec = "latest", platform = process.platform, deps) =>
  npmSpec(["install", `ccusage@${spec}`, "--prefix", CACHE_DIR,
    "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"], platform, deps);

// npx is the same kind of shim as npm, and the fallback run needs the same
// treatment for a second, sharper reason: its argument vector carries a
// user-supplied `--since`. `shell: true` handed `[file, ...args].join(" ")` to
// /bin/sh -c, so `GET /api/ccusage?since=1;id;` ran `id` — and because that
// route is a GET, any page open in the user's browser could aim it at the
// loopback port with no CORS, no preflight and no need to read the answer.
// spawnSpec quotes each argument into the cmd.exe line on Windows and spawns
// the vector untouched everywhere else, so nothing in it is ever parsed as
// syntax. Naming the file `npx.cmd` on Windows is what makes that work: only a
// .cmd/.bat file routes through cmd.exe, and a bare `npx` there is not a file
// spawn can launch at all (PATHEXT is a shell's job), so asking for the
// extensionless name would trade a shell injection for an ENOENT. What it must
// NOT be is the bare `npx.cmd` this said until #456 — see winShim.
function npxSpec(args, platform = process.platform, deps) {
  return spawnSpec(platform === "win32" ? winShim("npx.cmd", deps) : "npx", args, platform);
}

/**
 * What `spawn` gets for the portable `npx -y ccusage@latest <args>` fallback.
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS, and `deps` stands in for the Windows filesystem
 * the shim lookup asks about.
 */
export const fallbackSpec = (args = [], platform = process.platform, deps) =>
  npxSpec(["-y", "ccusage@latest", ...args], platform, deps);

let _installing = null;   // Promise guard so concurrent calls share one install
let _checkedThisRun = false; // only kick the daily check once per process boot

// The last `npm install` that failed, in one line of its own words.
//
// Module scope rather than a value thrown out of installSync, because the two
// callers that matter never see that throw. primeCcusage runs the install at
// boot and only logs the rejection; a second modal open that arrives while an
// install is in flight awaits the SHARED promise, whose rejection has already
// been handled by the first. Both then land on the npx fallback with nothing to
// say about why they were there — which is precisely how three rounds of
// debugging went to the fallback's stderr while the install's own account
// stayed on a terminal row the deck had already painted over.
//
// One line, not the whole dump: this is written into a sentence in a 46ch box.
// The full text still goes to the terminal through note() below.
let _lastInstallError = null;
const INSTALL_ERROR_ROOM = 240;

/**
 * Start the one shared install, remembering how it ended.
 *
 * Deduped through `_installing` the way it always was, so concurrent callers
 * cost one `npm install` between them; the only new thing is that the outcome
 * survives the promise.
 */
function startInstall(spec = "latest") {
  if (!_installing) {
    _installing = (async () => { installSync(spec); })()
      .then(() => { _lastInstallError = null; })
      .catch(e => {
        _lastInstallError = oneLine(e?.message ?? e, INSTALL_ERROR_ROOM);
        note("install failed", e);
      })
      .finally(() => { _installing = null; });
  }
  return _installing;
}

// AGENTS_DECK_NO_INSTALL=1 is documented as "never install or update
// claude-swap / ccusage, and never ask npm about releases", so it has to hold
// on the lazy path too — opening the usage-history modal must not be a way to
// pull ccusage off the registry behind the user's back. Read per call rather
// than once at import, because the module is imported lazily and a test (or an
// embedder) may set it after load.
function installsDisabled() {
  return process.env.AGENTS_DECK_NO_INSTALL === "1";
}

// A run can end four ways that mean four different things to whoever opened the
// modal — installs are forbidden, the deadline expired, the output was not usage
// data, the CLI exited on its own — and all four used to arrive as one `error`
// string, leaving the modal nothing to say but whatever `err.message` happened
// to be. The code rides on the error and comes back out as `reason`; `error`
// keeps the raw text, which the modal shows only on hover.
function tagged(reason, message) {
  return Object.assign(new Error(message), { reason });
}

// Everything this module says out loud goes through here, and it says one line.
//
// Both failures below carry a subprocess's entire stderr as their `message`,
// and on a machine whose npm shim is broken that is a fifteen-line Node stack
// trace. Handed to console.error whole, it landed across the deck's own status
// rows and its `\r`-repainted pulse line — and because primeCcusage runs at
// boot, it was the first thing such a machine ever showed (#432). The evidence
// is not lost by shortening this: a failed RUN carries its full text back to
// the browser in `error`, which the usage-history modal keeps on the status
// line's title, one hover away — the same division of labour admin-failure.ts
// states for claude-swap's output. What this line is for is the operator
// watching the terminal, who needs to know which of the two things failed and
// why, not to read a stack.
//
// The width is read per call: a terminal can be resized while the deck runs,
// and this can fire hours in.
function note(what, err) {
  const head = `${PRODUCT} ccusage: ${what}: `;
  console.error(head + oneLine(err?.message ?? err, termColumns(process.stderr) - head.length));
}

/**
 * Node saying it could not load a file it was pointed at.
 *
 * Both spellings are here because both happen: CommonJS throws
 * `MODULE_NOT_FOUND`, ESM throws `ERR_MODULE_NOT_FOUND` with the wording
 * "Cannot find package" for a bare specifier, and ccusage's entry point is ESM
 * while the npm/npx shims it may be launched through are not.
 *
 * Exported for tests. The one caller is the managed-install branch of
 * runCcusage, where the child is `node <our entry>` and nothing else — so a
 * module Node cannot resolve is by construction a file of OURS that is missing,
 * never the user's npm.
 */
export const cannotLoadModule = (text) =>
  /\b(?:ERR_)?MODULE_NOT_FOUND\b|cannot find (?:module|package)/i.test(String(text ?? ""));

// ── managed install ─────────────────────────────────────────────────────────

// Absolute path to ccusage's CLI entry inside our managed install, or null if
// not installed. Reads the package's `bin` field (currently "./src/cli.js").
//
// `bin` is a string out of a package.json downloaded from the registry, and it
// is joined onto PKG_DIR and then handed to `spawn(node, [entry])` — so a `bin`
// of "../../../evil.js" names a file outside the managed install and gets run.
// existsSync alone does not notice: it is asked whether the escaped path is
// there, and for an attacker who put something there the answer is yes.
//
// The narrowness is worth stating rather than leaving implied: a package that
// can choose its own `bin` can also ship an install script, so this is not the
// weak link in a hostile-package scenario. What it does close is the case where
// only the file is influenced — a tampered or half-written package.json in the
// cache dir, or a `bin` that walks out of the install by accident — and it
// costs one comparison.
//
// Exported for tests: the containment rule is the whole point of the function
// and there is no other way to reach it without an install on disk.
export function resolveEntry() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
    let rel = pkg.bin;
    if (rel && typeof rel === "object") rel = rel.ccusage ?? Object.values(rel)[0];
    if (typeof rel !== "string") return null;
    const entry = path.resolve(PKG_DIR, rel);
    // path.resolve, not path.join, so an ABSOLUTE `bin` is measured as the
    // absolute path it is rather than being silently re-rooted under PKG_DIR
    // and passing on a technicality. The trailing separator is what stops a
    // sibling directory whose name merely starts with PKG_DIR's — and it also
    // rejects PKG_DIR itself, which is a directory and no kind of entry point.
    if (!entry.startsWith(path.resolve(PKG_DIR) + path.sep)) return null;
    return existsSync(entry) ? { entry, version: pkg.version } : null;
  } catch {
    return null;
  }
}

/**
 * Everything spawnSync knows about a failed install, in the order the answer is
 * usually in.
 *
 * The old line read `(r.stderr || "").trim() || r.status`, which threw away the
 * two things most likely to be the whole story. `r.error` is where spawnSync
 * reports a failure to LAUNCH — ENOENT for a comspec that is not there, EINVAL
 * for a .cmd Node refuses to spawn directly, ETIMEDOUT when the deadline above
 * fired — and it comes with `status: null`, so what reached the terminal in
 * every one of those cases was the word "null". And npm has never confined
 * itself to stderr: a shim that dies before npm starts writes wherever Node
 * chose, and `npm ERR!` blocks have landed on stdout across majors.
 */
function installFailureText(r) {
  const parts = [];
  if (r?.error?.message) parts.push(String(r.error.message));
  const stderr = String(r?.stderr ?? "").trim();
  const stdout = String(r?.stdout ?? "").trim();
  if (stderr) parts.push(stderr);
  if (stdout) parts.push(stdout);
  if (!parts.length) parts.push(r?.status === null || r?.status === undefined
    ? "npm exited without a status and said nothing"
    : `npm exited ${r.status} and said nothing`);
  return parts.join(" — ");
}

/**
 * Which level of the managed install `npm install --prefix` actually produced.
 *
 * This is the honest answer to the question nobody could answer from a
 * screenshot: an install that exits 0 and leaves a tree resolveEntry cannot use
 * is reported as SUCCESS by an exit code alone, and #432 found that exact shape
 * once already. Naming the first level that is not there turns "ccusage could
 * not report usage" into a sentence about this machine's disk — whether npm
 * wrote nothing, wrote a node_modules with no ccusage in it, or wrote a package
 * whose entry point this deck refuses.
 */
function installTreeReport() {
  const levels = [
    [CACHE_DIR, "the prefix directory"],
    [path.join(CACHE_DIR, "node_modules"), "node_modules under it"],
    [PKG_DIR, "node_modules/ccusage"],
    [path.join(PKG_DIR, "package.json"), "node_modules/ccusage/package.json"],
  ];
  for (const [where, name] of levels) {
    if (!existsSync(where)) return `${name} is not there`;
  }
  // Every level exists, so resolveEntry refused for one of its own reasons: an
  // unreadable or bin-less package.json, or a `bin` pointing outside the
  // package. All three are about the package rather than about npm.
  return "the package is there but its bin entry could not be read or does not point inside it";
}

// Run `npm install ccusage@<spec> --prefix CACHE_DIR`. Synchronous variant for
// the first-run cold path (we must have a binary before we can answer).
function installSync(spec = "latest") {
  mkdirSync(CACHE_DIR, { recursive: true });
  const { file, args, opts } = installSpec(spec);
  const r = spawnSync(
    file,
    args,
    { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, encoding: "utf8", ...opts },
  );
  if (r.status !== 0) {
    throw new Error(`npm install ccusage failed: ${installFailureText(r)}`);
  }
  // A zero exit is npm's opinion, not a fact about the disk, and the caller
  // treats "installSync returned" as "there is something to run". Checking here
  // is what stops a silent success: getRunner used to call resolveEntry(), get
  // null, and fall through to the npx fallback with NOTHING recorded anywhere
  // about why — so the modal explained the fallback's stderr and the install's
  // half of the story was never written down at all.
  if (!resolveEntry()) {
    throw new Error(
      `npm install ccusage exited 0 but left nothing runnable under ${CACHE_DIR}: `
      + `${installTreeReport()}`,
    );
  }
}

// Background, non-blocking install (used by the daily update path).
function installAsync(spec = "latest") {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const { file, args, opts } = installSpec(spec);
    const child = spawn(
      file,
      args,
      { windowsHide: true, detached: false, stdio: "ignore", ...opts },
    );
    child.on("error", () => {});
    child.unref?.();
  } catch { /* best-effort */ }
}

// True at most once per UPDATE_CHECK_MS, gated by the marker file's mtime so the
// throttle survives restarts.
function updateCheckDue() {
  try {
    return Date.now() - statSync(MARKER).mtimeMs > UPDATE_CHECK_MS;
  } catch {
    return true; // no marker yet → due
  }
}
// (Re)write the marker so its mtime marks "now" as the last check time.
function touchMarker() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(MARKER, String(Date.now()));
  } catch { /* ignore */ }
}

// Non-blocking: compare installed version to npm `latest`; install if newer.
function maybeBackgroundUpdate(installedVersion) {
  if (installsDisabled()) return; // no `npm view`, no upgrade install
  if (_checkedThisRun || !updateCheckDue()) return;
  _checkedThisRun = true;
  touchMarker();
  try {
    const { file, args, opts } = npmSpec(["view", "ccusage", "version"]);
    const child = spawn(file, args, { windowsHide: true, ...opts });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.on("error", () => {});
    child.on("close", () => {
      const latest = out.trim();
      if (latest && latest !== installedVersion) installAsync(latest);
    });
  } catch { /* ignore */ }
}

// ── the user's own copy ─────────────────────────────────────────────────────

/**
 * A ccusage the USER put somewhere, either by naming it outright or by having
 * it on PATH — or null when there is no such thing.
 *
 * This is #433, and the case for it is not that a PATH search is nice to have.
 * The deck has been telling people "put ccusage on PATH yourself" in
 * admin-failure.ts for as long as that sentence has existed, and nothing
 * anywhere ever looked: a user who did exactly what they were told, and could
 * prove it with `ccusage --version` in their own shell, got the identical
 * failure on the next click. Two ways out of that, and the other one is to
 * delete the promise. It is kept because there is a configuration that needs it
 * and has no other:
 *
 *   - `AGENTS_DECK_NO_INSTALL=1` is documented as "never install or update
 *     claude-swap / ccusage". Someone who sets it AND installs ccusage
 *     themselves has done the only thing that flag can sensibly mean, and until
 *     now the deck answered "ccusage is not installed" while it was installed
 *     and on their PATH. There was NO combination of settings that made a
 *     self-managed ccusage work.
 *   - The #432 machine — npm and npx both unusable on disk — cannot create the
 *     managed install and cannot run the npx fallback. A copy the user already
 *     has is the only route left, and it was the one route the deck refused to
 *     look down.
 *
 * The override wins over PATH the way AGENTS_DECK_CSWAP does over cswap's own
 * search, and is never remembered, because somebody debugging a bad resolution
 * needs a change to it to take effect on the next click rather than the next
 * restart. Nothing here is cached for the same reason, and it is affordable:
 * a lookup is a handful of stats, once per uncached fetch, against a process
 * spawn that follows it.
 *
 * `platform` and `deps` are parameters, and this is exported, for the reason
 * every other Windows answer in this module is: the PATHEXT walk and the
 * `.cmd` spelling have to be checkable from a machine that cannot run Windows.
 */
export function userCcusage(platform = process.platform, deps, env = process.env) {
  const named = env.AGENTS_DECK_CCUSAGE;
  if (named) {
    // A path the user typed is used as typed — pathLookup would refuse it
    // anyway, since re-rooting a name that carries a directory is a way to run
    // something other than what was asked for. Whether it EXISTS is the
    // caller's question, because "the path you gave me is not there" is a
    // different sentence from "you have no ccusage".
    return { file: String(named), named: true };
  }
  const found = pathLookup("ccusage", platform, deps);
  return found ? { file: found, named: false } : null;
}

/** Does the file an explicit override names actually exist? Split out so the
 *  existence check is injectable alongside the lookup above. */
const overrideIsThere = (file, { exists = existsSync } = {}) => {
  try {
    return exists(file);
  } catch {
    return false;
  }
};

// Ensure a runnable ccusage. Returns { kind:"node", entry } for the managed
// install, { kind:"path", file } for a copy the user provided, or { kind:"npx" }
// as the portable fallback.
//
// The order is the whole design decision, so it is stated rather than implied.
//
// An explicit AGENTS_DECK_CCUSAGE is first and is never fallen through: a user
// who pointed the deck at a file and got silently ignored has been given a
// setting that does nothing, which is worse than not having one. If it does not
// resolve, the failure names THAT — "npx is not on this deck's PATH" would be
// both true and completely beside the point.
//
// The managed install then comes BEFORE the PATH copy, which is the opposite of
// what #433 proposed, and deliberately. Preferring PATH would silently change
// which ccusage runs on every machine that already has both — a deck that works
// today would start running a copy it has never run, and an old global ccusage
// without `daily --json` would turn a working panel into a broken one for no
// reason the user asked for. The PATH copy is an ESCAPE ROUTE, and it wants to
// be reached exactly when the managed install is not there; someone who wants
// their own copy to win over the deck's says so with AGENTS_DECK_CCUSAGE, which
// is unambiguous in a way a precedence rule never is.
//
// PATH comes before INSTALLING, though. Downloading a second copy of a tool
// that is already on the machine is not something to do to somebody, and it is
// what makes the order identical with and without AGENTS_DECK_NO_INSTALL=1 —
// that flag now removes a step rather than changing the sequence.
async function getRunner() {
  const mine = userCcusage();
  if (mine?.named) {
    if (!overrideIsThere(mine.file)) {
      throw tagged("bad_override",
        `AGENTS_DECK_CCUSAGE points at ${mine.file}, and there is no such file`);
    }
    return { kind: "path", file: mine.file, named: true };
  }
  let resolved = resolveEntry();
  if (resolved) {
    maybeBackgroundUpdate(resolved.version);
    return { kind: "node", entry: resolved.entry };
  }
  if (mine) return { kind: "path", file: mine.file, named: false };
  // Nothing installed, nothing of the user's to run, and installs are
  // forbidden. The npx fallback is not an escape hatch — `npx -y ccusage@latest`
  // downloads and runs the same package — so there is no runner to hand back.
  // Fail with the reason, which the usage-history modal shows, instead of
  // quietly installing.
  if (installsDisabled()) {
    throw tagged("no_install", "ccusage is not installed, and installs are off (AGENTS_DECK_NO_INSTALL=1)");
  }
  // Cold: install once (deduped across concurrent callers).
  await startInstall("latest");
  resolved = resolveEntry();
  if (resolved) { touchMarker(); return { kind: "node", entry: resolved.entry }; }
  // npm unavailable / offline → fall back to npx, carrying WHY the managed
  // install is not here. Without that the modal can only describe the fallback,
  // and the fallback is the second thing that failed.
  return { kind: "npx", installError: _lastInstallError };
}

/** Which of ccusage's three paths a failure came from, in the deck's own words.
 *  `stage` travels to the browser; the modal leads with it rather than making
 *  the reader guess from a stack trace which half of this module they are
 *  looking at. */
const STAGE = { node: "managed", path: "path", npx: "npx" };

/** Mark a failure with the path that produced it, and with the managed
 *  install's own account when that is why this path was taken at all. Set once:
 *  the retry below re-stamps with the runner that actually failed, and an error
 *  that already knows where it came from is not overwritten. */
function stamp(err, runner) {
  if (err && typeof err === "object") {
    if (!err.stage) err.stage = STAGE[runner?.kind] ?? "npx";
    // Which file, when the answer is a file the deck did not put there. The
    // stage alone says "your own copy failed" and leaves the reader to work out
    // WHICH copy, and on a machine with an override, a PATH entry and a managed
    // install that is exactly the question they cannot answer from here.
    if (runner?.kind === "path" && err.bin === undefined) err.bin = runner.file;
    if (runner?.installError && err.install === undefined) err.install = runner.installError;
  }
  return err;
}

// ── invocation ──────────────────────────────────────────────────────────────

// At most one repair per process, so a package that is simply unrunnable —
// reinstalled and still broken — cannot put this into a loop of npm installs.
let _repairedThisRun = false;

/**
 * Throw away a managed install that resolves but cannot run, so the next
 * attempt builds a new one.
 *
 * This is the only genuinely permanent failure in this module, and it is the
 * one a broken npm creates: `npm install` that dies partway leaves a
 * package.json and an entry file on disk, resolveEntry answers "installed", and
 * getRunner then hands back that entry FOREVER. Nothing re-checks it —
 * maybeBackgroundUpdate only reinstalls when the registry has a newer version,
 * so even a repaired npm never repaired the install. Every run failed
 * identically, the modal said "try again", and the only thing that actually
 * worked was deleting ~/.agents-deck/ccusage by hand, which nothing in the
 * product tells anyone to do.
 *
 * Only the managed branch qualifies: the npx fallback's failures are npm's own
 * and none of this deck's business to delete anything over.
 *
 * Not done under AGENTS_DECK_NO_INSTALL=1. That variable is a promise not to
 * fetch, and removing the only copy on a machine that cannot replace it would
 * turn a broken feature into an absent one.
 */
function discardDamagedInstall(runner, err) {
  if (_repairedThisRun || runner.kind !== "node" || installsDisabled()) return false;
  if (!cannotLoadModule(err?.message)) return false;
  _repairedThisRun = true;
  try {
    rmSync(PKG_DIR, { recursive: true, force: true });
  } catch {
    // Windows holds a lock on a file inside a directory being removed more
    // readily than POSIX does, and a half-removed install is still a resolvable
    // one. Say the repair did not happen so the caller reports the real failure
    // rather than retrying into the same broken entry point.
    return false;
  }
  return !resolveEntry();
}

/**
 * What `spawn` gets for a ccusage the user provided.
 *
 * `file` is always an absolute path by the time it reaches here — pathLookup
 * resolves the directory and an override is a path the user typed — and that is
 * load-bearing rather than tidy. On Windows the thing on PATH is `ccusage.cmd`,
 * a batch file, so spawnSpec routes it through cmd.exe; a batch file launched
 * by BARE name computes `%~dp0` from the deck's working directory and goes
 * looking for its payload there, which is #456 exactly. Resolving first and
 * quoting second is the same order the npm and npx shims go through.
 *
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS.
 */
export const userSpec = (file, args = [], platform = process.platform) =>
  spawnSpec(file, args, platform);

// One attempt with one runner. No branch gets a shell. The managed install is
// `node <entry> …`, which never needed one; the user's own copy and the npx
// fallback are routed through spawnSpec instead — see npxSpec and userSpec, and
// note that `args` here ends in whatever /api/ccusage was asked for.
function runOnce(runner, args) {
  const { file, args: full, opts } = runner.kind === "node"
    ? { file: process.execPath, args: [runner.entry, ...args], opts: {} }
    : runner.kind === "path"
      ? userSpec(runner.file, args)
      : fallbackSpec(args);
  return new Promise((resolve, reject) => {
    const child = spawn(file, full, { windowsHide: true, ...opts });
    let out = "", err = "";
    const timer = setTimeout(() => {
      // The npx fallback goes through cmd.exe on Windows, so `child` is the
      // wrapper there and npx is a grandchild that a plain kill would leave
      // downloading.
      killTree(child);
      reject(tagged("timeout", "ccusage timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `ccusage exited ${code}`));
    });
  });
}

// Run ccusage with the given args, resolve raw stdout AND the runner that
// produced it. One retry, and only for the one failure that is otherwise
// permanent — see discardDamagedInstall. The second getRunner() is what rebuilds
// the install, or falls through to npx when npm cannot.
//
// The runner comes back with the output because the caller has to say which
// path answered: `extractJson` below can fail on a run that started perfectly
// well, and "ccusage ran but printed no usage data" reads differently depending
// on which ccusage that was.
async function runCcusage(args) {
  const runner = await getRunner();
  try {
    return { out: await runOnce(runner, args), runner };
  } catch (err) {
    if (!discardDamagedInstall(runner, err)) throw stamp(err, runner);
    note("managed install was unusable, rebuilding it", err);
    const rebuilt = await getRunner();
    try {
      return { out: await runOnce(rebuilt, args), runner: rebuilt };
    } catch (again) {
      throw stamp(again, rebuilt);
    }
  }
}

// ccusage prints the JSON object somewhere in stdout; slice first { to last }.
function extractJson(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) throw tagged("bad_output", "no JSON in ccusage output");
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch (err) {
    // A ccusage that printed a progress line containing braces, or was cut off
    // mid-object, lands here rather than on the branch above. Same failure to
    // the reader either way: it ran, and what came back was not usage data.
    throw tagged("bad_output", `unreadable ccusage output: ${err?.message ?? err}`);
  }
}

// YYYYMMDD for the CLI's --since/--until.
function toCliDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Fetch daily usage from ccusage for a date range.
 * @param {{ since?: string, until?: string, force?: boolean }} opts
 *        since/until are YYYYMMDD strings (CLI format). Defaults to last 30 days.
 * @returns {{ ok, days, totals, since, until, fetchedAt } | { ok:false, reason, error }}
 */
export async function fetchCcusageDaily({ since, until, force = false } = {}) {
  const now = Date.now();
  const sinceArg = since || toCliDate(new Date(now - 30 * 86400_000));
  const key = `${sinceArg}|${until ?? ""}`;

  const cached = _cache.get(key);
  if (!force && cached && now - cached.at < CACHE_MS) return cached.result;

  let result;
  let ran = null; // the runner that answered, for stamping a bad_output failure
  try {
    const args = ["daily", "--json", "--since", sinceArg];
    if (until) args.push("--until", until);
    ran = await runCcusage(args);
    const raw = extractJson(ran.out);
    const days = Array.isArray(raw.daily) ? raw.daily : [];
    result = {
      ok: true,
      days,
      totals: raw.totals ?? null,
      since: sinceArg,
      until: until ?? null,
      fetchedAt: now,
    };
  } catch (err) {
    // `extractJson` throws about a run that started fine, so it arrives here
    // knowing nothing about which ccusage it read. The runner does.
    if (ran) stamp(err, ran.runner);
    // Naming the path in the terminal too. "fetch failed" alone was true of
    // both, and an operator reading a boot report has the same question the
    // modal's reader has: which of the two.
    note(err?.stage === "managed" ? "fetch failed (managed install)"
      : err?.stage === "npx" ? "fetch failed (npx fallback)"
        : "fetch failed", err);
    // Anything untagged got here from the child itself — a non-zero exit, or a
    // spawn that never started one — which is exactly what run_failed means.
    // `error` keeps the child's WHOLE output, stack trace and all: it is the
    // modal's hover title, which is where the raw bytes are meant to live, and
    // it is what somebody pastes into an issue. Only the terminal gets a line.
    //
    // `stage` and `install` are the halves that used to be lost. They are what
    // let the modal say WHICH path failed and why, on screen, instead of
    // guessing it from the shape of a stack trace — the guess that shipped two
    // wrong diagnoses in a row (#432, #450). `bin` joined them for #433: with a
    // third path, "your own copy failed" is only half an answer until it names
    // which file that was. Undefined when nothing ran, and JSON.stringify drops
    // them, so an older browser sees the reply it expects.
    result = {
      ok: false,
      reason: err?.reason ?? "run_failed",
      stage: err?.stage,
      install: err?.install,
      bin: err?.bin,
      error: String(err?.message ?? err),
      fetchedAt: now,
    };
  }

  _cache.set(key, { result, at: now });
  return result;
}

/**
 * Get ccusage ready at startup instead of on first use.
 *
 * The lazy path is fine for correctness but means the first person to open the
 * usage-history modal on a fresh machine waits out an npm install with no
 * explanation. Called from the CLI so that cost is paid while the deck is
 * still booting.
 *
 * Returns { state: "present" | "user" | "installing" | "updating" |
 * "unavailable" }. Never throws and never blocks on the install itself — a slow
 * registry must not hold up the server.
 *
 * The order here is getRunner's order, and it has to be: a boot that installs a
 * managed copy while the user already has one on PATH would make getRunner's
 * "PATH before installing" true only until the first restart, and would spend a
 * download saying so. `user` is reported without a version because finding one
 * means RUNNING the thing, and the boot is not the place to spawn a process to
 * fill in a status row.
 */
export function primeCcusage() {
  const mine = userCcusage();
  // An override that names a file which is not there is not reported here at
  // all: the boot has nothing useful to say about it and getRunner will say it
  // properly, with the path, the first time the modal is opened.
  if (mine && (!mine.named || overrideIsThere(mine.file))) {
    const resolved = resolveEntry();
    // The managed install still wins when it exists — see getRunner — so an
    // existing deck's boot row does not change.
    if (mine.named || !resolved) return { state: "user", bin: mine.file };
  }
  // The CLI already skips this call under AGENTS_DECK_NO_INSTALL=1; repeating
  // the check here keeps the promise a property of the module rather than of
  // one caller.
  if (installsDisabled()) {
    const have = resolveEntry();
    return have ? { state: "present", version: have.version } : { state: "unavailable" };
  }
  const resolved = resolveEntry();
  if (resolved) {
    // Already installed: the daily check may still queue a background upgrade.
    const due = !_checkedThisRun && updateCheckDue();
    maybeBackgroundUpdate(resolved.version);
    return { state: due ? "updating" : "present", version: resolved.version };
  }
  startInstall("latest");
  return { state: "installing" };
}
