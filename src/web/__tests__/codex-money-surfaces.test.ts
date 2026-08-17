// #400: three defects on the surfaces that turn Codex tokens into dollars.
//
// 1. RATES stopped at gpt-5.2 and the whole 5.1 / 5 estate — gpt-5, gpt-5-codex,
//    gpt-5.1, gpt-5.1-codex, gpt-5.1-codex-max, the mini and nano tiers — priced
//    out at nothing. What that looks like on screen is NOT `$0.00`: every
//    surface gates its cost element on the figure being positive, so the element
//    disappears and the tokens stay, and the usage panel's two tables filtered
//    on `cost > 0` while the token strip above them summed the same sessions.
//    The panel's headline therefore matched no visible row. The same file has a
//    catch-all on the context-window side (`/^gpt[-_]5/i` → 400K), which is what
//    proves the ids were expected to arrive.
// 2. `cache_write_input_tokens` is in every `total_token_usage` Codex writes and
//    reached the reducer verbatim, which read only Claude's spelling and dropped
//    it — so gpt-5.6, the first OpenAI family to publish a cache-write price,
//    had a rate with no count to multiply.
// 3. The 7-day token line is a pure local read of the rollout files. It rendered
//    inside the branch that requires the Codex QUOTA fetch — an authenticated
//    round trip to chatgpt.com — to have succeeded, so the one number needing no
//    network was withheld whenever the network failed.
//
// Measured here before any of it was written, on this machine, cold cache:
// /api/codex-usage answers in 2-4ms with zero outbound requests; /api/codex-quota
// takes 991-1299ms across two HTTPS GETs. Of the 171 `total_token_usage` objects
// in ~/.codex/sessions, `cache_write_input_tokens` is present in all of them and
// non-zero in none — 0.0000% of 7,782,286 tokens — so claim 2 is a latent
// under-report rather than a live one, and every number below is unchanged by
// the fix on today's data. That is also what makes the double-charge question
// answerable only from the payload's own arithmetic: `total_tokens` equals
// `input_tokens + output_tokens` in 171 of 171 objects, and each qualifier field
// (`cached_input_tokens`, `reasoning_output_tokens`) is ≤ its headline, so the
// identically-shaped write field is part of `input_tokens` too.
//
// No DOM here — plain node, no jsdom — so the panel and the card are read as
// source the way manage-block.test.ts and panel-overflow.test.ts read theirs,
// and everything arithmetic goes straight through pricing.ts, which is pure.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  billedInputTokens,
  contextWindowForModel,
  costForUsage,
  fmtCost,
  ratesForModel,
} from "../pricing";
// Read off the namespace on purpose, not as a named import. A named import of a
// symbol the module does not export is a link-time error that takes the whole
// file down with it — which would report ONE failure against the pre-fix source
// where this file has many, and the count of what a fix actually repairs is the
// point of running it against the old tree.
import * as pricing from "../pricing";
import { costBreakdownTooltip } from "../components/AgentNode";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload, TokenUsage } from "../types";

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...u,
});

