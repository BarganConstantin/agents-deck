// #395: a finished Codex session read as live for ninety minutes.
//
// Codex writes no Stop and no SessionEnd, so the ONLY thing that ever settled a
// Codex root was `sweepStaleSessions` — the ninety-minute silence reaper #350
// built for terminals that were killed. A turn that ended cleanly at 10:00 kept
// its inflight treatment, kept counting toward the topbar's running total and
// kept the favicon saying "running" until 11:30, at which point it flipped to
// done with a backdated `endedAt` and `reaped = true`, the flag that means the
// sweep GUESSED. It had not guessed. The session finished and the deck was told:
// `event_msg/task_complete` was sitting in the rollout, and `codexObjToPayload`
// dropped it on the floor with everything else it did not recognise.
//
// What the rollouts actually say, sampled across the eight files under this
// machine's CODEX_HOME (structural names only):
//
//    55  event_msg/task_started      one per turn, both CLI versions
//    54  event_msg/task_complete     the turn finished
//     1  event_msg/turn_aborted      the turn was interrupted (Esc)
//
// 54 + 1 = 55: every started turn ends with exactly one of the two, so the pair
// is exhaustive and both map to `Stop`. Per TURN, not per session — which is the
// same shape Claude has, where the Stop hook fires at the end of every turn and
// the next `UserPromptSubmit` reopens the root.
//
// The catch this file exists to pin: the prompt event that reopens a Codex root
// was RENAMED between CLI versions. 0.144 writes `event_msg/user_message`; 0.147
// writes `event_msg/item_completed` carrying a `UserMessage` item and no
// `user_message` at all. Mapping only the old name would have traded "live
// forever" for "done forever" on current Codex — a session settling at the end
// of turn one and never coming back. Both names are mapped, and both are driven
// here.
//
// No DOM — plain node, vitest — so this drives the real translation function and
// the real reducer, with the object shapes copied from real rollout lines.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  STALE_SESSION_MS,
  sweepStaleSessions,
  type GraphState,
} from "../reducer";
import { runningSessionCount } from "../ambient-counts";
import type { HookEnvelope, HookPayload } from "../types";
// @ts-expect-error — .mjs server module, no types
import { codexObjToPayload } from "../../server/index.mjs";

const SESSION = "01a00e9e-1905-7093-bca2-efa3b1d07752";
const CWD = "/repo";
const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** One rollout line, as Codex appends it. */
type Rollout = { type: string; payload: Record<string, unknown> };

// ── the real rollout shapes, keys verbatim from ~/.codex/sessions ────────────

const turnContext: Rollout = { type: "turn_context", payload: { model: "gpt-5-codex" } };

const taskStarted = (turnId: string): Rollout => ({
  type: "event_msg",
  payload: { type: "task_started", turn_id: turnId, started_at: 0, model_context_window: 258_400, collaboration_mode_kind: "default" },
});

/** Codex ≤ 0.144: the submission is its own event. */
const userMessage = (text: string): Rollout => ({
  type: "event_msg",
  payload: { type: "user_message", message: text, kind: "plain" },
});

/** Codex ≥ 0.147: the same submission, as a completed UserMessage item. */
const userItem = (text: string): Rollout => ({
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: SESSION,
    turn_id: "t-1",
    item: { type: "UserMessage", id: "item_0", content: [{ type: "text", text, text_elements: [] }] },
  },
});

const tokenCount: Rollout = {
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 } } },
};

const taskComplete = (turnId: string): Rollout => ({
  type: "event_msg",
  payload: { type: "task_complete", turn_id: turnId, last_agent_message: "done", started_at: 0, completed_at: 1, duration_ms: 9_600, time_to_first_token_ms: 1_713 },
});

const turnAborted = (turnId: string): Rollout => ({
  type: "event_msg",
  payload: { type: "turn_aborted", turn_id: turnId, reason: "interrupted", completed_at: 1, duration_ms: 14_825 },
});

/** The only thing Codex writes BETWEEN a turn ending and the next one starting,
 *  which makes the turn boundary unambiguous — and it must stay unmapped. */
const threadSettings: Rollout = { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: {} } };

// ── driving the two real functions ──────────────────────────────────────────

let seq = 0;

/** Translate a rollout line the way the watcher does, then feed whatever comes
 *  out to the reducer. Returns the payload so a test can assert the mapping and
 *  the resulting state in the same step. */
