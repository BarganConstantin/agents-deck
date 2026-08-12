// Nodes landing on top of each other is the one layout bug a user reports as
// "broken" rather than "ugly", so these assert the geometry directly instead
// of asserting that dagre was called with the right arguments.
import { describe, it, expect } from "vitest";
import type { Node, Edge } from "reactflow";
import { autoLayout } from "../layout";

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
