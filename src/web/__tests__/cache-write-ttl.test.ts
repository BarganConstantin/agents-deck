// Every cache-creation token used to be billed at the 5-minute write rate
// (1.25x base input), because pricing.ts only ever saw the flat
// `cache_creation_input_tokens`. CC writes 1-hour caches for the bulk of its
// prefix and Anthropic charges those at 2x input, so every cost chip, the cost
// bar, the session-list totals and the burn rate read 5-10% under the real
// bill — and under the ccusage figure the deck itself prints in the usage
// history. The split was in the transcript the whole time, one layer below:
// the server's `"usage":{([^}]+)}` capture stops at the first `}`, which in a
// real transcript closes `server_tool_use` several fields before
// `cache_creation`, so the sub-object never reached the client. These pin the
// three things that can regress: the per-TTL dollar arithmetic, the fallback
// for usage that carries no split, and the scanner reaching the sub-object.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cacheWriteBreakdown, costForUsage, ratesForModel } from "../pricing";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload, TokenUsage } from "../types";

// Nothing in this file may touch the real ~/.claude, ~/.codex or the
// claude-swap store: every home the server module resolves at import time is
// pointed at a throwaway directory before that import happens.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-cache-ttl-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
for (const k of ENV_KEYS) process.env[k] = k === "HOME" || k === "USERPROFILE" ? DIR : join(DIR, k);

/** Hard stop if a path we are about to hand the scanner escapes the sandbox —
 *  a transcript read is a read of whatever path it is given. */
function sandboxed(name: string): string {
  const p = resolve(DIR, name);
  if (!p.startsWith(resolve(DIR) + "/") && !p.startsWith(resolve(DIR) + "\\")) {
    throw new Error(`refusing to touch ${p}: outside ${DIR}`);
  }
  return p;
}

// @ts-expect-error — .mjs server module, no types
const { readUsageFromTranscript } = await import("../../server/index.mjs");

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k]; else process.env[k] = PREV[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...u,
});

describe("cache writes are priced at the TTL they were written for", () => {
  it("bills a 1-hour write at twice base input, not 1.25x", () => {
    // claude-opus-5: $5 input, so $10/Mtok for a 1-hour write and $6.25 for a
    // 5-minute one. One million tokens, all of them 1-hour.
    const c = costForUsage(
      usage({ cacheCreateTokens: 1_000_000, cacheCreate1hTokens: 1_000_000, cacheCreate5mTokens: 0 }),
      "claude-opus-5",
    );
    expect(c.cacheWrite).toBeCloseTo(10, 10);
    expect(c.total).toBeCloseTo(10, 10);
  });

  it("charges each bucket its own rate on a mixed session", () => {
    // The measured shape of real traffic: mostly 1-hour, a slice of 5-minute.
    const c = costForUsage(
      usage({
        cacheCreateTokens: 1_000_000,
        cacheCreate1hTokens: 800_000,
        cacheCreate5mTokens: 200_000,
      }),
      "claude-opus-5",
    );
    expect(c.cacheWrite).toBeCloseTo(800_000 * 10 / 1e6 + 200_000 * 6.25 / 1e6, 10);
    expect(c.cacheWrite).toBeCloseTo(9.25, 10);
  });

  it("reproduces the audit's opus-4-8 row to the cent", () => {
    // The figures the issue measured against ccusage: the old all-5-minute
    // arithmetic yields $18.277173, the real bill $20.339051.
    const u = usage({
      inputTokens: 298,
      outputTokens: 189_908,
      cacheReadTokens: 20_183_042,
      cacheCreateTokens: 549_834,
      cacheCreate1hTokens: 549_834,
      cacheCreate5mTokens: 0,
    });
    expect(costForUsage(u, "claude-opus-4-8").total).toBeCloseTo(20.339051, 6);

    const unsplit = usage({
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreateTokens: u.cacheCreateTokens,
    });
    expect(costForUsage(unsplit, "claude-opus-4-8").total).toBeCloseTo(18.277173, 6);
  });

  it("prices every claude model's 1-hour write at 2x input and its 5-minute at 1.25x", () => {
    const models = [
      "claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5",
      "claude-opus-4-8", "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4",
      "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4",
      "claude-haiku-4-5", "claude-haiku-3-5",
    ];
    for (const model of models) {
      const rates = ratesForModel(model, Date.UTC(2026, 0, 1))!;
      expect(rates, model).toBeTruthy();
      expect(rates.cacheWrite, model).toBeCloseTo(rates.input * 1.25, 10);
      expect(rates.cacheWrite1h, model).toBeCloseTo(rates.input * 2, 10);
    }
  });

  it("follows sonnet 5 across its intro-price cutover", () => {
    const u = usage({ cacheCreateTokens: 1_000_000, cacheCreate1hTokens: 1_000_000 });
    // Intro: $2 input -> $4 for a 1-hour write. After 2026-08-31: $3 -> $6.
    expect(costForUsage(u, "claude-sonnet-5", Date.UTC(2026, 7, 1)).cacheWrite).toBeCloseTo(4, 10);
    expect(costForUsage(u, "claude-sonnet-5", Date.UTC(2026, 8, 2)).cacheWrite).toBeCloseTo(6, 10);
  });
});