/** A source file with its comments gone. Every "appears nowhere" assertion below
 *  reads this, because the comments in these files quote the code they replaced
 *  — the retired gate and the old filter are both written out a few lines above
 *  the markup that retired them. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = strip(read("../components/UsagePanel.tsx"));
const card = strip(read("../components/AgentNode.tsx"));
const css = strip(read("../styles.css"));

// ── 1. the price table ──────────────────────────────────────────────────────

describe("the generations the table stopped short of", () => {
  // developers.openai.com/api/docs/models/*, read 2026-08-17.
  const PUBLISHED: Array<{ id: string; input: number; output: number; cacheRead: number }> = [
    { id: "gpt-5.1",              input: 1.25, output: 10,  cacheRead: 0.125 },
    { id: "gpt-5.1-codex",        input: 1.25, output: 10,  cacheRead: 0.125 },
    { id: "gpt-5.1-codex-max",    input: 1.25, output: 10,  cacheRead: 0.125 },
    { id: "gpt-5.1-codex-mini",   input: 0.25, output: 2,   cacheRead: 0.025 },
    { id: "gpt-5",                input: 1.25, output: 10,  cacheRead: 0.125 },
    { id: "gpt-5-codex",          input: 1.25, output: 10,  cacheRead: 0.125 },
    { id: "gpt-5-mini",           input: 0.25, output: 2,   cacheRead: 0.025 },
    { id: "gpt-5-nano",           input: 0.05, output: 0.4, cacheRead: 0.005 },
    { id: "gpt-5-pro",            input: 15,   output: 120, cacheRead: 15 },
  ];

  for (const { id, input, output, cacheRead } of PUBLISHED) {
    it(`prices ${id} at the published rate`, () => {
      const r = ratesForModel(id);
      expect(r, `${id} has no rates`).not.toBeNull();
      expect(r!.input).toBe(input);
      expect(r!.output).toBe(output);
      expect(r!.cacheRead).toBe(cacheRead);
      // Only gpt-5.6 publishes a separate cache-write price; these do not.
      expect(r!.cacheWrite).toBe(0);
    });
  }

  it("accepts every separator spelling its own pattern advertises", () => {
    // `[-_.]` between the version parts is what the table promises, and a `\b`
    // after the digit silently breaks that promise for the underscore form: `_`
    // is a word character, so there is no boundary between `1` and `_`. The
    // 5.1 row uses `(?!\d)`, which says what the boundary was actually for.
    for (const id of ["gpt_5_1_codex", "gpt-5-1-codex", "GPT-5.1-Codex-Max"]) {
      expect(ratesForModel(id), id).not.toBeNull();
      expect(ratesForModel(id)!.input).toBe(1.25);
    }
    // And it still refuses the version it would have been mistaken for.
    expect(ratesForModel("gpt-5.10")).toBeNull();
  });

  it("still prices a real session end to end, cache-heavy the way Codex is", () => {
    // Shaped like this machine's largest rollout: 90% of input is cached.
    const u = usage({ inputTokens: 5_212_304, outputTokens: 26_396, cacheReadTokens: 4_800_000 });
    const c = costForUsage(u, "gpt-5.1-codex");
    expect(c.input).toBeCloseTo((5_212_304 - 4_800_000) * 1.25 / 1e6, 10);
    expect(c.cacheRead).toBeCloseTo(4_800_000 * 0.125 / 1e6, 10);
    expect(c.total).toBeGreaterThan(0);
    // And it renders as money rather than as the "—" fmtCost gives a zero.
    expect(fmtCost(c.total)).not.toBe("—");
  });
});

describe("the new rows do not become the catch-all the window table has", () => {
  it("refuses to guess a minor version it has never seen", () => {
    // This is the whole argument for adding rows instead of one `/^gpt[-_]5/i`
    // price row: a window is a capability worth guessing, a price is a number
    // the user checks their bill against. An invented figure is worse than an
    // absent one because nothing on screen says it was invented.
    for (const id of ["gpt-5.7", "gpt-5.7-codex", "gpt-5.9-turbo", "gpt-5-7-codex"]) {
      expect(ratesForModel(id), id).toBeNull();
    }
  });

  it("leaves every family that was already priced exactly where it was", () => {
    // The new rows sit below these, and a `\b` after a version digit is a word
    // boundary before a `.` — so a bare `gpt-5` row without its lookahead would
    // have swallowed the lot.
    const before: Array<[string, number, number]> = [
      ["gpt-5.6-sol", 5, 30],
      ["gpt-5.6", 5, 30],
      ["gpt-5.6-luna", 0.20, 1.20],
      ["gpt-5.6-terra", 2, 12],
      ["gpt-5.6-cyber", 12.50, 75],
      ["gpt-5.5", 5, 30],
      ["gpt-5.5-pro", 30, 180],
      ["gpt-5.4", 2.50, 15],
      ["gpt-5.4-mini", 0.75, 4.50],
      ["gpt-5.4-nano", 0.20, 1.25],
      ["gpt-5.3-codex", 1.75, 14],
      ["gpt-5.2", 1.75, 14],
      ["gpt-5.2-pro", 21, 168],
      ["codex-mini-latest", 1.50, 6],
    ];
    for (const [id, input, output] of before) {
      const r = ratesForModel(id);
      expect(r, id).not.toBeNull();
      expect(r!.input, id).toBe(input);
      expect(r!.output, id).toBe(output);
    }
  });

  it("keeps the mini and nano tiers ahead of their own bare row", () => {
    // Order in the table is the only thing separating $0.05 from $1.25.
    expect(ratesForModel("gpt-5-mini")!.input).toBe(0.25);
    expect(ratesForModel("gpt-5-nano")!.input).toBe(0.05);
    expect(ratesForModel("gpt-5-pro")!.input).toBe(15);
    expect(ratesForModel("gpt-5.1-codex-mini")!.input).toBe(0.25);
  });

  it("was already answering for these ids on the context-window side", () => {
    // The asymmetry the issue used as its evidence, kept as a fact: the window
    // table's catch-all has always covered the bare gpt-5 generations, so the
    // price table's silence about them was never "these cannot arrive".
    for (const id of ["gpt-5", "gpt-5-codex", "gpt-5.1-codex", "gpt-5.7-codex"]) {
      expect(contextWindowForModel(id), id).toBe(400_000);
    }
  });
});

// ── 2. what an unpriced model shows ─────────────────────────────────────────

describe("a model with no rate says so instead of vanishing", () => {
  const UNKNOWN = "gpt-6-codex";
  const u = usage({ inputTokens: 900_000, outputTokens: 12_000, cacheReadTokens: 800_000 });

  it("has one word for it, and it is not the one a zero gets", () => {
    expect(pricing.UNPRICED_LABEL).toBe("not priced");
    // fmtCost(0) is "—", which this file's own vocabulary reserves for a number
    // known to be zero. Conflating the two is the defect in miniature.
    expect(fmtCost(0)).toBe("—");
    expect(pricing.UNPRICED_LABEL).not.toBe(fmtCost(0));
  });

  it("still returns a zero breakdown, which is why every gate hid the element", () => {
    // Unchanged behaviour, pinned because it is the mechanism: `$0` is never
    // printed for real spend — the element carrying it is removed instead.
    const c = costForUsage(u, UNKNOWN);
    expect(ratesForModel(UNKNOWN)).toBeNull();
    expect(c).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });

  it("reaches the tooltip that was written for this case and never reachable", () => {
    const tip = costBreakdownTooltip(u, UNKNOWN);
    // The id is what a reader needs in order to act on it — the old sentence,
    // "no rates for this model", named no model.
    expect(tip).toContain(UNKNOWN);
    expect(tip).toMatch(/no published rate/i);
    expect(tip).not.toMatch(/×/);  // no multiplication rows: there is nothing to multiply
  });

  it("puts the marker on the card in the slot the money would have used", () => {
    // The gate that removed the whole element is gone; the lookup now chooses
    // between two renderings instead of between one and nothing.
    expect(card).not.toMatch(/data\.model && ratesForModel\(data\.model\) &&/);
    expect(card).toMatch(/const rates = ratesForModel\(data\.model\);/);
    expect(card).toMatch(/className="cost-unpriced"/);
    expect(card).toMatch(/\{UNPRICED_LABEL\}/);
    // And only once there are tokens: a card that has not reported usage yet
    // has nothing to be unpriced about.
    expect(card).toMatch(/data\.usage\.inputTokens \+ data\.usage\.outputTokens\) <= 0\) return null/);
  });

  it("stops the usage panel dropping rows whose tokens it still counts", () => {
    expect(panel).not.toMatch(/filter\(m => m\.cost\.total > 0\)/);
    expect(panel).not.toMatch(/filter\(s => s\.cost > 0\)/);
    // Rows are selected on tokens now, in one place each rather than twice in
    // the markup — the old code called the same filter for the length check and
    // for the map.
    expect(panel).toMatch(/const modelRows\s+= byModel\.filter\(m => m\.cost\.total > 0 \|\| \(m\.inputTokens \+ m\.outputTokens\) > 0\)/);
    expect(panel).toMatch(/const sessionRows = bySessions\.filter\(s => s\.cost > 0 \|\| \(s\.inputTokens \+ s\.outputTokens\) > 0\)/);
    expect(panel).toMatch(/\{UNPRICED_LABEL\}/);
  });

  it("shows the breakdown even when nothing in the deck could be priced at all", () => {
    // The two tables used to live inside `hasCost`, so an all-Codex deck on an
    // unpriced model got a two-number strip and no breakdown whatsoever.
    expect(panel).toMatch(/\{totalTokenSum > 0 \? \(/);
    expect(panel).toMatch(/\{hasCost && \(/);
    expect(panel).not.toMatch(/\{hasCost \? \(/);
  });

  it("paints the marker as a state rather than as an amount", () => {
    // --ok is this app's colour for money. A phrase in it reads as a figure.
    const declOf = (selector: string, prop: string) => {
      const rule = new RegExp(`(?:^|})[^{}]*?${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
      const body = rule.exec(css)?.[1] ?? "";
      const hit = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`).exec(body);
      return hit ? hit[1].trim() : null;
    };
    for (const sel of [".up-unpriced", ".agent-node .meta .cost-unpriced"]) {
      expect(declOf(sel, "color"), sel).toBe("var(--muted)");
      expect(declOf(sel, "font-style"), sel).toBe("italic");
    }
    // The panel marker has to come after the two rules whose colour it beats —
    // same specificity, so source order decides.
    expect(css.indexOf(".up-unpriced")).toBeGreaterThan(css.indexOf(".up-cost-val"));
    expect(css.indexOf(".up-unpriced")).toBeGreaterThan(css.indexOf(".up-session-cost"));
  });
});

// ── 3. cache-write tokens ───────────────────────────────────────────────────

describe("the cache-write count Codex has been writing all along", () => {
  const env = (payload: HookPayload, seq: number): HookEnvelope =>
    ({ seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload });

  const observe = (model: string, u: Record<string, number>) => {
    let state = applyEvent(initialState(), env({
      hook_event_name: "SessionStart", session_id: "s-cw", model,
    } as HookPayload, 1));
    state = applyEvent(state, env({
      hook_event_name: "UsageObserved", session_id: "s-cw", usage: u,
    } as unknown as HookPayload, 2));
    return state.agents.get("s-cw")!;
  };

  it("reaches the agent from a rollout-shaped payload and prices at the 5.6 rate", () => {
    // Field names and shape copied from a real total_token_usage block; the
    // write count is synthetic because every real one on this machine is zero.
    const root = observe("gpt-5.6-sol", {
      input_tokens: 812_004,
      output_tokens: 41_233,
      cached_input_tokens: 700_000,
      cache_write_input_tokens: 9_000,
      reasoning_output_tokens: 2_241,
      total_tokens: 853_237,
    });
    expect(root.usage.cacheCreateTokens).toBe(9_000);
    expect(root.usage.cacheReadTokens).toBe(700_000);
    // $6.25/Mtok on sol — the line that was pinned at $0.00 forever.
    expect(costForUsage(root.usage, "gpt-5.6-sol").cacheWrite).toBeCloseTo(9_000 * 6.25 / 1e6, 10);
  });

  it("leaves Claude's spelling as the one that wins when both could apply", () => {
    // Same `??` precedence the cache-READ line has used since Codex arrived:
    // no producer emits both, and a provider that did would be a Claude one.
    const root = observe("claude-opus-5", {
      input_tokens: 2,
      output_tokens: 758,
      cache_read_input_tokens: 29_189,
      cache_creation_input_tokens: 83_119,
    });
    expect(root.usage.cacheCreateTokens).toBe(83_119);
    const both = observe("claude-opus-5", {
      cache_creation_input_tokens: 0,
      cache_write_input_tokens: 9_000,
    });
    expect(both.usage.cacheCreateTokens).toBe(0);
  });

  it("bills a written token once, not on the input line as well", () => {
    // The payload's own arithmetic puts the written tokens inside input_tokens
    // (total === input + output in 171/171 objects measured), so charging the
    // cache-write rate without taking them off the input line charges them at
    // input + cache-write together — a 2.25x over-report on that slice.
    const u = usage({ inputTokens: 1_000_000, cacheReadTokens: 700_000, cacheCreateTokens: 100_000 });
    expect(billedInputTokens(u, "gpt-5.6")).toBe(200_000);
    // The three token lines partition input_tokens exactly.
    expect(billedInputTokens(u, "gpt-5.6") + u.cacheReadTokens + u.cacheCreateTokens)
      .toBe(u.inputTokens);
    const c = costForUsage(u, "gpt-5.6");
    expect(c.input).toBeCloseTo(200_000 * 5 / 1e6, 10);
    expect(c.cacheRead).toBeCloseTo(700_000 * 0.5 / 1e6, 10);
    expect(c.cacheWrite).toBeCloseTo(100_000 * 6.25 / 1e6, 10);
    expect(c.total).toBeCloseTo(1.0 + 0.35 + 0.625, 10);
  });

  it("keeps them on the input line for a family that prices writes at zero", () => {
    // A zero cache-write rate means writes cost nothing EXTRA, not that the
    // tokens are free of the input charge. Subtracting them everywhere would
    // turn an over-report into an under-report.
    const u = usage({ inputTokens: 1_000_000, cacheReadTokens: 700_000, cacheCreateTokens: 100_000 });
    for (const id of ["gpt-5.4", "gpt-5.3-codex", "gpt-5.1-codex", "gpt-5"]) {
      expect(ratesForModel(id)!.cacheWrite, id).toBe(0);
      expect(billedInputTokens(u, id), id).toBe(300_000);
    }
    // And a Claude agent is untouched: Anthropic reports the two disjoint.
    expect(billedInputTokens(u, "claude-opus-5")).toBe(1_000_000);
    expect(costForUsage(u, "claude-opus-5").cacheWrite).toBeCloseTo(100_000 * 6.25 / 1e6, 10);
  });

  it("still reads every tooltip row out to the figure printed beside it", () => {
    // The invariant codex-cached-input-row.test.ts pins, re-checked on the one
    // case that now moves: a Codex session with a cache write.
    const tip = costBreakdownTooltip(
      usage({ inputTokens: 1_000_000, outputTokens: 50_000, cacheReadTokens: 700_000, cacheCreateTokens: 100_000 }),
      "gpt-5.6",
    );
    const rows = tip.split("\n").filter(l => l.includes("×")).map(line => {
      const [lhs, rhs] = line.split("×");
      const [rate, usd] = rhs.split("=");
      return {
        tokens: Number(lhs.replace(/^\D+/, "").replace(/\D/g, "")),
        rate: Number(rate.trim().replace("$", "").replace("/MTok", "")),
        usd: usd.trim(),
      };
    });
    for (const r of rows) expect(fmtCost(r.tokens * r.rate / 1e6)).toBe(r.usd);
    expect(rows[0].tokens).toBe(200_000);
  });
});

// ── the server-side aggregator, over a real rollout tree ────────────────────
// Everything lives under a temp CODEX_HOME. HOME and USERPROFILE go with it so
// no fallback can reach the developer's own ~/.codex on any of the three
// platforms, and the module resolves CODEX_HOME at import time — so the
// redirect has to be in place before the import below.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-money-"));
const CODEX_HOME = join(DIR, "codex-home");
const SESSIONS = join(CODEX_HOME, "sessions");
const ENV_KEYS = ["HOME", "USERPROFILE", "CODEX_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const { fetchCodexUsage } = await import("../../server/codex-usage.mjs");

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k]; else process.env[k] = PREV[k]!;
  }
  rmSync(DIR, { recursive: true, force: true });
});

describe("fetchCodexUsage fills the cache-write field its own shape declares", () => {
  it("counts it into the window instead of leaving the declared field at zero", async () => {
    const at = new Date(Date.now() - 60 * 60 * 1000);
    const [y, m, d] = at.toISOString().slice(0, 10).split("-");
    const dir = join(SESSIONS, y, m, d);
    rmSync(SESSIONS, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const [date, time] = at.toISOString().slice(0, 19).split("T");
    // Dashes in the time part — the filename shape is Windows-safe by design.
    const name = `rollout-${date}T${time.replace(/:/g, "-")}-session-cw.jsonl`;

    // Two cumulative snapshots, so the window delta has something to subtract.
    const line = (input: number, write: number) => JSON.stringify({
      timestamp: at.toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            output_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: write,
            total_tokens: input,
          },
        },
      },
    }) + "\n";
    writeFileSync(join(dir, name), line(1_000, 400) + line(5_000, 1_200), "utf8");

    const res = await fetchCodexUsage({ force: true });
    expect(res.ok).toBe(true);
    expect(res.window7d.sessionCount).toBe(1);
    expect(res.window7d.cacheCreateTokens).toBe(1_200);
    expect(res.window5h.cacheCreateTokens).toBe(1_200);
    // The token line the panel prints is unchanged: the written tokens are
    // already inside input_tokens, so they are not added to the total again.
    expect(res.window7d.totalTokens).toBe(5_000);
  });
});

// ── 4. the local number and the network call ────────────────────────────────

describe("the 7-day token line does not wait on an authenticated round trip", () => {
  it("renders outside all three branches of the Codex quota fetch", () => {
    // /api/codex-usage: 2-4ms, zero outbound requests, reading files this
    // machine already has. /api/codex-quota: 991-1299ms across two HTTPS GETs
    // to chatgpt.com, and it fails outright on no_token, api_key_mode, an
    // expired refresh or blocked egress. The local line used to render only
    // inside the success case of the second one.
    const uses = [...panel.matchAll(/codexUsage\?\.ok/g)];
    expect(uses).toHaveLength(1);
    const at = panel.indexOf("codexUsage?.ok");
    // Scoped to the Codex section: the Claude quota above it has the same three
    // branches, and an unanchored search for the loading one finds Claude's.
    const section = panel.indexOf("Codex quota");
    expect(section).toBeGreaterThan(-1);
    const successBranch = panel.indexOf("codexQuota?.ok ? (", section);
    const failureBranch = panel.indexOf("codexQuota?.ok === false", section);
    const loadingBranch = panel.indexOf("up-quota-loading", failureBranch);
    expect(successBranch).toBeGreaterThan(-1);
    expect(failureBranch).toBeGreaterThan(successBranch);
    expect(loadingBranch).toBeGreaterThan(failureBranch);
    // After the last of the three: outside the ternary entirely.
    expect(at).toBeGreaterThan(loadingBranch);
    // And still inside the Codex section rather than adrift in the cost half.
    expect(at).toBeLessThan(panel.indexOf("up-total-value"));
  });

  it("keeps polling it on its own timer, which is what makes that worth doing", () => {
    expect(panel).toMatch(/const \{ data: codexUsage \} = useCodexUsage\(\);/);
    expect(panel).toMatch(/fetch\("\/api\/codex-usage"\)/);
  });

  it("finally reads the 5-hour window the server has always computed", () => {
    // Nothing consumed window5h. It goes in the title rather than on the line:
    // the panel is 280px wide (#369) and a second visible figure costs more
    // than it says.
    expect(panel).toMatch(/codexUsage\.window5h/);
    expect(panel).toMatch(/last 5h/);
  });
});
