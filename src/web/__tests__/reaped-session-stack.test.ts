// #442. `sweepStaleSessions` is the stand-in for a `Stop` that never arrived,
// and it used to do only half of what `Stop` does. It settled the root, it
// settled the subagents — and it left the session's `activeSubagentStack`
// exactly as it found it.
//
// A key left on that stack is not inert. `resolveOwner` reads the stack top for
// every event that names no subagent, which is all of the real
// `UserPromptSubmit` and `Pre`/`PostToolUse` traffic, so after a reap the
// human's next prompt and every root-level tool call of the resumed turn were
// drawn on the card of a subagent that had finished two hours earlier. Nothing
// downstream undid it either: `UserPromptSubmit` retires the settled subagent
// and then un-retires it four lines later through `resolveOwner`, both pruners
// decline a node that is `active` again, and `popActive` removes only its own
// key — so the stale one waits UNDERNEATH the next legitimate `SubagentStart`
// and comes back as stack top the moment that one stops.
//
// The premise that makes clearing safe is the sweep's own and is stronger here
// than at `Stop`: a subagent doing long work emits its own Pre/PostToolUse under
// this session id, and each of those stamps the root's `lastEventAt`, so a
// session that reached STALE_SESSION_MS of TOTAL silence has nothing live under
// it whatever the stack still says.
//
// The second half of this file is the interaction #350 left behind. A late event
// un-reaps the ROOT and deliberately does not resurrect the subagents, so the
// stack must stay empty across that recovery: restoring it would hand the
// resumed session's whole turn back to a `done` node, which is the bug above
// re-created by the fix for the session dying. A subagent that really did
// survive re-announces itself, and `pushActive` puts it back the documented way.
//
// No DOM — plain node, vitest — so this drives the reducer directly.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  pruneDoneSessions,
  pruneOldAgents,
  STALE_SESSION_MS,
  sweepStaleSessions,
  sweepStaleTools,
  type GraphState,
} from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-442";
const SUB = `${SESSION}::A`;
const MIN = 60_000;
const SEC = 1_000;
/** Where every scenario starts, so "T0 + 3 hours" is a readable number. */
const T0 = 1_700_000_000_000;

let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: payload.provider === "codex" ? "codex" : "hook",
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

/** The exact shape the issue describes: a turn that started a subagent whose
 *  `SubagentStop` never reached the server — a fire-and-forget POST sent while
 *  the server was restarting, or a terminal killed while the human was away
 *  from a permission prompt — and then went quiet. The subagent's own tool call
 *  is answered, so nothing here depends on `sweepStaleTools` having run. */
function abandoned(): GraphState {
  seq = 0;
  let state = send(initialState(), T0, { hook_event_name: "SessionStart", cwd: "/repo" });
  state = send(state, T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "first prompt" });
  state = send(state, T0 + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "explorer" });
  state = send(state, T0 + 3 * SEC, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" });
  return send(state, T0 + 4 * SEC, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "t1", tool_response: "ok" });
}

/** The moment the sweep runs: ninety minutes of silence and then some. */
const REAPED_AT = T0 + 3 * 60 * MIN;

const root = (state: GraphState) => state.agents.get(SESSION)!;
const sub = (state: GraphState) => state.agents.get(SUB)!;
const names = (state: GraphState, id: string) => state.agents.get(id)!.tools.map(t => t.name);

