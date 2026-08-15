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
//   latest    — npm's dist-tag, fetched at most once an hour (CHECK_MS below,
//               which also explains why it is not the daily cadence it was)
//
// Installing is opt-in and narrow. `npm i -g` runs only when the user asks for
// it by name and only where it can actually work: a global install, on a
// directory we can write, outside a git checkout and outside an npx cache.
// Everywhere else this stays what it has always been — a printed command.
import { accessSync, constants as FS, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** What to hand `npx -y`, read from the cache directory's own metadata.
 *
 *  `fallback` is what to answer when that metadata names nothing usable — the
 *  package name, for the caller whose job is to re-run SOMETHING. Pass null and
 *  the answer is null instead, which is what invoked-as.mjs needs: it asks which
 *  name the user typed, and there the package name is not a lesser answer, it is
 *  a wrong one. */
export function npxSpecFromMeta(meta, fallback = "agents-deck") {
  const list = meta && meta._npx && Array.isArray(meta._npx.packages) ? meta._npx.packages : [];
  for (const entry of list) {
    const name = bareSpecName(entry);
    if (name) return `${name}@latest`;
  }
  return fallback ? `${fallback}@latest` : null;
}

/** The same, answered against the filesystem. Null when this is not an npx run,
 *  and — for a caller that passed no fallback — when the metadata cannot be
 *  read. */
export function npxRestartSpec(pkgRoot, name = "agents-deck") {
  const root = npxRoot(pkgRoot);
  if (!root) return null;
  let meta = null;
  try { meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch { /* fall back to the name */ }
  return npxSpecFromMeta(meta, name);
}

/** The package an upgrade would actually install here — the only package worth
 *  asking npm about.
 *
 *  The check used to ask about `agents-deck` no matter what the upgrade
 *  command installed, so a deck started with `npx ccdeck` compared its version
 *  against `agents-deck`'s dist-tag and then handed back `npx -y ccdeck@latest`.
 *  Nothing tied the two together. CI publishes the three names one after
 *  another, so between the first and the last publish they genuinely disagree,
 *  and inside that window the deck offered a version the command could not
 *  install — the ETARGET below, with a window measured in publishes rather than
 *  in seconds of propagation.
 *
 *  Deriving the name from the resolved upgrade spec keeps the two halves
 *  consistent by construction: whatever the command will install is what gets
 *  asked about, and the per-name marker follows the same name. A global install
 *  installs `name` and a checkout installs nothing, so both keep asking about
 *  the name this build was published under. */
export function upgradeName(pkgRoot, name = "agents-deck") {
  if (!isNpxInstall(pkgRoot) || isGitCheckout(pkgRoot)) return name;
  return bareSpecName(npxRestartSpec(pkgRoot, name)) ?? name;
}

/** The exact line the user can paste, for the way THIS copy was installed. */
export function upgradeCommand(pkgRoot, name = "agents-deck") {
  // A checkout is updated by pulling, and the bundle is built, not shipped —
  // so `npm run build` is part of the answer rather than an afterthought.
  if (isGitCheckout(pkgRoot)) return "git pull && npm run build";
  if (isNpxInstall(pkgRoot)) return `npx -y ${upgradeName(pkgRoot, name)}@latest`;
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

// A dist-tag is a pointer, and being pointed at is not the same as being
// installable.
//
// npm makes the moved tag visible before the version document has propagated to
// the replica the installer reads, so for a window `{"latest":"1.33.28"}` and
// `No matching version found for ccdeck@1.33.28` are both true at the same
// moment. Reported live: the banner offered v1.33.28, the restart ran
// `npx -y ccdeck@latest`, npm answered ETARGET, and the deck came back on the
// version it started with after tearing itself down — under npx a restart is
// not free, since the worker exits and hands the port over before anything is
// fetched.
//
// So the tag is checked against the version document, which is the same
// question `npm view <name>@<version> version` asks and the same document the
// installer resolves against. 404 is the answer this exists for: published
// tag, unpublished version, try again in five minutes. `ok` is false only when
// the registry gave no usable answer at all — that is not a licence to
// announce either, but it is not evidence of an unpublished version.
async function isPublished(name, version) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
      headers: { accept: "application/json", "user-agent": "agents-deck" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: true, published: false };
    if (!res.ok) return { ok: false, published: false };
    // The document has to be the one asked for: a registry that answers 200
    // with something else has not shown that this version is resolvable.
    const body = await res.json().catch(() => null);
    return { ok: true, published: body?.version === version };
  } catch {
    return { ok: false, published: false };
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
  return `.self-update-check-${safeNamePart(name)}`;
}

/** The sanitised half, shared with the restart-failure note below so the two
 *  files agree on what a package name becomes on disk. */
function safeNamePart(name) {
  const raw = typeof name === "string" ? name.trim().toLowerCase() : "";
  const safe = raw
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64)
    // Trimmed after the slice, and at both ends: Windows silently drops a
    // trailing dot from a file name, so a name that ends in one would write to
    // a path that is not the path we would later read.
    .replace(/^[-.]+|[-.]+$/g, "");
  return safe || "agents-deck";
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

/** The version npm last named as `latest` for this package, straight off the
 *  marker and with no lookup of its own.
 *
 *  This is what the supervisor calls a failed upgrade's TARGET. It has to be
 *  answerable without the network — the supervisor asks it in the moment
 *  between a click and a fetch, and the reason the fetch is about to fail may
 *  well be that there is no network — and it has to be the same number the
 *  banner offered, which is precisely what the marker holds. */
export function lastKnownLatest(name = "agents-deck") {
  const v = readMarker(name)?.version;
  return typeof v === "string" && v ? v : null;
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
 *  it.
 *
 *  `installable` is the third outcome: npm answered, and what it named is not
 *  yet a version anything can install. That is a real answer — `at` moves, the
 *  registry was reached — but the version is held in `pending` instead of
 *  `version`, so `latest` stays a number the upgrade command can resolve, and
 *  `pendingAt` puts the next look on the short window rather than the hour. */
export function nextMarker({ prev, now, ok, version, installable = true }) {
  if (!ok) {
    return {
      at: prev?.at ?? null,
      version: prev?.version ?? null,
      failedAt: now,
      pending: prev?.pending ?? null,
      pendingAt: prev?.pendingAt ?? null,
    };
  }
  if (!installable) {
    return { at: now, version: prev?.version ?? null, failedAt: null, pending: version ?? null, pendingAt: now };
  }
  return { at: now, version: version ?? null, failedAt: null, pending: null, pendingAt: null };
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
export function checkDue({ at, failedAt, pendingAt, now, first = false, force = false, ttlMs = CHECK_MS, retryMs = RETRY_MS }) {
  if (force || first) return true;      // explicit ask, or this process's first
  // Two ways of not having an answer yet, and neither may spend the hour a real
  // answer buys: the last attempt failed, or npm named a version that cannot be
  // installed yet. Both take the short window instead — an unreachable registry
  // must not turn every poll into another request, and a release mid-publish is
  // resolvable minutes later, not an hour later. Answered before `at`, which
  // here is the older, settled check and would otherwise ask again immediately
  // (or, for a pending version, not for another hour).
  const unsettled = [failedAt, pendingAt].filter(t => typeof t === "number");
  if (unsettled.length) {
    const last = Math.max(...unsettled);
    if (last > now) return true;        // clock moved; do not wait it out
    return now - last >= retryMs;
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
  if (!checkDue({ at: m?.at, failedAt: m?.failedAt, pendingAt: m?.pendingAt, now, first, force })) {
    return m?.version ?? null;
  }
  const inflight = _inflight.get(key);
  if (inflight) return inflight;
  const run = runCheck(name, m, now)
    // Record the outcome, not just the moment, and record it against THIS
    // package: only an answer stamps `at`; a failure takes the short retry
    // window instead of the hour, keeps the version we already knew rather
    // than erasing it, and lands in this name's marker rather than spending
    // another package's window on a lookup that was never about it.
    .then((marker) => {
      writeMarker(name, marker);
      return marker.version ?? null;
    })
    .catch(() => m?.version ?? null)
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, run);
  return run;
}

/** One check, as a marker: what npm's dist-tag says, and — only when that is a
 *  version this deck has not already confirmed — whether it can be installed.
 *
 *  The second request is what keeps the banner honest, and it is skipped in the
 *  case that runs all day: a tag that has not moved was confirmed the first
 *  time it was seen, so a deck sitting on the current release still costs one
 *  ~20-byte GET per check. Confirming costs one more, once per release. */
async function runCheck(name, prev, now) {
  const { ok, version } = await fetchLatest(name);
  if (!ok || version === prev?.version) return nextMarker({ prev, now, ok, version });
  const probe = await isPublished(name, version);
  return nextMarker({ prev, now, ok, version, installable: probe.ok && probe.published });
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

// ── the note a failed npx relaunch leaves behind ─────────────────────────────
//
// The npx upgrade is the one path whose failure the server cannot see. It runs
// in the SUPERVISOR, after this process has already exited: the worker asks to
// come back through `npx -y <spec>@latest`, npx fails, and the supervisor
// relaunches the copy on disk. The new worker boots knowing nothing, so
// /api/version kept answering `upgrade: {state:"idle"}` — the banner still
// offered "Update & restart", the tab said nothing at all, and a user who
// clicked the button without watching the terminal saw the deck blink and come
// back unchanged. Every click then repeated the whole cycle identically.
//
// A file is the only channel between the two processes: the supervisor writes
// one when the relaunch fails, and the worker it starts instead reads it here.
// Same directory as the update markers, and named after the package for the
// same reason they are.
//
// The package name alone was not enough, and one release was enough to show it.
// Two `npx ccdeck` decks resolve into the same content-addressed _npx directory,
// so they run the same package at the same version out of the same home: when
// one user's upgrade failed, the other deck — which had never asked for
// anything — read that note as its own, reported `upgrade: {state:"failed"}`
// and labelled its first ever click "Retry update". The version-staleness rule
// below cannot catch it, because both decks are the same version.
//
// So the name carries WHOSE failure it is as well as which package's: the pid
// of the supervisor that wrote it. That is unique among the decks alive on the
// machine, and it crosses the process boundary on its own — the worker that
// reads the note is a child the supervisor spawns after the failure, and
// inherits the pid through AGENTS_DECK_SUPERVISOR_PID. A worker with no
// supervisor to answer for reads nothing rather than falling back to a shared
// file, which is the bug this whole naming exists to avoid.
const NOTE_PREFIX = ".restart-failed-";

/** Which supervisor a note belongs to, as the file name may spell it. Digits
 *  and nothing else: legal on every filesystem, and readable back as the pid
 *  the sweep below asks about. Anything else is refused rather than scrubbed
 *  into digits, since two keys must never collapse into one file name. */
function safeOwner(key) {
  const raw = String(key ?? "").trim();
  return /^\d{1,12}$/.test(raw) && Number(raw) > 0 ? raw : null;
}

/** This process's own key, set by the supervisor on itself and inherited by
 *  every worker it launches. */
export function restartFailureKey(env = process.env) {
  return safeOwner(env?.AGENTS_DECK_SUPERVISOR_PID);
}

/** Called once by the supervisor, on its own environment, which every worker it
 *  spawns then inherits. Assigned rather than defaulted: a deck launched by
 *  another deck's npx relaunch inherits that supervisor's key and must answer
 *  for itself, not for the parent whose upgrade it is the result of. */
export function claimRestartFailureKey(env = process.env, pid = process.pid) {
  env.AGENTS_DECK_SUPERVISOR_PID = String(pid);
  return safeOwner(pid);
}

/** `ccdeck` under supervisor 4821 → `.restart-failed-ccdeck-4821`, or null when
 *  there is no supervisor, which is not a deck any note can be about. */
export function restartFailureFileName(name = "agents-deck", key = restartFailureKey()) {
  const owner = safeOwner(key);
  return owner ? `${NOTE_PREFIX}${safeNamePart(name)}-${owner}` : null;
}

function restartFailurePath(name, key) {
  const file = restartFailureFileName(name, key);
  return file ? join(MARKER_DIR, file) : null;
}

/** Called by the supervisor when an upgrade does not happen — because the fetch
 *  failed, because the fetched copy never served, or because this target has
 *  already failed here and is not being tried again. Best-effort: a read-only
 *  home costs the report, not the deck. */
export function recordRestartFailure({
  name = "agents-deck", command = null, error = null, version = null,
  target = null, attempts = 1, at = Date.now(), failedAt = at, key = restartFailureKey(),
} = {}) {
  const file = restartFailureFileName(name, key);
  if (!file) return;
  const path = join(MARKER_DIR, file);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      command,
      error: error ? String(error).slice(0, 300) : null,
      // The version that failed to leave — see restartFailureNotice.
      version,
      // The version that failed to ARRIVE, and how many attempts it has cost.
      // Together they are the whole of what stops an unattended deck retrying
      // the identical fetch forever; see upgradeAttempt in supervisor.mjs.
      target,
      attempts,
      // When the fetch itself failed, which a refusal re-stating that failure
      // carries forward unchanged. `at` moves on every write because the
      // browser ends its attempt on a note it has not seen before — the
      // cooldown must not be pushed out by the act of asking about it.
      failedAt,
      at,
    }));
    sweepOrphanedNotes(file);
  } catch { /* ignore */ }
}

/** Called before each attempt, so a retry is answered by its own outcome rather
 *  than by the last one's. */
export function clearRestartFailure(name = "agents-deck", key = restartFailureKey()) {
  const path = restartFailurePath(name, key);
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

export function readRestartFailure(name = "agents-deck", key = restartFailureKey()) {
  const path = restartFailurePath(name, key);
  if (!path) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

// A note is named after a process, so it outlives its deck whenever that
// supervisor is killed before anyone reads the tab, and nothing would ever
// delete it: the retry that clears one is exactly the thing that never happened.
// Swept from the only path that creates notes, and only where the owner is
// provably gone — another deck's note is another deck's to clear. Names without
// a pid are the single shared file of v1.33.82, which nothing reads any more.
function sweepOrphanedNotes(keep) {
  let files;
  try { files = readdirSync(MARKER_DIR); } catch { return; }
  for (const f of files) {
    if (f === keep || !f.startsWith(NOTE_PREFIX)) continue;
    const owner = Number(f.slice(f.lastIndexOf("-") + 1));
    if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) continue;
    try { rmSync(join(MARKER_DIR, f), { force: true }); } catch { /* ignore */ }
  }
}

// Signal 0 delivers nothing; it only asks whether the pid could be signalled.
// EPERM is someone else's process answering, which is still a process — the
// same test sweepStaleDiscovery makes of the discovery files.
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === "EPERM"; }
}

