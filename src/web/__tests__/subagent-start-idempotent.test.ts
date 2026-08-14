// SubagentStart used to push its key onto the session's attribution stack
// unconditionally, so one re-delivery (several live decks appending to the same
// events.jsonl, a hook retry, a log replay that reruns a Start whose Stop only
// arrives live) left surplus copies behind: SubagentStop removes exactly one,
// and every leftover kept resolveOwner handing the root's own traffic — the
// user's next prompt and all its Pre/PostToolUse, none of which carries an
// agent_id — to a subagent that had already finished. UserPromptSubmit then
// flipped that dead node back to state 'active' with endedAt cleared, so
// pruneOldAgents (needs 'done') and pruneDoneSessions (needs nothing live)
// could never evict it or its session again. The stack now ignores a key it is
// already carrying: one key can only be running once.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, pruneOldAgents } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-restart";
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

function start(): GraphState {
  seq = 0;
  return send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
}

describe("SubagentStart idempotence on the active-subagent stack", () => {
  it("leaves nothing on the stack when three decks replay one Start and only one Stop arrives", () => {
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["sub-1"]);

    state = send(state, { hook_event_name: "SubagentStop", agent_id: "sub-1" });
    expect(state.activeSubagentStack.get(SESSION)).toBeUndefined();
  });

  it("keeps the root owning its own prompt and tool calls after the subagent finished", () => {
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t1" });
    state = send(state, { hook_event_name: "SubagentStop", agent_id: "sub-1" });

    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "root turn" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2" });

    const root = state.agents.get(SESSION)!;
    expect(root.prompts.map(p => p.text)).toEqual(["root turn"]);
    expect(root.tools.map(t => t.name)).toEqual(["Read"]);
    expect(root.tools.filter(t => t.endedAt == null).map(t => t.name)).toEqual(["Read"]);

    const sub = state.agents.get(SUB)!;
    expect(sub.prompts).toHaveLength(0);
    expect(sub.tools.map(t => t.name)).toEqual(["Grep"]);
  });

  it("does not resurrect the finished subagent, so the pruner can still evict it", () => {
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "SubagentStop", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "root turn" });

    const sub = state.agents.get(SUB)!;
    expect(sub.state).toBe("done");
    expect(sub.endedAt).toBeGreaterThan(0);

    expect(pruneOldAgents(state, 1_000_000, /*cap*/ 1, /*graceMs*/ 1_000)).toBe(true);
    expect(state.agents.has(SUB)).toBe(false);
  });

  it("does not let a re-delivered Start steal attribution from a deeper subagent", () => {
    // Two Tasks running in parallel; the duplicate copy of the first one's
    // Start is old news and must not become the top of the stack again.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-2" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["sub-1", "sub-2"]);

    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
    expect(state.agents.get(`${SESSION}::sub-2`)!.tools.map(t => t.name)).toEqual(["Bash"]);
    expect(state.agents.get(SUB)!.tools).toHaveLength(0);
  });

  it("still unwinds two parallel subagents to the right depth", () => {
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-2" });
    state = send(state, { hook_event_name: "SubagentStop", agent_id: "sub-2" });

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["sub-1"]);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" });
    expect(state.agents.get(SUB)!.tools.map(t => t.name)).toEqual(["Read"]);
  });

  it("still re-arms a key CC reuses for a second Task after the first one stopped", () => {
    // The guard only ignores a key the stack is *currently* carrying — a key
    // that came off on SubagentStop is free to go back on.
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "SubagentStop", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["sub-1"]);
    const sub = state.agents.get(SUB)!;
    expect(sub.state).toBe("active");
    expect(sub.endedAt).toBeUndefined();

    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Glob", tool_use_id: "t1" });
    expect(sub.tools.map(t => t.name)).toEqual(["Glob"]);
  });

  it("does not merge a duplicate key across sessions", () => {
    let state = start();
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1" });
    const other: HookEnvelope = {
      seq: ++seq,
      receivedAt: 5_000,
      source: "hook",
      payload: { session_id: "sess-other", hook_event_name: "SubagentStart", agent_id: "sub-1" },
    };
    state = applyEvent(state, other);

    expect(state.activeSubagentStack.get(SESSION)).toEqual(["sub-1"]);
    expect(state.activeSubagentStack.get("sess-other")).toEqual(["sub-1"]);
  });
});