describe("a session reaped with a subagent still on its attribution stack", () => {
  it("leaves no key behind on the stack", () => {
    const state = abandoned();
    // The stranded key really is there before the sweep — otherwise the
    // assertion below would pass for the wrong reason.
    expect(state.activeSubagentStack.get(SESSION)).toEqual(["A"]);

    expect(sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS)).toBe(true);

    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();
    expect(state.activeSubagentStack.size).toBe(0);
    // What the reap settles is unchanged — this is only about the stack.
    expect(root(state).state).toBe("done");
    expect(root(state).reaped).toBe(true);
    expect(sub(state).state).toBe("done");
    expect(sub(state).endedAt).toBe(T0 + 4 * SEC);
  });

  it("attributes the prompt after the reap to the root, not to the dead subagent", () => {
    // The user-visible failure, end to end: the human comes back and types. That
    // `UserPromptSubmit` carries no `agent_id`, so where it lands is decided
    // entirely by what the sweep left on the stack.
    let state = abandoned();
    sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS);

    state = send(state, REAPED_AT + SEC, { hook_event_name: "UserPromptSubmit", prompt: "second prompt after coming back" });
    state = send(state, REAPED_AT + 2 * SEC, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t2" });

    expect(root(state).prompts.map(p => p.text)).toEqual(["first prompt", "second prompt after coming back"]);
    expect(sub(state).prompts).toEqual([]);
    // The root's own tool call draws under the root for the rest of the turn.
    expect(names(state, SESSION)).toEqual(["Bash"]);
    expect(names(state, SUB)).toEqual(["Read"]);
    // And the subagent stays finished: the retirement `UserPromptSubmit` stamps
    // on it now sticks instead of being undone by the `resolveOwner` call in the
    // same event.
    expect(sub(state).state).toBe("done");
    expect(sub(state).endedAt).toBe(T0 + 4 * SEC);
    expect(sub(state).exitAt).toBe(REAPED_AT + SEC);
  });

  it("hands the resumed session back to the pruners", () => {
    // The zombie was unreclaimable, which is why this was not merely cosmetic: a
    // subagent flipped back to `active` fails `pruneOldAgents`' `state === "done"`
    // test and keeps `pruneDoneSessions` off the whole tree, so the node survived
    // every eviction pass the deck has for as long as the terminal kept the
    // session fresh. Cap 0 and grace 0 is the most aggressive either pruner gets.
    let state = abandoned();
    sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS);
    state = send(state, REAPED_AT + SEC, { hook_event_name: "UserPromptSubmit", prompt: "second prompt after coming back" });

    expect(state.agents.size).toBe(2);
    expect(pruneOldAgents(state, REAPED_AT + 2 * SEC, 0, 0)).toBe(true);
    expect(state.agents.has(SUB)).toBe(false);
    // The root is alive again and is not evicted with it.
    expect(state.agents.has(SESSION)).toBe(true);
    expect(root(state).state).toBe("active");
  });

  it("does not leave a key hiding under the next legitimate subagent", () => {
    // `popActive` removes only its own key, so a stale one is not confined to the
    // turn that stranded it: it sits below whatever starts next and resurfaces as
    // stack top the moment that newer subagent stops.
    let state = abandoned();
    sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS);
    state = send(state, REAPED_AT + SEC, { hook_event_name: "UserPromptSubmit", prompt: "second prompt" });

    state = send(state, REAPED_AT + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "B", agent_type: "planner" });
    expect(state.activeSubagentStack.get(SESSION)).toEqual(["B"]);
    state = send(state, REAPED_AT + 3 * SEC, { hook_event_name: "PreToolUse", tool_name: "Glob", tool_use_id: "t3" });
    state = send(state, REAPED_AT + 4 * SEC, { hook_event_name: "SubagentStop", agent_id: "B" });
    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();

    // Back at the root, where the session actually is.
    state = send(state, REAPED_AT + 5 * SEC, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t4" });
    expect(names(state, SESSION)).toEqual(["Grep"]);
    expect(names(state, `${SESSION}::B`)).toEqual(["Glob"]);
    expect(names(state, SUB)).toEqual(["Read"]);
  });

  it("clears only the stack of the session it reaped", () => {
    // The sweep walks every root on the board, and a deck showing five terminals
    // is the normal case. A session still being heard from keeps its live
    // subagent and the attribution that goes with it.
    let state = abandoned();
    seq++;
    state = applyEvent(state, {
      seq,
      receivedAt: REAPED_AT - SEC,
      source: "hook",
      payload: { session_id: "sess-alive", hook_event_name: "SubagentStart", agent_id: "Z", agent_type: "explorer" },
    });

    expect(sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS)).toBe(true);

    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();
    expect(state.activeSubagentStack.get("sess-alive")).toEqual(["Z"]);
    expect(state.agents.get("sess-alive::Z")!.state).toBe("active");
  });

  it("is a no-op on a session that never started a subagent", () => {
    // Most reaps are this one, and the delete must not invent an entry or change
    // what the sweep reports as changed.
    seq = 0;
    let state = send(initialState(), T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "only prompt" });

    expect(sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS)).toBe(true);
    expect(state.activeSubagentStack.size).toBe(0);
    // Idempotent: the 250ms tick in App.tsx sweeps again a moment later and must
    // not report a change it did not make, or the canvas re-renders forever.
    expect(sweepStaleSessions(state, REAPED_AT + SEC, STALE_SESSION_MS)).toBe(false);
  });

  it("reports the same `changed` it always did", () => {
    // The stack is attribution state for events that have not arrived yet and
    // nothing on screen is drawn from it, so removing a key is not by itself a
    // reason to re-render. Swept twice: the second pass has a stack to clear on
    // neither run and must stay quiet.
    const state = abandoned();
    expect(sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS)).toBe(true);
    expect(sweepStaleSessions(state, REAPED_AT + SEC, STALE_SESSION_MS)).toBe(false);
  });
});

