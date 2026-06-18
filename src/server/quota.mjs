// Fetches Claude rate-limit quota by running `claude --print /usage`.
// On Windows the binary is a .cmd wrapper — we run it via cmd.exe.
// Caches the result for 2 minutes.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const execFileAsync = promisify(execFile);
const IS_WIN = platform() === "win32";

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 120_000;

function stripAnsi(s) {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][AB012]/g, "");
}

/**
 * Parse `claude --print /usage` output.
 *
 * Observed format (Claude Code ≥ 1.x):
 *   "Current session: 84% used · resets Jun 18, 4:09pm (Europe/Chisinau)"
 *   "Current week (all models): 85% used · resets Jun 21, 8:59am (Europe/Chisinau)"
 *   "Current week (Sonnet only): 48% used · resets Jun 21, 9am (Europe/Chisinau)"
 *   "Current week (Opus only): ..."   (if present)
 */
function parseUsageText(raw) {
  const text = stripAnsi(raw);
  const result = {};

  // Helper: find "X% used · resets <rest>" on a line matching a label.
  const extract = (labelRe) => {
    const line = text.split("\n").find(l => labelRe.test(l));
    if (!line) return null;
    const pctM = line.match(/(\d{1,3})\s*%/);
    const resetM = line.match(/resets\s+(.+)/i);
    return {
      pct: pctM ? Math.min(100, parseInt(pctM[1], 10)) : null,
      reset: resetM
        ? resetM[1]
            .replace(/\(.*?\)/g, "")  // strip timezone in parens
            .replace(/·/g, "")
            .trim()
        : null,
    };
  };

  const session = extract(/current session/i);
  if (session?.pct != null) {
    result.session5hPct = session.pct;
    if (session.reset) result.session5hReset = session.reset;
  }

  const weekAll = extract(/current week\s*\(all models\)/i) || extract(/current week\s*[:·]/i);
  if (weekAll?.pct != null) {
    result.week7dPct = weekAll.pct;
    if (weekAll.reset) result.week7dReset = weekAll.reset;
  }

  const weekSon = extract(/current week\s*\(sonnet/i);
  if (weekSon?.pct != null) result.weekSonnetPct = weekSon.pct;

  const weekOpus = extract(/current week\s*\(opus/i);
  if (weekOpus?.pct != null) result.weekOpusPct = weekOpus.pct;

  return Object.keys(result).length > 0 ? result : null;
}

/** Resolve the claude binary.
 *  On Windows, claude is a .cmd wrapper — return the full path so we can
 *  invoke it via cmd.exe. On Unix, look for the binary in common locations. */
function findClaudeBin() {
  if (IS_WIN) {
    const npmBin = join(homedir(), "AppData", "Roaming", "npm", "claude.cmd");
    if (existsSync(npmBin)) return { cmd: "cmd.exe", args: ["/c", npmBin] };
    // Fallback: let cmd.exe find it via PATH.
    return { cmd: "cmd.exe", args: ["/c", "claude.cmd"] };
  }
  // Unix: check PATH, then known install locations.
  const candidates = [
    "claude",
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const c of candidates) {
    if (!c.includes("/")) return { cmd: c, args: [] };
    if (existsSync(c)) return { cmd: c, args: [] };
  }
  return { cmd: "claude", args: [] };
}

export async function fetchClaudeQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const { cmd, args } = findClaudeBin();
  let parsed = null;

  try {
    const { stdout, stderr } = await execFileAsync(
      cmd,
      [...args, "--print", "/usage"],
      {
        timeout: 12_000,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      }
    );
    parsed = parseUsageText(stdout + "\n" + stderr);
  } catch (err) {
    // Binary not found or timed out — degrade gracefully.
    console.error("agents-deck quota: claude CLI failed:", err?.message ?? err);
  }

  const result = parsed
    ? { ok: true, ...parsed, fetchedAt: now }
    : { ok: false, fetchedAt: now };

  _cache = result;
  _cacheAt = now;
  return result;
}

export function invalidateQuotaCache() {
  _cache = null;
  _cacheAt = 0;
}
