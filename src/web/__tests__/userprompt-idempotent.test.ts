// UserPromptSubmit used to append to `prompts` unconditionally, so one
// re-delivery of a submission (the hook posts each event to every deck whose
// workspace matches, a restart replays the log region it already streamed live,
// a hook retry) recorded the same turn once per copy: the detail panel said
// 'Prompts 3' and listed the text three times, SessionSummary's promptCount
// reported three times the turns the session really had, and since nothing
// trims the list every surplus copy of the full prompt text stayed on the agent
// for its lifetime. The seq/epoch guard cannot catch these — a replayed line is
// re-pushed with a fresh seq under a new epoch, which rebases the guard instead
// of tripping it. A prompt carries no id, so the reducer keys it on its text
// plus the moment it arrived.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, PROMPT_REDELIVERY_WINDOW_MS } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-prompt";
const T0 = 1_700_000_000_000;

let seq = 0;
let epoch = "boot-1";

/** One delivery, stamped by the deck that handled it — `at` is that deck's own
 *  arrival time, which is what a copy of the same event differs in. */
function send(state: GraphState, payload: HookPayload, at: number): GraphState {
  const env: HookEnvelope = {
    seq: ++seq,
    receivedAt: at,
    source: "hook",
    epoch,
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

function prompt(state: GraphState, text: string, at: number): GraphState {
  return send(state, { hook_event_name: "UserPromptSubmit", prompt: text }, at);
}

function start(): GraphState {
  seq = 0;
  epoch = "boot-1";
  return send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
}

describe("UserPromptSubmit idempotence on the prompt list", () => {
  it("records one turn when three decks deliver the same submission milliseconds apart", () => {
    let state = start();
    state = prompt(state, "ship the fix", T0 + 10);
    state = prompt(state, "ship the fix", T0 + 11);
    state = prompt(state, "ship the fix", T0 + 13);

    const root = state.agents.get(SESSION)!;
    expect(root.prompts.map(p => p.text)).toEqual(["ship the fix"]);
    expect(root.firstPrompt).toBe("ship the fix");
  });

  it("records one turn when a slow deck in the fan-out stamps its copy a second later", () => {
    // The hook's per-target challenge and POST both have timeouts; its whole
    // run is capped at 1500ms, so the last copy can lag the first by ~a second.
    let state = start();
    state = prompt(state, "ship the fix", T0 + 10);
    state = prompt(state, "ship the fix", T0 + 1_400);

    expect(state.agents.get(SESSION)!.prompts).toHaveLength(1);
  });

  it("keeps the count right when a restart replays a log it already streamed live", () => {
    // The tab holds its state across the EventSource reconnect, and the boot
    // replay re-pushes every line with the receivedAt it was written with.
    let state = start();
    state = prompt(state, "first turn", T0 + 1_000);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" }, T0 + 2_000);
    state = prompt(state, "second turn", T0 + 60_000);

    seq = 0;
    epoch = "boot-2";
    state = send(state, { hook_event_name: "SessionStart", cwd: "/repo" }, T0);
    state = prompt(state, "first turn", T0 + 1_000);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" }, T0 + 2_000);
    state = prompt(state, "second turn", T0 + 60_000);

    const root = state.agents.get(SESSION)!;
    expect(root.prompts.map(p => p.text)).toEqual(["first turn", "second turn"]);
  });

  it("still records the same text the user types again in a later turn", () => {
    let state = start();
    state = prompt(state, "continue", T0 + 1_000);
    state = prompt(state, "continue", T0 + 90_000);
    state = prompt(state, "continue", T0 + 240_000);

    const root = state.agents.get(SESSION)!;
    expect(root.prompts.map(p => p.text)).toEqual(["continue", "continue", "continue"]);
    expect(root.prompts.map(p => p.at)).toEqual([T0 + 1_000, T0 + 90_000, T0 + 240_000]);
  });

  it("still records a repeat that lands just past the redelivery window", () => {
    let state = start();
    state = prompt(state, "continue", T0 + 1_000);
    state = prompt(state, "continue", T0 + 1_000 + PROMPT_REDELIVERY_WINDOW_MS + 1);

    expect(state.agents.get(SESSION)!.prompts).toHaveLength(2);
  });

  it("keeps two different prompts submitted in the same millisecond", () => {
    let state = start();
    state = prompt(state, "one", T0 + 1_000);
    state = prompt(state, "two", T0 + 1_000);

    expect(state.agents.get(SESSION)!.prompts.map(p => p.text)).toEqual(["one", "two"]);
  });

  it("dedupes each session's prompts on its own list", () => {
    let state = start();
    state = prompt(state, "same words", T0 + 10);
    state = prompt(state, "same words", T0 + 11);

    const other: HookEnvelope = {
      seq: ++seq,
      receivedAt: T0 + 12,
      source: "hook",
      epoch,
      payload: { session_id: "sess-other", hook_event_name: "UserPromptSubmit", prompt: "same words" },
    };
    state = applyEvent(state, other);

    expect(state.agents.get(SESSION)!.prompts).toHaveLength(1);
    expect(state.agents.get("sess-other")!.prompts.map(p => p.text)).toEqual(["same words"]);
  });

  it("still lets a re-delivered submission reopen the session it closed", () => {
    // Dropping the duplicate entry must not drop the rest of the handler: the
    // root is what the canvas draws as the live session.
    let state = start();
    state = prompt(state, "ship the fix", T0 + 10);
    state = send(state, { hook_event_name: "Stop" }, T0 + 20);
    expect(state.agents.get(SESSION)!.state).toBe("done");

    state = prompt(state, "ship the fix", T0 + 30);
    const root = state.agents.get(SESSION)!;
    expect(root.state).toBe("active");
    expect(root.endedAt).toBeUndefined();
    expect(root.prompts).toHaveLength(1);
  });
});