function feed(state: GraphState, at: number, obj: Rollout): { state: GraphState; payload: HookPayload | null } {
  const payload = codexObjToPayload(obj, SESSION, CWD) as HookPayload | null;
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

/** Replay a whole rollout, one line per second from `from`. */
function replay(state: GraphState, from: number, lines: Rollout[]): GraphState {
  let s = state;
  lines.forEach((line, i) => { s = feed(s, from + i * 1_000, line).state; });
  return s;
}

describe("what codexObjToPayload makes of a turn's end", () => {
  it("maps task_complete to Stop", () => {
    const p = codexObjToPayload(taskComplete("turn-1"), SESSION, CWD);
    expect(p).toMatchObject({ hook_event_name: "Stop", session_id: SESSION, cwd: CWD, provider: "codex" });
  });

  it("maps turn_aborted to Stop as well — an interrupted turn is over too", () => {
    // Esc is the case the user is most likely to be watching the deck for.
    const p = codexObjToPayload(turnAborted("turn-1"), SESSION, CWD);
    expect(p).toMatchObject({ hook_event_name: "Stop", session_id: SESSION, cwd: CWD, provider: "codex" });
  });

  it("emits no SessionEnd, because Codex never says the session is over", () => {
    // A rollout just stops growing when the terminal goes away. Synthesising a
    // SessionEnd from a turn ending would close a session that is still open.
    for (const line of [taskComplete("t"), turnAborted("t"), threadSettings]) {
      const p = codexObjToPayload(line, SESSION, CWD) as HookPayload | null;
      expect(p?.hook_event_name).not.toBe("SessionEnd");
    }
  });

  it("still ignores the lines that are not turn boundaries", () => {
    // thread_settings_applied is the one thing that lands between two turns; an
    // item_completed that is not the user's message belongs to #397's tool work
    // and is deliberately untouched here.
    expect(codexObjToPayload(threadSettings, SESSION, CWD)).toBeNull();
    expect(codexObjToPayload({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "CommandExecution", id: "i1", exit_code: 0 } },
    }, SESSION, CWD)).toBeNull();
  });
});

describe("what codexObjToPayload makes of a turn's start", () => {
  it("maps Codex 0.144's user_message to UserPromptSubmit", () => {
    expect(codexObjToPayload(userMessage("ship it"), SESSION, CWD))
      .toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "ship it" });
  });

  it("maps Codex 0.147's UserMessage item to the same thing", () => {
    // The rename is why the fix is two mappings and not one: without this, a
    // 0.147 session settles at the end of turn one and never reopens.
    expect(codexObjToPayload(userItem("what did I do in that branch"), SESSION, CWD))
      .toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "what did I do in that branch" });
  });

  it("joins the item's content parts rather than indexing one", () => {
    const split: Rollout = {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", id: "i", content: [{ type: "text", text: "ship " }, { type: "image" }, { type: "text", text: "it" }] },
      },
    };
    expect(codexObjToPayload(split, SESSION, CWD)).toMatchObject({ prompt: "ship it" });
  });
});

describe("a Codex turn that completes", () => {
  const rollout = (prompt: Rollout) => [turnContext, taskStarted("turn-1"), prompt, tokenCount, taskComplete("turn-1")];

  for (const [version, prompt] of [["0.144", userMessage("ship it")], ["0.147", userItem("ship it")]] as const) {
    it(`settles the root at the moment it finished, with no reaped flag (Codex ${version})`, () => {
      const state = replay(session(), T0, rollout(prompt));
      // Four lines mapped to events; the last one is the Stop, one second apart.
      const endedAt = T0 + 4 * 1_000;
      expect(root(state).state).toBe("done");
      expect(root(state).endedAt).toBe(endedAt);
      // The whole point: a finish, not a guess. `reaped` is what the UI reads to
      // say the sweep gave up on this session.
      expect(root(state).reaped).toBeFalsy();
      // And it stops holding the favicon and the topbar's running total the
      // moment it ends, through the counter the app itself runs (#377).
      expect(runningSessionCount(state.agents.values())).toBe(0);
    });
  }

  it("is settled within one watcher tick rather than after ninety minutes", () => {
    // The reaper is the thing being taken off this path. Before the fix the only
    // way this root ever left `active` was the sweep, ninety minutes later.
    const state = replay(session(), T0, rollout(userItem("ship it")));
    expect(root(state).state).toBe("done");
    expect(sweepStaleSessions(state, T0 + 5 * 60 * MIN, STALE_SESSION_MS)).toBe(false);
    expect(root(state).reaped).toBeFalsy();
    // The sweep must not rewrite the ending it did not produce, either.
    expect(root(state).endedAt).toBe(T0 + 4 * 1_000);
  });

  it("survives the token_count that lands after it in some rollouts", () => {
    // Ordering is not fixed: token_count usually precedes task_complete but not
    // always. UsageObserved touches usage only and must not reopen the root.
    let state = replay(session(), T0, rollout(userItem("ship it")));
    state = feed(state, T0 + 10_000, tokenCount).state;
    expect(root(state).state).toBe("done");
    expect(root(state).endedAt).toBe(T0 + 4 * 1_000);
  });

  it("settles the same way when the human interrupts it", () => {
    const state = replay(session(), T0, [turnContext, taskStarted("turn-1"), userItem("ship it"), turnAborted("turn-1")]);
    expect(root(state).state).toBe("done");
    expect(root(state).reaped).toBeFalsy();
  });
});

