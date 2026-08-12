// Fetches Codex/ChatGPT quota from the same endpoint the Codex CLI uses.
// Auth (including token refresh) lives in codex-auth.mjs.
//
// The response is deliberately parsed defensively: OpenAI ships new plan
// types, new limit families and new numeric encodings without warning, and a
// menu-bar-style readout is worth more when it degrades to "some lanes" than
// when one unrecognised field blanks the whole panel. So every section is
// optional, unknown values pass through verbatim, and a `partial` flag tells
// the UI when something was dropped instead of silently showing less.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getCodexAuth, forceCodexRefresh } from "./codex-auth.mjs";

const CODEX_HOME  = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const CONFIG_PATH = join(CODEX_HOME, "config.toml");
const DEFAULT_BASE = "https://chatgpt.com/backend-api";

let _cache   = null;
let _cacheAt = 0;
const CACHE_MS = 60_000;

// ── base URL ───────────────────────────────────────────────────────────────
// `chatgpt_base_url` in config.toml can point at a proxy, and the path style
// follows from its shape exactly as in the CLI: a /backend-api base speaks
// /wham/*, anything else speaks /api/codex/*.
async function readBaseUrl() {
  let raw = null;
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    for (const line of text.split("\n")) {
      const m = line.replace(/#.*$/, "").match(/^\s*chatgpt_base_url\s*=\s*(.+?)\s*$/);
      if (m) { raw = m[1].replace(/^["']|["']$/g, "").trim(); break; }
    }
  } catch { /* no config.toml — use the default */ }

  let base = (raw || DEFAULT_BASE).replace(/\/+$/, "");
  if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)/.test(base) && !base.includes("/backend-api")) {
    base += "/backend-api";
  }
  return base;
}

function usagePath(base)        { return base.includes("/backend-api") ? "/wham/usage" : "/api/codex/usage"; }
function resetCreditsPath(base) { return base.includes("/backend-api") ? "/wham/rate-limit-reset-credits" : "/api/codex/rate-limit-reset-credits"; }

// ── lenient field readers ──────────────────────────────────────────────────
// Team and enterprise payloads send numbers as strings ("limit": "1000"), and
// reset timestamps answer to three different spellings depending on which
// sub-object you are in.
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function resetAt(o) {
  return num(o?.resets_at) ?? num(o?.resetsAt) ?? num(o?.reset_at) ?? null;
}

/** "Jun 18, 4:09pm" — matches the Claude quota formatting so both read alike. */
function fmtReset(unixSec) {
  if (!unixSec) return null;
  return new Date(unixSec * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).replace(",", "").toLowerCase().replace(/\s+am/, "am").replace(/\s+pm/, "pm");
}

// ── window classification ──────────────────────────────────────────────────
// Slot position is NOT the lane. Free plans return a weekly window in the
// primary slot, and a 30-day lane can arrive in either slot — labelling by
// slot is how a weekly cap ends up displayed as a 5-hour one. Duration is the
// only trustworthy signal.
const HOUR = 3600;
function laneFor(windowSec) {
  if (windowSec == null || windowSec <= 0) return { key: "unknown", label: "Rate limit", rank: 9 };
  if (windowSec <= 6 * HOUR)       return { key: "session", label: `${Math.round(windowSec / HOUR)}-hour window`, rank: 0 };
  if (windowSec <= 8 * 24 * HOUR)  return { key: "weekly",  label: "7-day window",  rank: 1 };
  return { key: "monthly", label: "30-day window", rank: 2 };
}

/** One rate-limit lane, or null when the window carries no usable reading. */
function toWindow(w, idFallback) {
  const pct = num(w?.used_percent ?? w?.usedPercent);
  if (pct == null) return null;
  const windowSec = num(w?.limit_window_seconds ?? w?.limitWindowSeconds);
  const lane      = laneFor(windowSec);
  const reset     = resetAt(w);
  return {
    id:         idFallback ? `${idFallback}-${lane.key}` : lane.key,
    key:        lane.key,
    label:      lane.label,
    rank:       lane.rank,
    pct,                                   // never clamped — over-quota is real information
    windowSec:  windowSec ?? null,
    resetAt:    reset,
    reset:      fmtReset(reset),
  };
}

/** Both slots of a rate_limit object, ordered by lane rather than by slot. */
function windowsFrom(rl, idPrefix) {
  return [toWindow(rl?.primary_window, idPrefix), toWindow(rl?.secondary_window, idPrefix)]
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

// ── spend control / monthly credit limit ───────────────────────────────────
// Three places can carry it, in this precedence. Whichever answers first wins.
function creditLimitFrom(data) {
  const src = data?.individual_limit
           ?? data?.rate_limit?.individual_limit
           ?? data?.spend_control?.individual_limit;
  const limit = num(src?.limit);
  if (!limit || limit <= 0) return null;

  const remainingPct = num(src?.remaining_percent ?? src?.remainingPercent);
  const used = num(src?.used) ?? (remainingPct != null ? limit * Math.max(0, Math.min(100, 100 - remainingPct)) / 100 : 0);
  const pct  = remainingPct != null ? Math.max(0, Math.min(100, 100 - remainingPct)) : (used / limit) * 100;
  const reset = resetAt(src);

  return {
    limit,
    used,
    usedPct:   pct,
    remaining: num(src?.remaining) ?? Math.max(0, limit - used),
    source:    src?.source ?? null,
    resetAt:   reset,
    reset:     fmtReset(reset),
  };
}

// ── plan labels ────────────────────────────────────────────────────────────
// OpenAI's marketing names, since "pro" alone tells the user nothing about
// which of the two Pro tiers they are on.
const PLAN_LABELS = { pro: "Pro 20x", prolite: "Pro 5x", pro_lite: "Pro 5x", "pro-lite": "Pro 5x" };
function planLabel(plan) {
  if (!plan || typeof plan !== "string") return null;
  const k = plan.toLowerCase().replace(/\s+/g, "_");
  if (PLAN_LABELS[k]) return PLAN_LABELS[k];
  if (k === "k12" || k === "cbp") return k.toUpperCase();
  return k.split(/[_-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

// ── extra limit families (Codex Spark and friends) ────────────────────────
// `additional_rate_limits` is an ARRAY of {limit_name, metered_feature,
// rate_limit}, not a map. Decoded element-wise so one malformed entry costs
// only itself.
function extraLimits(data) {
  const arr = data?.additional_rate_limits;
  if (!Array.isArray(arr)) return { extras: [], damaged: arr != null };

  const extras = [];
  let damaged = false;
  for (const entry of arr) {
    try {
      const slug = String(entry?.metered_feature ?? entry?.limit_name ?? "extra")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const title = entry?.limit_name ?? entry?.metered_feature ?? "Codex extra limit";
      for (const w of windowsFrom(entry?.rate_limit, slug)) {
        extras.push({ ...w, label: `${title} · ${w.label}`, family: slug });
      }
    } catch { damaged = true; }
  }
  return { extras, damaged };
}

// ── fetch ──────────────────────────────────────────────────────────────────
function authHeaders(auth, { accountIdHeader = "ChatGPT-Account-Id", extra = {} } = {}) {
  const h = {
    "Authorization": `Bearer ${auth.accessToken}`,
    "Accept":        "application/json",
    "User-Agent":    "codex-cli",
    ...extra,
  };
  if (auth.accountId) h[accountIdHeader] = auth.accountId;
  if (auth.isFedramp) h["X-OpenAI-Fedramp"] = "true";
  return h;
}

/**
 * Reset credits ("one free rate limit reset" grants). Best-effort and short-
 * timeout: it is a nice-to-have next to the gauges, never a reason to fail
 * the quota read. Read-only — we never redeem.
 */
async function fetchResetCredits(base, auth) {
  try {
    const res = await fetch(base + resetCreditsPath(base), {
      // This endpoint alone wants the uppercase-ID spelling and the beta
      // headers; sending the wham/usage set here returns nothing useful.
      headers: authHeaders(auth, {
        accountIdHeader: "ChatGPT-Account-ID",
        extra: { "OpenAI-Beta": "codex-1", "originator": "Codex Desktop" },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const count = num(body?.available_count);
    if (count == null || count < 0) return null;
    const next = (body?.credits ?? [])
      .filter(c => c?.status === "available" && c?.expires_at)
      .map(c => Date.parse(c.expires_at))
      .filter(t => !isNaN(t))
      .sort((a, b) => a - b)[0] ?? null;
    return { availableCount: count, nextExpiryAt: next };
  } catch { return null; }
}

async function requestUsage(base, auth) {
  return fetch(base + usagePath(base), {
    headers: authHeaders(auth),
    // Quota is per-account state; a cached response is how one account's
    // gauges end up shown for another.
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
}

export async function fetchCodexQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const finish = (r) => { _cache = r; _cacheAt = now; return r; };

  let auth = await getCodexAuth();
  if (!auth.ok) return finish({ ok: false, reason: auth.reason, fetchedAt: now });

  // An API key in auth.json is a platform credential, not a ChatGPT session —
  // sending it here only produces a confusing 401.
  if (auth.apiKeyMode) return finish({ ok: false, reason: "api_key_mode", fetchedAt: now });

  const base = await readBaseUrl();

  let res;
  try {
    res = await requestUsage(base, auth);

    // The JWT's own `exp` is not the last word: OpenAI revokes server-side, so
    // a token that looks valid locally can still come back expired. One forced
    // refresh + retry turns that from "bar goes dark" into a hiccup.
    if (res.status === 401 || res.status === 403) {
      const refreshed = await forceCodexRefresh();
      if (!refreshed.ok) return finish({ ok: false, reason: refreshed.reason, fetchedAt: now });
      auth = await getCodexAuth({ allowRefresh: false });
      if (!auth.ok) return finish({ ok: false, reason: auth.reason, fetchedAt: now });
      res = await requestUsage(base, auth);
    }

    if (!res.ok) {
      const reason = (res.status === 401 || res.status === 403) ? "refresh_rejected" : `http_${res.status}`;
      return finish({ ok: false, reason, fetchedAt: now });
    }
  } catch (err) {
    console.error("agents-deck codex-quota: fetch failed:", err?.message ?? err);
    return finish({ ok: false, reason: "fetch_error", fetchedAt: now });
  }

  let data;
  try { data = await res.json(); }
  catch { return finish({ ok: false, reason: "decode_error", fetchedAt: now }); }

  const rl              = data?.rate_limit;
  const windows         = windowsFrom(rl);
  const { extras, damaged } = extraLimits(data);
  const creditsRaw      = data?.credits;
  const balance         = num(creditsRaw?.balance);

  const result = {
    ok:           true,
    limitReached: rl?.limit_reached ?? false,
    allowed:      rl?.allowed ?? true,

    // Lanes, already ordered session → weekly → monthly and labelled by the
    // window duration the API actually reported.
    windows,
    extraWindows: extras,

    plan:      data?.plan_type ?? auth.planType ?? null,
    planLabel: planLabel(data?.plan_type ?? auth.planType),
    email:     data?.email ?? auth.email ?? null,

    creditsBalance:   balance != null && balance > 0 ? String(creditsRaw.balance) : null,
    creditsUnlimited: creditsRaw?.unlimited === true,
    overageReached:   creditsRaw?.overage_limit_reached === true,
    creditLimit:      creditLimitFrom(data),

    spendControlReached: data?.spend_control?.reached === true,
    reachedType:         data?.rate_limit_reached_type?.type ?? data?.rate_limit_reached_type ?? null,
    promo:               data?.promo?.message ?? null,

    // True when something in the payload did not decode — the UI says "partial"
    // rather than pretending the missing lanes do not exist.
    partial:   damaged || windows.length === 0,
    refreshed: auth.refreshed === true,
    fetchedAt: now,
  };

  result.resetCredits = await fetchResetCredits(base, auth);

  return finish(result);
}

export function invalidateCodexQuotaCache() {
  _cache = null;
  _cacheAt = 0;
}
