// Fetches Claude rate-limit quota.
//
// Primary source: Anthropic's OAuth usage API
//   GET https://api.anthropic.com/api/oauth/usage
//   Auth: Bearer token from ~/.claude/.credentials.json (claudeAiOauth.accessToken)
// This is instant and exact — same data the `/usage` command shows, but with no
// cold-start gap (the CLI omits the quota lines on its first invocation after
// idle). Mechanism reverse-engineered from steipete/CodexBar.
//
// Fallback: parse `claude --print /usage` CLI output (used only if the API call
// fails — no token, expired token, network error). On Windows the binary is a
// .cmd wrapper, so we use exec() (shell-based) for correct quoting + stdin.
//
// Result is cached for 60s.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

const execAsync = promisify(exec);
const IS_WIN = platform() === "win32";

const CREDS_PATH  = join(homedir(), ".claude", ".credentials.json");
const USAGE_URL   = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const WIN_5H_SEC  = 18000;
const WIN_7D_SEC  = 604800;

// 429 cooldown gate — after a rate-limit, skip the API until this passes.
let _rateLimitedUntil = 0;

async function readOAuthToken() {
  try {
    const raw  = await readFile(CREDS_PATH, "utf8");
    const auth = JSON.parse(raw)?.claudeAiOauth;
    if (!auth?.accessToken) return null;
    // expiresAt is epoch milliseconds. If expired, the CLI fallback handles it.
    if (auth.expiresAt && Date.now() >= auth.expiresAt) return null;
    return auth.accessToken;
  } catch {
    return null;
  }
}

// ISO-8601 → "Jun 19, 1:19pm" (local time, matching the CLI display format).
function fmtResetIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  // "Jun 19, 1:19 PM" → "Jun 19, 1:19pm" (matches the CLI display format)
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).replace(/\s+(AM|PM)/, (_, p) => p.toLowerCase());
}

function isoToSec(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

// Map the OAuth usage JSON to our quota result shape.
// utilization is already a 0–100 percentage. 5h falls back to 7d if absent.
function mapOAuthUsage(data) {
  const fh = data?.five_hour;
  const sd = data?.seven_day;
  const son = data?.seven_day_sonnet;
  const opus = data?.seven_day_opus;

  const primary = (fh?.utilization != null) ? fh : sd;
  if (!primary || primary.utilization == null) return null;

  const round = (v) => Math.min(100, Math.max(0, Math.round(v)));
  const result = {
    session5hPct:       round(primary.utilization),
    session5hWindowSec: WIN_5H_SEC,
    session5hReset:     fmtResetIso(primary.resets_at),
    session5hResetAt:   isoToSec(primary.resets_at),
    week7dWindowSec:    WIN_7D_SEC,
  };
  if (sd?.utilization != null) {
    result.week7dPct     = round(sd.utilization);
    result.week7dReset   = fmtResetIso(sd.resets_at);
    result.week7dResetAt = isoToSec(sd.resets_at);
  } else {
    result.week7dPct = 0;
  }
  if (son?.utilization != null)  result.weekSonnetPct = round(son.utilization);
  if (opus?.utilization != null) result.weekOpusPct   = round(opus.utilization);

  // extra usage credits (pay-as-you-go top-up), if enabled
  const extra = data?.extra_usage;
  if (extra?.is_enabled) {
    result.extraEnabled = true;
    if (extra.used_credits != null)  result.extraUsedCredits  = extra.used_credits;
    if (extra.monthly_limit != null) result.extraMonthlyLimit = extra.monthly_limit;
    if (extra.currency)              result.extraCurrency     = extra.currency;
  }
  return result;
}

async function fetchOAuthUsage() {
  if (Date.now() < _rateLimitedUntil) return null;
  const token = await readOAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": BETA_HEADER,
        "Accept":         "application/json",
        "Content-Type":   "application/json",
        "User-Agent":     "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const cooldownMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 5 * 60_000;
      _rateLimitedUntil = Date.now() + cooldownMs;
      return null;
    }
    if (!res.ok) return null;

    return mapOAuthUsage(await res.json());
  } catch {
    return null;
  }
}

