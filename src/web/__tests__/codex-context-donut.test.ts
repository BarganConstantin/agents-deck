// #399: Codex is the only provider that reports its context window exactly, and
// it was the only one with no context readout at all.
//
// `ContextObserved` had one emitter, `maybeResolveContext`, and a provider gate
// routed Codex past it — belt and braces, since that function also early-returns
// without `transcript_path`, a field Codex never sends. So `agent.context` was
// permanently undefined for a Codex session, `currentContextTokens` was 0, and
// the donut's own gate (`kind === "root" && currentContextTokens > 0`) never
// opened. The donut's onClick is the only caller of `setContextFor`, so the
// whole ContextModal had no entry point for a Codex user: not an empty modal, no
// way to open one. The `contextWindow` the reducer had been stamping on the root
// since #171 had exactly two readers, the donut and that modal, and both sat
// behind the closed gate — write-only state.
//
// WHAT THE ROLLOUTS ACTUALLY SAY. Sampled every rollout under this machine's
// CODEX_HOME (structural names, keys and numbers only, never record content):
// 8 files, 5 on Codex 0.144.5 and 3 on 0.147.0.
//
//    58  event_msg/task_started   every one carrying a numeric
//                                 model_context_window — #395's claim holds
//   178  event_msg/token_count    every one carrying info.last_token_usage,
//                                 info.total_token_usage AND
//                                 info.model_context_window
//   164  of those on 0.144.5, whose usage blocks have five keys
//    14  of those on 0.147.0, which adds cache_write_input_tokens
//
// So the window is on 236 records and the deck read it off 58 of them; the
// occupancy is on 178 and the deck read it off none. Both numbers were already
// parsed and thrown away.
//
// WHICH FIELD IS THE OCCUPANCY. `total_token_usage` is cumulative SPEND — it
// re-counts the cached prefix every turn and reaches 5,238,700 against a 258,400
// window inside one session here, so it cannot be an occupancy. `last_token_usage`
// is the most recent request: `input_tokens` is the whole conversation Codex
// sent (it already contains the cached prefix) and `total_tokens` is that plus
// the completion — exactly input + output on 177 of the 178 records.
//
// The 178th is the interesting one and it decides the field. It sits immediately
// before a `thread_rolled_back` record — the user rewinding the conversation —
// and its per-request components are all zero while `last_token_usage.total_tokens`
// reads 47,355, down from 58,516, with `total_token_usage` unchanged because no
// request was made. Codex is restating the recomputed size of the context there.
// Reading `input_tokens` would have collapsed the donut to 0% at the one moment
// the number moved most, so `total_tokens` is what the deck reads.
//
// IS THE WINDOW "LIVE"? Not in the sense of changing: 258,400 on all 236 records
// across both CLI versions, both models seen (gpt-5.6-sol, gpt-5.6-luna) and all
// 8 files, and it changed mid-session in zero of them. It is live in the sense
// that matters — it is the CLI's own ceiling rather than the deck's guess, and
// the static table answers 1,050,000 for the same model. That is the 4x error
// the donut would draw with if this were dropped.
//
// No DOM — plain node, vitest — so this drives the real translation function,
// the real reducer, the real scanners and the real copy rule, with the object
// shapes copied from real rollout lines.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { effectiveContextWindow, contextWindowForModel } from "../pricing";
import type { HookEnvelope, HookPayload, Provider } from "../types";

// ── the sandbox the two memory scanners are pointed at ─────────────────────
// $CODEX_HOME is resolved once at module load by codex-dir.mjs, so it has to be
// set before index.mjs is imported — which is why index.mjs arrives through a
// dynamic import below rather than a hoisted static one. Nothing here reads or
// writes the developer's own ~/.codex or ~/.claude.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-ctx-donut-"));
const FAKE_CODEX_HOME = join(SANDBOX, "codex-home");
const PREV_CODEX_HOME = process.env.CODEX_HOME;
process.env.CODEX_HOME = FAKE_CODEX_HOME;

