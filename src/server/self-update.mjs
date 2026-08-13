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

const CHECK_MS = 24 * 3600_000; // same daily cadence as the ccusage/cswap checks
const FETCH_TIMEOUT_MS = 6_000;
// A third marker path: ccusage owns ~/.agents-deck/ccusage/.last-update-check
// and cswap owns ~/.agents-deck/.cswap-update-check. Sharing one would make the
// three features fight over a single daily slot.
const MARKER = join(homedir(), ".agents-deck", ".self-update-check");

let _inflight = null; // dedupe concurrent /api/version calls into one fetch

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

/** The exact line the user can paste, for the way THIS copy was installed. */
export function upgradeCommand(pkgRoot, name = "agents-deck") {
  // A checkout is updated by pulling, and the bundle is built, not shipped —
  // so `npm run build` is part of the answer rather than an afterthought.
  if (isGitCheckout(pkgRoot)) return "git pull && npm run build";
  if (isNpxInstall(pkgRoot)) return `npx -y ${name}@latest`;
  return `npm i -g ${name}@latest`;
}

// ── what npm has ─────────────────────────────────────────────────────────────

// The dist-tags endpoint answers with ~20 bytes ({"latest":"1.30.7"}); the full
// packument is >2 KB and needs parsing we have no use for.
async function fetchLatest(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/-/package/${name}/dist-tags`, {
      headers: { accept: "application/json", "user-agent": "agents-deck" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const v = (await res.json())?.latest;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// The marker carries the answer, not just the timestamp. The existing markers
// store only an mtime, which means a restart inside the 24h window forgets what
// npm said and shows nothing until the window expires.
function readMarker() {
  try {
    const m = JSON.parse(readFileSync(MARKER, "utf8"));
    return typeof m?.at === "number" ? m : null;
  } catch {
    return null;
  }
}
function writeMarker(at, version) {
  try {
    mkdirSync(dirname(MARKER), { recursive: true });
    writeFileSync(MARKER, JSON.stringify({ at, version: version ?? null }));
  } catch { /* a read-only home must not break the deck */ }
}

/** Last known npm `latest`, refreshed at most once per CHECK_MS. Returns the
 *  cached answer immediately when the window has not elapsed. */
async function latestOnNpm(name, now) {
  const m = readMarker();
  if (m && now - m.at < CHECK_MS) return m.version ?? null;
  if (_inflight) return _inflight;
  _inflight = fetchLatest(name)
    // Stamp before deciding what to keep: a failed lookup must burn the day's
    // slot rather than retry on every poll, but it must not erase a version we
    // already knew.
    .then(v => { writeMarker(now, v ?? m?.version ?? null); return v ?? m?.version ?? null; })
    .catch(() => m?.version ?? null)
    .finally(() => { _inflight = null; });
  return _inflight;
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

  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, INSTALL_TIMEOUT_MS);
  timer.unref?.();

  child.on("error", (e) => {
    clearTimeout(timer);
    _upgrade = { state: "failed", command, error: e?.message ?? String(e), at: Date.now() };
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      // Deliberately does not restart anything. The new files on disk make
      // installedVersion() disagree with the running one, and the ordinary
      // drift path takes it from there — including its wait for an idle moment.
      _upgrade = { state: "done", command, error: null, at: Date.now() };
    } else {
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
export async function versionReport({ running, pkgRoot, name = "agents-deck", now = Date.now() }) {
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
  const latest = skipRegistry ? null : await latestOnNpm(name, now);
  return {
    name,
    running: running ?? null,
    installed,
    latest,
    notice: pickNotice({ running, installed, latest }),
    command: upgradeCommand(pkgRoot, name),
    // Why the Update button is absent, when it is — so the UI can say so
    // instead of leaving a gap the user has to guess about.
    upgradeBlocked: upgradeBlock(pkgRoot),
    upgrade: upgradeStatus(),
  };
}
