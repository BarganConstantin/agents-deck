// Live Anthropic API pricing → dollar cost per agent.
//
// Rates sourced from platform.claude.com/docs/en/about-claude/pricing on
// 2026-06-13. All values are USD per million tokens of the base API
// (no Batch discount, no fast-mode premium, no data-residency multiplier).
//
// Anthropic bills a cache write by the TTL it was written at: 1.25× base
// input for a 5-minute entry, 2× for a 1-hour one. CC writes 1-hour caches
// for the bulk of its prefix, so charging the whole of
// `cache_creation_input_tokens` at the 5-minute rate — which this file used
// to do — under-reported every Claude session by 5-10% and disagreed with
// the ccusage number the deck prints in its own usage-history modal. The
// transcript carries the split; costForUsage documents what happens to
// tokens that reach us without one.

import type { TokenUsage } from "./types";

export interface ModelRates {
  input: number;       // $/Mtok
  output: number;      // $/Mtok
  cacheRead: number;   // $/Mtok — hits & refreshes
  cacheWrite: number;  // $/Mtok — 5-minute writes (1.25× input)
  /** $/Mtok for a 1-hour cache write (2× input). Anthropic is the only
   *  family here that publishes a second cache-write price — OpenAI has one
   *  cache tier and its usage never carries a TTL split — so the Codex rows
   *  leave this unset and costForUsage falls back to `cacheWrite`. */
  cacheWrite1h?: number;
}

// Sonnet 5 launched with introductory pricing that ends 2026-08-31. Computed
// rather than hardcoded so the number is right on both sides of that date —
// a pinned intro rate silently under-reports every session from September on.
//
// Stored as a function, not as a value: the table below is built once per page
// load, and the deck is meant to run in tabs that stay open for days (see
// restart.ts), so a rate resolved at module evaluation would keep quoting the
// intro price long after the cutover — the exact pinning this comment warns
// about. Resolving per call keeps it honest, and lets tests pass an explicit
// clock instead of depending on the day they run.
const SONNET_5_INTRO_ENDS = Date.UTC(2026, 8, 1);  // 2026-09-01
function sonnet5Rates(now: number): ModelRates {
  return now < SONNET_5_INTRO_ENDS
    ? { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 }
    : { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 };
}