afterAll(() => {
  if (PREV_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = PREV_CODEX_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

// @ts-expect-error — .mjs server module, no types
const server = await import("../../server/index.mjs");
const codexObjToPayload = server.codexObjToPayload as (o: unknown, sid: string, cwd: string) => HookPayload | null;
type MemoryScan = (cwd: string) => Promise<Array<{ path: string; bytes: number }>>;
const scanAgentsMdFiles = server.scanAgentsMdFiles as MemoryScan | undefined;
const scanClaudeMdFiles = server.scanClaudeMdFiles as MemoryScan | undefined;

/** The scanner, or a failed assertion naming it — never a thrown TypeError.
 *  Same defence codex-home-one-reader.test.ts uses on the module it introduced:
 *  against the pre-fix source this file has to report one named failure per
 *  thing that regressed, not collapse into a single collection error that says
 *  only that something did. */
function scan(fn: MemoryScan | undefined, name: string): MemoryScan {
  expect(fn, `${name} is not exported from src/server/index.mjs`).toBeTypeOf("function");
  return fn!;
}

/** The copy rule, imported the same defensive way and for the same reason: it
 *  lives in a .tsx that renders through React, and a missing export there would
 *  otherwise take the mapper and reducer tests down with it. */
type ContextCopy = {
  subtitle: string;
  windowScope: string;
  compositionCounted: boolean;
  compositionUncounted: string;
  memoryHeading: string;
  memoryEmpty: string;
};
let contextCopy: ((p: Provider | undefined) => ContextCopy) | null = null;
try {
  const mod = await import("../components/ContextModal");
  contextCopy = (mod as { contextCopy?: (p: Provider | undefined) => ContextCopy }).contextCopy ?? null;
} catch {
  contextCopy = null;
}
function copyFor(provider: Provider | undefined): ContextCopy {
  expect(contextCopy, "contextCopy is not exported from ContextModal.tsx").not.toBeNull();
  return contextCopy!(provider);
}

const SESSION = "01a00e99-37b3-7781-90d7-aa76a7fca6fa";
const CWD = "/repo";
const T0 = 1_700_000_000_000;
/** What every task_started and every token_count in the sample reports. */
const CODEX_WINDOW = 258_400;

/** One rollout line, as Codex appends it. */
type Rollout = { type: string; payload: Record<string, unknown> };

// ── the real rollout shapes, keys verbatim from ~/.codex/sessions ────────────

const turnContext: Rollout = { type: "turn_context", payload: { model: "gpt-5.6-sol", approval_policy: "never" } };

const taskStarted: Rollout = {
  type: "event_msg",
  payload: { type: "task_started", turn_id: "t-1", started_at: 0, model_context_window: CODEX_WINDOW, collaboration_mode_kind: "default" },
};

/**
 * Codex 0.144.5's token_count: five keys in each usage block.
 *
 * The numbers are a real pair from the sample — the first request of a session
 * (17,585 prompt + 20 completion) — so `total_token_usage` and
 * `last_token_usage` agree here the way they do on turn one and diverge later.
 */
const tokenCount144 = (lastTotal: number, cumulative: number): Rollout => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {},
    info: {
      model_context_window: CODEX_WINDOW,
      last_token_usage: {
        input_tokens: lastTotal - 20, cached_input_tokens: 9_984,
        output_tokens: 20, reasoning_output_tokens: 0, total_tokens: lastTotal,
      },
      total_token_usage: {
        input_tokens: cumulative - 20, cached_input_tokens: 9_984,
        output_tokens: 20, reasoning_output_tokens: 0, total_tokens: cumulative,
      },
    },
  },
});

/**
 * Codex 0.147.0's token_count: the same record with a sixth key,
 * `cache_write_input_tokens`, in both usage blocks.
 *
 * Pinned separately because the two CLI versions are mutually exclusive per
 * rollout file, so a mapper that only handled one shape would be silently
 * correct on half the machines in the wild.
 */
