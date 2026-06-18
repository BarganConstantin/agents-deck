// Live Anthropic API pricing → dollar cost per agent.
//
// Rates sourced from platform.claude.com/docs/en/about-claude/pricing on
// 2026-06-13. All values are USD per million tokens of the base API
// (no Batch discount, no fast-mode premium, no data-residency multiplier).
//
// Cache-write rate is the 5-minute variant (1.25× base input). CC's hook
// payloads expose `cache_creation_input_tokens` without distinguishing
// 5-minute vs 1-hour caches, so we pick the common case. If the 1-hour
// variant matters to anyone, that's an easy follow-up — sum two fields
// or store separately.

import type { TokenUsage } from "./types";

export interface ModelRates {
  input: number;       // $/Mtok
  output: number;      // $/Mtok
  cacheRead: number;   // $/Mtok — hits & refreshes
  cacheWrite: number;  // $/Mtok — 5-minute writes
}

const RATES: Array<{ match: RegExp; rates: ModelRates }> = [
  // Fable 5 / Mythos 5 — $10 / $50
  { match: /^claude[-_](fable|mythos)[-_]5\b/i,
    rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },

  // Opus 4.5 - 4.8 — $5 / $25 (the "new" Opus tier introduced with 4.5)
  { match: /^claude[-_]opus[-_]4[-_.](?:5|6|7|8)\b/i,
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },

  // Opus 4 / 4.1 (deprecated, but may still show up in older sessions) — $15 / $75
  { match: /^claude[-_]opus[-_]4(?:[-_.]1)?\b/i,
    rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },

  // Sonnet 4.5 / 4.6 — $3 / $15
  { match: /^claude[-_]sonnet[-_]4[-_.](?:5|6)\b/i,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },

  // Sonnet 4 (deprecated) — same as 4.5/4.6
  { match: /^claude[-_]sonnet[-_]4\b/i,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },

  // Haiku 4.5 — $1 / $5
  { match: /^claude[-_]haiku[-_]4[-_.]5\b/i,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },

  // Haiku 3.5 (retired except Bedrock/Vertex) — $0.80 / $4
  { match: /^claude[-_]haiku[-_]3[-_.]5\b/i,
    rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },

  // ── OpenAI / Codex family ────────────────────────────────────────────────
  // Rates sourced 2026-06-17 from platform.openai.com/docs/pricing.
  // OpenAI billing is READ-DISCOUNT-ONLY: cached input tokens are billed at
  // a reduced cached-input rate; there is NO cache-write charge (unlike
  // Anthropic). cacheWrite is therefore 0 for every row below.
  // See costForUsage() for the Codex-specific cost formula — input_tokens
  // from OpenAI INCLUDES cached tokens, so we must not double-bill them.

  // gpt-5.3-codex — $1.75 / $14  (cached $0.175)
  { match: /^gpt[-_]5[-_.]3[-_.]codex/i,
    rates: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },

  // codex-mini-latest — $1.50 / $6  (cached $0.375)
  { match: /^codex[-_]mini/i,
    rates: { input: 1.50, output: 6, cacheRead: 0.375, cacheWrite: 0 } },

  // gpt-5.5 — $5 / $30  (cached $0.50)
  { match: /^gpt[-_]5[-_.]5\b/i,
    rates: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },

  // gpt-5.4-mini — $0.75 / $4.50  (cached $0.075)  ← must come before plain 5.4
  { match: /^gpt[-_]5[-_.]4[-_.]mini/i,
    rates: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },

  // gpt-5.4-nano — $0.20 / $1.25  (cached $0.02)  ← must come before plain 5.4
  { match: /^gpt[-_]5[-_.]4[-_.]nano/i,
    rates: { input: 0.20, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },

  // gpt-5.4 — $2.50 / $15  (cached $0.25)
  { match: /^gpt[-_]5[-_.]4\b/i,
    rates: { input: 2.50, output: 15, cacheRead: 0.25, cacheWrite: 0 } },

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

export function ratesForModel(modelId: string | undefined): ModelRates | null {
  if (!modelId) return null;
  for (const r of RATES) {
    if (r.match.test(modelId)) return r.rates;
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

export function costForUsage(usage: TokenUsage, modelId: string | undefined): CostBreakdown {
  const rates = ratesForModel(modelId);
  if (!rates) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  // OpenAI/Codex: input_tokens INCLUDES cached tokens, so bill only the
  // non-cached portion at the full input rate to avoid double-charging.
  // Claude: inputTokens EXCLUDES cache tokens — use it as-is.
  const isCodex = isCodexModel(modelId);
  const fullInputTokens = isCodex
    ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
    : usage.inputTokens;
  const input      = fullInputTokens              * rates.input      / 1_000_000;
  const output     = usage.outputTokens           * rates.output     / 1_000_000;
  const cacheRead  = usage.cacheReadTokens        * rates.cacheRead  / 1_000_000;
  const cacheWrite = usage.cacheCreateTokens      * rates.cacheWrite / 1_000_000;  // 0 for Codex
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

// ─── Context window ──────────────────────────────────────────────────────
// Source: LiteLLM model_prices_and_context_window.json. Opus 4.7 and
// Sonnet 4.6 ship with 1M-token windows; older tiers and Haiku stay at
// 200K. The model id sometimes has a `[1m]` suffix (CC's UI banner uses
// it) — treat that as an explicit override regardless of family.
const CONTEXT_WINDOW_DEFAULT = 200_000;
const CONTEXT_WINDOW_BIG = 1_000_000;

const BIG_CONTEXT_PATTERNS: RegExp[] = [
  /\[1m\]/i,                                  // explicit suffix
  /^claude[-_]opus[-_]4[-_.](?:5|6|7|8)\b/i,  // Opus 4.5+
  /^claude[-_]sonnet[-_]4[-_.]6\b/i,          // Sonnet 4.6
  /^claude[-_](fable|mythos)[-_]5\b/i,        // Fable/Mythos 5
];

// Codex context-window defaults when the live `model_context_window` value
// from session_meta isn't on the agent node yet. The CLI emits the real
// number on task_started — these are only a first-paint guess.
const CODEX_CONTEXT_DEFAULTS: Array<{ match: RegExp; window: number }> = [
  { match: /^gpt[-_]5[-_.]3[-_.]codex/i, window: 256_000 },
  { match: /^gpt[-_]5[-_.]2[-_.]codex/i, window: 256_000 },
  { match: /^gpt[-_]5[-_.]\d+[-_.]codex/i, window: 256_000 },
  { match: /^gpt[-_]5/i,                  window: 200_000 },
  { match: /^o\d/i,                       window: 200_000 },
];

export function contextWindowForModel(modelId: string | undefined): number {
  if (!modelId) return CONTEXT_WINDOW_DEFAULT;
  for (const p of BIG_CONTEXT_PATTERNS) if (p.test(modelId)) return CONTEXT_WINDOW_BIG;
  for (const e of CODEX_CONTEXT_DEFAULTS) if (e.match.test(modelId)) return e.window;
  return CONTEXT_WINDOW_DEFAULT;
}

export function fmtCost(usd: number): string {
  if (usd <= 0) return "—";
  if (usd < 0.005) return "<1¢";
  if (usd < 1) return `${(usd * 100).toFixed(usd < 0.1 ? 1 : 0)}¢`;
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
