// Fetches Claude rate-limit quota by running `claude --print /usage`.
// On Windows the binary is a .cmd wrapper — we use exec() (shell-based)
// so that cmd.exe handles quoting and stdin redirect correctly.
// Caches the result for 2 minutes.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const execAsync = promisify(exec);
const IS_WIN = platform() === "win32";

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 60_000;

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
// Parse "Jun 18, 4:09pm" (local time, no tz) into unix seconds.
// Claude shows times in the user's local timezone, so parsing as local is correct.
function parseResetToSec(resetStr) {
  if (!resetStr) return null;
  try {
    const year = new Date().getFullYear();
    // "4:09pm" → "4:09 PM" so Date.parse handles it
    const norm = resetStr
      .replace(/(\d{1,2}:\d{2})(am|pm)/i, "$1 $2")
      .trim();
    const d = new Date(`${norm} ${year}`);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  } catch { return null; }
}

function parseUsageText(raw) {
  const text = stripAnsi(raw);
  const result = {};

  // Helper: find "X% used · resets <rest>" on a line matching a label.
  const extract = (labelRe) => {
    const line = text.split("\n").find(l => labelRe.test(l));
    if (!line) return null;
    const pctM = line.match(/(\d{1,3})\s*%/);
    const resetM = line.match(/resets\s+(.+)/i);
    const resetFull = resetM
      ? resetM[1].replace(/\(.*?\)/g, "").replace(/·/g, "").trim()
      : null;
    return {
      pct:     pctM ? Math.min(100, parseInt(pctM[1], 10)) : null,
      reset:   resetFull,
      resetAt: parseResetToSec(resetFull),
    };
  };

  const session = extract(/current session/i);
  if (session?.pct != null) {
    result.session5hPct       = session.pct;
    result.session5hWindowSec = 18000;
    if (session.reset)   result.session5hReset   = session.reset;
    if (session.resetAt) result.session5hResetAt  = session.resetAt;
  }

  const weekAll = extract(/current week\s*\(all models\)/i) || extract(/current week\s*[:·]/i);
  if (weekAll?.pct != null) {
    result.week7dPct       = weekAll.pct;
    result.week7dWindowSec = 604800;
    if (weekAll.reset)   result.week7dReset   = weekAll.reset;
    if (weekAll.resetAt) result.week7dResetAt  = weekAll.resetAt;
  }

  const weekSon = extract(/current week\s*\(sonnet/i);
  if (weekSon?.pct != null) result.weekSonnetPct = weekSon.pct;

  const weekOpus = extract(/current week\s*\(opus/i);
  if (weekOpus?.pct != null) result.weekOpusPct = weekOpus.pct;

  return Object.keys(result).length > 0 ? result : null;
}

/** Build the shell command string for `claude --print /usage`.
 *
 *  We use exec() (shell-based) so cmd.exe / sh processes redirects.
 *  On Windows: `< nul` closes stdin immediately, preventing the 3-second
 *  "no stdin data" wait the claude CLI does when it detects a pipe.
 *  On Unix: `< /dev/null` has the same effect.
 */
function buildQuotaShellCmd() {
  if (IS_WIN) {
    const npmBin = join(homedir(), "AppData", "Roaming", "npm", "claude.cmd");
    const bin = existsSync(npmBin) ? npmBin : "claude.cmd";
    // exec() on Windows uses cmd /c, so < nul redirect works fine.
    // Wrap path in quotes in case of spaces in username.
    return `"${bin}" --print /usage < nul`;
  }
  const candidates = [
    "claude",
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const c of candidates) {
    if (!c.includes("/") || existsSync(c)) return `${c} --print /usage < /dev/null`;
  }
  return "claude --print /usage < /dev/null";
}

export async function fetchClaudeQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const shellCmd = buildQuotaShellCmd();
  let parsed = null;

  try {
    const { stdout, stderr } = await execAsync(shellCmd, {
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      maxBuffer: 1024 * 1024, // 1 MB
    });
    parsed = parseUsageText(stdout + "\n" + stderr);
  } catch (err) {
    // Binary not found or timed out — degrade gracefully.
    const msg = err?.stderr ? stripAnsi(err.stderr).trim() : (err?.message ?? String(err));
    console.error("agents-deck quota: claude CLI failed:", msg);
    // exec() may still have stdout on non-zero exit — try to parse it
    if (err?.stdout || err?.stderr) {
      parsed = parseUsageText((err.stdout ?? "") + "\n" + (err.stderr ?? ""));
    }
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
