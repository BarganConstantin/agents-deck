// Ensures `cswap` (claude-swap) is available, because the accounts panel is
// built entirely on the store it maintains.
//
// Unlike the ccusage install, this one lands in the user's GLOBAL tool path
// rather than a private prefix under ~/.agents-deck, and claude-swap handles
// Claude credentials. That makes it something the user should see happen: the
// caller prints what this returns, and AGENTS_DECK_NO_INSTALL=1 turns it off
// entirely. It is always best-effort — the deck's core function does not
// depend on it, so a failure is reported and then ignored.
import { execFile } from "node:child_process";

const INSTALL_TIMEOUT_MS = 180_000; // uv resolves + builds a Python env

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

/**
 * Make sure cswap exists, installing it if it does not.
 *
 * Returns a small status the CLI prints verbatim:
 *   { state: "present" | "installed" | "skipped" | "unavailable", ... }
 */
export async function ensureCswap() {
  if (process.env.AGENTS_DECK_NO_INSTALL === "1") {
    const version = await cswapVersion();
    return version ? { state: "present", version } : { state: "skipped" };
  }

  const existing = await cswapVersion();
  if (existing) return { state: "present", version: existing };

  const result = await installCswap();
  if (!result.ok) return { state: "unavailable", ...result };

  // Freshly installed tools land in ~/.local/bin, which may not be on the PATH
  // of the shell that launched us — so confirm rather than assume.
  const version = await cswapVersion();
  return version
    ? { state: "installed", via: result.via, version }
    : { state: "unavailable", reason: "not_on_path", via: result.via };
}