describe("usage that carries no TTL split keeps the numbers it already had", () => {
  it("bills the whole flat total at the 5-minute rate", () => {
    const c = costForUsage(usage({ cacheCreateTokens: 1_000_000 }), "claude-opus-5");
    expect(c.cacheWrite).toBeCloseTo(6.25, 10);
  });

  it("bills the remainder a partial split leaves behind at the 5-minute rate", () => {
    // Half a transcript predates CC emitting the sub-object: the split sums to
    // less than the flat field, and the difference must not go uncharged — nor
    // be counted twice.
    const c = costForUsage(
      usage({ cacheCreateTokens: 1_000_000, cacheCreate1hTokens: 400_000, cacheCreate5mTokens: 0 }),
      "claude-opus-5",
    );
    expect(c.cacheWrite).toBeCloseTo(400_000 * 10 / 1e6 + 600_000 * 6.25 / 1e6, 10);

    const cw = cacheWriteBreakdown(
      usage({ cacheCreateTokens: 1_000_000, cacheCreate1hTokens: 400_000, cacheCreate5mTokens: 0 }),
      ratesForModel("claude-opus-5")!,
    );
    expect(cw.tokens1h + cw.tokens5m).toBe(1_000_000);
  });

  it("leaves codex alone, where no 1-hour tier exists", () => {
    const c = costForUsage(usage({ cacheCreateTokens: 1_000_000 }), "gpt-5.6");
    expect(c.cacheWrite).toBeCloseTo(6.25, 10);
    expect(ratesForModel("gpt-5.6")!.cacheWrite1h).toBeUndefined();
  });
});

describe("the split survives the trip from transcript to agent", () => {
  const env = (payload: HookPayload, seq: number): HookEnvelope =>
    ({ seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload });

  it("reads the cache_creation sub-object out of a real-shaped usage block", async () => {
    // Field order copied from a live CC transcript: `cache_creation` sits
    // after `server_tool_use`, past where the usage-block capture stops.
    const path = sandboxed("ttl.jsonl");
    const message = {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 83_119,
        cache_read_input_tokens: 29_189,
        output_tokens: 758,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard",
        cache_creation: { ephemeral_1h_input_tokens: 83_000, ephemeral_5m_input_tokens: 119 },
      },
    };
    writeFileSync(path, JSON.stringify({ type: "assistant", message }) + "\n");

    const totals = await readUsageFromTranscript(path);
    expect(totals.cache_creation_input_tokens).toBe(83_119);
    expect(totals.ephemeral_1h_input_tokens).toBe(83_000);
    expect(totals.ephemeral_5m_input_tokens).toBe(119);
    // The sub-fields sum back to the flat one — nothing is invented or lost.
    expect(totals.ephemeral_1h_input_tokens + totals.ephemeral_5m_input_tokens)
      .toBe(totals.cache_creation_input_tokens);
  });

  it("stamps the split onto the root agent and prices it", () => {
    let state = applyEvent(initialState(), env({
      hook_event_name: "SessionStart",
      session_id: "s1",
      model: "claude-opus-5",
    }, 1));
    state = applyEvent(state, env({
      hook_event_name: "UsageObserved",
      session_id: "s1",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 800_000,
        ephemeral_5m_input_tokens: 200_000,
      },
    }, 2));

    const root = state.agents.get("s1")!;
    expect(root.usage.cacheCreate1hTokens).toBe(800_000);
    expect(root.usage.cacheCreate5mTokens).toBe(200_000);
    expect(costForUsage(root.usage, "claude-opus-5").cacheWrite).toBeCloseTo(9.25, 10);
  });

  it("clears a stale split when a later pass reports none", () => {
    let state = applyEvent(initialState(), env({
      hook_event_name: "SessionStart",
      session_id: "s2",
      model: "claude-opus-5",
    }, 1));
    state = applyEvent(state, env({
      hook_event_name: "UsageObserved",
      session_id: "s2",
      usage: {
        cache_creation_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 1_000_000,
        ephemeral_5m_input_tokens: 0,
      },
    }, 2));
    expect(state.agents.get("s2")!.usage.cacheCreate1hTokens).toBe(1_000_000);

    // UsageObserved carries cumulative totals, so it overwrites rather than
    // accumulates — a split left behind here would price tokens that are gone.
    state = applyEvent(state, env({
      hook_event_name: "UsageObserved",
      session_id: "s2",
      usage: { cache_creation_input_tokens: 400_000 },
    }, 3));
    const root = state.agents.get("s2")!;
    expect(root.usage.cacheCreate1hTokens).toBeUndefined();
    expect(costForUsage(root.usage, "claude-opus-5").cacheWrite).toBeCloseTo(400_000 * 6.25 / 1e6, 10);
  });
});
