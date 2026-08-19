// #520 put the name Claude Code gives a session on the node card and left the
// cluster header alone. The header is the workspace basename, plus four
// characters of the session id when — and only when — a second cluster carries
// the same workspace label. That condition is the whole point of the id there:
// it is a collision disambiguator, not a field the header always wants.
//
// The name joins it here, and the id keeps its condition unchanged. The two
// cannot be traded for each other in either direction. A name does not earn the
// id, because a header without a collision has nothing to disambiguate; and a
// name does not excuse it, because two sessions in one workspace can be named
// the same thing and then the name disambiguates nothing at all. So there are
// four shapes, three of them uncommon, and each has to be deliberate.
//
// The other half is width. The header sits over a group of nodes and its box is
// the nodes' bounding box — it is not derived from its own text, and the pill is
// `white-space: nowrap`, so a long name does not wrap, does not clip and does
// not push anything: it simply runs past the right edge of the box it labels.
// The longest agentName in the transcripts on this machine is 53 characters,
// which draws a 480px header over a 276px one-card cluster. The cap is what
// keeps that overhang inside the 240px gutter layout.ts leaves between two
// session columns.
//
// Pure functions only, like the rest of this suite: no DOM, no layout engine.
import { describe, it, expect } from "vitest";
import {
  clusterBounds,
  clusterHeader,
  truncateName,
  NAME_COLUMNS,
  SEP,
  type ClusterHeader,
  type ClusterNode,
} from "../components/SessionClusters";
import type { AgentNodeData } from "../types";

/** The header as it reads on screen, minus the sheet's uppercasing. */
function rendered(h: ClusterHeader): string {
  return [h.label, h.name, h.shortId].filter(Boolean).join(SEP);
}

const NAME = "account-management-oauth-flow";
const SID = "4efa1c2d-0000-4000-8000-000000000000";

describe("the four shapes a cluster header draws", () => {
  it("workspace alone, when there is neither a name nor a collision", () => {
    const h = clusterHeader("vcrm-core", undefined, SID, false);
    expect(rendered(h)).toBe("vcrm-core");
    expect(h.name).toBeUndefined();
    expect(h.shortId).toBeUndefined();
  });

  it("workspace and name, when the session is named and alone in its workspace", () => {
    const h = clusterHeader("vcrm-core", NAME, SID, false);
    expect(rendered(h)).toBe(`vcrm-core${SEP}${NAME}`);
    expect(h.shortId).toBeUndefined();
  });

  it("workspace and id, when the workspace collides and nothing is named", () => {
    const h = clusterHeader("vcrm-core", undefined, SID, true);
    expect(rendered(h)).toBe(`vcrm-core${SEP}4efa`);
    expect(h.name).toBeUndefined();
  });

  it("all three, in that order, when the session is named AND collides", () => {
    const h = clusterHeader("vcrm-core", NAME, SID, true);
    expect(rendered(h)).toBe(`vcrm-core${SEP}${NAME}${SEP}4efa`);
  });

  it("reads exactly as it did before #520 when the session has no name", () => {
    // Both no-name shapes, byte for byte against the two strings the header
    // composed when the name did not exist. This is the Codex card promise from
    // #520 one level up: a provider that carries no naming record leaves the
    // header alone rather than leaving a hole in it.
    expect(rendered(clusterHeader("vcrm-core", undefined, SID, false))).toBe("vcrm-core");
    expect(rendered(clusterHeader("vcrm-core", undefined, SID, true))).toBe("vcrm-core · 4efa");
    expect(rendered(clusterHeader("vcrm-core", "", SID, true))).toBe("vcrm-core · 4efa");
    expect(rendered(clusterHeader("vcrm-core", "   ", SID, true))).toBe("vcrm-core · 4efa");
  });
});

describe("the name never takes the short id over", () => {
  it("does not summon an id that no collision asked for", () => {
    expect(clusterHeader("vcrm-core", NAME, SID, false).shortId).toBeUndefined();
  });

  it("does not dismiss the id it cannot replace", () => {
    expect(clusterHeader("vcrm-core", NAME, SID, true).shortId).toBe("4efa");
  });

  it("keeps two identically named sessions in one workspace apart", () => {
    // The case the id exists for, with the name doing nothing about it: same
    // workspace, same name, two sessions. Without the id these two headers are
    // the same string.
    const a = clusterHeader("vcrm-core", NAME, "4efa1111-0000-4000-8000-000000000000", true);
    const b = clusterHeader("vcrm-core", NAME, "9bd70000-0000-4000-8000-000000000000", true);
    expect(rendered(a)).not.toBe(rendered(b));
    expect([a.shortId, b.shortId]).toEqual(["4efa", "9bd7"]);
  });
});

