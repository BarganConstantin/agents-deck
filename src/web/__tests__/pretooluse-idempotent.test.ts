// PreToolUse used to append unconditionally, so one re-delivery of a
// tool_use_id (several live decks appending to the same events.jsonl, a hook
// retry, a log replay after a restart) permanently duplicated the tool: only
// the newest copy could ever be settled by PostToolUse, the older ones were
// swept stale and shown as failures, and toolCount plus the in-flight backlog
// counted every copy. The reducer now treats a known id as the same call.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  MAX_TOOLS_PER_AGENT,
  sweepStaleTools,
} from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-dupe";

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

function pre(state: GraphState, id: string, name = "Read"): GraphState {
  return send(state, {
    hook_event_name: "PreToolUse",
    tool_name: name,
    tool_use_id: id,
    tool_input: { file_path: `/repo/${id}.ts` },
  });
}

function post(state: GraphState, id: string): GraphState {
  return send(state, {
    hook_event_name: "PostToolUse",
    tool_use_id: id,
    tool_response: { content: "ok" },
  });
}

describe("PreToolUse idempotence on tool_use_id", () => {
  it("keeps one entry when the same call is delivered three times in a row", () => {
    // Three decks appending to the shared log: Pre×3, then Post×3.
    let state = start();
    state = pre(state, "t1");
    state = pre(state, "t1");
    state = pre(state, "t1");

    const root = state.agents.get(SESSION)!;
    expect(root.tools.length).toBe(1);
    expect(root.toolCount).toBe(1);
    expect(root.inFlightTool?.id).toBe("t1");

    state = post(state, "t1");
    expect(root.tools[0].endedAt).toBeGreaterThan(0);
    expect(root.tools[0].ok).toBe(true);
    expect(root.inFlightTool).toBeNull();
    expect(state.toolIndex.size).toBe(0);
    expect(state.toolOwner.size).toBe(0);
  });

  it("keeps one entry when the re-delivery lands after the call settled", () => {
    // The interleaved shape — Pre, Post, then a second copy of both. The
    // settled call is out of toolIndex by then, so the guard has to find it in
    // the owner's history rather than the live index.
    let state = start();
    state = pre(state, "t1");
    state = post(state, "t1");
    state = pre(state, "t1");
    state = post(state, "t1");

    const root = state.agents.get(SESSION)!;
    expect(root.tools.length).toBe(1);
    expect(root.toolCount).toBe(1);
    expect(root.inFlightTool).toBeNull();
  });

  it("never leaves a duplicate behind for the stale sweep to mark failed", () => {
    // This was the visible symptom: a red × and a permanent in-flight backlog
    // on calls that actually succeeded.
    let state = start();
    for (let n = 0; n < 5; n++) {
      const id = `t${n}`;
      state = pre(state, id);
      state = pre(state, id);
      state = post(state, id);
    }

    const root = state.agents.get(SESSION)!;
    expect(root.tools.length).toBe(5);
    expect(root.toolCount).toBe(5);

    const swept = sweepStaleTools(state, 1_000_000, 90_000);
    expect(swept).toBe(false);
    expect(root.tools.every(t => t.ok === true)).toBe(true);
    expect(root.tools.some(t => t.errorPreview)).toBe(false);
    expect(root.inFlightTool).toBeNull();
  });

  it("does not reopen a settled call or re-attach a released payload", () => {
    let state = start();
    state = pre(state, "t1");
    state = post(state, "t1");
    const settled = state.agents.get(SESSION)!.tools[0];
    const endedAt = settled.endedAt;

    state = pre(state, "t1");
    expect(settled.endedAt).toBe(endedAt);
    expect(settled.ok).toBe(true);

    // A trimmed entry keeps its previews but must not get its blob back.
    settled.input = undefined;
    settled.trimmed = true;
    state = pre(state, "t1");
    expect(settled.input).toBeUndefined();
  });

  it("fills in fields the first copy was missing", () => {
    let state = start();
    state = send(state, { hook_event_name: "PreToolUse", tool_use_id: "t1" });
    state = pre(state, "t1", "Bash");

    const tool = state.agents.get(SESSION)!.tools[0];
    expect(tool.name).toBe("Bash");
    expect(tool.inputPreview).toContain("/repo/t1.ts");
    expect(state.agents.get(SESSION)!.tools.length).toBe(1);
  });

  it("still records distinct ids, and still trims once the cap is passed", () => {
    // The dedupe must not fight trimTools: the window still slides, and a
    // re-delivery of a call already evicted from it is simply a new entry.
    let state = start();
    for (let n = 0; n < MAX_TOOLS_PER_AGENT + 10; n++) {
      state = pre(state, `t${n}`);
      state = pre(state, `t${n}`);
      state = post(state, `t${n}`);
    }

    const root = state.agents.get(SESSION)!;
    expect(root.tools.length).toBe(MAX_TOOLS_PER_AGENT);
    expect(root.toolCount).toBe(MAX_TOOLS_PER_AGENT + 10);
    expect(new Set(root.tools.map(t => t.id)).size).toBe(MAX_TOOLS_PER_AGENT);
    expect(root.tools[root.tools.length - 1].id).toBe(`t${MAX_TOOLS_PER_AGENT + 9}`);
  });

  it("still generates a unique id for calls that carry no tool_use_id", () => {
    let state = start();
    for (let n = 0; n < 4; n++) {
      state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash" });
    }
    const root = state.agents.get(SESSION)!;
    expect(root.tools.length).toBe(4);
    expect(new Set(root.tools.map(t => t.id)).size).toBe(4);
    expect(root.toolCount).toBe(4);
  });

  it("does not append a second copy under a subagent that started meanwhile", () => {
    // The re-delivery is attributed by the active-subagent stack, so a copy
    // arriving after a SubagentStart resolves to a different owner. The live
    // index is global, so the in-flight call is still recognised.
    let state = start();
    state = pre(state, "t1");
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = pre(state, "t1");

    const root = state.agents.get(SESSION)!;
    const sub = state.agents.get(`${SESSION}::sub-1`)!;
    expect(root.tools.length).toBe(1);
    expect(sub.tools.length).toBe(0);
    expect(sub.toolCount).toBe(0);
    expect(state.toolOwner.get("t1")).toBe(SESSION);
  });
});
