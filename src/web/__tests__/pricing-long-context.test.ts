import { describe, it, expect } from "vitest";
import { costForUsage } from "../pricing";
import type { TokenUsage } from "../types";

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...u,
});

// A Codex agent's usage is the session running total (`total_token_usage`),
// never one request's input. Cumulative input passes OpenAI's 272K
// long-context line on most non-trivial sessions while every individual
// request stays well below it, so cost must not change as the total crosses.
describe("codex cost is not surcharged by cumulative session input", () => {
  it("prices gpt-5.6 at base rates once the session total passes 272K", () => {
    // 300K cumulative input, 250K of it cache reads — six ~50K turns, no
    // single request anywhere near the threshold.
    const c = costForUsage(
      usage({ inputTokens: 300_000, cacheReadTokens: 250_000, outputTokens: 20_000 }),
      "gpt-5.6",
    );
    // gpt-5.6: $5 input, $30 output, $0.50 cache read.
    expect(c.input).toBeCloseTo(50_000 * 5 / 1e6, 10);
    expect(c.output).toBeCloseTo(20_000 * 30 / 1e6, 10);
    expect(c.cacheRead).toBeCloseTo(250_000 * 0.5 / 1e6, 10);
    expect(c.total).toBeCloseTo(0.25 + 0.6 + 0.125, 10);
  });

  it("scales linearly across the old threshold instead of jumping", () => {
    const below = costForUsage(usage({ inputTokens: 200_000, outputTokens: 10_000 }), "gpt-5.5");
    const above = costForUsage(usage({ inputTokens: 400_000, outputTokens: 20_000 }), "gpt-5.5");
    expect(above.total).toBeCloseTo(below.total * 2, 10);
  });

  it("leaves the 400K-window models alone, where the tier is unreachable", () => {
    for (const model of ["gpt-5.4-mini", "gpt-5.4-nano"]) {
      const one = costForUsage(usage({ inputTokens: 100_000, outputTokens: 5_000 }), model);
      const three = costForUsage(usage({ inputTokens: 300_000, outputTokens: 15_000 }), model);
      expect(three.total).toBeCloseTo(one.total * 3, 10);
    }
  });

  it("still subtracts cached tokens from codex input, and leaves claude as-is", () => {
    const codex = costForUsage(usage({ inputTokens: 300_000, cacheReadTokens: 280_000 }), "gpt-5.4");
    expect(codex.input).toBeCloseTo(20_000 * 2.5 / 1e6, 10);

    const claude = costForUsage(
      usage({ inputTokens: 300_000, cacheReadTokens: 280_000, outputTokens: 10_000 }),
      "claude-opus-5",
    );
    expect(claude.input).toBeCloseTo(300_000 * 5 / 1e6, 10);
    expect(claude.output).toBeCloseTo(10_000 * 25 / 1e6, 10);
  });
});
