// A deck that upgrades itself can hand a tab a new bundle without anyone
// clearing anything, so saved state outlives the version that wrote it. These
// pin which half survives: preferences always, shape-bearing state only while
// the shape is unchanged.
import { describe, it, expect } from "vitest";
import { pruneStaleState, SCHEMA_KEY, SHAPE_KEYS, STATE_SCHEMA } from "../storage";

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe("pruneStaleState", () => {
  it("does nothing when the stamp matches", () => {
    const s = store({ [SCHEMA_KEY]: STATE_SCHEMA, "agent-dag.layout": "{}" });
    expect(pruneStaleState(s)).toEqual([]);
    expect(s.getItem("agent-dag.layout")).toBe("{}");
  });

  it("drops shape-bearing state written under a different schema", () => {
    const s = store({ [SCHEMA_KEY]: "0", "agent-dag.layout": "{}", "agent-dag.viewport": "{}" });
    expect(pruneStaleState(s, "1").sort()).toEqual([...SHAPE_KEYS].sort());
    expect(s.getItem("agent-dag.layout")).toBeNull();
    expect(s.getItem(SCHEMA_KEY)).toBe("1");
  });

  it("keeps preferences — an upgrade must not reset the theme", () => {
    const s = store({ [SCHEMA_KEY]: "0", "agent-dag.theme": "dark", "agent-dag.autoRestart": "0", "agent-dag.layout": "{}" });
    pruneStaleState(s, "1");
    expect(s.getItem("agent-dag.theme")).toBe("dark");
    expect(s.getItem("agent-dag.autoRestart")).toBe("0");
  });

  it("treats an unstamped store as current, so existing layouts survive", () => {
    // Everyone upgrading into the first stamped version has no stamp. Reading
    // that as "stale" would wipe every hand-arranged canvas exactly once, for
    // nothing.
    const s = store({ "agent-dag.layout": "{}" });
    expect(pruneStaleState(s, "1")).toEqual([]);
    expect(s.getItem("agent-dag.layout")).toBe("{}");
    expect(s.getItem(SCHEMA_KEY)).toBe("1");
  });

  it("survives a storage that throws — boot must not depend on it", () => {
    const dead = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(pruneStaleState(dead)).toEqual([]);
  });
});
