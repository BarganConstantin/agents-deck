// #346: the badge from #337 works, and the alarm surfaces were being lit by the
// kind of block that is not an alarm — which is also the kind that fires most.
// Counted from one machine's events.jsonl, deduplicated across the decks that
// share it: 16 idle_prompt against 5 permission_prompt. So three quarters of
// everything the topbar chip, the tab title and the favicon reported was a
// session that had simply finished its turn and not been picked back up, on a
// node already reading `done` two columns away. Those three surfaces are worth
// having only while they are rare.
//
// The two kinds were already separate where it mattered least (sort order,
// styling) and identical where it mattered most (every place that counts). This
// pins the split at the counting, and it pins what idle KEEPS: its row, its card
// line, its place above running in the sort, and CC's verbatim sentence in the
// tooltip. Only the alarm goes.
//
// No DOM — plain node, vitest — so this drives the shapes App.tsx and
// SessionList.tsx build their rows from, and calls the shipped rules on them
// directly.
//
// #377: the alarm predicate was re-derived here rather than imported, because
// until then it existed only inline inside a React component that bare node
// cannot render. That is also why ambient-signal.test.ts kept its own copy, and
// why that copy silently went stale. The rule now lives in ambient-counts.ts,
// so both suites call the same function the app calls and neither can drift
// from it; the source-text checks below shrank to the one thing text is
// actually good for, which is proving the call sites did not quietly grow a
// second definition beside it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { waitingLabel, waitingSentence } from "../components/AgentNode";
import { ambientSignal } from "../ambient";
import { isAlarming } from "../ambient-counts";
import type { AgentNodeData, WaitingBlock } from "../types";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const block = (kind: WaitingBlock["kind"], message: string): WaitingBlock =>
  ({ kind, message, since: 1_000 });

const PERMISSION = block("permission", "Claude needs your permission");
const IDLE = block("idle", "Claude is waiting for your input");

/** A root the way both counters see one. */
const root = (id: string, waiting: WaitingBlock | null): Partial<AgentNodeData> =>
  ({ id, sessionId: id, kind: "root", label: id, state: "active", waiting });

describe("what raises an alarm", () => {
  // The rule both call sites share — imported, not restated. A restatement is
  // what #377 was: a second copy of this expression that #348 never reached,
  // asserting the superseded counting as correct for thirty releases.
  const alarming = isAlarming;

  it("counts a permission block and not an idle one", () => {
    const agents = [
      root("a", PERMISSION),
      root("b", IDLE),
      root("c", IDLE),
      root("d", null),
    ];
    expect(agents.filter(a => alarming(a.waiting)).length).toBe(1);
    // And the naive rule, which is what shipped, would have said three.
    expect(agents.filter(a => a.waiting).length).toBe(3);
  });

  it("leaves the tab strip at rest when every block is idle", () => {
    // The regression exactly as reported: one finished session, untouched for
    // seven minutes, putting a count in the title and amber in the favicon.
    const idleOnly = [root("a", IDLE), root("b", IDLE)];
    const waiting = idleOnly.filter(a => alarming(a.waiting)).length;
    expect(ambientSignal({ waiting, running: 1 })).toEqual({ title: "ccdeck", icon: "running" });
    // Not a claim that idle is invisible — it is on the card and in the list.
    expect(idleOnly.every(a => a.waiting)).toBe(true);
  });

  it("still fires on the case the feature exists for", () => {
    const blocked = [root("a", PERMISSION), root("b", IDLE)];
    const waiting = blocked.filter(a => alarming(a.waiting)).length;
    expect(ambientSignal({ waiting, running: 2 }).icon).toBe("waiting");
    expect(ambientSignal({ waiting, running: 2 }).title).toBe("(1) ccdeck");
  });
});

describe("what an idle block says out loud", () => {
  it("reads as your move, not as an emergency", () => {
    // "Claude is waiting for your input" is accurate and sounds like an alarm.
    expect(waitingLabel(IDLE)).toBe("Your turn");
    expect(waitingLabel(IDLE)).not.toBe(IDLE.message);
  });

  it("keeps CC's exact sentence for the tooltip to carry", () => {
    // The payload has no tool_name and no tool_input, so this sentence is the
    // whole of what we know — it may be quieted on the card, never discarded.
    expect(waitingSentence(IDLE)).toBe("Claude is waiting for your input");
  });

  it("does not touch a permission block, which is urgent as written", () => {
    expect(waitingLabel(PERMISSION)).toBe("Claude needs your permission");
    expect(waitingLabel(PERMISSION)).toBe(waitingSentence(PERMISSION));
  });

  it("falls back per kind when an old log line carries no message", () => {
    expect(waitingLabel(block("permission", ""))).toBe("Needs your permission");
    expect(waitingLabel(block("idle", ""))).toBe("Your turn");
  });
});

describe("the two call sites", () => {
  // Counting `waiting` truthiness is the bug. If either file goes back to it,
  // the alarm goes back to being three quarters noise — and nothing else in the
  // suite would notice, because both surfaces still work, they just lie.
  //
  // The behaviour is pinned above, against the imported rule; what is left for
  // text to check is that the call sites still ASK that rule. A file that stops
  // importing ambient-counts.ts and answers the question itself passes every
  // behavioural case in this repo while shipping whatever it likes, which is
  // the shape #377 turned out to have.
  it("ask the shared rule rather than deciding for themselves", () => {
    // The CALL, not the import: an import can sit unused above a file that has
    // grown the loop back inline, which is exactly what a careless revert of
    // this refactor looks like.
    const app = src("../App.tsx");
    expect(app, "App.tsx no longer counts blocked sessions through ambient-counts.ts")
      .toMatch(/blockedSessions\(stateRef\.current\.agents\.values\(\)\)/);
    expect(app, "App.tsx grew its own copy of the alarm rule again")
      .not.toMatch(/for \(const a of stateRef\.current\.agents\.values\(\)\) \{\s*\n\s*if \(a\.kind === "root"/);

    const list = src("../components/SessionList.tsx");
    expect(list, "SessionList counts any block again")
      .toMatch(/rows\.filter\(r => isAlarming\(r\.waiting\)\)/);
  });

  it("keeps idle sorted above running, which is not an alarm but is still news", () => {
    // rank(): permission 0, idle 1, active 2, rest 3. Dropping idle out of the
    // count must not drop it out of the ordering — the sidebar is the surface
    // idle keeps, so the two questions have to stay separable. Asserted as text
    // because rank() is module-private to a component this suite cannot render.
    expect(src("../components/SessionList.tsx")).toMatch(/isAlarming\(r\.waiting\) \? 0 : 1/);
  });
});