describe("a name is cut to a bound the header can afford", () => {
  it("leaves a name that already fits exactly as Claude Code wrote it", () => {
    expect(truncateName(NAME)).toBe(NAME);
    expect(NAME.length).toBeLessThanOrEqual(NAME_COLUMNS);
  });

  it("cuts the longest name measured on this machine, ellipsis included in the count", () => {
    // "Refactor mailbox controller request response handling" — an agentName,
    // not an aiTitle, and 53 characters of one. Names are not all kebab slugs.
    const long = "Refactor mailbox controller request response handling";
    const cut = truncateName(long);
    expect(cut.endsWith("…")).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(NAME_COLUMNS);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  });

  it("never lets a cut read as a separator the name itself contains", () => {
    // A cut landing on a hyphen would render "oauth-…", which reads as a name
    // whose next segment is empty rather than as a name that continues.
    const cut = truncateName("account-management-oauth-flow-and-then-some", 20);
    expect(cut).toBe("account-management…");
    expect(cut).not.toMatch(/[-\s_.:/]…$/);
  });

  it("counts a double-width code point as the two columns it draws", () => {
    // 20 CJK characters draw 40 monospace columns, so a cap counted in
    // characters would let this name run to twice the bound the header is
    // allowed. Counted in columns it stops at the same width a Latin name does.
    const cjk = "日本語".repeat(20);
    const cut = truncateName(cjk);
    expect([...cut].length).toBeLessThanOrEqual(NAME_COLUMNS / 2);
  });

  it("cuts on code points, so a surrogate pair is never split in half", () => {
    const cut = truncateName(`${"a".repeat(30)}🙂🙂🙂`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("keeps the whole name in the tooltip when the header could not show it", () => {
    const long = "Refactor mailbox controller request response handling";
    const h = clusterHeader("vcrm-core", long, SID, true);
    expect(h.name).not.toBe(long);
    expect(h.fullLabel).toBe(`vcrm-core${SEP}${long}${SEP}4efa`);
    expect(h.fullLabel).not.toContain("…");
  });

  it("says the same thing twice when nothing was cut", () => {
    const h = clusterHeader("vcrm-core", NAME, SID, false);
    expect(h.fullLabel).toBe(rendered(h));
  });
});

// The composition is reached through clusterBounds in the app, and the geometry
// half of that is cluster-bounds.test.ts. What is checked here is only that the
// name arrives from the session ROOT and from nowhere else.
const W = 240, H = 130;

function card(sessionId: string, x: number, over: Partial<AgentNodeData>): ClusterNode {
  return {
    type: "agent",
    position: { x, y: 0 },
    width: W,
    height: H,
    data: { sessionId, kind: "root", label: "vcrm-core", state: "active", ...over } as AgentNodeData,
  };
}

describe("the header reads the name off the session root", () => {
  it("takes the name a root carries", () => {
    const [c] = clusterBounds([card("s1", 0, { sessionName: NAME })]);
    expect(c.name).toBe(NAME);
    expect(c.label).toBe("vcrm-core");
  });

  it("stays nameless for a session whose root has no name yet", () => {
    const [c] = clusterBounds([card("s1", 0, {})]);
    expect(c.name).toBeUndefined();
    expect(c.fullLabel).toBe("vcrm-core");
  });

  it("ignores a name on a subagent, whichever order the store hands them over", () => {
    // A subagent carries no sessionName in the reducer, but the header must not
    // depend on that staying true: only the root speaks for the session.
    const sub = card("s1", 300, { kind: "subagent", label: "explore", sessionName: "not-the-session" });
    const root = card("s1", 0, { sessionName: NAME });
    expect(clusterBounds([root, sub])[0].name).toBe(NAME);
    expect(clusterBounds([sub, root])[0].name).toBe(NAME);
  });

  it("gives two same-named sessions in one workspace their ids and neither the other name", () => {
    const boxes = clusterBounds([
      card("4efa1111-0000-4000-8000-000000000000", 0, { sessionName: NAME }),
      card("9bd70000-0000-4000-8000-000000000000", 900, { sessionName: NAME }),
    ]);
    expect(boxes.map(c => c.shortId)).toEqual(["4efa", "9bd7"]);
    expect(boxes.map(c => c.name)).toEqual([NAME, NAME]);
  });
});
