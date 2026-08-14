// Nodes landing on top of each other is the one layout bug a user reports as
// "broken" rather than "ugly", so these assert the geometry directly instead
// of asserting that dagre was called with the right arguments.
import { describe, it, expect } from "vitest";
import type { Node, Edge } from "reactflow";
import { autoLayout, separateOverlaps, fillGapsWithNewSessions } from "../layout";

const W = 260, H = 120;

function agent(id: string, sessionId: string): Node {
  return { id, position: { x: 0, y: 0 }, data: { sessionId }, width: W, height: H } as Node;
}
const sizes = (ids: string[]) => new Map(ids.map(id => [id, { width: W, height: H }]));

/** Every pair of nodes that share canvas area. */
function overlaps(nodes: Node[], measured: Map<string, { width: number; height: number }>) {
  const box = (n: Node) => {
    const m = measured.get(n.id)!;
    return { x: n.position.x, y: n.position.y, w: m.width, h: m.height };
  };
  const pairs: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = box(nodes[i]), b = box(nodes[j]);
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        pairs.push(`${nodes[i].id} / ${nodes[j].id}`);
      }
    }
  }
  return pairs;
}

describe("autoLayout — nodes never share space", () => {
  it("separates several sessions", () => {
    const nodes = [
      agent("a1", "sa"), agent("a2", "sa"),
      agent("b1", "sb"), agent("b2", "sb"),
      agent("c1", "sc"),
    ];
    const edges: Edge[] = [
      { id: "e1", source: "a1", target: "a2" },
      { id: "e2", source: "b1", target: "b2" },
    ];
    const measured = sizes(nodes.map(n => n.id));
    expect(overlaps(autoLayout(nodes, edges, { measured }), measured)).toEqual([]);
  });

  it("does not stack the next session onto a node dragged below its session", () => {
    // The reported bug: a node dragged down (and persisted to localStorage)
    // used to leave the following session stacked straight through it.
    const nodes = [agent("a1", "sa"), agent("a2", "sa"), agent("b1", "sb")];
    const measured = sizes(["a1", "a2", "b1"]);
    const pinned = new Map([["a2", { x: 0, y: 600 }]]);

    const out = autoLayout(nodes, [], { measured, pinned });
    expect(overlaps(out, measured)).toEqual([]);

    const a2 = out.find(n => n.id === "a2")!;
    const b1 = out.find(n => n.id === "b1")!;
    expect(a2.position).toEqual({ x: 0, y: 600 });        // drag is respected
    expect(b1.position.y).toBeGreaterThan(600 + H);        // and cleared
  });

  it("leaves no gap where a pinned node used to sit", () => {
    // A pinned node is out of the flow, so the remaining nodes should close
    // up rather than lay themselves out around an empty reserved slot.
    const ids = ["a1", "a2", "a3"];
    const nodes = ids.map(id => agent(id, "sa"));
    const measured = sizes(ids);

    const free = autoLayout(nodes, [], { measured });
    const withPin = autoLayout(nodes, [], { measured, pinned: new Map([["a2", { x: 0, y: 40 }]]) });

    const spanOf = (out: Node[], skip: string) => {
      const ys = out.filter(n => n.id !== skip).map(n => n.position.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spanOf(withPin, "a2")).toBeLessThan(spanOf(free, "a2"));
  });

  it("is stable across repeated runs", () => {
    const nodes = [agent("a1", "sa"), agent("b1", "sb")];
    const measured = sizes(["a1", "b1"]);
    const once = autoLayout(nodes, [], { measured }).map(n => n.position);
    const twice = autoLayout(nodes, [], { measured }).map(n => n.position);
    expect(twice).toEqual(once);
  });

  it("handles a session whose every node is pinned", () => {
    const nodes = [agent("a1", "sa"), agent("b1", "sb")];
    const measured = sizes(["a1", "b1"]);
    const out = autoLayout(nodes, [], { measured, pinned: new Map([["a1", { x: 0, y: 0 }]]) });
    expect(overlaps(out, measured)).toEqual([]);
  });
});

describe("separateOverlaps — repairs only what is wrong", () => {
  const boxes = (pos: Map<string, { x: number; y: number }>, ids: string[]) =>
    ids.map(id => ({ id, ...pos.get(id)!, w: W, h: H }));
  const anyHit = (bs: ReturnType<typeof boxes>) => {
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
      }
    return false;
  };

  it("leaves a clean arrangement untouched", () => {
    const nodes = ["a", "b"].map(id => agent(id, "s"));
    const pos = new Map([["a", { x: 0, y: 0 }], ["b", { x: 0, y: 400 }]]);
    expect(separateOverlaps(nodes, pos, new Map(), sizes(["a", "b"]))).toEqual([]);
    expect(pos.get("b")).toEqual({ x: 0, y: 400 });
  });

  it("moves only the node that is on top of another", () => {
    const nodes = ["a", "b", "c"].map(id => agent(id, "s"));
    const pos = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 0, y: 10 }],    // sitting on a
      ["c", { x: 0, y: 900 }],   // fine
    ]);
    const moved = separateOverlaps(nodes, pos, new Map(), sizes(["a", "b", "c"]));
    expect(moved).toEqual(["b"]);
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });      // untouched
    expect(pos.get("c")).toEqual({ x: 0, y: 900 });    // untouched
    expect(anyHit(boxes(pos, ["a", "b", "c"]))).toBe(false);
  });

  it("never relocates a dragged node — it moves what landed on it", () => {
    const nodes = ["p", "q"].map(id => agent(id, "s"));
    const pinned = new Map([["p", { x: 0, y: 50 }]]);
    const pos = new Map([["p", { x: 0, y: 50 }], ["q", { x: 0, y: 60 }]]);
    const moved = separateOverlaps(nodes, pos, pinned, sizes(["p", "q"]));
    expect(moved).toEqual(["q"]);
    expect(pinned.get("p")).toEqual({ x: 0, y: 50 });
    expect(anyHit([{ id: "p", x: 0, y: 50, w: W, h: H }, { id: "q", ...pos.get("q")!, w: W, h: H }])).toBe(false);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const nodes = ["a", "b", "c"].map(id => agent(id, "s"));
    const pos = new Map([["a", { x: 0, y: 0 }], ["b", { x: 0, y: 5 }], ["c", { x: 0, y: 9 }]]);
    separateOverlaps(nodes, pos, new Map(), sizes(["a", "b", "c"]));
    const after = JSON.stringify([...pos]);
    expect(separateOverlaps(nodes, pos, new Map(), sizes(["a", "b", "c"]))).toEqual([]);
    expect(JSON.stringify([...pos])).toBe(after);
  });

  it("leaves side-by-side columns alone", () => {
    // Different x, same y — a normal two-session-wide arrangement, not a clash.
    const nodes = ["a", "b"].map(id => agent(id, "s"));
    const pos = new Map([["a", { x: 0, y: 0 }], ["b", { x: 600, y: 0 }]]);
    expect(separateOverlaps(nodes, pos, new Map(), sizes(["a", "b"]))).toEqual([]);
  });
});

