// Subagent keys are pushed onto activeSubagentStack by SubagentStart and were
// popped only by SubagentStop. Hook delivery is fire-and-forget, so a
// SubagentStop sent while the server was restarting is simply gone — and the
// stranded key kept swallowing every later event that carries no agent_id,
// which is all of the real UserPromptSubmit / PreToolUse / PostToolUse traffic.
// The user's next prompt landed in the dead subagent's card, root tool calls
// pulsed under it, and replay rebuilt the same poisoned stack on refresh.
// Stop / SessionEnd now drop the session's stack: the root's turn cannot end
// while a Task is still running, so nothing left on it can be live.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-stack";
const SUB = `${SESSION}::sub-1`;

let seq = 0;

function send(state: GraphState, payload: HookPayload): GraphState {
  const env: HookEnvelope = {
    seq: ++seq,
    receivedAt: 1_000 + seq,
    source: "hook",
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

describe("Stop / SessionEnd and the active subagent stack", () => {
  it("stops attributing later events to a subagent whose SubagentStop was lost", () => {
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t1" });
    // ...and here the subagent's SubagentStop never reaches the server.
    state = send(state, { hook_event_name: "Stop" });

    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();

    // Next turn of the same session: everything belongs to the root again.
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "next turn" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2" });

    const root = state.agents.get(SESSION)!;
    expect(root.prompts.map(p => p.text)).toEqual(["next turn"]);
    expect(root.tools.map(t => t.name)).toEqual(["Read"]);
    expect(root.inFlightTool?.name).toBe("Read");

    const sub = state.agents.get(SUB)!;
    expect(sub.prompts).toHaveLength(0);
    expect(sub.tools.map(t => t.name)).toEqual(["Grep"]);
  });

  it("clears the whole stack, not just its top, on SessionEnd", () => {
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-2" });
    state = send(state, { hook_event_name: "SessionEnd" });

    expect(state.activeSubagentStack.size).toBe(0);

    // A resumed session reusing the same id starts attributing to its root.
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "resumed" });
    expect(state.agents.get(SESSION)!.prompts.map(p => p.text)).toEqual(["resumed"]);
    expect(state.agents.get(`${SESSION}::sub-1`)!.prompts).toHaveLength(0);
    expect(state.agents.get(`${SESSION}::sub-2`)!.prompts).toHaveLength(0);
  });

  it("does not disturb a subagent in another session", () => {
    let state = send(initialState(), { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    const other: HookEnvelope = {
      seq: ++seq,
      receivedAt: 2_000,
      source: "hook",
      payload: { session_id: "sess-other", hook_event_name: "SubagentStart", agent_id: "sub-9" },
    };
    state = applyEvent(state, other);
    state = send(state, { hook_event_name: "Stop" });

    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();
    expect(state.activeSubagentStack.get("sess-other")).toEqual(["sub-9"]);
    expect(state.agents.get("sess-other::sub-9")?.state).toBe("active");
  });

  it("still routes to a subagent that is genuinely running", () => {
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t1" });
    state = send(state, { hook_event_name: "SubagentStop", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2" });

    expect(state.agents.get(SUB)?.tools.map(t => t.name)).toEqual(["Grep"]);
    expect(state.agents.get(SESSION)?.tools.map(t => t.name)).toEqual(["Read"]);
  });
});
