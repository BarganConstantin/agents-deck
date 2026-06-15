// Regression: previously rendered session, agent, group, and tool-call nodes
// must remain present across live incremental updates. The only thing allowed
// to remove a node is an explicit delete event (`__clear`).
//
// Reproduces the "subagent flicker / vanish" bug: a live UserPromptSubmit
// stamps `exitAt = now` on every prior-turn done subagent. EXIT_ANIM_MS later
// (600ms) `isAgentVisible` filters them out, even though the data is still in
// `state.agents`. Tool-call entries inside those subagents disappear with
// their parents; the bottom strip + bursts gate on the same visibility set so
// the canvas ends up with the root card plus orphan-looking tool dots.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { computeVisibleIds, EXIT_ANIM_MS } from "../visibility";
import type { HookEnvelope, HookPayload } from "../types";

let seq = 1;
function envelope(payload: HookPayload, at: number, opts: { replay?: boolean } = {}): HookEnvelope {
  return {
    seq: seq++,
    receivedAt: at,
    source: "hook",
    payload,
    replay: opts.replay,
  };
}

function feed(state: GraphState, events: HookEnvelope[]): GraphState {
  let s = state;
  for (const e of events) s = applyEvent(s, e);
  return s;
}

const SESSION = "sess-A";
const SUB1 = "tool-use-aaaaaaaaaaaaaaaa";
const SUB2 = "tool-use-bbbbbbbbbbbbbbbb";

// Anchor the simulated timeline 60s in the past. That way replay-flagged
// events (T(0) … T(20_000) → 60s … 40s ago) are already far outside the
// EXIT_ANIM_MS window at refresh-render time (Date.now()), so retired
// subagents stay invisible from the first frame. Live tests compute
// visibility relative to their own promptAt + offset, so the shift doesn't
// affect them.
const NOW = Date.now();
const TIMELINE_START = NOW - 60_000;
const T = (ms: number): number => TIMELINE_START + ms;