describe("autoLayout — packs sessions into columns", () => {
  /** n sessions of one node each. */
  const sessions = (n: number) =>
    Array.from({ length: n }, (_, i) => agent(`s${i}n0`, `s${i}`));

  const colsUsed = (out: Node[]) => new Set(out.map(n => Math.round(n.position.x))).size;

  it("stays single-column when nothing is passed", () => {
    const nodes = sessions(4);
    const out = autoLayout(nodes, [], { measured: sizes(nodes.map(n => n.id)) });
    expect(colsUsed(out)).toBe(1);
  });

  it("adds a second column on a wide canvas and stops there", () => {
    const nodes = sessions(6);
    const measured = sizes(nodes.map(n => n.id));
    const opts = { measured, availableHeight: 400 };   // force a wrap
    expect(colsUsed(autoLayout(nodes, [], { ...opts, availableWidth: 400 }))).toBe(1);
    expect(colsUsed(autoLayout(nodes, [], { ...opts, availableWidth: 2400 }))).toBe(2);
    // Capped: a very wide canvas must not keep splitting into thin columns,
    // which shrinks the fit zoom until the cards are unreadable.
    expect(colsUsed(autoLayout(nodes, [], { ...opts, availableWidth: 9000 }))).toBe(2);
  });

  it("leaves room for the tool-burst lane beside each card", () => {
    // Bursts render as an overlay rather than nodes, so the column pitch has
    // to allow for them or the next column lands on this session's chips.
    const nodes = sessions(4);
    const measured = sizes(nodes.map(n => n.id));
    const out = autoLayout(nodes, [], { measured, availableWidth: 4000, availableHeight: 400 });
    const xs = [...new Set(out.map(n => Math.round(n.position.x)))].sort((a, b) => a - b);
    expect(xs.length).toBe(2);
    expect(xs[1] - xs[0]).toBeGreaterThan(W + 400);
  });

  it("never overlaps, at any width", () => {
    const nodes = sessions(9);
    const measured = sizes(nodes.map(n => n.id));
    for (const availableWidth of [0, 300, 700, 1100, 1900, 3000, 5000]) {
      const out = autoLayout(nodes, [], { measured, availableWidth, availableHeight: 500 });
      expect(overlaps(out, measured), `width ${availableWidth}`).toEqual([]);
    }
  });

  it("fills the first column before starting the second", () => {
    // Sessions should read top-to-bottom in start order, not alternate across
    // columns. With room for 3 per column, the first 3 share a column.
    const nodes = sessions(6);
    const measured = sizes(nodes.map(n => n.id));
    const perColumn = 3;
    const sessionPitch = H + 18 * 2 + 26 + 12 + 36;   // content + cluster chrome + gap
    const out = autoLayout(nodes, [], {
      measured,
      availableWidth: 4000,
      availableHeight: sessionPitch * perColumn - 10,
    });

    const colOf = (id: string) => Math.round(out.find(n => n.id === id)!.position.x);
    const first = colOf("s0n0");
    expect(colOf("s1n0")).toBe(first);
    expect(colOf("s2n0")).toBe(first);
    expect(colOf("s3n0")).not.toBe(first);   // wrapped only once full
  });

  it("keeps a session's own nodes in one column", () => {
    // A session is read as one block; splitting it across the column boundary
    // would defeat the point of the cluster box.
    const nodes = [
      agent("a1", "sa"), agent("a2", "sa"),
      agent("b1", "sb"), agent("b2", "sb"),
    ];
    const edges: Edge[] = [
      { id: "e1", source: "a1", target: "a2" },
      { id: "e2", source: "b1", target: "b2" },
    ];
    const measured = sizes(nodes.map(n => n.id));
    const out = autoLayout(nodes, edges, { measured, availableWidth: 4000, availableHeight: 400 });

    const spanOf = (ids: string[]) => {
      const xs = out.filter(n => ids.includes(n.id)).map(n => n.position.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    // Within a session, dagre's own LR spread is far smaller than a column.
    expect(spanOf(["a1", "a2"])).toBeLessThan(600);
    expect(spanOf(["b1", "b2"])).toBeLessThan(600);
    expect(overlaps(out, measured)).toEqual([]);
  });

  it("is stable for the same inputs", () => {
    const nodes = sessions(7);
    const measured = sizes(nodes.map(n => n.id));
    const a = autoLayout(nodes, [], { measured, availableWidth: 2400, availableHeight: 500 }).map(n => n.position);
    const b = autoLayout(nodes, [], { measured, availableWidth: 2400, availableHeight: 500 }).map(n => n.position);
    expect(b).toEqual(a);
  });
});

describe("column spacing", () => {
  it("leaves at least a node's width of clear space between columns", () => {
    const nodes = Array.from({ length: 4 }, (_, i) => agent(`s${i}n0`, `s${i}`));
    const measured = sizes(nodes.map(n => n.id));
    const out = autoLayout(nodes, [], { measured, availableWidth: 4000, availableHeight: 300 });

    const xs = [...new Set(out.map(n => Math.round(n.position.x)))].sort((a, b) => a - b);
    expect(xs.length).toBe(2);

    // Clear space = pitch, minus the card, minus the burst lane beside it.
    const TOOL_LANE = 420;
    const clear = (xs[1] - xs[0]) - W - TOOL_LANE;
    expect(clear).toBeGreaterThanOrEqual(W);
  });
});

describe("separateOverlaps — cluster boxes, not just cards", () => {
  const CHROME = 18 * 2 + 26 + 12;   // padding both sides + header + label tab

  it("keeps different sessions clear of each other's cluster box", () => {
    // Cards 30px apart never touch, but the boxes drawn around them do — the
    // box reaches ~56px above its card for the header and label tab.
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const pos = new Map([["a", { x: 0, y: 0 }], ["b", { x: 0, y: H + 30 }]]);
    const moved = separateOverlaps(nodes, pos, new Map(), sizes(["a", "b"]));

    expect(moved).toEqual(["b"]);
    expect(pos.get("b")!.y - (pos.get("a")!.y + H)).toBeGreaterThanOrEqual(CHROME);
  });

  it("still packs nodes of the same session tightly", () => {
    // Within one session there is no second box to clear, so the generous
    // cross-session spacing must not apply.
    const nodes = [agent("a", "sa"), agent("b", "sa")];
    const pos = new Map([["a", { x: 0, y: 0 }], ["b", { x: 0, y: H + 30 }]]);
    expect(separateOverlaps(nodes, pos, new Map(), sizes(["a", "b"]))).toEqual([]);
  });
});

describe("breathing room between sessions", () => {
  const PAD = 18, HEADER_H = 26, LABEL_LIFT = 12;

  it("leaves a visible gap between one session's box and the next one's label", () => {
    // What the eye sees: the bottom edge of A's cluster box to the top of B's
    // label tab. Card-origin distance is not the same thing — the chrome sits
    // between them.
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const measured = sizes(["a", "b"]);
    const out = autoLayout(nodes, [], { measured });

    const a = out.find(n => n.id === "a")!.position;
    const b = out.find(n => n.id === "b")!.position;
    const aBoxBottom = a.y + H + PAD;
    const bLabelTop = b.y - PAD - HEADER_H - LABEL_LIFT;

    expect(bLabelTop - aBoxBottom).toBeGreaterThanOrEqual(30);
  });

  it("holds that gap when the repair pass moves a session too", () => {
    const nodes = [agent("a", "sa"), agent("b", "sb")];
    const measured = sizes(["a", "b"]);
    const pos = new Map([["a", { x: 0, y: 0 }], ["b", { x: 0, y: H + 10 }]]);
    separateOverlaps(nodes, pos, new Map(), measured);

    const aBoxBottom = pos.get("a")!.y + H + PAD;
    const bLabelTop = pos.get("b")!.y - PAD - HEADER_H - LABEL_LIFT;
    expect(bLabelTop - aBoxBottom).toBeGreaterThanOrEqual(30);
  });
});

describe("fillGapsWithNewSessions — reuse the space finished sessions left", () => {
  const CHROME = 18 * 2 + 26 + 12;
  const GAP = 72;
  const PITCH = H + CHROME + GAP;   // where the layout puts consecutive sessions

  it("puts a new session in the hole left by a finished one", () => {
    // Three sessions were stacked; the middle one finished and was pruned.
    const nodes = [agent("a", "sa"), agent("c", "sc"), agent("new", "snew")];
    const measured = sizes(["a", "c", "new"]);
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["c", { x: 0, y: PITCH * 2 }],
      ["new", { x: 0, y: PITCH * 3 }],   // appended at the bottom
    ]);

    const moved = fillGapsWithNewSessions(nodes, positions, new Map(), measured, new Set(["new"]));
    expect(moved).toEqual(["snew"]);
    // It should now sit in the vacated middle band, not below `c`.
    expect(positions.get("new")!.y).toBeLessThan(positions.get("c")!.y);
    expect(positions.get("new")!.y).toBeGreaterThan(positions.get("a")!.y);
    expect(overlaps(
      nodes.map(n => ({ ...n, position: positions.get(n.id)! })), measured,
    )).toEqual([]);
  });

  it("leaves it at the bottom when nothing has been vacated", () => {
    const nodes = [agent("a", "sa"), agent("b", "sb"), agent("new", "snew")];
    const measured = sizes(["a", "b", "new"]);
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 0, y: PITCH }],
      ["new", { x: 0, y: PITCH * 2 }],
    ]);
    expect(fillGapsWithNewSessions(nodes, positions, new Map(), measured, new Set(["new"]))).toEqual([]);
    expect(positions.get("new")!.y).toBe(PITCH * 2);
  });

  it("does not squeeze into a hole too small for it", () => {
    // The band between a and b is half a session tall. The arrival must end up
    // after b, not wedged between them — though it may still be pulled up from
    // an artificially distant y, which is compaction rather than gap-filling.
    const nodes = [agent("a", "sa"), agent("b", "sb"), agent("new", "snew")];
    const measured = sizes(["a", "b", "new"]);
    const bY = H + CHROME + GAP / 2;
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 0, y: bY }],
      ["new", { x: 0, y: 2000 }],
    ]);
    fillGapsWithNewSessions(nodes, positions, new Map(), measured, new Set(["new"]));

    expect(positions.get("new")!.y).toBeGreaterThanOrEqual(bY + H);   // after b
    expect(overlaps(
      nodes.map(n => ({ ...n, position: positions.get(n.id)! })), measured,
    )).toEqual([]);
  });

  it("moves a multi-card session as one block", () => {
    const nodes = [agent("a", "sa"), agent("n1", "snew"), agent("n2", "snew"), agent("c", "sc")];
    const measured = sizes(["a", "n1", "n2", "c"]);
    const positions = new Map([
      ["a",  { x: 0, y: 0 }],
      ["c",  { x: 0, y: PITCH * 4 }],
      ["n1", { x: 0,   y: 5000 }],
      ["n2", { x: 320, y: 5040 }],    // offset from n1 within its own session
    ]);
    fillGapsWithNewSessions(nodes, positions, new Map(), measured, new Set(["n1", "n2"]));
    // The pair keeps its internal offset exactly.
    expect(positions.get("n2")!.x - positions.get("n1")!.x).toBe(320);
    expect(positions.get("n2")!.y - positions.get("n1")!.y).toBe(40);
    expect(positions.get("n1")!.y).toBeLessThan(5000);
  });

  it("leaves a subagent beside the parent that spawned it", () => {
    // The caller passes every node without a stored position, which for a
    // session already on screen that spawns a subagent is just that child.
    // It is not a new session, so it must stay in the slot dagre gave it next
    // to its parent — not be teleported into the gap a pruned session left.
    const nodes = [agent("a", "sa"), agent("c", "sc"), agent("child", "sc")];
    const measured = sizes(["a", "c", "child"]);
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["c", { x: 0, y: PITCH * 2 }],              // a session already running
      ["child", { x: 640, y: PITCH * 2 + 40 }],   // its brand-new subagent
    ]);

    const moved = fillGapsWithNewSessions(nodes, positions, new Map(), measured, new Set(["child"]));
    expect(moved).toEqual([]);
    expect(positions.get("child")).toEqual({ x: 640, y: PITCH * 2 + 40 });
  });

  it("never relocates a dragged node", () => {
    const nodes = [agent("a", "sa"), agent("p", "snew")];
    const measured = sizes(["a", "p"]);
    const positions = new Map([["a", { x: 0, y: 0 }], ["p", { x: 0, y: 4000 }]]);
    const pinned = new Map([["p", { x: 0, y: 4000 }]]);
    expect(fillGapsWithNewSessions(nodes, positions, pinned, measured, new Set(["p"]))).toEqual([]);
  });
});

