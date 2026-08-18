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
import { killTree, spawnSpec } from "./exec.mjs";
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

// npm is a .cmd shim on Windows, which spawn can only launch through cmd.exe.
// `shell: true` is the tempting way to get there and the wrong one: Node then
// joins file and args with single spaces and no quoting, so on a profile like
// C:\Users\John Smith the `--prefix <CACHE_DIR>` below arrived as
// `--prefix C:\Users\John` plus a bogus package spec `Smith\.agents-deck\...`,
// npm exited non-zero, and the managed install never materialised. spawnSpec
// routes the .cmd through cmd.exe with every argument quoted, and hands back
// the argument vector untouched everywhere else.
function npmSpec(args, platform = process.platform) {
  return spawnSpec(platform === "win32" ? "npm.cmd" : "npm", args, platform);
}

/**
 * What `spawn` gets for `npm install ccusage@<spec>`.
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS.
 */
export const installSpec = (spec = "latest", platform = process.platform) =>
  npmSpec(["install", `ccusage@${spec}`, "--prefix", CACHE_DIR,
    "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"], platform);

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
// extensionless name would trade a shell injection for an ENOENT.
function npxSpec(args, platform = process.platform) {
  return spawnSpec(platform === "win32" ? "npx.cmd" : "npx", args, platform);
}

/**
 * What `spawn` gets for the portable `npx -y ccusage@latest <args>` fallback.
 * Exported for tests: the platform is a parameter so the Windows command line
 * can be checked from any OS.
 */
export const fallbackSpec = (args = [], platform = process.platform) =>
  npxSpec(["-y", "ccusage@latest", ...args], platform);

let _installing = null;   // Promise guard so concurrent calls share one install
let _checkedThisRun = false; // only kick the daily check once per process boot

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
    throw new Error(`npm install ccusage failed: ${(r.stderr || "").trim() || r.status}`);
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

// Ensure a runnable ccusage. Returns { kind:"node", entry } for the managed
// install, or { kind:"npx" } as the portable fallback.
async function getRunner() {
  let resolved = resolveEntry();
  if (resolved) {
    maybeBackgroundUpdate(resolved.version);
    return { kind: "node", entry: resolved.entry };
  }
  // Nothing installed and installs are forbidden. The npx fallback is not an
  // escape hatch — `npx -y ccusage@latest` downloads and runs the same package
  // — so there is no runner to hand back. Fail with the reason, which the
  // usage-history modal shows, instead of quietly installing.
  if (installsDisabled()) {
    throw tagged("no_install", "ccusage is not installed, and installs are off (AGENTS_DECK_NO_INSTALL=1)");
  }
  // Cold: install once (deduped across concurrent callers).
  if (!_installing) {
    _installing = (async () => { installSync("latest"); })()
      .catch(e => { note("install failed", e); })
      .finally(() => { _installing = null; });
  }
  await _installing;
  resolved = resolveEntry();
  if (resolved) { touchMarker(); return { kind: "node", entry: resolved.entry }; }
  return { kind: "npx" }; // npm unavailable / offline → fall back to npx
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

// One attempt with one runner. Neither branch gets a shell. The managed install
// is `node <entry> …`, which never needed one; the npx fallback is routed
// through spawnSpec instead — see npxSpec, and note that `args` here ends in
// whatever /api/ccusage was asked for.
function runOnce(runner, args) {
  const { file, args: full, opts } = runner.kind === "node"
    ? { file: process.execPath, args: [runner.entry, ...args], opts: {} }
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

// Run ccusage with the given args, resolve raw stdout. One retry, and only for
// the one failure that is otherwise permanent — see discardDamagedInstall. The
// second getRunner() is what rebuilds the install, or falls through to npx when
// npm cannot.
async function runCcusage(args) {
  const runner = await getRunner();
  try {
    return await runOnce(runner, args);
  } catch (err) {
    if (!discardDamagedInstall(runner, err)) throw err;
    note("managed install was unusable, rebuilding it", err);
    return runOnce(await getRunner(), args);
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
  try {
    const args = ["daily", "--json", "--since", sinceArg];
    if (until) args.push("--until", until);
    const raw = extractJson(await runCcusage(args));
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
    note("fetch failed", err);
    // Anything untagged got here from the child itself — a non-zero exit, or a
    // spawn that never started one — which is exactly what run_failed means.
    // `error` keeps the child's WHOLE output, stack trace and all: it is the
    // modal's hover title, which is where the raw bytes are meant to live, and
    // it is what somebody pastes into an issue. Only the terminal gets a line.
    result = {
      ok: false,
      reason: err?.reason ?? "run_failed",
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
 * Returns { state: "present" | "installing" | "updating" | "unavailable" }.
 * Never throws and never blocks on the install itself — a slow registry must
 * not hold up the server.
 */
export function primeCcusage() {
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
  if (!_installing) {
    _installing = (async () => { installSync("latest"); })()
      .catch(e => { note("install failed", e); })
      .finally(() => { _installing = null; });
  }
  return { state: "installing" };
}