let _cache    = null;
let _cacheAt  = 0;
let _inflight = null;   // deduplicates concurrent exec() calls
let _lastGood = null;   // last result that had real quota percentages
const CACHE_MS = 60_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // If another exec() is already in flight, wait for it instead of spawning a
  // second concurrent process (which can return empty output and overwrite the
  // good result with 0%).
  if (_inflight) return _inflight;

  _inflight = _doFetch(now).finally(() => { _inflight = null; });
  return _inflight;
}

// Run `claude --print /usage` once. Returns { cliOk, parsed }.
//   cliOk  — the CLI ran and we recognized its output (preamble present)
//   parsed — quota percentages object, or null if the "Current session/week"
//            lines were absent (CLI cold-start, or genuinely <1% usage)
async function _execOnce(shellCmd) {
  try {
    const { stdout, stderr } = await execAsync(shellCmd, {
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      maxBuffer: 1024 * 1024,
    });
    const combined = stdout + "\n" + stderr;
    const cliOk = /subscription/i.test(combined) || /claude code usage/i.test(combined);
    return { cliOk, parsed: parseUsageText(combined) };
  } catch (err) {
    const msg = err?.stderr ? stripAnsi(err.stderr).trim() : (err?.message ?? String(err));
    console.error("agents-deck quota: claude CLI failed:", msg);
    if (err?.stdout || err?.stderr) {
      const combined = (err.stdout ?? "") + "\n" + (err.stderr ?? "");
      return { cliOk: /subscription/i.test(combined), parsed: parseUsageText(combined) };
    }
    return { cliOk: false, parsed: null };
  }
}

async function _doFetch(now) {
  // Primary: OAuth usage API — instant, exact, no cold-start gap.
  const api = await fetchOAuthUsage();
  if (api) {
    const result = { ok: true, ...api, source: "api", fetchedAt: now };
    _cache = result; _cacheAt = now;
    _lastGood = result;
    return result;
  }

  // Fallback: parse `claude --print /usage` CLI output.
  const shellCmd = buildQuotaShellCmd();

  // The CLI sometimes omits the "Current session/week" quota lines on a cold
  // invocation (right after the server starts, or after the page is hard-
  // refreshed). The real lines appear on a subsequent call. Retry a couple
  // times before giving up so the first paint already shows real values.
  let cliOk = false;
  let parsed = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200);
    const r = await _execOnce(shellCmd);
    cliOk = r.cliOk || cliOk;
    if (r.parsed) { parsed = r.parsed; break; }
  }

  // Got real quota lines — cache normally and remember as last-known-good.
  if (parsed) {
    const result = { ok: true, ...parsed, fetchedAt: now };
    _cache = result; _cacheAt = now;
    _lastGood = result;
    return result;
  }

  // No quota lines after retries. If we've ever seen real values, keep showing
  // them rather than regressing to 0% on a transient empty read. Short-cache so
  // we retry the CLI again soon.
  if (_lastGood) {
    const result = { ..._lastGood, fetchedAt: now, stale: true };
    _cache = result;
    _cacheAt = now - (CACHE_MS - 5_000);
    return result;
  }

  // Never had good data. CLI ran but lines absent → treat as genuine <1%.
  // CLI failed entirely → ok:false. Either way short-cache for a quick retry.
  const result = cliOk
    ? { ok: true, session5hPct: 0, session5hWindowSec: 18000,
        week7dPct: 0, week7dWindowSec: 604800, fetchedAt: now }
    : { ok: false, fetchedAt: now };
  _cache = result;
  _cacheAt = now - (CACHE_MS - 5_000);
  return result;
}

export function invalidateQuotaCache() {
  _cache = null;
  _cacheAt = 0;
}
