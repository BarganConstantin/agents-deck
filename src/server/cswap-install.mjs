// Ensures `cswap` (claude-swap) is available, because the accounts panel is
// built entirely on the store it maintains.
//
// Unlike the ccusage install, this one lands in the user's GLOBAL tool path
// rather than a private prefix under ~/.agents-deck, and claude-swap handles
// Claude credentials. That makes it something the user should see happen: the
// caller prints what this returns, and AGENTS_DECK_NO_INSTALL=1 turns it off
// entirely. It is always best-effort — the deck's core function does not
// depend on it, so a failure is reported and then ignored.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const INSTALL_TIMEOUT_MS = 180_000; // uv resolves + builds a Python env

// Same throttle the ccusage installer uses: check once a day, tracked by a
// marker file's mtime so the interval survives restarts.
const UPDATE_CHECK_MS = 24 * 3600_000;
const MARKER = join(homedir(), ".agents-deck", ".cswap-update-check");

function run(cmd, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, shell: false, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Installed version string, or null when cswap isn't on PATH. */
export async function cswapVersion() {
  const r = await run("cswap", ["--version"]);
  if (!r.ok) return null;
  // "claude-swap 0.25.0" → "0.25.0"
  const m = (r.stdout || r.stderr).trim().match(/(\d+\.\d+\.\d+\S*)/);
  return m ? m[1] : "installed";
}

/**
 * Install claude-swap with whichever Python tool installer is present.
 *
 * `uv` first because it is what claude-swap documents and it is dramatically
 * faster; `pipx` as the established alternative. Deliberately NOT falling back
 * to bare `pip install --user`: that drops the package into the user's default
 * Python environment where it can collide with their own dependencies, which
 * is not a thing to do to someone without asking.
 */
async function installCswap() {
  for (const [cmd, args] of [
    ["uv",   ["tool", "install", "claude-swap"]],
    ["pipx", ["install", "claude-swap"]],
  ]) {
    const probe = await run(cmd, ["--version"], 5_000);
    if (!probe.ok) continue;
    const r = await run(cmd, args, INSTALL_TIMEOUT_MS);
    if (r.ok) return { ok: true, via: cmd };
    return { ok: false, reason: "install_failed", via: cmd, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
  }
  return { ok: false, reason: "no_installer" };
}

function updateCheckDue() {
  try { return Date.now() - statSync(MARKER).mtimeMs > UPDATE_CHECK_MS; }
  catch { return true; }   // no marker yet
}
function touchMarker() {
  try {
    mkdirSync(join(homedir(), ".agents-deck"), { recursive: true });
    writeFileSync(MARKER, String(Date.now()));
  } catch { /* ignore */ }
}

/** Newest claude-swap on PyPI, or null if the check fails. */
async function latestOnPypi() {
  try {
    const res = await fetch("https://pypi.org/pypi/claude-swap/json", {
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const v = (await res.json())?.info?.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Numeric-segment version compare; returns true when `a` is older than `b`. */
function isOlder(a, b) {
  const seg = (v) => v.split(/[.\-+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
  const x = seg(a), y = seg(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * Upgrade claude-swap in the background when a newer release exists.
 *
 * Detached and unawaited: an upgrade resolves a Python environment and can
 * take tens of seconds, which is not a thing to put in front of the server
 * starting. The running copy keeps working; the new one is there next launch.
 */
function upgradeInBackground(via) {
  const args = via === "uv" ? ["tool", "upgrade", "claude-swap"] : ["upgrade", "claude-swap"];
  try {
    const child = spawn(via, args, { stdio: "ignore", shell: false, windowsHide: true, detached: false });
    child.on("error", () => {});
    child.unref?.();
  } catch { /* best-effort */ }
}

/** Whichever Python tool installer is available, or null. */
async function findInstaller() {
  for (const cmd of ["uv", "pipx"]) {
    if ((await run(cmd, ["--version"], 5_000)).ok) return cmd;
  }
  return null;
}

/**
 * Make sure cswap exists and is reasonably current, installing it if missing.
 *
 * Returns a small status the CLI prints verbatim:
 *   { state: "present" | "installed" | "upgrading" | "skipped" | "unavailable", ... }
 */
export async function ensureCswap() {
  if (process.env.AGENTS_DECK_NO_INSTALL === "1") {
    const version = await cswapVersion();
    return version ? { state: "present", version } : { state: "skipped" };
  }

  const existing = await cswapVersion();
  if (existing) {
    // Installed — the only question left is whether it's stale. One PyPI
    // request a day, and the upgrade itself never blocks startup.
    if (!updateCheckDue()) return { state: "present", version: existing };
    touchMarker();
    const latest = await latestOnPypi();
    if (latest && existing !== "installed" && isOlder(existing, latest)) {
      const via = await findInstaller();
      if (via) {
        upgradeInBackground(via);
        return { state: "upgrading", version: existing, latest, via };
      }
    }
    return { state: "present", version: existing };
  }

  const result = await installCswap();
  if (!result.ok) return { state: "unavailable", ...result };

  // Freshly installed tools land in ~/.local/bin, which may not be on the PATH
  // of the shell that launched us — so confirm rather than assume.
  const version = await cswapVersion();
  return version
    ? { state: "installed", via: result.via, version }
    : { state: "unavailable", reason: "not_on_path", via: result.via };
}