/**
 * The note as the version report should carry it, or null when it no longer
 * describes this deck. Pure, because the staleness rule is the whole subtlety.
 * WHOSE failure it is was settled by the file name; this decides only whether
 * it is still current.
 *
 * The note names the version that was running when the upgrade failed. While
 * that is still the version on disk, the failure is current: the deck really is
 * stuck where it was. Once the files are a different version the upgrade
 * happened some other way — a `npm i -g`, a fixed npm prefix, a manual npx —
 * and a note about a deck that no longer exists must not keep claiming the
 * update is broken.
 */
export function restartFailureNotice(record, installed = null) {
  if (!record || typeof record.error !== "string" || !record.error) return null;
  if (record.version && installed && record.version !== installed) return null;
  return {
    state: "failed",
    command: typeof record.command === "string" ? record.command : null,
    error: record.error,
    at: typeof record.at === "number" ? record.at : 0,
  };
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

/** Full answer for GET /api/version. Never throws, and answers the local half
 *  even when the registry is unreachable.
 *
 *  Network worst case is 2 x FETCH_TIMEOUT_MS, not one: the dist-tag lookup,
 *  plus — only when the tag has moved to a version this deck has not confirmed
 *  yet — the installability probe (see runCheck), each carrying its own
 *  AbortSignal timeout. That second request costs its timeout at most once per
 *  release; a deck sitting on the current release stays inside one. */
export async function versionReport({ running, pkgRoot, name = "agents-deck", now = Date.now(), force = false }) {
  const installed = installedVersion(pkgRoot);
  // Asked about the package the command installs, not about the one this build
  // happens to be named after — see upgradeName. Everything registry-shaped in
  // this report is about `target`: the version, the marker it is cached in, and
  // the name the report gives for it.
  const target = upgradeName(pkgRoot, name);
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
  const latest = skipRegistry ? null : await latestOnNpm(target, now, force);
  const marker = skipRegistry ? null : readMarker(target);
  const blocked = upgradeBlock(pkgRoot);
  // An install started in THIS process outranks the note on disk: it is newer
  // by construction, and a running one must not be reported as a past failure.
  // The note is read whatever the registry is doing — it is a local event, not
  // a lookup — so an offline deck still explains why its update did nothing.
  // Only the note addressed to this deck's own supervisor is read: the decks
  // sharing this home directory are usually the same package at the same
  // version, and none of them may answer for another's failed upgrade.
  const live = upgradeStatus();
  const upgrade = live.state === "idle"
    ? (restartFailureNotice(readRestartFailure(target), installed) ?? live)
    : live;
  return {
    name: target,
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
    // A version npm's dist-tag names that the registry cannot serve yet — the
    // one thing `latest` deliberately will not say, since saying it is what
    // sent a deck into a restart that ended in ETARGET. Reported so the state
    // is visible rather than looking like nothing was published at all.
    latestPending: marker?.pending ?? null,
    checkDisabled: skipRegistry,
    notice: pickNotice({ running, installed, latest }),
    command: upgradeCommand(pkgRoot, name),
    // Why an in-app `npm i -g` is refused, when it is — so the UI can say so
    // instead of leaving a gap the user has to guess about. "npx" is a refusal
    // of the install, not of the update: upgradeMode says so.
    upgradeBlocked: blocked,
    upgradeMode: upgradeMode(blocked),
    upgrade,
  };
}
