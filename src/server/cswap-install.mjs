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
import { bootstrapUv, existingBootstrappedUv } from "./uv-bootstrap.mjs";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix as posixPath, win32 as winPath } from "node:path";
import { homedir } from "node:os";

const INSTALL_TIMEOUT_MS = 180_000; // uv resolves + builds a Python env

// Same throttle the ccusage installer uses: check once a day, tracked by a
// marker file's mtime so the interval survives restarts.
const UPDATE_CHECK_MS = 24 * 3600_000;
const MARKER = join(homedir(), ".agents-deck", ".cswap-update-check");

/**
 * How to invoke cswap: the bare name when PATH resolves it, otherwise an
 * absolute path to where its installers actually put it.
 *
 * ~/.local/bin is where both `uv tool install` and `pipx install` place
 * executables, on every platform, and it is famously not on PATH — that is the
 * whole reason `pipx ensurepath` exists. Installing claude-swap successfully
 * and then reporting it as missing because the shell cannot see it is a bad
 * enough outcome on its own; it is worse now that the deck may have done the
 * installing. So PATH is a convenience here, not the source of truth.
 *
 * Re-resolved when a lookup fails so an install during this process is picked
 * up without a restart.
 */
/**
 * Every place an installer is known to leave cswap. Pure, and the platform is a
 * parameter, so the Windows list can be checked from a Mac — which is the only
 * way this list stays right, since it exists entirely for machines the author is
 * not sitting at.
 */
export function cswapCandidates(platform = process.platform, env = process.env, home = homedir()) {
  // The path flavour follows the PLATFORM ARGUMENT, not the host: node's `join`
  // would emit forward slashes when this is exercised from a Mac, which is both
  // wrong for the caller and invisible in a test.
  const { join } = platform === "win32" ? winPath : posixPath;
  const exe = platform === "win32" ? "cswap.exe" : "cswap";
  const dirs = [];
  // Explicit configuration first: someone who set these means them.
  if (env.UV_TOOL_BIN_DIR) dirs.push(env.UV_TOOL_BIN_DIR);
  if (env.XDG_BIN_HOME) dirs.push(env.XDG_BIN_HOME);
  // Where `uv tool install` and `pipx install` put executables, everywhere.
  dirs.push(join(home, ".local", "bin"));
  if (platform === "win32") {
    // pipx before 1.5, and any `pip install --user`. APPDATA is respected when
    // set because a roaming profile moves it off the home directory.
    dirs.push(join(env.APPDATA || join(home, "AppData", "Roaming"), "Python", "Scripts"));
    dirs.push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "Python", "Scripts"));
    dirs.push(join(home, "scoop", "shims"));
  } else {
    dirs.push(join(home, ".pyenv", "shims"));
    // uv keeps the tool's own venv here and only symlinks into ~/.local/bin; if
    // that link was never made, this is still a working executable.
    dirs.push(join(home, ".local", "share", "uv", "tools", "claude-swap", "bin"));
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  return dirs.map(d => join(d, exe));
}

let _bin = null;
export async function cswapBin() {
  // An explicit path wins over everything and is never cached away — someone
  // debugging a bad resolution needs it to take effect immediately.
  if (process.env.AGENTS_DECK_CSWAP) return process.env.AGENTS_DECK_CSWAP;
  if (_bin) return _bin;
  if ((await run("cswap", ["--version"], { timeout: 8_000 })).ok) return (_bin = "cswap");

  for (const c of cswapCandidates()) {
    if (existsSync(c) && (await run(c, ["--version"], { timeout: 8_000 })).ok) return (_bin = c);
  }
  return "cswap";   // not found; leave the bare name so errors read sensibly
}

/** Forget the cached resolution — call after installing. */
export function resetCswapBin() { _bin = null; }

