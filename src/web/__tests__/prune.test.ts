// The eviction rule runs during the first render, when the agent map is still
// empty because the event log replays over SSE in an effect. Pruning then used
// to delete every position restored from localStorage, so the canvas rearranged
// itself on every reload and the 1.5s debounced save then made that permanent.
import { describe, it, expect } from "vitest";
import { pruneStaleEntries, measuredNodeIds } from "../prune";

const pos = (x: number, y: number) => ({ x, y });

describe("pruneStaleEntries", () => {
  it("keeps every restored position while the graph is still empty", () => {
    const positions = new Map([["a", pos(10, 20)], ["b", pos(30, 40)]]);
    pruneStaleEntries(positions, new Map());
    expect([...positions.keys()]).toEqual(["a", "b"]);
    expect(positions.get("a")).toEqual(pos(10, 20));
  });

  it("evicts entries whose agent is gone once the graph has replayed", () => {
    const positions = new Map([["a", pos(10, 20)], ["gone", pos(30, 40)]]);
    pruneStaleEntries(positions, new Map([["a", {}]]));
    expect([...positions.keys()]).toEqual(["a"]);
  });

  it("keeps entries for agents that are still tracked", () => {
    const pinned = new Map([["a", pos(1, 2)], ["b", pos(3, 4)]]);
    pruneStaleEntries(pinned, new Set(["a", "b"]));
    expect(pinned.size).toBe(2);
  });

  it("survives a replay that arrives after an empty first pass", () => {
    const positions = new Map([["a", pos(10, 20)], ["gone", pos(30, 40)]]);
    pruneStaleEntries(positions, new Map()); // first render, pre-replay
    pruneStaleEntries(positions, new Map([["a", {}]])); // after replay
    expect([...positions.entries()]).toEqual([["a", pos(10, 20)]]);
  });
});

// The size cache was only ever added to — the sole removal was the Clear
// button — so a tab left open for days kept a size for every agent and every
// session it had ever drawn. layout.ts's columnGap() takes the widest measured
// node of all, and a session drag handle is as wide as the session box, so one
// pruned session went on setting the gap between columns forever.
describe("measuredNodeIds", () => {
  const agent = (id: string, sessionId: string) => ({ id, sessionId });
  const size = (width: number, height: number) => ({ width, height });

  it("names the session drag handle alongside every agent card", () => {
    const ids = measuredNodeIds([agent("a", "s1"), agent("sub", "s1")]);
    expect([...ids].sort()).toEqual(["a", "group:s1", "sub"]);
  });

  it("is empty for an empty agent map, which stops the prune from running", () => {
    expect(measuredNodeIds([]).size).toBe(0);
  });

  it("evicts a departed session's cards and its giant handle measurement", () => {
    const measured = new Map([
      ["a", size(240, 130)],
      ["group:s1", size(260, 180)],
      ["old", size(250, 130)],
      ["group:s0", size(1480, 900)],
    ]);
    pruneStaleEntries(measured, measuredNodeIds([agent("a", "s1")]));
    expect([...measured.keys()].sort()).toEqual(["a", "group:s1"]);
  });

  it("keeps handles for sessions whose agents are still tracked", () => {
    const measured = new Map([["group:s1", size(600, 400)]]);
    pruneStaleEntries(measured, measuredNodeIds([agent("a", "s1")]));
    expect(measured.has("group:s1")).toBe(true);
  });

  it("keeps every measurement while the graph is still empty", () => {
    const measured = new Map([["a", size(240, 130)], ["group:s1", size(600, 400)]]);
    pruneStaleEntries(measured, measuredNodeIds([]));
    expect(measured.size).toBe(2);
  });
});
