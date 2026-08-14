// The cost chip's tooltip exists for exactly one purpose: to let a user check
// the price by hand. For Codex agents its input row printed `usage.inputTokens`
// next to dollars that costForUsage had computed from `inputTokens -
// cacheReadTokens` — OpenAI folds the cached prefix into input_tokens and only
// the remainder is billed at the input rate. On a multi-turn session the cached
// share is most of the input, so the row read "1,000,000 × $5/MTok = 50¢": the
// operands miss their own printed result by nearly 10x, and anyone auditing the
// number concludes the deck is overcharging by 10x when the total is right.
// These pin the invariant the whole tooltip rests on — every row multiplies out
// to the figure beside it, and the rows sum to the total — with the billed
// token count living in pricing.ts so the tooltip and the total can never
// disagree about it again.
//
// Nothing imported here touches the filesystem: pricing.ts is arithmetic, and
// AgentNode's import graph is react / reactflow / reducer, all browser-only.
import { describe, it, expect } from "vitest";
import { billedInputTokens, costForUsage, fmtCost, ratesForModel } from "../pricing";
import { costBreakdownTooltip } from "../components/AgentNode";
import type { TokenUsage } from "../types";

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...u,
});

interface Row { label: string; tokens: number; rate: number; usd: string }

/** Pull the multiplication rows back out of the rendered tooltip. A count goes
 *  through toLocaleString, whose group separator follows the runtime locale
 *  (`1,000,000` here, `1.000.000` on a de-DE box), so its digits are recovered
 *  by dropping every non-digit rather than by assuming a comma — and only from
 *  the count, since the `cache w5m` label carries a digit of its own. */
function rowsOf(tooltip: string): Row[] {
  return tooltip.split("\n").filter(l => l.includes("×")).map(line => {
    const [lhs, rhs] = line.split("×");
    const [rateText, usd] = rhs.split("=");
    const label = lhs.replace(/[\s\d.,'\u00a0\u202f]+$/, "");
    return {
      label: label.trim(),
      tokens: Number(lhs.slice(label.length).replace(/\D/g, "")),
      rate: Number(rateText.trim().replace("$", "").replace("/MTok", "")),
      usd: usd.trim(),
    };
  });
}

function totalOf(tooltip: string): string {
  const line = tooltip.split("\n").find(l => l.startsWith("total"))!;
  return line.split("=")[1].trim();
}

describe("the input row prints the token count its own dollar column was billed on", () => {
  it("subtracts the cached prefix Codex folds into input_tokens", () => {
    const u = usage({ inputTokens: 1_000_000, cacheReadTokens: 900_000 });
    expect(billedInputTokens(u, "gpt-5.6")).toBe(100_000);
    // 100,000 × $5/Mtok = $0.50, which is what the chip already showed.
    expect(costForUsage(u, "gpt-5.6").input).toBeCloseTo(0.5, 10);
  });

  it("leaves a Claude agent's count alone, where cache tokens are reported apart", () => {
    const u = usage({ inputTokens: 1_000_000, cacheReadTokens: 900_000 });
    expect(billedInputTokens(u, "claude-opus-5")).toBe(1_000_000);
    expect(costForUsage(u, "claude-opus-5").input).toBeCloseTo(5, 10);
  });

  it("never reports a negative count when the cached figure exceeds the input", () => {
    const u = usage({ inputTokens: 1_000, cacheReadTokens: 4_000 });
    expect(billedInputTokens(u, "gpt-5.6")).toBe(0);
    expect(costForUsage(u, "gpt-5.6").input).toBe(0);
  });

  it("renders the audited gpt-5.6 row with operands that produce its 50¢", () => {
    const u = usage({ inputTokens: 1_000_000, cacheReadTokens: 900_000 });
    const [input] = rowsOf(costBreakdownTooltip(u, "gpt-5.6"));
    expect(input.tokens).toBe(100_000);
    expect(input.rate).toBe(5);
    expect(input.usd).toBe("50¢");
    expect(fmtCost(input.tokens * input.rate / 1e6)).toBe(input.usd);
    // Relabelled, because 900,000 of the reported input moved to the row below.
    expect(input.label).toBe("uncached");
  });

  it("keeps the label `input` when nothing was subtracted", () => {
    const claude = rowsOf(costBreakdownTooltip(
      usage({ inputTokens: 40_000, cacheReadTokens: 900_000 }), "claude-opus-5"));
    expect(claude[0].label).toBe("input");
    const codexCold = rowsOf(costBreakdownTooltip(usage({ inputTokens: 40_000 }), "gpt-5.6"));
    expect(codexCold[0].label).toBe("input");
  });

  it("keeps every row's column alignment when the label changes width", () => {
    const tip = costBreakdownTooltip(
      usage({ inputTokens: 1_000_000, cacheReadTokens: 900_000, cacheCreateTokens: 2_000 }),
      "gpt-5.6",
    );
    const cols = tip.split("\n").filter(l => l.includes("×")).map(l => l.indexOf("×"));
    expect(new Set(cols).size).toBe(1);
  });
});

describe("every tooltip row multiplies out to the figure beside it", () => {
  const cases: Array<{ name: string; model: string; u: TokenUsage }> = [
    { name: "the cache-heavy codex session the audit measured",
      model: "gpt-5.6", u: usage({
        inputTokens: 1_000_000, outputTokens: 50_000, cacheReadTokens: 900_000 }) },
    { name: "a codex session with a cache write, the one OpenAI family that prices them",
      model: "gpt-5.6", u: usage({
        inputTokens: 812_004, outputTokens: 41_233, cacheReadTokens: 774_100, cacheCreateTokens: 9_000 }) },
    { name: "a codex-tuned model on a cheaper tier",
      model: "gpt-5.3-codex", u: usage({
        inputTokens: 250_000, outputTokens: 12_345, cacheReadTokens: 240_000 }) },
    { name: "a claude session with the per-TTL split, which prints two write rows",
      model: "claude-opus-4-8", u: usage({
        inputTokens: 298, outputTokens: 189_908, cacheReadTokens: 20_183_042,
        cacheCreateTokens: 549_834, cacheCreate1hTokens: 549_834, cacheCreate5mTokens: 0 }) },
    { name: "a claude session with a flat cache-creation figure and no split",
      model: "claude-sonnet-4-6", u: usage({
        inputTokens: 1_204, outputTokens: 33_120, cacheReadTokens: 4_400_000, cacheCreateTokens: 120_000 }) },
  ];

  for (const { name, model, u } of cases) {
    it(`reproduces the printed dollars from the printed operands on ${name}`, () => {
      const tip = costBreakdownTooltip(u, model);
      const rows = rowsOf(tip);
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const r of rows) {
        expect(fmtCost(r.tokens * r.rate / 1e6), `${model} ${r.label}`).toBe(r.usd);
      }
      const summed = rows.reduce((acc, r) => acc + r.tokens * r.rate / 1e6, 0);
      expect(summed).toBeCloseTo(costForUsage(u, model).total, 8);
      expect(fmtCost(summed)).toBe(totalOf(tip));
    });
  }

  it("quotes the rate the pricing table holds for the model", () => {
    const rates = ratesForModel("gpt-5.6")!;
    const rows = rowsOf(costBreakdownTooltip(
      usage({ inputTokens: 500_000, outputTokens: 20_000, cacheReadTokens: 400_000, cacheCreateTokens: 1_000 }),
      "gpt-5.6",
    ));
    expect(rows.map(r => r.rate)).toEqual([rates.input, rates.output, rates.cacheRead, rates.cacheWrite]);
  });
});
