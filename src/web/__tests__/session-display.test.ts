// #520 put `agentName` on the card and left `aiTitle` in the tooltip. #521 put
// the same `agentName` in the cluster header. Both were built on one transcript
// that happened to carry a name, and the result renders for almost nobody.
//
// Swept over every transcript under ~/.claude/projects on this machine — 7,743
// files, 1.2 GB, 19 projects, matching the whole-line records by their exact
// `{"type":"…"` prefix so a mention in prose does not count:
//
//     with agent-name        18   0.2%      over 50 KB:  14   1.1%
//     with ai-title         318   4.1%      over 50 KB: 313  25.3%
//     name and no title       0   0.0%
//     title and no name     300   3.9%
//     neither              7425  95.9%
//
// The rare field was on the card and the common one was hidden behind a hover.
// Worse, `name and no title` is EMPTY: there is no session anywhere here that
// the old rule serves and the new one does not, so the fallback costs nothing
// and buys back 300 of the 318 sessions that have anything to show at all.
//
// One more thing the sweep says, which the four cases below have to respect:
// of the 18 named sessions, ZERO have a title that differs from the name.
// CC overwrites `aiTitle` with the slug once a session is named, so "both,
// and distinct" is a real code path that no transcript here is currently in —
// which is exactly why it needs a test rather than a measurement.
//
// Pure functions only, like the rest of this suite: no DOM, no layout engine.
// That the two surfaces then WIRE these strings up is a render question and was
// checked in a browser against the built bundle, not here.
import { describe, it, expect } from "vitest";
import { sessionDisplay } from "../session-display";
import {
  clusterBounds,
  clusterHeader,
  truncateName,
  NAME_COLUMNS,
  SEP,
  type ClusterNode,
} from "../components/SessionClusters";
import { applyEvent, initialState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";

/** An `agent-name` measured on this machine. */
const NAME = "account-management-oauth-flow";
/** An `ai-title` measured on this machine — 44 code points, past the cap. */
const TITLE = "Create Jira task for AI copilot feature setup";

describe("the four cases, which are the whole feature", () => {
  // 1 of 4. Rare — 0 transcripts of 7,743 are in this state, since CC writes a
  // title before it ever writes a name. Kept because the reducer MANUFACTURES
  // it: when the title merely repeats the name it drops the title (#520), and
  // what is left is this.
  it("name only: the name on the face, and the same name in the tooltip", () => {
    const d = sessionDisplay(NAME, undefined);
    expect(d.face).toBe(NAME);
    expect(d.tooltip).toBe(NAME);
  });

  // 2 of 4, and the one that matters: 300 of the 318 sessions with any naming
  // at all. This is what rendered NOTHING before.
  it("title only: the title on the face, where the name would have gone", () => {
    const d = sessionDisplay(null, TITLE);
    expect(d.face).toBe(TITLE);
    expect(d.tooltip).toBe(TITLE);
  });

  // 3 of 4. #520's arrangement, preserved exactly: the name wins the face and
  // the sentence stays the thing the tooltip adds.
  it("both: the name on the face, the sentence in the tooltip", () => {
    const d = sessionDisplay(NAME, "Add resizable folders panel with auto-save width");
    expect(d.face).toBe(NAME);
    expect(d.tooltip).toBe("Add resizable folders panel with auto-save width");
  });

  // 4 of 4. A Codex rollout, and a Claude session too young to have been named,
  // are the same case and produce the same nothing. Absent, not blank: the
  // callers render no row at all rather than an empty one.
  it("neither: no face and no tooltip, so no row exists to be empty", () => {
    const d = sessionDisplay(undefined, undefined);
    expect(d.face).toBeUndefined();
    expect(d.tooltip).toBeUndefined();
  });

  it("treats blank, whitespace and the wrong type as nothing at all", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
      const d = sessionDisplay(bad as string, bad as string);
      expect(d.face).toBeUndefined();
      expect(d.tooltip).toBeUndefined();
    }
    // and a blank in ONE of the two falls through to the other rather than
    // winning with an empty string, which would render a row of nothing.
    expect(sessionDisplay("   ", TITLE).face).toBe(TITLE);
    expect(sessionDisplay(NAME, "   ").face).toBe(NAME);
  });

  it("trims, because the two records are written by different code paths", () => {
    expect(sessionDisplay(`  ${NAME}  `, null).face).toBe(NAME);
    expect(sessionDisplay(null, `\t${TITLE}\n`).face).toBe(TITLE);
  });

  // The pair the reducer normally removes, answered correctly anyway: this
  // function does not get to assume its caller sanitised its input, and for one
  // string twice both rules give the same answer.
  it("answers a name and title that are the same string without a special case", () => {
    const d = sessionDisplay(NAME, NAME);
    expect(d.face).toBe(NAME);
    expect(d.tooltip).toBe(NAME);
  });
});