const tokenCount147 = (lastTotal: number, cumulative: number): Rollout => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {},
    info: {
      model_context_window: CODEX_WINDOW,
      last_token_usage: {
        input_tokens: lastTotal - 315, cached_input_tokens: 17_152, cache_write_input_tokens: 0,
        output_tokens: 315, reasoning_output_tokens: 119, total_tokens: lastTotal,
      },
      total_token_usage: {
        input_tokens: cumulative - 315, cached_input_tokens: 17_152, cache_write_input_tokens: 0,
        output_tokens: 315, reasoning_output_tokens: 119, total_tokens: cumulative,
      },
    },
  },
});

/**
 * The record written when the user rewinds the conversation: every per-request
 * component zero, `total_tokens` restated to the recomputed context size, and
 * `total_token_usage` untouched because no request was made.
 */
const tokenCountAfterRollback: Rollout = {
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {},
    info: {
      model_context_window: CODEX_WINDOW,
      last_token_usage: {
        input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
        reasoning_output_tokens: 0, total_tokens: 47_355,
      },
      total_token_usage: {
        input_tokens: 1_385_398, cached_input_tokens: 58_112, output_tokens: 58_746,
        reasoning_output_tokens: 41, total_tokens: 1_444_144,
      },
    },
  },
};

// ── driving the real functions ──────────────────────────────────────────────

let seq = 0;

function feed(state: GraphState, at: number, obj: Rollout): { state: GraphState; payload: HookPayload | null } {
  const payload = codexObjToPayload(obj, SESSION, CWD);
  if (!payload) return { state, payload: null };
  seq++;
  const env: HookEnvelope = { seq, receivedAt: at, source: "codex", payload };
  return { state: applyEvent(state, env), payload };
}

/** A live Codex session with its root on the board, the way the watcher opens
 *  one: the lazy SessionStart, then the rollout's own lines. */
function session(): GraphState {
  seq = 1;
  return applyEvent(initialState(), {
    seq,
    receivedAt: T0,
    source: "codex",
    payload: { session_id: SESSION, cwd: CWD, provider: "codex", hook_event_name: "SessionStart" },
  });
}

const root = (state: GraphState) => state.agents.get(SESSION)!;

/** The donut's own gate, spelled the way AgentNode spells it. Copied rather than
 *  imported because AgentNode renders through React Flow and this suite has no
 *  DOM; what is asserted below is therefore the STATE the gate reads, which is
 *  the half that was broken. */
const donutDraws = (state: GraphState, id = SESSION): boolean => {
  const a = state.agents.get(id);
  return !!a && a.kind === "root" && (a.context?.currentContextTokens ?? 0) > 0;
};

/** Send a synthetic payload straight to the reducer, for the Claude comparisons
 *  that have no rollout line to come from. */
function send(state: GraphState, payload: HookPayload): GraphState {
  seq++;
  return applyEvent(state, { seq, receivedAt: T0, source: "internal", payload });
}

// ── what the mapper now takes off a token_count ─────────────────────────────