function liveTimeline(): HookEnvelope[] {
  seq = 1;
  return [
    envelope({ hook_event_name: "SessionStart", session_id: SESSION, cwd: "/repo" }, T(1_000)),

    // Root-level tool call (Read).
    envelope({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Read", tool_use_id: "tu-read-1", tool_input: { file_path: "/repo/a.ts" } }, T(1_100)),
    envelope({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Read", tool_use_id: "tu-read-1", tool_response: { content: "ok" } }, T(1_200)),

    // First subagent — runs Bash + curl.
    envelope({ hook_event_name: "SubagentStart", session_id: SESSION, parent_tool_use_id: SUB1, subagent_type: "explorer" }, T(2_000)),
    envelope({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: "tu-bash-1", tool_input: { command: "ls" } }, T(2_500)),
    envelope({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: "tu-bash-1", tool_response: { stdout: "..." } }, T(3_000)),
    envelope({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: "tu-curl-1", tool_input: { command: "curl example.com" } }, T(3_500)),
    envelope({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: "tu-curl-1", tool_response: { stdout: "..." } }, T(4_000)),
    envelope({ hook_event_name: "SubagentStop", session_id: SESSION, parent_tool_use_id: SUB1 }, T(5_000)),

    // Second subagent — runs Grep + cd + spawns its own Agent tool.
    envelope({ hook_event_name: "SubagentStart", session_id: SESSION, parent_tool_use_id: SUB2, subagent_type: "reviewer" }, T(7_000)),
    envelope({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Grep", tool_use_id: "tu-grep-1", tool_input: { pattern: "foo" } }, T(7_500)),
    envelope({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Grep", tool_use_id: "tu-grep-1", tool_response: { matches: [] } }, T(8_000)),
    envelope({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: "tu-cd-1", tool_input: { command: "cd /tmp" } }, T(8_500)),
    envelope({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: "tu-cd-1", tool_response: { stdout: "" } }, T(9_000)),
    envelope({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Agent", tool_use_id: "tu-agent-1", tool_input: { description: "do thing" } }, T(9_500)),
    envelope({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Agent", tool_use_id: "tu-agent-1", tool_response: { ok: true } }, T(9_700)),
    envelope({ hook_event_name: "SubagentStop", session_id: SESSION, parent_tool_use_id: SUB2 }, T(10_000)),
  ];
}

const ROOT_ID = SESSION;
const SUB1_ID = `${SESSION}::${SUB1}`;
const SUB2_ID = `${SESSION}::${SUB2}`;

describe("regression — nodes must not vanish from live incremental updates", () => {
  it("keeps every session, agent and tool-call entry in state after live events", () => {
    const state = feed(initialState(), liveTimeline());

    expect(state.agents.has(ROOT_ID)).toBe(true);
    expect(state.agents.has(SUB1_ID)).toBe(true);
    expect(state.agents.has(SUB2_ID)).toBe(true);

    const root = state.agents.get(ROOT_ID)!;
    expect(root.tools.map(t => t.name)).toEqual(["Read"]);

    const sub1 = state.agents.get(SUB1_ID)!;
    expect(sub1.tools.map(t => t.id)).toEqual(["tu-bash-1", "tu-curl-1"]);

    const sub2 = state.agents.get(SUB2_ID)!;
    expect(sub2.tools.map(t => t.id)).toEqual(["tu-grep-1", "tu-cd-1", "tu-agent-1"]);
  });

  it("retires prior-turn subagents 600ms after a live UserPromptSubmit", () => {
    let state = feed(initialState(), liveTimeline());

    const promptAt = T(20_000);
    state = applyEvent(state, envelope({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      prompt: "next turn",
    }, promptAt));

    // Data MUST stay in state — retirement is visual only, not a delete.
    expect(state.agents.has(SUB1_ID)).toBe(true);
    expect(state.agents.has(SUB2_ID)).toBe(true);

    // Mid-animation: subagents still visible (rf-exiting fade-out running).
    const mid = promptAt + 200;
    const visMid = computeVisibleIds(state, mid);
    expect(visMid.has(SUB1_ID)).toBe(true);
    expect(visMid.has(SUB2_ID)).toBe(true);

    // After EXIT_ANIM_MS: prior-turn subagents filtered out.
    const after = promptAt + EXIT_ANIM_MS + 100;
    const visAfter = computeVisibleIds(state, after);
    expect(visAfter.has(ROOT_ID)).toBe(true);
    expect(visAfter.has(SUB1_ID)).toBe(false);
    expect(visAfter.has(SUB2_ID)).toBe(false);
  });

  it("repeated live UserPromptSubmit cycles consistently retire each prior turn", () => {
    let state = feed(initialState(), liveTimeline());

    for (let turn = 0; turn < 3; turn++) {
      const t = T(20_000 + turn * 5_000);
      state = applyEvent(state, envelope({
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        prompt: `turn ${turn}`,
      }, t));

      // Root stays visible across every turn.
      for (const offset of [0, 100, EXIT_ANIM_MS - 1, EXIT_ANIM_MS + 1, 1_000, 4_000]) {
        const visible = computeVisibleIds(state, t + offset);
        expect(visible.has(ROOT_ID), `root at turn=${turn} offset=${offset}`).toBe(true);
      }
      // After this turn's exit animation, prior subagents must be gone.
      const visAfter = computeVisibleIds(state, t + EXIT_ANIM_MS + 100);
      expect(visAfter.has(SUB1_ID), `sub1 retired by turn=${turn}`).toBe(false);
      expect(visAfter.has(SUB2_ID), `sub2 retired by turn=${turn}`).toBe(false);
    }
  });

  it("refresh (replay) does not re-show prior-turn subagents (no flash-then-vanish)", () => {
    seq = 1;
    let state = initialState();
    for (const e of liveTimeline()) {
      state = applyEvent(state, { ...e, replay: true });
    }
    // A new prompt closed out that prior turn — also replayed.
    state = applyEvent(state, envelope({
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION,
      prompt: "replayed turn",
    }, T(20_000), { replay: true }));

    // Data stays in state for inspection / history.
    expect(state.agents.has(SUB1_ID)).toBe(true);
    expect(state.agents.has(SUB2_ID)).toBe(true);

    // First render after replay uses wall-clock now; replayed exitAt
    // timestamps are far in the past → already past EXIT_ANIM_MS → prior
    // subagents are invisible from the very first frame (no flash).
    const visible = computeVisibleIds(state, Date.now());
    expect(visible.has(ROOT_ID)).toBe(true);
    expect(visible.has(SUB1_ID)).toBe(false);
    expect(visible.has(SUB2_ID)).toBe(false);
  });

  it("refresh without a closing UserPromptSubmit keeps the in-flight turn's subagents", () => {
    // No UserPromptSubmit after the timeline = still in the same turn the
    // subagents belong to. They should remain visible.
    seq = 1;
    let state = initialState();
    for (const e of liveTimeline()) {
      state = applyEvent(state, { ...e, replay: true });
    }
    const visible = computeVisibleIds(state, Date.now());
    expect(visible.has(ROOT_ID)).toBe(true);
    expect(visible.has(SUB1_ID)).toBe(true);
    expect(visible.has(SUB2_ID)).toBe(true);
  });

  it("only an explicit delete (__clear) removes nodes from state", () => {
    let state = feed(initialState(), liveTimeline());
    expect(state.agents.size).toBeGreaterThan(0);

    state = applyEvent(state, envelope({ hook_event_name: "__clear" }, T(30_000)));
    expect(state.agents.size).toBe(0);
    expect(state.toolIndex.size).toBe(0);
    expect(state.toolOwner.size).toBe(0);
  });
});
