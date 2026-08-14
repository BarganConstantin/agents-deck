// The invisible per-session drag handle is a React Flow node like any other,
// and @reactflow/minimap paints every node it can measure: its selector is
// `!node.hidden && node.width && node.height`, with no node-type test and no
// z-index test. The handle is measured (it is sized to the whole session box)
// and never hidden, so it reached the minimap's nodeColor callback alongside
// the cards.
//
// That callback read `n.data.state`, which a handle does not have — its data
// is `{sessionId, w, h}` — so both branches fell through to the finished
// green. Every live session therefore painted one solid green block over its
// 160px ranksep gaps and its 420px burst lane, whatever the agents inside it
// were actually doing, with the real agent rects drawn on top.
import { describe, it, expect } from "vitest";
import type { AgentState } from "../types";
import { SESSION_GROUP_TYPE, minimapNodeColor, type MinimapNode } from "../minimap";

/** Resolve a CSS custom property to its own name, so assertions name tokens. */
const token = (name: string) => name;

const card = (state: AgentState): MinimapNode =>
  ({ type: "agent", data: { id: "a1", sessionId: "s1", state } });

/** A handle as App builds it: session-sized, and carrying no agent state. */
const handle = {
  type: SESSION_GROUP_TYPE,
  data: { sessionId: "s1", w: 1096, h: 400 },
} as unknown as MinimapNode;

describe("minimap node colour", () => {
  it("paints the invisible session drag handle with nothing at all", () => {
    expect(minimapNodeColor(handle, token)).toBe("transparent");
  });

  it("does not read the handle as a finished agent", () => {
    expect(minimapNodeColor(handle, token)).not.toBe(token("--ok"));
  });

  it("tells a handle from a card by node type, not by its id prefix", () => {
    // `group:<sessionId>` is prune.ts's business; drift between two spellings
    // of the same question is what put the handles in the column-gap maths.
    const prefixOnly: MinimapNode = { type: "agent", data: { id: "group:s1", sessionId: "s1", state: "done" } };
    expect(minimapNodeColor(prefixOnly, token)).toBe(token("--ok"));
  });

  it("still paints a running agent in the in-flight colour", () => {
    expect(minimapNodeColor(card("active"), token)).toBe(token("--inflight"));
  });

  it("still paints a failed agent in the error colour", () => {
    expect(minimapNodeColor(card("err"), token)).toBe(token("--err"));
  });

  it("still paints a finished agent in the ok colour", () => {
    expect(minimapNodeColor(card("done"), token)).toBe(token("--ok"));
  });

  it("survives a node React Flow hands over before its data is attached", () => {
    expect(minimapNodeColor({ type: "agent" }, token)).toBe(token("--ok"));
  });
});
