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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { killTree } from "./exec.mjs";

const CACHE_MS = 120_000; // 2 min — modal is manual-open; cheap to keep warm
const TIMEOUT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 120_000; // first-run npm install can be slow
const UPDATE_CHECK_MS = 24 * 3600_000; // check npm for a newer ccusage once/day

const CACHE_DIR = path.join(os.homedir(), ".agents-deck", "ccusage");
const PKG_DIR = path.join(CACHE_DIR, "node_modules", "ccusage");
const MARKER = path.join(CACHE_DIR, ".last-update-check");

const _cache = new Map(); // key `${since}|${until}` → { result, at }

// npm is a .cmd shim on Windows, which spawn can only launch through a shell.
// Everywhere else shell:false — with a shell, Node warns that arguments are
// concatenated rather than escaped, and the warning lands in our startup
// banner now that these run at boot.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_SHELL = process.platform === "win32";

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

// ── managed install ─────────────────────────────────────────────────────────

// Absolute path to ccusage's CLI entry inside our managed install, or null if
// not installed. Reads the package's `bin` field (currently "./src/cli.js").
function resolveEntry() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
    let rel = pkg.bin;
    if (rel && typeof rel === "object") rel = rel.ccusage ?? Object.values(rel)[0];
    if (typeof rel !== "string") return null;
    const entry = path.join(PKG_DIR, rel);
    return existsSync(entry) ? { entry, version: pkg.version } : null;
  } catch {
    return null;
  }
}

// Run `npm install ccusage@<spec> --prefix CACHE_DIR`. Synchronous variant for
// the first-run cold path (we must have a binary before we can answer).
function installSync(spec = "latest") {
  mkdirSync(CACHE_DIR, { recursive: true });
  const r = spawnSync(
    NPM,
    ["install", `ccusage@${spec}`, "--prefix", CACHE_DIR,
     "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"],
    { shell: NPM_SHELL, windowsHide: true, timeout: INSTALL_TIMEOUT_MS, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`npm install ccusage failed: ${(r.stderr || "").trim() || r.status}`);
  }
}

// Background, non-blocking install (used by the daily update path).
function installAsync(spec = "latest") {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const child = spawn(
      NPM,
      ["install", `ccusage@${spec}`, "--prefix", CACHE_DIR,
       "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"],
      { shell: NPM_SHELL, windowsHide: true, detached: false, stdio: "ignore" },
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
    const child = spawn(NPM, ["view", "ccusage", "version"],
      { shell: NPM_SHELL, windowsHide: true });
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
    throw new Error("ccusage is not installed, and installs are off (AGENTS_DECK_NO_INSTALL=1)");
  }
  // Cold: install once (deduped across concurrent callers).
  if (!_installing) {
    _installing = (async () => { installSync("latest"); })()
      .catch(e => { console.error("agents-deck ccusage: install failed:", e?.message ?? e); })
      .finally(() => { _installing = null; });
  }
  await _installing;
  resolved = resolveEntry();
  if (resolved) { touchMarker(); return { kind: "node", entry: resolved.entry }; }
  return { kind: "npx" }; // npm unavailable / offline → fall back to npx
}

// ── invocation ──────────────────────────────────────────────────────────────

// Run ccusage with the given args, resolve raw stdout.
async function runCcusage(args) {
  const runner = await getRunner();
  const [cmd, full] = runner.kind === "node"
    ? [process.execPath, [runner.entry, ...args]]
    : ["npx", ["-y", "ccusage@latest", ...args]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, full, {
      // node path needs no shell; npx fallback does (Windows .cmd shim).
      shell: runner.kind === "npx",
      windowsHide: true,
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      // The npx fallback runs through a shell, so on Windows `child` is cmd.exe
      // and npx is a grandchild that a plain kill would leave downloading.
      killTree(child);
      reject(new Error("ccusage timed out"));
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

// ccusage prints the JSON object somewhere in stdout; slice first { to last }.
function extractJson(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in ccusage output");
  return JSON.parse(out.slice(start, end + 1));
}

// YYYYMMDD for the CLI's --since/--until.
function toCliDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Fetch daily usage from ccusage for a date range.
 * @param {{ since?: string, until?: string, force?: boolean }} opts
 *        since/until are YYYYMMDD strings (CLI format). Defaults to last 30 days.
 * @returns {{ ok, days, totals, since, until, fetchedAt } | { ok:false, error }}
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
    console.error("agents-deck ccusage: fetch failed:", err?.message ?? err);
    result = { ok: false, error: String(err?.message ?? err), fetchedAt: now };
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
      .catch(e => { console.error("agents-deck ccusage: install failed:", e?.message ?? e); })
      .finally(() => { _installing = null; });
  }
  return { state: "installing" };
}

export function invalidateCcusageCache() {
  _cache.clear();
}