describe("a second prompt in a session whose last turn finished", () => {
  it("brings the root back to active without forking a second node", () => {
    // Turn one ends at T0+4s; the human types again three hours later, which is
    // well past the reaper's threshold and exactly the case that used to look
    // like a dead session.
    let state = replay(session(), T0, [turnContext, taskStarted("turn-1"), userItem("hi"), tokenCount, taskComplete("turn-1")]);
    expect(root(state).state).toBe("done");
    const before = state.agents.size;

    const t2 = T0 + 3 * 60 * MIN;
    state = replay(state, t2, [threadSettings, taskStarted("turn-2"), userItem("ok")]);
    expect(root(state).state).toBe("active");
    expect(root(state).endedAt).toBeUndefined();
    expect(root(state).exitAt).toBeUndefined();
    expect(state.agents.size).toBe(before);
    expect(runningSessionCount(state.agents.values())).toBe(1);

    // …and ends again on its own task_complete, still without a reaped flag.
    state = replay(state, t2 + 10_000, [tokenCount, taskComplete("turn-2")]);
    expect(root(state).state).toBe("done");
    expect(root(state).reaped).toBeFalsy();
    expect(root(state).endedAt).toBe(t2 + 10_000 + 1_000);
  });

  it("records both prompts, one per turn, on either CLI version", () => {
    let state = replay(session(), T0, [turnContext, taskStarted("t1"), userItem("first"), taskComplete("t1")]);
    state = replay(state, T0 + 60_000, [threadSettings, taskStarted("t2"), userMessage("second"), taskComplete("t2")]);
    expect(root(state).prompts.map(p => p.text)).toEqual(["first", "second"]);
  });

  it("is not reopened by the lines that merely sit between two turns", () => {
    // thread_settings_applied maps to nothing and task_started maps to
    // ModelObserved, which the reducer deliberately does not treat as the
    // session moving. Only the prompt reopens the root.
    let state = replay(session(), T0, [turnContext, taskStarted("t1"), userItem("hi"), taskComplete("t1")]);
    state = replay(state, T0 + 60_000, [threadSettings, taskStarted("t2")]);
    expect(root(state).state).toBe("done");
    // The context window still lands off task_started — that plumbing is
    // untouched by this fix.
    expect(root(state).contextWindow).toBe(258_400);
  });
});

describe("a Codex session that dies mid-turn", () => {
  it("is still reaped at ninety minutes, and still flagged as a guess", () => {
    // The terminal was closed while the turn was running, so no task_complete
    // and no turn_aborted will ever be written. This is the case #350 built the
    // sweep for and it has to keep working — the fix takes the honest finishes
    // off the reaper's plate, it does not weaken the reaper.
    const state = replay(session(), T0, [turnContext, taskStarted("turn-1"), userItem("ship it")]);
    const lastEvent = T0 + 2 * 1_000;
    expect(root(state).state).toBe("active");

    expect(sweepStaleSessions(state, lastEvent + STALE_SESSION_MS, STALE_SESSION_MS)).toBe(false);
    expect(root(state).state).toBe("active");

    expect(sweepStaleSessions(state, lastEvent + STALE_SESSION_MS + 1, STALE_SESSION_MS)).toBe(true);
    expect(root(state).state).toBe("done");
    expect(root(state).reaped).toBe(true);
    expect(root(state).endedAt).toBe(lastEvent);
  });

  it("comes back if the terminal turns out to have been alive after all", () => {
    // The un-reap still works for Codex: the late task_complete both revives the
    // session and settles it honestly, clearing the guess it was reaped under.
    const state = replay(session(), T0, [turnContext, taskStarted("turn-1"), userItem("ship it")]);
    sweepStaleSessions(state, T0 + 2 * 60 * MIN, STALE_SESSION_MS);
    expect(root(state).reaped).toBe(true);

    const late = feed(state, T0 + 3 * 60 * MIN, taskComplete("turn-1")).state;
    expect(root(late).state).toBe("done");
    expect(root(late).reaped).toBe(false);
    expect(root(late).endedAt).toBe(T0 + 3 * 60 * MIN);
  });
});