// `rates` is either a fixed table entry or a function of the current time, for
// the handful of models whose published price changes on a known date.
const RATES: Array<{ match: RegExp; rates: ModelRates | ((now: number) => ModelRates) }> = [
  // Fable 5 / Mythos 5 — $10 / $50
  { match: /^claude[-_](fable|mythos)[-_]5\b/i,
    rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 } },

  // Opus 5 — $5 / $25. Must precede the Opus 4.x rows: "opus-5" shares no
  // prefix with them, but keeping the generations in order stops the next
  // person from inserting a looser pattern above it.
  { match: /^claude[-_]opus[-_]5\b/i,
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 } },

  // Sonnet 5 — $3 / $15, or $2 / $10 until 2026-08-31 (see above)
  { match: /^claude[-_]sonnet[-_]5\b/i, rates: sonnet5Rates },

  // Opus 4.5 - 4.8 — $5 / $25 (the "new" Opus tier introduced with 4.5)
  { match: /^claude[-_]opus[-_]4[-_.](?:5|6|7|8)\b/i,
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 } },

  // Opus 4 / 4.1 (deprecated, but may still show up in older sessions) — $15 / $75
  { match: /^claude[-_]opus[-_]4(?:[-_.]1)?\b/i,
    rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 } },

  // Sonnet 4.5 / 4.6 — $3 / $15
  { match: /^claude[-_]sonnet[-_]4[-_.](?:5|6)\b/i,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 } },

  // Sonnet 4 (deprecated) — same as 4.5/4.6
  { match: /^claude[-_]sonnet[-_]4\b/i,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 } },

  // Haiku 4.5 — $1 / $5
  { match: /^claude[-_]haiku[-_]4[-_.]5\b/i,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 } },

  // Haiku 3.5 (retired except Bedrock/Vertex) — $0.80 / $4
  { match: /^claude[-_]haiku[-_]3[-_.]5\b/i,
    rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 } },

  // ── OpenAI / Codex family ────────────────────────────────────────────────
  // Rates verified 2026-08-12 against developers.openai.com/api/docs/pricing,
  // models.dev, and the LiteLLM catalog.
  //
  // Cached input is a DISCOUNT, not an addition: OpenAI's input_tokens already
  // includes the cached portion, so costForUsage subtracts it before applying
  // the full input rate. cacheWrite is 0 for every family except gpt-5.6,
  // which is the first to publish a separate cache-write price.
  //
  // Order matters — the first match wins, so each family's variants precede
  // its bare alias.

  // gpt-5.6-cyber — $12.50 / $75  (cached $1.25).   400K context.
  { match: /^gpt[-_]5[-_.]6[-_]cyber/i,
    rates: { input: 12.50, output: 75, cacheRead: 1.25, cacheWrite: 0 } },

  // gpt-5.6-luna — $0.20 / $1.20  (cached $0.02, cache write $0.25)
  { match: /^gpt[-_]5[-_.]6[-_]luna/i,
    rates: { input: 0.20, output: 1.20, cacheRead: 0.02, cacheWrite: 0.25 } },

  // gpt-5.6-terra — $2 / $12  (cached $0.20, cache write $2.50)
  { match: /^gpt[-_]5[-_.]6[-_]terra/i,
    rates: { input: 2, output: 12, cacheRead: 0.20, cacheWrite: 2.50 } },

  // gpt-5.6 / gpt-5.6-sol — $5 / $30  (cached $0.50, cache write $6.25).
  // Bare `gpt-5.6` is an alias for sol, so one row covers both.
  { match: /^gpt[-_]5[-_.]6(?:[-_]sol)?\b/i,
    rates: { input: 5, output: 30, cacheRead: 0.50, cacheWrite: 6.25 } },

  // gpt-5.5-pro — $30 / $180  (no cached rate published)
  { match: /^gpt[-_]5[-_.]5[-_]pro/i,
    rates: { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 } },

  // gpt-5.5 — $5 / $30  (cached $0.50)
  { match: /^gpt[-_]5[-_.]5\b/i,
    rates: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },

  // gpt-5.4-pro — $30 / $180  (cached $3)
  { match: /^gpt[-_]5[-_.]4[-_]pro/i,
    rates: { input: 30, output: 180, cacheRead: 3, cacheWrite: 0 } },

  // gpt-5.4-mini — $0.75 / $4.50  (cached $0.075)  ← before plain 5.4
  { match: /^gpt[-_]5[-_.]4[-_]mini/i,
    rates: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },

  // gpt-5.4-nano — $0.20 / $1.25  (cached $0.02)  ← before plain 5.4
  { match: /^gpt[-_]5[-_.]4[-_]nano/i,
    rates: { input: 0.20, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },

  // gpt-5.4 — $2.50 / $15  (cached $0.25)
  { match: /^gpt[-_]5[-_.]4\b/i,
    rates: { input: 2.50, output: 15, cacheRead: 0.25, cacheWrite: 0 } },

  // gpt-5.3-codex (and -spark) — $1.75 / $14  (cached $0.175).
  // The last codex-tuned model: there is no gpt-5.4/5.5/5.6-codex.
  { match: /^gpt[-_]5[-_.]3[-_]codex/i,
    rates: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },

  // gpt-5.2-pro — $21 / $168  (no cached rate published)
  { match: /^gpt[-_]5[-_.]2[-_]pro/i,
    rates: { input: 21, output: 168, cacheRead: 21, cacheWrite: 0 } },

  // gpt-5.2 — $1.75 / $14  (cached $0.175)
  { match: /^gpt[-_]5[-_.]2\b/i,
    rates: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },

  // codex-mini-latest — retired 2026-02-12. Kept so historical sessions still
  // cost out; new sessions can no longer produce it.
  { match: /^codex[-_]mini/i,
    rates: { input: 1.50, output: 6, cacheRead: 0.375, cacheWrite: 0 } },

  // o1-pro / o1 — $150 / $600 and $15 / $60  (o1 cached $7.50)
  { match: /^o1[-_]pro/i, rates: { input: 150, output: 600, cacheRead: 150, cacheWrite: 0 } },
  { match: /^o1\b/i,      rates: { input: 15, output: 60, cacheRead: 7.50, cacheWrite: 0 } },

  // o3-mini — $1.10 / $4.40  (cached $0.55)  ← before plain o3
  { match: /^o3[-_]mini/i,
    rates: { input: 1.10, output: 4.40, cacheRead: 0.55, cacheWrite: 0 } },

  // o3-pro — $20 / $80  (no cached rate published)
  { match: /^o3[-_]pro/i,
    rates: { input: 20, output: 80, cacheRead: 20, cacheWrite: 0 } },

  // o4-mini — $1.10 / $4.40  (cached $0.275)
  { match: /^o4[-_]mini/i,
    rates: { input: 1.10, output: 4.40, cacheRead: 0.275, cacheWrite: 0 } },

  // o3 — $2.00 / $8  (cached $0.50)
  { match: /^o3\b/i,
    rates: { input: 2.00, output: 8, cacheRead: 0.50, cacheWrite: 0 } },
];

