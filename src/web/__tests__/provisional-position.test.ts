// A node whose stored position goes missing is stamped at {0, 0} so it still
// renders that frame, and the stamp used to be written into `positions` — the
// same map that answers "has this node been laid out". The node therefore left
// the set handed to dagre the instant it was rescued, and the "fresh layout
// pass" the invalidation below it promised never reconsidered it: the only pass
// that still touched it was separateOverlaps, which resolves on Y alone, so the
// node lived out the tab in the x=0 column at whatever height stopped it
// colliding — no relation to its parent, its rank or its session.
//
// These drive the real passes in the order App.tsx runs them, because the bug
// is not in any one of them: it is in what `positions` was asked to mean.
import { describe, it, expect } from "vitest";
import type { Edge, Node } from "reactflow";
import { autoLayout, fillGapsWithNewSessions, separateOverlaps } from "../layout";
import { isUnplaced, needsLayout, recordPlacement, stampPlaceholder, type Provisional } from "../placement";

const W = 260, H = 120;
const CANVAS = { availableWidth: 4000, availableHeight: 2000 };

type Point = { x: number; y: number };

function agent(id: string, sessionId: string): Node {
  return { id, position: { x: 0, y: 0 }, data: { sessionId }, width: W, height: H } as Node;
}

const sizes = (nodes: Node[]) => new Map(nodes.map(n => [n.id, { width: W, height: H }]));

/** The layout branch of snapshotToFlow: place what is unplaced, then repair. */
function layoutPass(
  nodes: Node[],
  edges: Edge[],
  positions: Map<string, Point>,
  provisional: Provisional,
  pinned: Map<string, Point> = new Map(),
  measured = sizes(nodes),
): string[] {
  const missing = nodes.filter(n => needsLayout(n.id, pinned, positions, provisional));
  if (missing.length > 0) {
    const laidOut = autoLayout(nodes, edges, { direction: "LR", pinned, measured, ...CANVAS });
    for (const n of laidOut) {
      if (isUnplaced(n.id, positions, provisional)) recordPlacement(n.id, n.position, positions, provisional);
    }
    fillGapsWithNewSessions(nodes, positions, pinned, measured, new Set(missing.map(n => n.id)));
  }
  separateOverlaps(nodes, positions, pinned, measured);
  return missing.map(n => n.id);
}

/** The tail of snapshotToFlow: every visible node gets a coordinate, always. */
function renderPass(
  nodes: Node[],
  positions: Map<string, Point>,
  provisional: Provisional,
  pinned: Map<string, Point> = new Map(),
): Map<string, Point> {
  const drawn = new Map<string, Point>();
  for (const n of nodes) {
    const p = pinned.get(n.id) ?? positions.get(n.id) ?? stampPlaceholder(n.id, positions, provisional);
    drawn.set(n.id, p);
  }
  return drawn;
}

/** One session: a parent that has spawned two subagents. */
const family = [agent("p", "s1"), agent("c1", "s1"), agent("c2", "s1")];
const forks: Edge[] = [
  { id: "e1", source: "p", target: "c1" },
  { id: "e2", source: "p", target: "c2" },
];

