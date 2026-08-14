// The invisible per-session drag handle is a React Flow node like any other:
// it is measured, and its size is the whole session box. It never reaches
// autoLayout's `nodes` — App builds the handles from the laid-out cards, after
// the fact — but it does reach `measured`, which is one shared map, and prune
// deliberately keeps its entry alive.
//
// columnGap() used to take the widest value in that map, so the moment one
// session fanned out to subagents its ~1100px handle became the pitch between
// two 240px columns. On a canvas where two columns just fit, the width check
// then failed and every session collapsed into one very tall strip that
// fit-to-view shrank to nothing; on a wider one the columns survived with an
// ~850px band of empty canvas between them.
import { describe, it, expect } from "vitest";
import type { Node } from "reactflow";
import { autoLayout } from "../layout";

const W = 260, H = 120;
const TOOL_LANE = 420;

function agent(id: string, sessionId: string): Node {
  return { id, position: { x: 0, y: 0 }, data: { sessionId }, width: W, height: H } as Node;
}

/** Six sessions of one card each — enough to need a second column. */
const sessions = Array.from({ length: 6 }, (_, i) => agent(`s${i}n0`, `s${i}`));

const cards = () => new Map(sessions.map(n => [n.id, { width: W, height: H }]));

/**
 * `measured` as the canvas really holds it: the cards, plus a handle for every
 * session. s0 has fanned out, so its handle is four cards wide.
 */
function withHandles(): Map<string, { width: number; height: number }> {
  const m = cards();
  m.set("group:s0", { width: 1096, height: 400 });
  for (let i = 1; i < 6; i++) m.set(`group:s${i}`, { width: 276, height: 156 });
  return m;
}

const columnsOf = (out: Node[]) =>
  [...new Set(out.map(n => Math.round(n.position.x)))].sort((a, b) => a - b);

describe("columnGap ignores the per-session drag handles", () => {
  it("keeps the second column on a canvas that fits two", () => {
    // Two columns of card + burst lane and one card of gap is 1620 wide; with
    // the handle setting the gap it claims 2456 and the fallback to a single
    // column fires.
    const out = autoLayout(sessions, [], {
      measured: withHandles(), availableWidth: 2000, availableHeight: 400,
    });
    expect(columnsOf(out).length).toBe(2);
  });

  it("leaves one card of clear space between the columns, not a session box", () => {
    const out = autoLayout(sessions, [], {
      measured: withHandles(), availableWidth: 4000, availableHeight: 400,
    });
    const xs = columnsOf(out);
    expect(xs.length).toBe(2);
    // Pitch minus the card and the burst lane beside it is what the eye reads
    // as the gap.
    expect(xs[1] - xs[0] - W - TOOL_LANE).toBe(W);
  });

  it("places every card exactly where it would with no handle measured at all", () => {
    const opts = { availableWidth: 4000, availableHeight: 400 };
    const bare = autoLayout(sessions, [], { ...opts, measured: cards() });
    const real = autoLayout(sessions, [], { ...opts, measured: withHandles() });
    expect(real.map(n => n.position)).toEqual(bare.map(n => n.position));
  });

  it("still widens the gap when a real card is measured wider than the default", () => {
    // The gap follows the widest card on screen so it holds when cards grow.
    // Dropping the handles must not drop that too.
    const measured = withHandles();
    measured.set("s2n0", { width: 400, height: H });   // lands in the second column
    const xs = columnsOf(autoLayout(sessions, [], {
      measured, availableWidth: 4000, availableHeight: 400,
    }));
    expect(xs.length).toBe(2);
    expect(xs[1] - xs[0]).toBe(W + TOOL_LANE + 400);
  });
});