/** Recognise Codex / OpenAI model ids so the UI can tag the model display
 *  without inventing a price. Returns true for gpt-*, codex-*, o-series. */
export function isCodexModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return /^(?:gpt[-_]|codex[-_]|o\d)/i.test(modelId);
}

/** `now` is injectable so a dated rate can be exercised on both sides of its
 *  cutover; callers in the app leave it alone and get the wall clock. */
export function ratesForModel(
  modelId: string | undefined,
  now: number = Date.now(),
): ModelRates | null {
  if (!modelId) return null;
  for (const r of RATES) {
    if (r.match.test(modelId)) return typeof r.rates === "function" ? r.rates(now) : r.rates;
  }
  return null;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// No long-context surcharge here, deliberately. OpenAI's >272K tier re-prices
// a single request at 2x input / 1.5x output once THAT REQUEST's input passes
// the line, but the only usage we ever hold for a Codex agent is the session
// running total (`info.total_token_usage` from the rollout's token_count
// events, which the reducer overwrites onto the session root). Cumulative
// input crosses 272K on almost any multi-turn session while each individual
// request stays far below it, so testing the total against a per-request
// threshold surcharged nearly every Codex session by roughly 2x. The Codex
// CLI also clamps its window to 258,400 (272,000 x 95%) precisely so no single
// request crosses the boundary — see CODEX_CONTEXT_DEFAULTS below — which
// makes the tier effectively unreachable. Restoring it would need per-request
// input (the rollout's `last_token_usage`) accumulated request by request.

/** Cache-creation tokens grouped by the TTL they were billed at, with the
 *  dollars each bucket contributes. Exported so the cost tooltip can print
 *  the same multiplication the total is built from rather than re-deriving
 *  it and drifting. */
export interface CacheWriteBreakdown {
  tokens5m: number;
  tokens1h: number;
  usd5m: number;
  usd1h: number;
}

/** Claude reports `cache_creation_input_tokens` alongside a per-TTL split
 *  (`ephemeral_5m_input_tokens` + `ephemeral_1h_input_tokens`) that sums back
 *  to it exactly. Whatever the split does not account for — a transcript
 *  written before CC emitted one, a hook payload carrying only the flat
 *  field, any Codex agent — is billed at the 5-minute rate, which is what
 *  every token got before the split was plumbed through. So a session with
 *  no split reads exactly as it did, and no token is ever charged twice. */
export function cacheWriteBreakdown(usage: TokenUsage, rates: ModelRates): CacheWriteBreakdown {
  const tokens1h = Math.max(0, usage.cacheCreate1hTokens ?? 0);
  const split5m = Math.max(0, usage.cacheCreate5mTokens ?? 0);
  const unsplit = Math.max(0, usage.cacheCreateTokens - tokens1h - split5m);
  const tokens5m = split5m + unsplit;
  const rate1h = rates.cacheWrite1h ?? rates.cacheWrite;
  return {
    tokens5m,
    tokens1h,
    usd5m: tokens5m * rates.cacheWrite / 1_000_000,
    usd1h: tokens1h * rate1h / 1_000_000,
  };
}

/** The token count the input rate is actually applied to.
 *
 *  OpenAI/Codex: `input_tokens` INCLUDES the cached prefix, so only the
 *  non-cached remainder is billed at the full input rate — the cached part is
 *  charged again, cheaper, on the cache-read line. Claude reports the two
 *  disjoint, so its count stands as-is.
 *
 *  Exported so the cost tooltip prints THIS number beside the input dollars.
 *  It used to print `usage.inputTokens`, which on a cache-heavy Codex session
 *  is close to an order of magnitude larger — the one place a user goes to
 *  check the pricing showed a multiplication that missed its own printed
 *  result, reading exactly like the deck overcharging by 10x. */
export function billedInputTokens(usage: TokenUsage, modelId: string | undefined): number {
  return isCodexModel(modelId)
    ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
    : usage.inputTokens;
}

export function costForUsage(
  usage: TokenUsage,
  modelId: string | undefined,
  now: number = Date.now(),
): CostBreakdown {
  const rates = ratesForModel(modelId, now);
  if (!rates) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  const input      = billedInputTokens(usage, modelId) * rates.input / 1_000_000;
  const output     = usage.outputTokens      * rates.output     / 1_000_000;
  const cacheRead  = usage.cacheReadTokens   * rates.cacheRead  / 1_000_000;
  const cw = cacheWriteBreakdown(usage, rates);
  const cacheWrite = cw.usd5m + cw.usd1h;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

// ─── Context window ──────────────────────────────────────────────────────
// Every current Claude model above Haiku ships a 1M-token window; Haiku and
// the older tiers stay at 200K. The model id sometimes carries a `[1m]`
// suffix (CC's UI banner uses it) — treat that as an explicit override
// regardless of family.
const CONTEXT_WINDOW_DEFAULT = 200_000;
const CONTEXT_WINDOW_BIG = 1_000_000;

const BIG_CONTEXT_PATTERNS: RegExp[] = [
  /\[1m\]/i,                                  // explicit suffix
  /^claude[-_]opus[-_]5\b/i,                  // Opus 5
  /^claude[-_]sonnet[-_]5\b/i,                // Sonnet 5
  /^claude[-_]opus[-_]4[-_.](?:5|6|7|8)\b/i,  // Opus 4.5+
  /^claude[-_]sonnet[-_]4[-_.]6\b/i,          // Sonnet 4.6
  /^claude[-_](fable|mythos)[-_]5\b/i,        // Fable/Mythos 5
];

// Codex context-window defaults, used only until the live
// `model_context_window` from the CLI's session_meta reaches the agent node.
//
// These are the API's real windows. Note the Codex CLI reports something
// smaller — 258,400 for the gpt-5.6 family, being 272,000 x 95% — because it
// deliberately clamps a session below OpenAI's >272K-input pricing boundary
// rather than letting one silently cross it. The live value wins wherever it
// is available; these only cover first paint.
const CODEX_CONTEXT_DEFAULTS: Array<{ match: RegExp; window: number }> = [
  { match: /^gpt[-_]5[-_.]6[-_]cyber/i,           window:   400_000 },
  { match: /^gpt[-_]5[-_.]6/i,                    window: 1_050_000 },
  { match: /^gpt[-_]5[-_.]5/i,                    window: 1_050_000 },
  { match: /^gpt[-_]5[-_.]4[-_](?:mini|nano)/i,   window:   400_000 },
  { match: /^gpt[-_]5[-_.]4/i,                    window: 1_050_000 },
  { match: /^gpt[-_]5[-_.]3[-_]codex[-_]spark/i,  window:   128_000 },
  { match: /^gpt[-_]5[-_.]3[-_]codex/i,           window:   400_000 },
  { match: /^gpt[-_]5[-_.]2/i,                    window:   400_000 },
  { match: /^gpt[-_]5/i,                          window:   400_000 },
  { match: /^codex[-_]mini/i,                     window:   200_000 },
  { match: /^o\d/i,                               window:   200_000 },
];

export function contextWindowForModel(modelId: string | undefined): number {
  if (!modelId) return CONTEXT_WINDOW_DEFAULT;
  for (const p of BIG_CONTEXT_PATTERNS) if (p.test(modelId)) return CONTEXT_WINDOW_BIG;
  for (const e of CODEX_CONTEXT_DEFAULTS) if (e.match.test(modelId)) return e.window;
  return CONTEXT_WINDOW_DEFAULT;
}

/** The window to render for an agent. A live `model_context_window` observed
 *  from the CLI always wins; the static table above only covers first paint
 *  and providers that never report one. */
export function effectiveContextWindow(
  live: number | undefined,
  modelId: string | undefined,
): number {
  if (typeof live === "number" && live > 0) return live;
  return contextWindowForModel(modelId);
}

export function fmtCost(usd: number): string {
  if (usd <= 0) return "—";
  if (usd < 0.005) return "<1¢";
  if (usd < 1) {
    // Rounding can carry the cents past a full dollar ($0.996 → "100¢"), so
    // check the rounded string rather than the raw value and fall through to
    // the dollar branch when it does.
    const cents = (usd * 100).toFixed(usd < 0.1 ? 1 : 0);
    if (Number(cents) < 100) return `${cents}¢`;
  }
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 10_000) return `$${usd.toFixed(0)}`;
  return `$${(usd / 1000).toFixed(1)}k`;
}

/** Burn rate — total cost over elapsed seconds. Auto-picks /min vs /hr
 *  scale so the number reads naturally (always 0.01 - 99 in chosen unit).
 *  Returns null when there's no meaningful rate yet (<10s of activity
 *  or zero cost) so callers can hide the chip. */
export function fmtCostRate(totalUsd: number, elapsedSec: number): string | null {
  if (totalUsd <= 0 || elapsedSec < 10) return null;
  const perSec = totalUsd / elapsedSec;
  const perMin = perSec * 60;
  // Prefer /min when it reads ≥ 1¢; otherwise switch to /hr.
  if (perMin >= 0.01) return `${fmtCost(perMin)}/min`;
  return `${fmtCost(perSec * 3600)}/hr`;
}
