// Tells the deck when the code it is executing is no longer the code on disk.
//
// Node caches every module at import. A deck that was already running when
// `npm i -g agents-deck` replaced its files keeps executing the OLD code until
// the process restarts — and nothing says so. The terminal banner still prints
// the version it booted with, and the browser's __APP_VERSION__ is baked into
// whichever bundle it happened to load, so the UI can even show the NEW number
// while the server runs the old one.
//
// That is not theoretical. On 2026-08-12 a deck left running from before
// v1.30.4 kept spawning `claude --print /usage` once a minute, burning the
// whole hourly usage-endpoint budget and 429-ing claude-swap, while the fix sat
// unused on disk. The user had no way to see it.
//
// So we report three distinct versions:
//   running   — captured at boot by the caller, before an upgrade can land
//   installed — re-read from disk per call; what a restart would run
//   latest    — npm's dist-tag, fetched at most once a day
//
// Installing is opt-in and narrow. `npm i -g` runs only when the user asks for
// it by name and only where it can actually work: a global install, on a
// directory we can write, outside a git checkout and outside an npx cache.
// Everywhere else this stays what it has always been — a printed command.
import { accessSync, constants as FS, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { killTree } from "./exec.mjs";

// Once an hour, not once a day.
//
// The daily cadence was copied from the ccusage and cswap checks, where it is
// right: those answer "is a different tool out of date", and nobody is waiting
// on it. This one answers "is the thing you are looking at out of date", and a
// day is long enough that a deck started shortly before a release shows nothing
// at all until tomorrow — reported from a machine running `npx ccdeck`, which
// is the case where it bites hardest, since npx runs are short-lived and each
// one inherits the same stale marker. The request is ~20 bytes.
const CHECK_MS = 3600_000;
// A lookup that failed is not an answer, so it must not spend the hour an
// answer buys. It still has to spend something: the reason to rate-limit is
// gone, but a registry that is down would otherwise be asked again on every
// single poll. Five minutes is the compromise — short enough that a network
// coming back is noticed while the user is still looking at the deck, long
// enough that a full npm outage costs a dozen ~20-byte requests an hour.
const RETRY_MS = 300_000;
const FETCH_TIMEOUT_MS = 6_000;
// A third marker family: ccusage owns ~/.agents-deck/ccusage/.last-update-check
// and cswap owns ~/.agents-deck/.cswap-update-check. Sharing one would make the
// three features fight over a single daily slot.
const MARKER_DIR = join(homedir(), ".agents-deck");
// The name this deck was published under is part of the marker's identity.
//
// A single ~/.agents-deck/.self-update-check was shared by every deck on the
// machine, so whichever one asked npm first pinned the answer for all of them
// until the window expired — including a freshly started `npx ccdeck` that had
// never written it, and including decks running a DIFFERENT package where the
// cached version means nothing. Reported with four decks alive at once: three
// served the same `checkedAt` to the millisecond and none of them showed the
// seven releases that had shipped meanwhile. One file per package name means
// `agents-deck`, `ccdeck` and `agent-dag` decks stop silencing each other; the
// old shared path stays here only to be inherited from once.
const LEGACY_MARKER = join(MARKER_DIR, ".self-update-check");

// Dedupe concurrent /api/version calls into one fetch, per package name — two
// names are two different questions and must not be answered with one answer.
const _inflight = new Map();

// ── version comparison ───────────────────────────────────────────────────────

/** True when `a` sorts before `b`. Numeric-segment compare, same shape as the
 *  one in cswap-install.mjs — non-numeric segments count as 0, missing
 *  segments pad with 0, so "1.30" < "1.30.1" and "1.9.0" < "1.10.0". */
export function isOlder(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const seg = (v) => v.split(/[.\-+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
  const x = seg(a), y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

// ── what is on disk ──────────────────────────────────────────────────────────

/** Version currently written in the package's own package.json. Deliberately
 *  read fresh on every call: that is the whole point — it changes under a
 *  running process when npm replaces the install. */
export function installedVersion(pkgRoot) {
  try {
    const v = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"))?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** npx keeps each package in its own content-addressed cache directory, so
 *  `npm i -g` is the wrong advice there — nothing global exists to upgrade. */
export function isNpxInstall(pkgRoot) {
  // Split on both separators, not `path.sep`: Windows paths reach here with
  // backslashes but a POSIX-style path is still a valid input there, and a
  // separator-agnostic test is what keeps this identical on all three
  // platforms. Segment-wise, so a directory merely named "my_npx-tools" is not
  // mistaken for the npx cache.
  return typeof pkgRoot === "string" && pkgRoot.split(/[\\/]/).includes("_npx");
}

/** A git checkout is the maintainer's own tree. Its version routinely sits
 *  ahead of npm, and telling someone to `npm i -g` over their working copy is
 *  actively wrong, so the registry side of the check is skipped there. */
export function isGitCheckout(pkgRoot) {
  try { return existsSync(join(pkgRoot, ".git")); } catch { return false; }
}

// ── npx ──────────────────────────────────────────────────────────────────────
//
// An npx run lives in ~/.npm/_npx/<hash>/node_modules/<pkg>. The hash is over
// the SPEC the user typed, so upgrading means fetching a different directory —
// there is nothing to install over. What there IS, is the spec itself: npm
// writes it into <hash>/package.json as `_npx.packages`, which is the only
// record of whether the user typed `ccdeck`, `agent-dag` or `agents-deck`.
// Re-running the wrong one would work but would leave them on a package they
// never asked for, so it is worth reading rather than guessing.

/** The `_npx/<hash>` directory this package was unpacked into, or null. Pure —
 *  path arithmetic only, so both platforms' separators can be tested. */
export function npxRoot(pkgRoot) {
  if (typeof pkgRoot !== "string") return null;
  const parts = pkgRoot.split(/[\\/]/);
  const i = parts.lastIndexOf("_npx");
  if (i === -1 || i + 1 >= parts.length) return null;
  // Keep the separator the input used: a Windows path must come back as one.
  const sep = pkgRoot.includes("\\") && !pkgRoot.includes("/") ? "\\" : "/";
  return parts.slice(0, i + 2).join(sep);
}

/** Package name out of an npm spec, scope intact: `ccdeck@1.2.3` → `ccdeck`,
 *  `@scope/pkg` → `@scope/pkg`. Null for anything that is not a plain name —
 *  a tarball URL or a git spec is not something to re-run with `@latest`. */
export function bareSpecName(spec) {
  if (typeof spec !== "string") return null;
  const s = spec.trim();
  if (!s) return null;
  const at = s.lastIndexOf("@");
  const name = at > 0 ? s.slice(0, at) : s;
  return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i.test(name) ? name : null;
}

/** What to hand `npx -y`, read from the cache directory's own metadata. */
export function npxSpecFromMeta(meta, fallback = "agents-deck") {
  const list = meta && meta._npx && Array.isArray(meta._npx.packages) ? meta._npx.packages : [];
  for (const entry of list) {
    const name = bareSpecName(entry);
    if (name) return `${name}@latest`;
  }
  return `${fallback}@latest`;
}

/** The same, answered against the filesystem. Null when this is not an npx run. */
export function npxRestartSpec(pkgRoot, name = "agents-deck") {
  const root = npxRoot(pkgRoot);
  if (!root) return null;
  let meta = null;
  try { meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch { /* fall back to the name */ }
  return npxSpecFromMeta(meta, name);
}

/** The exact line the user can paste, for the way THIS copy was installed. */
export function upgradeCommand(pkgRoot, name = "agents-deck") {
  // A checkout is updated by pulling, and the bundle is built, not shipped —
  // so `npm run build` is part of the answer rather than an afterthought.
  if (isGitCheckout(pkgRoot)) return "git pull && npm run build";
  if (isNpxInstall(pkgRoot)) return `npx -y ${npxRestartSpec(pkgRoot, name) ?? `${name}@latest`}`;
  return `npm i -g ${name}@latest`;
}

// ── what npm has ─────────────────────────────────────────────────────────────

// The dist-tags endpoint answers with ~20 bytes ({"latest":"1.30.7"}); the full
// packument is >2 KB and needs parsing we have no use for.
//
// Answers `{ ok, version }` rather than a bare string, because "npm says the
// latest is X" and "npm did not answer" used to arrive here as the same null.
// `ok` is true only when the registry handed back a usable version — a
// timeout, a non-200 and a 200 with no `latest` in it are all failures, and
// the caller has to be able to tell them from an up-to-date deck.
async function fetchLatest(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/-/package/${name}/dist-tags`, {
      headers: { accept: "application/json", "user-agent": "agents-deck" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, version: null };
    const v = (await res.json())?.latest;
    return typeof v === "string" ? { ok: true, version: v } : { ok: false, version: null };
  } catch {
    return { ok: false, version: null };
  }
}

/** Marker file name for a package: `ccdeck` → `.self-update-check-ccdeck`.
 *
 *  Pure, and deliberately strict about what reaches the filesystem — a package
 *  name may be scoped (`@scope/pkg`), and `/`, `\` and `:` are either a path
 *  separator or outright illegal in a Windows file name. Everything outside
 *  `[a-z0-9._-]` collapses to `-`, the scope's leading `@` is dropped so the
 *  common case reads plainly, and the tail is trimmed so a pathological name
 *  cannot produce a path the OS refuses. An unusable name falls back to the
 *  default rather than to the shared file this fix exists to get rid of. */
export function markerFileName(name = "agents-deck") {
  const raw = typeof name === "string" ? name.trim().toLowerCase() : "";
  const safe = raw
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64)
    // Trimmed after the slice, and at both ends: Windows silently drops a
    // trailing dot from a file name, so a name that ends in one would write to
    // a path that is not the path we would later read.
    .replace(/^[-.]+|[-.]+$/g, "");
  return `.self-update-check-${safe || "agents-deck"}`;
}

function markerPath(name) {
  return join(MARKER_DIR, markerFileName(name));
}

// The marker carries the answer, not just the timestamp. The existing markers
// store only an mtime, which means a restart inside the window forgets what npm
// said and shows nothing until the window expires.
//
// It carries the outcome too. `at` is when npm last ANSWERED and `version` is
// what it said; `failedAt` is when the last attempt failed, and is null the
// moment one succeeds. Keeping them apart is what lets the deck say "checked
// 3m ago" and "could not reach npm" as the different things they are, instead
// of reporting a timeout as a fresh, up-to-date check.
function readMarkerFile(path) {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    // Either half is enough to be worth keeping: a marker written by a first
    // attempt that failed has no `at` yet, and markers written before
    // `failedAt` existed have no `failedAt` at all.
    return (typeof m?.at === "number" || typeof m?.failedAt === "number") ? m : null;
  } catch {
    return null;
  }
}

// The unsuffixed marker every earlier deck wrote, read at most once per name
// per process: upgrading to this version should not throw away an answer npm
// already gave. It is consulted only while the per-name file is still missing,
// so the shared file never goes back to being in charge.
const _legacy = new Map();
function legacyMarker(name) {
  const key = markerFileName(name);
  if (!_legacy.has(key)) _legacy.set(key, readMarkerFile(LEGACY_MARKER));
  return _legacy.get(key);
}

function readMarker(name) {
  return readMarkerFile(markerPath(name)) ?? legacyMarker(name);
}
function writeMarker(name, marker) {
  const path = markerPath(name);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(marker));
  } catch { /* a read-only home must not break the deck */ }
}

/** What the marker should hold after an attempt. Pure, because "a failed
 *  lookup must not be recorded as a successful one" is precisely the rule this
 *  file used to get wrong, and a rule worth a bug is worth a test.
 *
 *  A success stamps the hour and clears the failure. A failure records only
 *  itself, leaving the last real answer and the time it arrived untouched —
 *  the deck keeps showing what it knew, and stops claiming it just confirmed
 *  it. */
export function nextMarker({ prev, now, ok, version }) {
  if (ok) return { at: now, version: version ?? null, failedAt: null };
  return { at: prev?.at ?? null, version: prev?.version ?? null, failedAt: now };
}

// Even a per-package marker is shared by every deck running that package, so
// one deck's check still answers for the others inside the window. Asking once
// per PROCESS lands the check exactly where the user expects the truth: a
// freshly started deck — which for `npx ccdeck` is every single run. Keyed by
// name, so a process that asked about one package has not asked about another.
const _askedThisProcess = new Set();

/**
 * Whether to ask npm, or reuse the answer on disk. Pure, because "why did no
 * banner appear" is the question this feature gets asked, and the rule behind
 * it should be readable in one place.
 */
export function checkDue({ at, failedAt, now, first = false, force = false, ttlMs = CHECK_MS, retryMs = RETRY_MS }) {
  if (force || first) return true;      // explicit ask, or this process's first
  // The last attempt failed, so there is nothing to reuse and the long window
  // does not apply — but the short one does, or an unreachable registry turns
  // every poll into another request. Answered first: `at` here is the older,
  // successful check, and letting it decide would ask again immediately.
  if (typeof failedAt === "number") {
    if (failedAt > now) return true;    // clock moved; do not wait it out
    return now - failedAt >= retryMs;
  }
  if (typeof at !== "number") return true;  // never checked
  if (at > now) return true;            // marker from the future: a moved clock
  return now - at >= ttlMs;
}

/** Last known npm `latest`, refreshed at most once per CHECK_MS. Returns the
 *  cached answer immediately when the window has not elapsed.
 *
 *  `force` skips the window: the first call in this process, and an explicit
 *  "check now" from the UI. */
async function latestOnNpm(name, now, force = false) {
  const m = readMarker(name);
  const key = markerFileName(name);
  const first = !_askedThisProcess.has(key);
  _askedThisProcess.add(key);
  if (!checkDue({ at: m?.at, failedAt: m?.failedAt, now, first, force })) return m?.version ?? null;
  const pending = _inflight.get(key);
  if (pending) return pending;
  const run = fetchLatest(name)
    // Record the outcome, not just the moment, and record it against THIS
    // package: only an answer stamps `at`; a failure takes the short retry
    // window instead of the hour, keeps the version we already knew rather
    // than erasing it, and lands in this name's marker rather than spending
    // another package's window on a lookup that was never about it.
    .then(({ ok, version }) => {
      writeMarker(name, nextMarker({ prev: m, now, ok, version }));
      return (ok ? version : null) ?? m?.version ?? null;
    })
    .catch(() => m?.version ?? null)
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, run);
  return run;
}

// ── the notice ───────────────────────────────────────────────────────────────

/** Pure: turns three version strings into at most one thing worth saying.
 *
 *  "restart" outranks "upgrade" because it is the free fix — the newer code is
 *  already on the machine and a restart is all that stands between the user and
 *  it. Once restarted, the next check surfaces the upgrade if one is still due. */
export function pickNotice({ running, installed, latest }) {
  if (running && installed && isOlder(running, installed)) {
    return { kind: "restart", from: running, to: installed };
  }
  const have = installed ?? running;
  if (have && latest && isOlder(have, latest)) {
    return { kind: "upgrade", from: have, to: latest };
  }
  return null;
}

// ── installing ───────────────────────────────────────────────────────────────

// npm is a .cmd shim on Windows, which spawn can only launch through a shell.
// Everywhere else shell:false — with a shell, Node warns that arguments are
// concatenated rather than escaped. Same pair the ccusage installer uses.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_SHELL = process.platform === "win32";
const INSTALL_TIMEOUT_MS = 300_000; // a cold global install on a slow line

/**
 * Why an in-app upgrade would be wrong here, or null when it is fine.
 *
 * Pure so the policy can be read and tested on its own — it is the part that
 * decides whether we are allowed to write to the user's machine.
 */
export function upgradeBlockedReason({ git, npx, writable, optedOut }) {
  if (optedOut) return "opted_out";
  // The maintainer's own tree. Its version leads npm's, and installing over it
  // would replace a working copy with a published tarball.
  if (git) return "git_checkout";
  // npx runs from a content-addressed cache directory that is never upgraded in
  // place — `npx agents-deck@latest` fetches a DIFFERENT directory, which this
  // process could not switch to even after restarting.
  if (npx) return "npx";
  // Almost always a root-owned global prefix. Failing inside npm with EACCES
  // tells the user less than declining up front does.
  if (!writable) return "not_writable";
  return null;
}

/**
 * How this copy can update itself, if it can at all.
 *
 *   "install" — `npm i -g` here and restart into the new files.
 *   "npx"     — nothing to install: the supervisor re-runs `npx -y <spec>`,
 *               which fetches a NEW cache directory and hands the port to it.
 *   null      — a checkout, an unwritable prefix, or an explicit opt-out; the
 *               user gets the command and does it themselves.
 *
 * Pure, so the policy is one readable expression rather than three conditions
 * spread across the server and the UI.
 */
export function upgradeMode(blockedReason) {
  if (blockedReason === null || blockedReason === undefined) return "install";
  return blockedReason === "npx" ? "npx" : null;
}

function dirWritable(p) {
  try { accessSync(p, FS.W_OK); return true; } catch { return false; }
}

/** The same question, answered against the real filesystem and environment. */
export function upgradeBlock(pkgRoot) {
  return upgradeBlockedReason({
    git: isGitCheckout(pkgRoot),
    npx: isNpxInstall(pkgRoot),
    // npm -g rewrites the package directory and its parent (the global
    // node_modules), so both have to be ours to write.
    writable: dirWritable(pkgRoot) && dirWritable(resolve(pkgRoot, "..")),
    optedOut: process.env.AGENTS_DECK_NO_INSTALL === "1",
  });
}

// One install at a time, per process. State is deliberately coarse: the UI only
// needs to know whether to show a spinner, a version, or an error.
let _upgrade = { state: "idle", command: null, error: null, at: 0 };

export function upgradeStatus() {
  return { ..._upgrade };
}

/**
 * Start `npm i -g <name>@latest` in the background.
 *
 * Returns immediately with the accepted command, or a refusal. Never installs
 * anything except this package, and never at a version the caller chose — the
 * argument vector is fixed here, not assembled from request input.
 */
export function startUpgrade({ pkgRoot, name = "agents-deck" }) {
  if (_upgrade.state === "running") return { ok: true, already: true, command: _upgrade.command };
  const blocked = upgradeBlock(pkgRoot);
  if (blocked) return { ok: false, reason: blocked, command: upgradeCommand(pkgRoot, name) };

  const args = ["install", "-g", `${name}@latest`, "--no-audit", "--no-fund", "--loglevel", "error"];
  const command = `npm ${args.join(" ")}`;
  _upgrade = { state: "running", command, error: null, at: Date.now() };

  let child;
  try {
    child = spawn(NPM, args, { shell: NPM_SHELL, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    _upgrade = { state: "failed", command, error: err?.message ?? String(err), at: Date.now() };
    return { ok: false, reason: "spawn_failed", command };
  }

  // Only the tail is kept: npm's failures put the useful line near the end, and
  // a full buffer of an install log is not something the browser should hold.
  let err = "";
  const keepTail = (s) => { err = (err + s).slice(-4000); };
  child.stdout.on("data", d => keepTail(String(d)));
  child.stderr.on("data", d => keepTail(String(d)));

  // The deadline states the outcome itself, and only then kills.
  //
  // npm is a .cmd shim on Windows and is therefore spawned through a shell, so
  // `child` is cmd.exe and npm itself is a grandchild — a plain kill would
  // report the install as timed out while it carried on writing to
  // node_modules. killTree is what reaches it (taskkill /T there, the same
  // plain signal everywhere else).
  //
  // Leaving the verdict to 'close' was the other half of the same bug. 'close'
  // waits for the stdio pipes, which the grandchild inherited, so on Windows it
  // could arrive minutes after the deadline — or never, if the tree kill could
  // not run at all — and until it did, /api/version kept reporting
  // `state: "running"` with the UI spinning on "installing…" and the guard at
  // the top of this function refusing every retry. When it finally arrived it
  // carried the killed wrapper's status, so a five-minute timeout was announced
  // to the user as "npm exited null".
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    _upgrade = {
      state: "failed",
      command,
      error: `timed out after ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} minutes`,
      at: Date.now(),
    };
    killTree(child);
  }, INSTALL_TIMEOUT_MS);
  timer.unref?.();

  child.on("error", (e) => {
    clearTimeout(timer);
    // A kill can make the child emit one of these; whatever it says, the reason
    // this install failed is the deadline that has already been reported.
    if (timedOut) return;
    _upgrade = { state: "failed", command, error: e?.message ?? String(e), at: Date.now() };
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      // A clean exit is a real install even if it lands after the deadline —
      // npm finishing in the same breath as the timer is the one case where the
      // files on disk disagree with the verdict above, and the files win.
      //
      // Deliberately does not restart anything. The new files on disk make
      // installedVersion() disagree with the running one, and the ordinary
      // drift path takes it from there — including its wait for an idle moment.
      _upgrade = { state: "done", command, error: null, at: Date.now() };
    } else if (!timedOut) {
      _upgrade = { state: "failed", command, error: lastMeaningfulLine(err) || `npm exited ${code}`, at: Date.now() };
    }
  });

  return { ok: true, command };
}

/** npm's real complaint is usually the last non-empty, non-decorative line. */
export function lastMeaningfulLine(text) {
  const lines = String(text ?? "").split(/\r?\n/)
    .map(l => l.replace(/^npm (ERR!|WARN)\s*/, "").trim())
    .filter(l => l && !/^-+$/.test(l) && !/^A complete log/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

/** Full answer for GET /api/version. Never throws, never blocks on the network
 *  for longer than FETCH_TIMEOUT_MS, and answers the local half even when the
 *  registry is unreachable. */
export async function versionReport({ running, pkgRoot, name = "agents-deck", now = Date.now(), force = false }) {
  const installed = installedVersion(pkgRoot);
  // Only an explicit opt-out silences the registry.
  //
  // A checkout used to be excluded here too, on the reasoning that its version
  // leads npm's. That reasoning holds for the COMMAND — telling someone to
  // `npm i -g` over their working copy is wrong — but not for the question.
  // Knowing a release shipped is useful however you would install it, and
  // suppressing the lookup meant `latest` was always null, so the upgrade
  // notice could never appear and the "this is a checkout" explanation had
  // nowhere to render. A checkout that is ahead of npm still says nothing:
  // isOlder decides that, not this.
  const skipRegistry =
    process.env.AGENTS_DECK_NO_UPDATE_CHECK === "1" ||
    process.env.AGENTS_DECK_NO_INSTALL === "1";
  const latest = skipRegistry ? null : await latestOnNpm(name, now, force);
  const marker = skipRegistry ? null : readMarker(name);
  const blocked = upgradeBlock(pkgRoot);
  return {
    name,
    running: running ?? null,
    installed,
    latest,
    // When npm last ANSWERED, so the UI can say it rather than leaving the
    // user to wonder whether the check runs at all. A lookup that failed does
    // not move this: "checked 2 minutes ago" over an hour-old answer is the
    // one thing this field must never say.
    checkedAt: marker?.at ?? null,
    // …and when it last failed, null once one succeeds. Without it, the single
    // most common reason for a missing update button — a proxy, a flaky line,
    // an offline machine — is indistinguishable from being up to date.
    checkFailedAt: marker?.failedAt ?? null,
    checkDisabled: skipRegistry,
    notice: pickNotice({ running, installed, latest }),
    command: upgradeCommand(pkgRoot, name),
    // Why an in-app `npm i -g` is refused, when it is — so the UI can say so
    // instead of leaving a gap the user has to guess about. "npx" is a refusal
    // of the install, not of the update: upgradeMode says so.
    upgradeBlocked: blocked,
    upgradeMode: upgradeMode(blocked),
    upgrade: upgradeStatus(),
  };
}