// ── Truncation, which now fires on the ordinary path rather than the edge ────
//
// 198 of the 299 distinct titles here exceed 32 columns, against 4 of the 10
// distinct names. #521's cap was a guard; it is the common case now.

describe("a title is cut to the same bound a name was", () => {
  it("cuts the longest title measured on this machine", () => {
    // 64 code points, eleven past the longest agentName #521 sized the cap on.
    const long = "Explore hotkey and global search features in VCRM Angular portal";
    expect([...long].length).toBe(64);
    const cut = truncateName(long);
    expect(cut.endsWith("…")).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(NAME_COLUMNS);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
  });

  // The bound is on the OUTPUT, which is why a longer input did not need a
  // bigger cap: everything over the line lands on the same width.
  it("bounds a 64-code-point title exactly as tightly as a 53-character name", () => {
    const title = "Explore hotkey and global search features in VCRM Angular portal";
    const name = "Refactor mailbox controller request response handling";
    expect([...truncateName(title)].length).toBeLessThanOrEqual(NAME_COLUMNS);
    expect([...truncateName(name)].length).toBeLessThanOrEqual(NAME_COLUMNS);
  });

  // Hypothetical when #521 wrote it, real now: this is an ai-title from the
  // sweep. 18 code points, 36 columns — over a cap that a character count says
  // it is comfortably under.
  it("counts the double-width columns of a real Japanese title", () => {
    const jp = "日本語への翻訳とエージェント並列実行";
    expect([...jp].length).toBe(18);
    expect([...jp].length).toBeLessThan(NAME_COLUMNS);   // a naive count passes it
    const cut = truncateName(jp);
    expect(cut.endsWith("…")).toBe(true);                // the column count does not
    expect([...cut].length).toBeLessThanOrEqual(NAME_COLUMNS / 2);
  });

  // A sentence cut mid-way lands on a space far more often than a slug does,
  // so the separator walk-back stopped being a nicety.
  it("never leaves a title ending in the space it was cut at", () => {
    const cut = truncateName("Create Jira task for AI copilot feature setup");
    expect(cut).toBe("Create Jira task for AI copilot…");
    expect(cut).not.toMatch(/[-\s_.:/]…$/);
  });

  it("leaves a short title exactly as Claude Code wrote it", () => {
    const short = "Fix the login redirect";
    expect(truncateName(short)).toBe(short);
  });
});

// ── The two surfaces, which must choose the same field ───────────────────────

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

describe("the cluster header falls back to the title too", () => {
  it("carries the title when the root has no name", () => {
    const [c] = clusterBounds([card("s1", 0, { sessionTitle: TITLE })]);
    expect(c.name).toBe(truncateName(TITLE));
    expect(c.fullLabel).toBe(`vcrm-core${SEP}${TITLE}`);
  });

  it("still prefers the name when the root has both", () => {
    const [c] = clusterBounds([card("s1", 0, { sessionName: NAME, sessionTitle: TITLE })]);
    expect(c.name).toBe(NAME);
    expect(c.fullLabel).toBe(`vcrm-core${SEP}${NAME}`);
  });

  it("recovers the untruncated title from the tooltip when the header cut it", () => {
    const [c] = clusterBounds([card("s1", 0, { sessionTitle: TITLE })]);
    expect(c.name).toContain("…");
    expect(c.fullLabel).toContain(TITLE);
    expect(c.fullLabel).not.toContain("…");
  });

  // The id keeps the condition #521 gave it. A title does not earn it and does
  // not excuse it, exactly as a name does not.
  it("does not let a title summon or dismiss the short id", () => {
    const alone = clusterBounds([card("s1", 0, { sessionTitle: TITLE })]);
    expect(alone[0].shortId).toBeUndefined();
    const colliding = clusterBounds([
      card("4efa1111-0000-4000-8000-000000000000", 0, { sessionTitle: TITLE }),
      card("9bd70000-0000-4000-8000-000000000000", 900, { sessionTitle: TITLE }),
    ]);
    expect(colliding.map(c => c.shortId)).toEqual(["4efa", "9bd7"]);
  });

  it("ignores a title on a subagent, whichever order the store hands them over", () => {
    const sub = card("s1", 300, { kind: "subagent", label: "explore", sessionTitle: "not the session" });
    const root = card("s1", 0, { sessionTitle: TITLE });
    expect(clusterBounds([root, sub])[0].fullLabel).toBe(`vcrm-core${SEP}${TITLE}`);
    expect(clusterBounds([sub, root])[0].fullLabel).toBe(`vcrm-core${SEP}${TITLE}`);
  });

  // The promise the cap is justified by: the header never shows more of the
  // field than the card beside it does. Both read the same function, so this
  // holds by construction — pinned so it keeps holding.
  it("never shows more of the field than the card does", () => {
    for (const [n, t] of [[NAME, TITLE], [null, TITLE], [NAME, null]] as const) {
      const face = sessionDisplay(n, t).face!;
      const h = clusterHeader("vcrm-core", face, "s1", false);
      expect([...h.name!].length).toBeLessThanOrEqual([...face].length);
      expect(face.startsWith(h.name!.replace(/…$/, ""))).toBe(true);
    }
  });
});