describe("codexObjToPayload reads all three numbers on a token_count", () => {
  it("carries occupancy and window on Codex 0.144.5's five-key record", () => {
    const p = codexObjToPayload(tokenCount144(17_605, 17_605), SESSION, CWD)!;
    expect(p).toMatchObject({
      hook_event_name: "UsageObserved",
      session_id: SESSION,
      provider: "codex",
      context_tokens: 17_605,
      model_context_window: CODEX_WINDOW,
    });
    // The field it always read is untouched: this is additive, not a swap.
    expect(p.usage).toMatchObject({ total_tokens: 17_605 });
  });

  it("carries them on Codex 0.147.0's six-key record too", () => {
    // 0.147 adds cache_write_input_tokens to both usage blocks. The two versions
    // are mutually exclusive per rollout file, so handling one is handling half.
    const p = codexObjToPayload(tokenCount147(22_795, 76_304), SESSION, CWD)!;
    expect(p).toMatchObject({ context_tokens: 22_795, model_context_window: CODEX_WINDOW });
    expect(p.usage).toMatchObject({ total_tokens: 76_304, cache_write_input_tokens: 0 });
  });

  it("takes last_token_usage and not the cumulative total beside it", () => {
    // The distinction the whole fix turns on. At this point in the sampled
    // session the deck had spent 5,238,700 tokens against a 258,400 window; the
    // context held 112,731. A donut drawn from the cumulative figure would have
    // been pinned at 100% from the third turn of every session onwards.
    const p = codexObjToPayload(tokenCount144(112_731, 5_238_700), SESSION, CWD)!;
    expect(p.context_tokens).toBe(112_731);
    expect(p.context_tokens).not.toBe(5_238_700);
  });

  it("reports the recomputed size after a rollback, not zero", () => {
    // The one record in 178 where total_tokens is not input + output. Reading
    // input_tokens here would drop the donut to 0% on a session still holding
    // 47,355 tokens.
    const p = codexObjToPayload(tokenCountAfterRollback, SESSION, CWD)!;
    expect(p.context_tokens).toBe(47_355);
  });

  it("still maps task_started to a ModelObserved carrying the window", () => {
    // #395's report pins that the window lands on the root from here. It is now
    // the earlier of two carriers rather than the only one, and it stays.
    expect(codexObjToPayload(taskStarted, SESSION, CWD)).toMatchObject({
      hook_event_name: "ModelObserved",
      model_context_window: CODEX_WINDOW,
    });
  });

  it("emits nothing for a token_count that states none of the three", () => {
    // An empty envelope in the ring buffer and in the persisted log is a cost
    // every future reader pays to skip.
    expect(codexObjToPayload({ type: "event_msg", payload: { type: "token_count", info: {} } }, SESSION, CWD)).toBeNull();
    expect(codexObjToPayload({ type: "event_msg", payload: { type: "token_count" } }, SESSION, CWD)).toBeNull();
  });
});

// ── what the reducer does with them ─────────────────────────────────────────

describe("a Codex session lights the context donut", () => {
  it("does not draw one before any token_count", () => {
    // The pre-fix state of every Codex session, forever.
    const s = feed(feed(session(), T0, turnContext).state, T0 + 1_000, taskStarted).state;
    expect(root(s).context?.currentContextTokens ?? 0).toBe(0);
    expect(donutDraws(s)).toBe(false);
  });

  it("draws one from the first token_count, on both CLI versions", () => {
    for (const line of [tokenCount144(17_605, 17_605), tokenCount147(17_605, 17_605)]) {
      let s = feed(session(), T0, turnContext).state;
      s = feed(s, T0 + 1_000, taskStarted).state;
      s = feed(s, T0 + 2_000, line).state;
      expect(root(s).context?.currentContextTokens).toBe(17_605);
      expect(donutDraws(s)).toBe(true);
    }
  });

  it("tracks the occupancy up as the session fills", () => {
    // The four token_counts of a real 0.147 session, in order.
    let s = feed(session(), T0, turnContext).state;
    s = feed(s, T0 + 1_000, taskStarted).state;
    const seen: number[] = [];
    [17_605, 17_747, 18_157, 22_795].forEach((n, i) => {
      s = feed(s, T0 + 2_000 + i * 1_000, tokenCount147(n, 17_605 * (i + 1))).state;
      seen.push(root(s).context!.currentContextTokens);
    });
    expect(seen).toEqual([17_605, 17_747, 18_157, 22_795]);
  });

  it("scales the ring against the CLI's window and not the static table", () => {
    // The failure #171 was written for, now reachable. 112,731 tokens is 43.6%
    // of what Codex says its window is and 10.7% of what the table guesses.
    let s = feed(session(), T0, turnContext).state;
    // task_started is what carries the model onto the root — the fallback table
    // is keyed on it, so a test that skipped it would be comparing the live
    // window against the deck's answer for "no model at all".
    s = feed(s, T0 + 1_000, taskStarted).state;
    s = feed(s, T0 + 2_000, tokenCount144(112_731, 5_238_700)).state;
    const a = root(s);
    expect(a.model).toBe("gpt-5.6-sol");
    const live = effectiveContextWindow(a.contextWindow, a.model);
    expect(live).toBe(CODEX_WINDOW);
    expect(contextWindowForModel(a.model)).toBe(1_050_000);
    expect(Math.round((a.context!.currentContextTokens / live) * 100)).toBe(44);
    expect(Math.round((a.context!.currentContextTokens / contextWindowForModel(a.model)) * 100)).toBe(11);
  });

  it("gets the window from a token_count with no task_started in sight", () => {
    // The ordinary case, not an exotic one: the watcher skips a pre-existing
    // session's history at startup, so a deck opened mid-turn sees token_counts
    // long before the next turn begins. task_started used to be the only carrier.
    const s = feed(session(), T0, tokenCount144(17_605, 17_605)).state;
    expect(root(s).contextWindow).toBe(CODEX_WINDOW);
  });

  it("leaves a Codex session with a zeroed context without a donut", () => {
    // 0 is written rather than skipped, and the gate — not the reducer — is what
    // takes the ring away, so an emptied context reads as empty and not as stale.
    let s = feed(session(), T0, tokenCount144(17_605, 17_605)).state;
    expect(donutDraws(s)).toBe(true);
    s = send(s, { hook_event_name: "UsageObserved", session_id: SESSION, provider: "codex", context_tokens: 0 });
    expect(root(s).context!.currentContextTokens).toBe(0);
    expect(donutDraws(s)).toBe(false);
  });

  it("ignores a window or an occupancy that is not a number", () => {
    // A provider that reported either as a string would be a lie the donut must
    // not believe.
    let s = feed(session(), T0, tokenCount144(17_605, 17_605)).state;
    s = send(s, {
      hook_event_name: "UsageObserved", session_id: SESSION, provider: "codex",
      context_tokens: "99999" as unknown as number,
      model_context_window: "1" as unknown as number,
    });
    expect(root(s).context!.currentContextTokens).toBe(17_605);
    expect(root(s).contextWindow).toBe(CODEX_WINDOW);
  });
});