/** Installed version string, or null when cswap cannot be found. */
export async function cswapVersion() {
  const r = await run(await cswapBin(), ["--version"]);
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
/**
 * Python interpreters that are safe to execute on this machine.
 *
 * Both desktop platforms ship a fake python that does something other than run
 * python when none is installed, and this code runs unprompted at startup for
 * an optional panel — so neither may be executed on spec.
 *
 * macOS: /usr/bin/python3 is a shim that opens the "install developer tools?"
 * dialog. `xcode-select -p` says whether the real thing is behind it, and is
 * itself only a path lookup.
 *
 * Windows: `python` and `python3` are App Execution Aliases under
 * WindowsApps — zero-length reparse points that open the Microsoft Store. They
 * are on PATH whether or not Python exists, so presence proves nothing and
 * running one opens the Store. `where` reports the paths without executing
 * anything, so the aliases can be filtered out and the real interpreter (if
 * any) called by absolute path. `py`, the Python launcher, only exists when
 * Python was actually installed and is safe as-is.
 *
 * Returns absolute paths or bare command names, best first; empty when there
 * is nothing safe to run.
 */
let _pythons = null;
async function safePythons() {
  if (_pythons != null) return _pythons;

  if (process.platform === "darwin") {
    _pythons = (await run("xcode-select", ["-p"], { timeout: 5_000 })).ok
      ? ["python3", "python"]
      : [];
    return _pythons;
  }

  if (process.platform !== "win32") {
    _pythons = ["python3", "python"];
    return _pythons;
  }

  const found = [];
  // The launcher first: it is never an alias.
  if ((await run("py", ["-0"], { timeout: 8_000 })).ok) found.push("py");
  for (const name of ["python", "python3"]) {
    const r = await run("where", [name], { timeout: 8_000 });
    if (!r.ok) continue;
    for (const line of r.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (!p || /\\WindowsApps\\/i.test(p)) continue;   // Store alias, not an interpreter
      found.push(p);
      break;
    }
  }
  _pythons = found;
  return _pythons;
}

/**
 * Ways to install a Python application, best first.
 *
 * `python -m pipx` matters more than it looks: pipx is very often present as a
 * module without a `pipx` on PATH — every Debian/Ubuntu `apt install pipx`, and
 * any `pip install --user pipx` where ~/.local/bin was never added to PATH. The
 * two-entry version of this list reported "needs uv or pipx" to people who had
 * pipx installed, which is the kind of wrong answer that stops someone looking.
 *
 * Every entry carries its UPGRADE command line as well as its install one. The
 * upgrade used to be re-derived from the `via` label instead, and any label that
 * derivation did not recognise fell through to `-m pipx upgrade` — so the
 * bundled uv, which is the only installer present on a machine that had neither
 * uv nor pipx nor a usable python, was asked to run a pipx command it rejects.
 */
async function installers() {
  const out = [
    { cmd: "uv",   probe: ["--version"], args: ["tool", "install", "claude-swap"], upgrade: ["tool", "upgrade", "claude-swap"], via: "uv" },
    { cmd: "pipx", probe: ["--version"], args: ["install", "claude-swap"],         upgrade: ["upgrade", "claude-swap"],         via: "pipx" },
  ];
  // A uv fetched on an earlier run counts as installed tooling from here on.
  const own = existingBootstrappedUv();
  if (own) {
    out.push({
      cmd: own,
      probe: ["--version"],
      args: ["tool", "install", "claude-swap"],
      upgrade: ["tool", "upgrade", "claude-swap"],
      via: "uv (bundled)",
    });
  }
  for (const py of await safePythons()) {
    out.push({
      cmd: py,
      probe: ["-m", "pipx", "--version"],
      args: ["-m", "pipx", "install", "claude-swap"],
      upgrade: ["-m", "pipx", "upgrade", "claude-swap"],
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

  // Nothing on the machine can install a Python application. Rather than hand
  // the user a command and stop, fetch uv itself — verified, and into the
  // deck's own directory, see uv-bootstrap.mjs — and use that.
  const boot = await bootstrapUv();
  if (!boot.ok) return { ok: false, reason: "no_installer", bootstrap: boot.reason, hint: await installHint() };

  const r = await run(boot.bin, ["tool", "install", "claude-swap"], { timeout: INSTALL_TIMEOUT_MS });
  if (r.ok) return { ok: true, via: `uv ${boot.version} (fetched)` };
  return { ok: false, reason: "install_failed", via: "uv (fetched)", detail: (r.stderr || r.stdout).trim().slice(0, 300) };
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
  for (const py of await safePythons()) {
    if ((await run(py, ["-c", "import sys"], { timeout: 5_000 })).ok) {
      // Quoted: a resolved Windows path routinely contains spaces.
      const q = /\s/.test(py) ? `"${py}"` : py;
      return `${q} -m pip install --user pipx && ${q} -m pipx install claude-swap`;
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
 *
 * The command line comes from the installer entry rather than from its label:
 * runDetached captures nothing, so an upgrade aimed at the wrong tool fails
 * where nobody can see it while the caller still reports "upgrading".
 */
function upgradeInBackground({ cmd, upgrade }) {
  runDetached(cmd, upgrade);
}

/** Whichever Python tool installer is available, or null. */
async function findInstaller() {
  for (const { cmd, probe, upgrade, via } of await installers()) {
    if ((await run(cmd, probe, { timeout: 8_000 })).ok) return { cmd, upgrade, via };
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
  resetCswapBin();   // it exists now; the earlier "not on PATH" answer is stale

  // Freshly installed tools land in ~/.local/bin, which may not be on the PATH
  // of the shell that launched us — cswapBin looks there directly, so this
  // confirms the install rather than confirming the user's PATH.
  const version = await cswapVersion();
  return version
    ? { state: "installed", via: result.via, version }
    : { state: "unavailable", reason: "not_on_path", via: result.via };
}
