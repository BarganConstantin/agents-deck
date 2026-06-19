// Fetches Codex/ChatGPT quota percentages from chatgpt.com/backend-api/wham/usage.
// Auth: reads access_token from ~/.codex/auth.json (written by the Codex CLI login).
// Returns the same shape as Claude quota so the UI can use identical QuotaBar components.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const AUTH_PATH   = join(CODEX_HOME, "auth.json");
const WHAM_URL    = "https://chatgpt.com/backend-api/wham/usage";

let _cache    = null;
let _cacheAt  = 0;
const CACHE_MS = 60_000;

async function readAccessToken() {
  try {
    const raw  = await readFile(AUTH_PATH, "utf8");
    const auth = JSON.parse(raw);
    return auth?.tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

// Format a unix timestamp into "Jun 18, 4:09pm" style (same as claude quota output).
function fmtReset(unixSec) {
  if (!unixSec) return null;
  const d = new Date(unixSec * 1000);
  return d.toLocaleString("en-US", {
    month: "short",
    day:   "numeric",
    hour:  "numeric",
    minute: "2-digit",
    hour12: true,
  }).replace(",", "").toLowerCase().replace(/\s+am/, "am").replace(/\s+pm/, "pm");
}

export async function fetchCodexQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const token = await readAccessToken();
  if (!token) {
    const r = { ok: false, reason: "no_token", fetchedAt: now };
    _cache = r; _cacheAt = now;
    return r;
  }

  let result;
  try {
    const res = await fetch(WHAM_URL, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
        "User-Agent":    "Mozilla/5.0 (compatible; agents-deck)",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      const r = { ok: false, reason: `http_${res.status}`, fetchedAt: now };
      _cache = r; _cacheAt = now;
      return r;
    }

    const data = await res.json();
    const rl   = data?.rate_limit;
    const pw   = rl?.primary_window;    // 5-hour session window
    const sw   = rl?.secondary_window;  // 7-day weekly window

    const creds = data?.credits;
    result = {
      ok:                  true,
      limitReached:        rl?.limit_reached ?? false,
      session5hPct:        pw?.used_percent        ?? null,
      session5hReset:      pw?.reset_at ? fmtReset(pw.reset_at) : null,
      session5hResetAt:    pw?.reset_at             ?? null,  // unix seconds
      session5hWindowSec:  pw?.limit_window_seconds ?? 18000,
      week7dPct:           sw?.used_percent        ?? null,
      week7dReset:         sw?.reset_at ? fmtReset(sw.reset_at) : null,
      week7dResetAt:       sw?.reset_at             ?? null,  // unix seconds
      week7dWindowSec:     sw?.limit_window_seconds ?? 604800,
      // credits (ChatGPT Plus top-up credits if any)
      creditsBalance:      creds?.has_credits ? creds.balance : null,
      creditsUnlimited:    creds?.unlimited   ?? false,
      planType:            data?.plan_type    ?? null,
      fetchedAt:           now,
    };

    // Additional model-specific limits (e.g. Codex Spark)
    const extra = rl?.additional_rate_limits;
    if (extra && typeof extra === "object") {
      for (const [key, win] of Object.entries(extra)) {
        if (win?.used_percent != null) {
          result[`extra_${key}_pct`]   = win.used_percent;
          if (win.reset_at) result[`extra_${key}_reset`] = fmtReset(win.reset_at);
        }
      }
    }
  } catch (err) {
    console.error("agents-deck codex-quota: fetch failed:", err?.message ?? err);
    result = { ok: false, reason: "fetch_error", fetchedAt: now };
  }

  _cache = result;
  _cacheAt = now;
  return result;
}

export function invalidateCodexQuotaCache() {
  _cache = null;
  _cacheAt = 0;
}
