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
// Notify only. We never run `npm i` on the user's behalf: agents-deck may be
// running globally, from an npx cache, or from a git checkout, and each wants a
// different command (or none at all).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** The exact line the user can paste. */
export function upgradeCommand(pkgRoot, name = "agents-deck") {
  return isNpxInstall(pkgRoot) ? `npx -y ${name}@latest` : `npm i -g ${name}@latest`;
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

/** Full answer for GET /api/version. Never throws, never blocks on the network
 *  for longer than FETCH_TIMEOUT_MS, and answers the local half even when the
 *  registry is unreachable. */
export async function versionReport({ running, pkgRoot, name = "agents-deck", now = Date.now() }) {
  const installed = installedVersion(pkgRoot);
  // A checkout has no meaningful "latest", and an opt-out means no egress at
  // all. Both keep the running-vs-installed half, which is purely local.
  const skipRegistry =
    process.env.AGENTS_DECK_NO_UPDATE_CHECK === "1" ||
    process.env.AGENTS_DECK_NO_INSTALL === "1" ||
    isGitCheckout(pkgRoot);
  const latest = skipRegistry ? null : await latestOnNpm(name, now);
  return {
    name,
    running: running ?? null,
    installed,
    latest,
    notice: pickNotice({ running, installed, latest }),
    command: upgradeCommand(pkgRoot, name),
  };
}