// ── the breakdown is merged, not rebuilt ────────────────────────────────────

describe("ContextObserved composes with the occupancy instead of erasing it", () => {
  const files = [{ path: "/repo/AGENTS.md", bytes: 812 }];

  it("keeps the memory files when the next token_count lands", () => {
    let s = feed(session(), T0, tokenCount144(17_605, 17_605)).state;
    s = send(s, { hook_event_name: "ContextObserved", session_id: SESSION, provider: "codex", context: { memoryFiles: files } });
    s = feed(s, T0 + 3_000, tokenCount144(22_795, 76_304)).state;
    expect(root(s).context!.memoryFiles).toEqual(files);
    expect(root(s).context!.currentContextTokens).toBe(22_795);
  });

  it("keeps the occupancy when the memory scan lands after it", () => {
    // The two producers race every 1.5 seconds; whichever order they arrive in
    // has to leave both facts standing.
    let s = feed(session(), T0, tokenCount144(22_795, 76_304)).state;
    s = send(s, { hook_event_name: "ContextObserved", session_id: SESSION, provider: "codex", context: { memoryFiles: files } });
    expect(root(s).context!.currentContextTokens).toBe(22_795);
    expect(root(s).context!.memoryFiles).toEqual(files);
  });

  it("still reads a log written under the old key name", () => {
    // The deck replays its own persisted JSONL at boot, and a log written before
    // this change spells the list `claudeMdFiles`.
    const s = send(session(), {
      hook_event_name: "ContextObserved", session_id: SESSION,
      context: { claudeMdFiles: [{ path: "/repo/CLAUDE.md", bytes: 40 }] },
    });
    expect(root(s).context!.memoryFiles).toEqual([{ path: "/repo/CLAUDE.md", bytes: 40 }]);
  });
});

