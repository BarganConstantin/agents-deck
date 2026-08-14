// The eviction rule runs during the first render, when the agent map is still
// empty because the event log replays over SSE in an effect. Pruning then used
// to delete every position restored from localStorage, so the canvas rearranged
// itself on every reload and the 1.5s debounced save then made that permanent.
import { describe, it, expect } from "vitest";
import { pruneStaleEntries } from "../prune";

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