describe("a session with no naming at all is left exactly as it was", () => {
  // The Codex promise, and the young-Claude one, which are the same promise.
  // Both no-naming shapes byte for byte against what the header composed before
  // any of this existed.
  it("renders the header a nameless session has always had", () => {
    const [c] = clusterBounds([card("s1", 0, {})]);
    expect(c.name).toBeUndefined();
    expect(c.fullLabel).toBe("vcrm-core");
    const two = clusterBounds([
      card("4efa1111-0000-4000-8000-000000000000", 0, {}),
      card("9bd70000-0000-4000-8000-000000000000", 900, {}),
    ]);
    expect(two.map(c => c.fullLabel)).toEqual(["vcrm-core · 4efa", "vcrm-core · 9bd7"]);
  });

  it("gives a Codex root no face for the card to draw", () => {
    const codex = sessionDisplay(undefined, undefined);
    expect(codex.face).toBeUndefined();
  });
});

// ── End to end, from the payload the running deck actually emits ─────────────

let seq = 0;
const envelope = (payload: HookPayload): HookEnvelope =>
  ({ seq: ++seq, receivedAt: Date.now(), source: "hook", payload });

function rooted(sid: string) {
  return applyEvent(initialState(), envelope({
    hook_event_name: "SessionStart", session_id: sid, cwd: "/repo/vcrm-core",
  }));
}

describe("the SessionNamed payloads a live deck emits", () => {
  // Copied from the events a running deck emitted on this machine. Every one
  // of them carries sessionName: null and a perfectly good sessionTitle, and
  // every one of them drew a blank card before this change.
  const live = [
    { session_id: "4efab9a0", sessionName: null, sessionTitle: "Add profile details zone to panel layout" },
    { session_id: "2dc5b245", sessionName: null, sessionTitle: "Set up SSH key-based authentication" },
    { session_id: "41482386", sessionName: null, sessionTitle: "Create Jira task for AI copilot feature setup" },
  ];

  for (const ev of live) {
    it(`draws "${ev.sessionTitle}" rather than nothing`, () => {
      const s = applyEvent(rooted(ev.session_id), envelope({
        hook_event_name: "SessionNamed", ...ev,
      }));
      const root = s.agents.get(ev.session_id)!;
      expect(root.sessionName).toBeUndefined();
      expect(root.sessionTitle).toBe(ev.sessionTitle);
      const d = sessionDisplay(root.sessionName, root.sessionTitle);
      expect(d.face).toBe(ev.sessionTitle);
    });
  }

  // The reducer drop, still correct and still doing its job: it turns the pair
  // CC actually writes for a named session into the name-only case, so the
  // tooltip does not read the card back to the user.
  it("collapses a title that repeats the name into the name-only case", () => {
    const s = applyEvent(rooted("s9"), envelope({
      hook_event_name: "SessionNamed", session_id: "s9",
      sessionName: NAME, sessionTitle: NAME,
    }));
    const root = s.agents.get("s9")!;
    expect(root.sessionTitle).toBeUndefined();
    expect(sessionDisplay(root.sessionName, root.sessionTitle)).toEqual({
      face: NAME, tooltip: NAME,
    });
  });

  // A title arriving after a name must not take the face off the name, and a
  // name arriving after a title must take it.
  it("hands the face over when a name finally arrives, and not before", () => {
    let s = applyEvent(rooted("s10"), envelope({
      hook_event_name: "SessionNamed", session_id: "s10",
      sessionName: null, sessionTitle: TITLE,
    }));
    let root = s.agents.get("s10")!;
    expect(sessionDisplay(root.sessionName, root.sessionTitle).face).toBe(TITLE);

    s = applyEvent(s, envelope({
      hook_event_name: "SessionNamed", session_id: "s10",
      sessionName: NAME, sessionTitle: null,
    }));
    root = s.agents.get("s10")!;
    const d = sessionDisplay(root.sessionName, root.sessionTitle);
    expect(d.face).toBe(NAME);
    expect(d.tooltip).toBe(TITLE);
  });

  it("leaves a session with no SessionNamed event with nothing to draw", () => {
    const root = rooted("s11").agents.get("s11")!;
    expect(sessionDisplay(root.sessionName, root.sessionTitle).face).toBeUndefined();
  });
});