describe("the Claude path is unchanged", () => {
  const CLAUDE_SESSION = "c0ffee00-0000-4000-8000-000000000001";
  const claudeRoot = () => {
    seq = 100;
    return applyEvent(initialState(), {
      seq, receivedAt: T0, source: "hook",
      payload: { session_id: CLAUDE_SESSION, cwd: CWD, hook_event_name: "SessionStart" },
    });
  };

  it("lands a full transcript breakdown exactly as before", () => {
    const s = applyEvent(claudeRoot(), {
      seq: 101, receivedAt: T0, source: "internal",
      payload: {
        hook_event_name: "ContextObserved", session_id: CLAUDE_SESSION,
        context: {
          msgsUser: 12, msgsAssistant: 9, toolUses: 30, toolResults: 29,
          systemReminders: 4, currentContextTokens: 84_000,
          memoryFiles: [{ path: "/repo/CLAUDE.md", bytes: 2_048 }],
        },
      },
    });
    expect(s.agents.get(CLAUDE_SESSION)!.context).toEqual({
      msgsUser: 12, msgsAssistant: 9, toolUses: 30, toolResults: 29,
      systemReminders: 4, currentContextTokens: 84_000,
      memoryFiles: [{ path: "/repo/CLAUDE.md", bytes: 2_048 }],
    });
  });

  it("no longer zeroes the counts when only the file list arrives", () => {
    // maybeResolveContext sends the file list with no breakdown whenever the
    // transcript has not been folded yet, and that used to reset five counts and
    // the occupancy to 0 — a Claude bug the merge fixes on the way past.
    let s = applyEvent(claudeRoot(), {
      seq: 102, receivedAt: T0, source: "internal",
      payload: {
        hook_event_name: "ContextObserved", session_id: CLAUDE_SESSION,
        context: { msgsUser: 12, msgsAssistant: 9, toolUses: 30, toolResults: 29, systemReminders: 4, currentContextTokens: 84_000, memoryFiles: [] },
      },
    });
    s = applyEvent(s, {
      seq: 103, receivedAt: T0, source: "internal",
      payload: {
        hook_event_name: "ContextObserved", session_id: CLAUDE_SESSION,
        context: { memoryFiles: [{ path: "/repo/CLAUDE.md", bytes: 2_048 }] },
      },
    });
    expect(s.agents.get(CLAUDE_SESSION)!.context!.currentContextTokens).toBe(84_000);
    expect(s.agents.get(CLAUDE_SESSION)!.context!.msgsUser).toBe(12);
  });
});

// ── which memory file each CLI actually reads ───────────────────────────────

