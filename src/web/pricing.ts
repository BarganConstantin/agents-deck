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
];

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
  const input      = (usage.inputTokens       * rates.input)      / 1_000_000;
  const output     = (usage.outputTokens      * rates.output)     / 1_000_000;
  const cacheRead  = (usage.cacheReadTokens   * rates.cacheRead)  / 1_000_000;
  const cacheWrite = (usage.cacheCreateTokens * rates.cacheWrite) / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
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