describe("the un-reap path #350 left behind", () => {
  it("brings the root back without bringing the subagent back with it", () => {
    // #350's recovery is deliberately root-only: a subagent that was mid-flight
    // when its session went quiet is genuinely over, and `SubagentStart` is what
    // brings one of those back. Restoring the stack alongside the root would
    // contradict that in the worst possible way — every event of the resumed
    // session would be attributed to a node this same reducer is holding `done`.
    let state = abandoned();
    sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS);
    expect(root(state).reaped).toBe(true);

    // Any event at all is enough; a bare notification carries no agent_id either.
    state = send(state, REAPED_AT + SEC, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission",
    });

    expect(root(state).reaped).toBe(false);
    expect(root(state).state).toBe("active");
    expect(root(state).endedAt).toBeUndefined();
    expect(root(state).lastEventAt).toBe(REAPED_AT + SEC);
    // The subagent does not come back, and neither does its key.
    expect(sub(state).state).toBe("done");
    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();
  });

  it("still routes to a subagent that re-announces itself after the un-reap", () => {
    // The door #350 leaves open has to still work: a session that was reaped
    // wrongly, came back, and started a real Task must attribute to that Task.
    let state = abandoned();
    sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS);
    state = send(state, REAPED_AT + SEC, { hook_event_name: "UserPromptSubmit", prompt: "carry on" });
    state = send(state, REAPED_AT + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "C", agent_type: "explorer" });
    state = send(state, REAPED_AT + 3 * SEC, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t5" });

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["C"]);
    expect(names(state, `${SESSION}::C`)).toEqual(["Read"]);
    expect(names(state, SESSION)).toEqual([]);
  });

  it("brings back a subagent re-announced under the key the reap settled", () => {
    // CC reuses `parent_tool_use_id` when a Task is re-invoked, so the same key
    // can legitimately come round again. `SubagentStart` is the resurrection
    // path, and clearing the stack must not have closed it.
    let state = abandoned();
    sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS);
    state = send(state, REAPED_AT + SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "explorer" });

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["A"]);
    expect(sub(state).state).toBe("active");
    expect(sub(state).endedAt).toBeUndefined();
    expect(sub(state).exitAt).toBeUndefined();
  });
});

describe("what clearing the stack does not disturb", () => {
  it("leaves #436's tool rule alone on a session that is still emitting", () => {
    // A call is settled on the SESSION's silence, never on its own age: of the
    // real Claude calls measured for #436, four in five of the old age-based
    // verdicts were false. A three-hour-old call under a session still reporting
    // stays in-flight, and neither sweep touches the session or its stack.
    let state = abandoned();
    state = send(state, T0 + 5 * SEC, { hook_event_name: "SubagentStart", agent_id: "B", agent_type: "worker" });
    state = send(state, T0 + 6 * SEC, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "slow" });
    for (let t = T0 + 10 * MIN; t <= T0 + 180 * MIN; t += 10 * MIN) {
      state = send(state, t, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `poll-${t}` });
      state = send(state, t + SEC, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `poll-${t}`, tool_response: "ok" });
      expect(sweepStaleTools(state, t + 2 * SEC, STALE_SESSION_MS)).toBe(false);
      expect(sweepStaleSessions(state, t + 2 * SEC, STALE_SESSION_MS)).toBe(false);
    }
    const slow = state.agents.get(`${SESSION}::B`)!.tools.find(t => t.id === "slow")!;
    expect(slow.endedAt).toBeUndefined();
    expect(slow.ok).toBeUndefined();
    expect(state.activeSubagentStack.get(SESSION)).toEqual(["A", "B"]);
  });

  it("still settles a genuinely abandoned Claude call in the sweep that clears the stack", () => {
    // The case #436 kept: the session did die mid-call, and once it has been
    // silent for the whole window the call settles saying what was observed. The
    // tick runs both sweeps, so this is what one tick does to the dead session.
    let state = abandoned();
    state = send(state, T0 + 5 * SEC, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "lost" });

    expect(sweepStaleTools(state, REAPED_AT, STALE_SESSION_MS)).toBe(true);
    expect(sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS)).toBe(true);

    // The call was attributed to the subagent on the stack, which is where it
    // stays — the fix changes attribution for events that arrive AFTER the reap,
    // never for the ones already recorded.
    const lost = sub(state).tools.find(t => t.id === "lost")!;
    expect(lost.ok).toBe(false);
    expect(lost.errorPreview).toBe("session ended before this call returned");
    expect(lost.endedAt).toBe(T0 + 5 * SEC);
    expect(state.toolIndex.has("lost")).toBe(false);
    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();
  });

  it("leaves #397's Codex skip alone when the Codex session is reaped", () => {
    // On Codex a missing result means the call has not finished, not that the
    // result was lost — the rollout records the call line at request time, so a
    // quiet call is a long command or one parked on an approval prompt. Reaping
    // the session must not start failing those.
    seq = 0;
    let state = send(initialState(), T0, { hook_event_name: "SessionStart", cwd: "/repo", provider: "codex" });
    state = send(state, T0 + SEC, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "cx1", provider: "codex" });

    expect(root(state).provider).toBe("codex");
    expect(sweepStaleTools(state, REAPED_AT, STALE_SESSION_MS)).toBe(false);
    expect(sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS)).toBe(true);

    const call = root(state).tools.find(t => t.id === "cx1")!;
    expect(call.endedAt).toBeUndefined();
    expect(call.ok).toBeUndefined();
    expect(state.toolIndex.has("cx1")).toBe(true);
  });

  it("leaves a whole reaped session reclaimable, as it was before", () => {
    // `pruneDoneSessions` evicts a session only when nothing in it is live, and
    // that is exactly what a reap produces. Pinned so the stack clear is visibly
    // not the thing keeping the tree on the board.
    const state = abandoned();
    sweepStaleSessions(state, REAPED_AT, STALE_SESSION_MS);
    expect(pruneDoneSessions(state, REAPED_AT + SEC, 0, 0)).toBe(true);
    expect(state.agents.size).toBe(0);
  });
});