describe("the memory scan follows the provider", () => {
  // A nested checkout so the walk has more than one level to find, plus one
  // decoy of the other ecosystem's filename at each level.
  const REPO = join(SANDBOX, "repo");
  const NESTED = join(REPO, "packages", "web");
  mkdirSync(NESTED, { recursive: true });
  mkdirSync(FAKE_CODEX_HOME, { recursive: true });
  writeFileSync(join(REPO, "AGENTS.md"), "root agents\n");
  writeFileSync(join(REPO, "CLAUDE.md"), "root claude\n");
  writeFileSync(join(NESTED, "AGENTS.md"), "nested agents\n");
  writeFileSync(join(NESTED, "CLAUDE.md"), "nested claude\n");
  writeFileSync(join(FAKE_CODEX_HOME, "AGENTS.md"), "global agents\n");
  // A zero-byte file contributes nothing to a context window, so listing it
  // would have the reader hunting for bytes it does not cost.
  writeFileSync(join(REPO, "packages", "AGENTS.md"), "");

  it("finds AGENTS.md nearest-first up from cwd for a Codex session", async () => {
    const found = (await scan(scanAgentsMdFiles, "scanAgentsMdFiles")(NESTED)).map(f => f.path);
    expect(found).toContain(join(NESTED, "AGENTS.md"));
    expect(found).toContain(join(REPO, "AGENTS.md"));
    expect(found.indexOf(join(NESTED, "AGENTS.md"))).toBeLessThan(found.indexOf(join(REPO, "AGENTS.md")));
  });

  it("includes $CODEX_HOME/AGENTS.md, wherever CODEX_HOME points", async () => {
    // Read through codex-dir.mjs like every other Codex path in the process
    // (#375), so a relocated Codex home is honoured without a sixth spelling.
    const found = (await scan(scanAgentsMdFiles, "scanAgentsMdFiles")(NESTED)).map(f => f.path);
    expect(found).toContain(join(FAKE_CODEX_HOME, "AGENTS.md"));
  });

  it("never reports CLAUDE.md to a Codex session", async () => {
    // Codex does not read it. Verified against every rollout under this
    // machine's CODEX_HOME: `AGENTS.md` on 9 lines across 5 of 8 files,
    // `CLAUDE.md` on none.
    const found = (await scan(scanAgentsMdFiles, "scanAgentsMdFiles")(NESTED)).map(f => f.path);
    expect(found.some(p => p.endsWith("CLAUDE.md"))).toBe(false);
  });

  it("skips an empty file rather than listing a zero-cost row", async () => {
    const found = (await scan(scanAgentsMdFiles, "scanAgentsMdFiles")(NESTED)).map(f => f.path);
    expect(found).not.toContain(join(REPO, "packages", "AGENTS.md"));
  });

  it("never reports AGENTS.md to a Claude session", async () => {
    // The mirror image, and the reason the two scanners are exported together:
    // one walk, two filenames, and neither may drift into the other's.
    const found = (await scan(scanClaudeMdFiles, "scanClaudeMdFiles")(NESTED)).map(f => f.path);
    expect(found).toContain(join(NESTED, "CLAUDE.md"));
    expect(found).toContain(join(REPO, "CLAUDE.md"));
    expect(found.some(p => p.endsWith("AGENTS.md"))).toBe(false);
  });

  it("answers with nothing rather than throwing on a cwd it was never given", async () => {
    expect(await scan(scanAgentsMdFiles, "scanAgentsMdFiles")("")).toEqual([]);
    expect(await scan(scanAgentsMdFiles, "scanAgentsMdFiles")(undefined as unknown as string)).toEqual([]);
  });
});

// ── what the modal says once it can be opened ───────────────────────────────

describe("ContextModal copy follows the provider", () => {
  it("names AGENTS.md at a Codex session and CLAUDE.md at a Claude one", () => {
    const codex = copyFor("codex");
    const claude = copyFor("claude");
    // Unlocking the donut without this ships a new copy bug: the modal would
    // tell a Codex user "No CLAUDE.md files found on the path from cwd to
    // ~/.claude", naming a file and a directory Codex does not use.
    expect(codex.memoryHeading).toContain("AGENTS.md");
    expect(codex.memoryHeading).not.toContain("CLAUDE.md");
    expect(codex.memoryEmpty).toContain("AGENTS.md");
    expect(codex.memoryEmpty).toContain("$CODEX_HOME");
    expect(codex.memoryEmpty).not.toContain("~/.claude");
    expect(claude.memoryHeading).toContain("CLAUDE.md");
    expect(claude.memoryEmpty).toContain("~/.claude");
    expect(claude.memoryEmpty).not.toContain("AGENTS.md");
  });

  it("does not call the Codex figure an approximation of CC's /context", () => {
    // It is neither an approximation nor CC's. Both halves of that sentence are
    // false for a session whose CLI states the number itself.
    expect(copyFor("codex").subtitle).not.toContain("/context");
    expect(copyFor("codex").subtitle).not.toContain("approximation");
    expect(copyFor("claude").subtitle).toContain("approximation");
  });

  it("says the composition is not counted for Codex rather than printing zeroes", () => {
    // The refusal, in the slot the answer would have gone — the shape #398 gave
    // a Codex session's approval state. Five zeroes beside a card already
    // showing a real tool count would read as a broken panel, and a context
    // breakdown cannot afford to be confidently wrong about what is in the
    // window.
    expect(copyFor("codex").compositionCounted).toBe(false);
    expect(copyFor("codex").compositionUncounted).not.toBe("");
    expect(copyFor("claude").compositionCounted).toBe(true);
  });

  it("treats a session with no provider as Claude", () => {
    // Events persisted before multi-provider support carry no provider field.
    expect(copyFor(undefined)).toEqual(copyFor("claude"));
  });
});
