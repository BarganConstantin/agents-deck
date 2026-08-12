// Ensures `cswap` (claude-swap) is available, because the accounts panel is
// built entirely on the store it maintains.
//
// Unlike the ccusage install, this one lands in the user's GLOBAL tool path
// rather than a private prefix under ~/.agents-deck, and claude-swap handles
// Claude credentials. That makes it something the user should see happen: the
// caller prints what this returns, and AGENTS_DECK_NO_INSTALL=1 turns it off
// entirely. It is always best-effort — the deck's core function does not
// depend on it, so a failure is reported and then ignored.
import { run, runDetached } from "./exec.mjs";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const INSTALL_TIMEOUT_MS = 180_000; // uv resolves + builds a Python env

// Same throttle the ccusage installer uses: check once a day, tracked by a
// marker file's mtime so the interval survives restarts.
const UPDATE_CHECK_MS = 24 * 3600_000;
const MARKER = join(homedir(), ".agents-deck", ".cswap-update-check");

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
const PY = process.platform === "win32" ? ["py", "python"] : ["python3", "python"];

/**
 * Whether it is safe to execute a python interpreter here.
 *
 * On macOS, /usr/bin/python3 is a shim: with the Command Line Tools absent it
 * does not run python, it pops the "install developer tools?" dialog. Probing
 * for python in the background would throw that dialog at someone who only
 * wanted a dashboard, so on darwin nothing python-shaped is executed until
 * xcode-select confirms the tools are actually there. That check is a plain
 * path lookup and triggers nothing itself.
 */
let _pyOk = null;
async function pythonProbeSafe() {
  if (_pyOk != null) return _pyOk;
  _pyOk = process.platform !== "darwin"
    ? true
    : (await run("xcode-select", ["-p"], { timeout: 5_000 })).ok;
  return _pyOk;
}

/**
 * Ways to install a Python application, best first.
 *
 * `python -m pipx` matters more than it looks: pipx is very often present as a
 * module without a `pipx` on PATH — every Debian/Ubuntu `apt install pipx`, and
 * any `pip install --user pipx` where ~/.local/bin was never added to PATH. The
 * two-entry version of this list reported "needs uv or pipx" to people who had
 * pipx installed, which is the kind of wrong answer that stops someone looking.
 */
async function installers() {
  const out = [
    { cmd: "uv",   probe: ["--version"], args: ["tool", "install", "claude-swap"], via: "uv" },
    { cmd: "pipx", probe: ["--version"], args: ["install", "claude-swap"],         via: "pipx" },
  ];
  if (!(await pythonProbeSafe())) return out;
  for (const py of PY) {
    out.push({
      cmd: py,
      probe: ["-m", "pipx", "--version"],
      args: ["-m", "pipx", "install", "claude-swap"],
      via: `${py} -m pipx`,
    });
  }
  return out;
}

async function installCswap() {
  for (const { cmd, probe, args, via } of await installers()) {
    if (!(await run(cmd, probe, { timeout: 8_000 })).ok) continue;
    const r = await run(cmd, args, { timeout: INSTALL_TIMEOUT_MS });
    if (r.ok) return { ok: true, via };
    return { ok: false, reason: "install_failed", via, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
  }
  return { ok: false, reason: "no_installer", hint: await installHint() };
}

/**
 * What to actually type, for this machine.
 *
 * "needs uv or pipx" is a dead end for the person who has neither and no
 * opinion about Python packaging — which is most people running a Node CLI.
 * uv is a single self-contained binary and is what claude-swap documents, so
 * that is what gets recommended; if the machine already has Python, pipx via
 * pip is offered instead because it uses something already installed.
 */
export async function installHint() {
  const uv = process.platform === "win32"
    ? 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"  (then: uv tool install claude-swap)'
    : "curl -LsSf https://astral.sh/uv/install.sh | sh  (then: uv tool install claude-swap)";
  if (!(await pythonProbeSafe())) return uv;
  for (const py of PY) {
    if ((await run(py, ["-c", "import sys"], { timeout: 5_000 })).ok) {
      return `${py} -m pip install --user pipx && ${py} -m pipx install claude-swap`;
    }
  }
  return uv;
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
function upgradeInBackground(found) {
  const { cmd, via } = found;
  const args = via === "uv"
    ? ["tool", "upgrade", "claude-swap"]
    : via === "pipx"
      ? ["upgrade", "claude-swap"]
      : ["-m", "pipx", "upgrade", "claude-swap"];   // python -m pipx
  runDetached(cmd, args);
}

/** Whichever Python tool installer is available, or null. */
async function findInstaller() {
  for (const { cmd, probe, via } of await installers()) {
    if ((await run(cmd, probe, { timeout: 8_000 })).ok) return { cmd, via };
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
      const found = await findInstaller();
      if (found) {
        upgradeInBackground(found);
        return { state: "upgrading", version: existing, latest, via: found.via };
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
