// A live deck showed 246 .tool-burst-wrap elements for 7 agents, against a
// ceiling of 56 — whole clusters of chips piled on identical coordinates,
// some ticked, some still spinning, some sitting where no agent card was.
// Every bubble was keyed by its tool id alone, and an agent's tools array has
// no uniqueness guarantee, so a repeated tool_use_id gave two bubbles the same
// React key; React mis-reconciles a keyed list with repeated keys and never
// unmounts the extras. These assert the render window holds each tool id once
// and that the keys built from it are unique across the whole canvas.
import { describe, it, expect } from "vitest";
import type { AgentNodeData, ToolCall } from "../types";
import { collectBursts, distinctRecentTools } from "../components/ToolBursts";

const NOW = 1_000_000;

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: "Bash", inputPreview: "", startedAt: NOW - 100, ...over };
}

function agent(id: string, tools: ToolCall[]): AgentNodeData {
  return {
    id, sessionId: id, label: id, kind: "root", state: "active",
    startedAt: NOW - 1000, tools, prompts: [], toolCount: tools.length,
    childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  };
}

/** Runs collectBursts over a laid-out canvas holding exactly these agents. */
function burstsFor(...agents: AgentNodeData[]) {
  const map = new Map(agents.map(a => [a.id, a]));
  const positions = new Map(agents.map((a, i) => [a.id, { x: 0, y: i * 400 }]));
  const measured = new Map(agents.map(a => [a.id, { width: 260, height: 130 }]));
  return collectBursts(map, new Set(map.keys()), positions, new Map(), measured, NOW);
}

const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

describe("distinctRecentTools", () => {
  it("returns the tail in order when every id is distinct", () => {
    const tools = ["a", "b", "c", "d", "e"].map(id => tool(id));
    expect(distinctRecentTools(tools, 4).map(t => t.id)).toEqual(["b", "c", "d", "e"]);
  });

  it("returns everything when the list is shorter than the window", () => {
    const tools = ["a", "b"].map(id => tool(id));
    expect(distinctRecentTools(tools, 4).map(t => t.id)).toEqual(["a", "b"]);
    expect(distinctRecentTools([], 4)).toEqual([]);
  });

  it("collapses a repeated tool id to a single entry", () => {
    const tools = [tool("a"), tool("a"), tool("b"), tool("b")];
    expect(distinctRecentTools(tools, 4).map(t => t.id)).toEqual(["a", "b"]);
  });

  it("keeps the newest record of a repeated id — the one PostToolUse settled", () => {
    // The reducer's toolIndex points at the most recently pushed copy, so that
    // is the one that gets endedAt/ok. Keeping the older copy would leave a
    // bubble spinning forever next to a tool that finished.
    const tools = [tool("a"), tool("a", { endedAt: NOW - 10, ok: true })];
    const kept = distinctRecentTools(tools, 4);
    expect(kept).toHaveLength(1);
    expect(kept[0].ok).toBe(true);
  });

  it("fills the window from tools further back when the tail repeats", () => {
    const tools = [tool("a"), tool("b"), tool("c"), tool("c"), tool("c")];
    expect(distinctRecentTools(tools, 4).map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  it("never returns more than the window, however long the history", () => {
    const tools = Array.from({ length: 500 }, (_, i) => tool(`t${i}`));
    expect(distinctRecentTools(tools, 4)).toHaveLength(4);
  });
});

describe("collectBursts — React keys", () => {
  it("gives one bubble per tool when the same tool id was pushed twice", () => {
    const twice = burstsFor(agent("s1", [tool("dup"), tool("dup")]));
    const once = burstsFor(agent("s1", [tool("dup")]));
    expect(twice).toHaveLength(once.length);
    expect(dupes(twice.map(b => b.id))).toEqual([]);
  });

  it("keys a shell sub-bubble apart from its own primary", () => {
    const bursts = burstsFor(agent("s1", [tool("t1", { input: { command: "git status" } })]));
    expect(bursts).toHaveLength(2);          // primary + parsed "gh/git" chip
    expect(bursts[0].id).not.toBe(bursts[1].id);
    expect(bursts[0].toolId).toBe(bursts[1].toolId);   // both open the same tool
  });

  it("keys the same tool id apart when two agents both report it", () => {
    // A parent and its subagent can legitimately carry the same tool_use_id,
    // and both render on one flat layer — the key has to be agent-scoped.
    const shared = tool("toolu_shared", { input: { command: "npm test" } });
    const bursts = burstsFor(agent("s1", [shared]), agent("s2", [shared]));
    expect(dupes(bursts.map(b => b.id))).toEqual([]);
    expect(new Set(bursts.map(b => b.agentId))).toEqual(new Set(["s1", "s2"]));
  });

  it("stays collision-free on a canvas full of duplicated tools", () => {
    const agents = ["s1", "s2", "s3"].map(id =>
      agent(id, ["a", "a", "b", "b", "c", "c", "d", "d"].map(t =>
        tool(t, { name: "Read", input: { file_path: `/repo/${t}.ts` } }))));
    const bursts = burstsFor(...agents);
    expect(dupes(bursts.map(b => b.id))).toEqual([]);
    // 3 agents × 4 slots × (primary + file sub-bubble) — the real ceiling.
    expect(bursts).toHaveLength(3 * 4 * 2);
  });
});