// Reported with a screenshot: five Chrome bubbles piled on top of each other,
// unreadable. Bursts are an overlay rather than React Flow nodes, so dagre
// cannot see them — and ranksep is 160 while a lane reaches 420 out. The next
// rank was therefore placed straight through the previous agent's bubbles.
describe("burst lanes are reserved in the layout", () => {
  const agent = (id: string, sessionId = "s1") => ({
    id,
    position: { x: 0, y: 0 },
    data: { sessionId, kind: "agent" },
  }) as any;

  const measured = (ids: string[]) =>
    new Map(ids.map(id => [id, { width: 240, height: 130 }]));

  it("puts a child clear of its parent's bubbles", () => {
    const nodes = [agent("a"), agent("b")];
    const edges = [{ id: "e", source: "a", target: "b" }] as any;
    const withLane = autoLayout(nodes, edges, {
      measured: measured(["a", "b"]),
      lanes: new Map([["a", 4]]),
    });
    const a = withLane.find(n => n.id === "a")!.position.x;
    const b = withLane.find(n => n.id === "b")!.position.x;
    // Card is 240 wide, bubbles start 60 past it and run to ~420 — so the
    // child has to begin beyond that, not 160px after the card.
    expect(b - a).toBeGreaterThan(240 + 420);
  });

  it("leaves an agent without tools exactly where it was", () => {
    const nodes = [agent("a"), agent("b")];
    const edges = [{ id: "e", source: "a", target: "b" }] as any;
    const bare = autoLayout(nodes, edges, { measured: measured(["a", "b"]) });
    const b = bare.find(n => n.id === "b")!.position.x;
    const a = bare.find(n => n.id === "a")!.position.x;
    // No lanes passed: the old spacing, so a quiet graph stays compact.
    expect(b - a).toBeLessThan(240 + 420);
  });

  it("gives a tall trail vertical room too", () => {
    // Four bubbles at 36px each start 6px below the card's top: 150px, which
    // is more than the 130px card that dagre would otherwise reserve.
    const nodes = [agent("a"), agent("b")];
    const withLane = autoLayout(nodes, [] as any, {
      measured: measured(["a", "b"]),
      lanes: new Map([["a", 4], ["b", 4]]),
    });
    const ys = withLane.map(n => n.position.y).sort((x, y) => x - y);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(150);
  });
});
