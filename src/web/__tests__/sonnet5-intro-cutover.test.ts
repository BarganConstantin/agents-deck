// Sonnet 5's introductory price ends 2026-08-31, and the rate table used to
// resolve that once while the module was evaluated — i.e. once per page load.
// The deck is built for tabs that stay open for days (restart.ts exists for
// exactly that reason, and nothing else reloads the bundle), so a tab opened
// in August kept pricing September sessions at the intro rate, under-reporting
// input and output by a third. The check now runs per cost computation, with
// an injectable clock so both sides of the cutover are exercised here rather
// than depending on the day the suite runs.
import { describe, it, expect } from "vitest";
import { ratesForModel, costForUsage } from "../pricing";
import type { TokenUsage } from "../types";

const BEFORE = Date.UTC(2026, 7, 30);  // 2026-08-30, intro pricing
const AFTER = Date.UTC(2026, 8, 5);    // 2026-09-05, standard pricing
const CUTOVER = Date.UTC(2026, 8, 1);  // 2026-09-01, first standard instant

const INTRO = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const STANDARD = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...u,
});

describe("sonnet 5 intro pricing is resolved per call", () => {
  it("quotes the intro rate before the cutover", () => {
    expect(ratesForModel("claude-sonnet-5", BEFORE)).toEqual(INTRO);
  });

  it("quotes the standard rate after the cutover", () => {
    expect(ratesForModel("claude-sonnet-5", AFTER)).toEqual(STANDARD);
  });

  it("switches exactly at 2026-09-01 UTC", () => {
    expect(ratesForModel("claude-sonnet-5", CUTOVER - 1)).toEqual(INTRO);
    expect(ratesForModel("claude-sonnet-5", CUTOVER)).toEqual(STANDARD);
  });

  it("re-checks the date on every call, so a long-lived tab still cuts over", () => {
    // The regression: one module evaluation, two different clocks. A table
    // built at load time would answer INTRO both times.
    expect(ratesForModel("claude-sonnet-5", BEFORE)).toEqual(INTRO);
    expect(ratesForModel("claude-sonnet-5", AFTER)).toEqual(STANDARD);
    expect(ratesForModel("claude-sonnet-5", BEFORE)).toEqual(INTRO);
  });

  it("prices a session through costForUsage on both sides", () => {
    const u = usage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 1_000_000,
    });
    const before = costForUsage(u, "claude-sonnet-5", BEFORE);
    expect(before.input).toBeCloseTo(2, 10);
    expect(before.output).toBeCloseTo(10, 10);
    expect(before.cacheRead).toBeCloseTo(0.2, 10);
    expect(before.cacheWrite).toBeCloseTo(2.5, 10);

    const after = costForUsage(u, "claude-sonnet-5", AFTER);
    expect(after.input).toBeCloseTo(3, 10);
    expect(after.output).toBeCloseTo(15, 10);
    expect(after.cacheRead).toBeCloseTo(0.3, 10);
    expect(after.cacheWrite).toBeCloseTo(3.75, 10);

    expect(after.total).toBeGreaterThan(before.total);
  });

  it("defaults to the wall clock when no time is passed", () => {
    const expected = Date.now() < CUTOVER ? INTRO : STANDARD;
    expect(ratesForModel("claude-sonnet-5")).toEqual(expected);
  });

  it("leaves undated models identical on both sides", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-4.5", "gpt-5.6"]) {
      expect(ratesForModel(model, BEFORE)).toEqual(ratesForModel(model, AFTER));
    }
  });
});