describe("a node that loses its stored position", () => {
  it("is laid out again by the next pass, not left in the x=0 column", () => {
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    layoutPass(family, forks, positions, provisional);
    const home = positions.get("c2")!;
    expect(home.x).toBeGreaterThan(0);   // a rank to the right of its parent

    // The loss: the entry is gone by the time the render tail runs, which is
    // the case the stamp exists for.
    positions.delete("c2");
    renderPass(family, positions, provisional);
    layoutPass(family, forks, positions, provisional);

    expect(positions.get("c2")).toEqual(home);
  });

  it("still renders somewhere on the frame it is lost, rather than vanishing", () => {
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    layoutPass(family, forks, positions, provisional);

    positions.delete("c2");
    const drawn = renderPass(family, positions, provisional);
    expect(drawn.size).toBe(family.length);
    expect(drawn.get("c2")).toEqual({ x: 0, y: 0 });
  });

  it("is handed to the layout pass because it is marked, not because it is empty", () => {
    // The stamp fills the entry in, so absence cannot be the test any more.
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    stampPlaceholder("c2", positions, provisional);
    expect(positions.has("c2")).toBe(true);
    expect(needsLayout("c2", new Map(), positions, provisional)).toBe(true);
  });

  it("is reconsidered once, so a stamp cannot hold dagre open every render", () => {
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    layoutPass(family, forks, positions, provisional);

    positions.delete("c2");
    renderPass(family, positions, provisional);
    expect(layoutPass(family, forks, positions, provisional)).toEqual(["c2"]);
    expect(provisional.size).toBe(0);
    expect(layoutPass(family, forks, positions, provisional)).toEqual([]);
  });

  it("lands where a graph that never lost it would have put it", () => {
    // The retry runs dagre over the whole canvas, so the recovered node must
    // not disturb the ones that were already settled either.
    const fresh = new Map<string, Point>();
    layoutPass(family, forks, fresh, new Set());

    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    layoutPass(family, forks, positions, provisional);
    positions.delete("p");
    renderPass(family, positions, provisional);
    layoutPass(family, forks, positions, provisional);

    expect([...positions.entries()].sort()).toEqual([...fresh.entries()].sort());
  });

  it("measures itself by card and burst lane, not by its session's drag handle", () => {
    // The retry is a dagre pass where there used to be none, so it is a new
    // way for the invisible `group:<sessionId>` handle to reach geometry. It
    // is not in `nodes`, only in `measured`, and it is as wide as the whole
    // session — letting it set the column pitch is what v1.33.84 and v1.33.95
    // were both about.
    const measured = sizes(family);
    measured.set("group:s1", { width: 1096, height: 420 });

    const bare = new Map<string, Point>();
    layoutPass(family, forks, bare, new Set());

    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    layoutPass(family, forks, positions, provisional, new Map(), measured);
    positions.delete("c1");
    renderPass(family, positions, provisional);
    layoutPass(family, forks, positions, provisional, new Map(), measured);

    expect([...positions.entries()].sort()).toEqual([...bare.entries()].sort());
  });

  it("leaves a node the user dragged alone, marked or not", () => {
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    const pinned = new Map<string, Point>([["c1", { x: 1800, y: 640 }]]);
    layoutPass(family, forks, positions, provisional, pinned);

    // A drag after a stamp: the mark outlives the placeholder, and a pin is
    // the one coordinate no pass may take back.
    stampPlaceholder("c1", positions, provisional);
    expect(needsLayout("c1", pinned, positions, provisional)).toBe(false);
    expect(renderPass(family, positions, provisional, pinned).get("c1")).toEqual({ x: 1800, y: 640 });
  });
});

describe("a burst of agents arriving at once", () => {
  it("is placed before it is drawn, so nothing is ever stamped", () => {
    // The placeholder is a rescue, not the normal path — an arrival has no
    // position, which is exactly what puts it in front of dagre first. If a
    // burst ever reached the render tail unplaced it would flash at the origin
    // for a frame, which is the flicker the stamp was added to hide.
    const swarm = Array.from({ length: 12 }, (_, i) => agent(`n${i}`, `s${i % 3}`));
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();

    layoutPass(swarm, [], positions, provisional);
    const drawn = renderPass(swarm, positions, provisional);

    expect(provisional.size).toBe(0);
    expect(drawn.size).toBe(swarm.length);
    expect([...drawn.values()].filter(p => p.x === 0 && p.y === 0).length).toBeLessThanOrEqual(1);
  });

  it("keeps the agents that were already on canvas where they were", () => {
    const first = [agent("a", "s1"), agent("b", "s1")];
    const positions = new Map<string, Point>();
    const provisional: Provisional = new Set();
    layoutPass(first, [], positions, provisional);
    const settled = new Map(positions);

    const withSwarm = [...first, ...Array.from({ length: 6 }, (_, i) => agent(`n${i}`, "s2"))];
    layoutPass(withSwarm, [], positions, provisional, new Map(), sizes(withSwarm));

    for (const [id, p] of settled) expect(positions.get(id)).toEqual(p);
  });
});
