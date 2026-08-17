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
import { buildRows, rank } from "../components/SessionList";
import { ambientSignal } from "../ambient";
import { isAlarming } from "../ambient-counts";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload, WaitingBlock } from "../types";

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

});

// ── the order the sidebar puts them in, driven through the reducer ──────────
//
// #378: this was one regex — `/isAlarming\(r\.waiting\) \? 0 : 1/` over
// SessionList.tsx — standing over the whole ordering, because rank() and the
// comparator were module-private to a component bare node cannot render. A
// regex over an expression is not a test of what the expression computes:
// reversing rank()'s two non-blocked tiers AND reversing the longest-blocked-
// first comparator left the entire suite green, since both reversals keep the
// characters the regex was looking for. Both functions are exported now and
// these cases call them, on rows the real reducer built from real hook
// payloads, so the mutation that survived is the mutation that fails here.

const NOTIFY = {
  permission: { notification_type: "permission_prompt", message: "Claude needs your permission" },
  idle: { notification_type: "idle_prompt", message: "Claude is waiting for your input" },
} as const;

let seq = 0;
function send(state: GraphState, session: string, payload: HookPayload, receivedAt?: number): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: receivedAt ?? 1_000 + seq,
    source: "hook",
    payload: { session_id: session, ...payload },
  };
  return applyEvent(state, env);
}

/** Starts `session` and puts it mid-turn, which is what `active` means here. */
function start(state: GraphState, session: string, at: number): GraphState {
  state = send(state, session, { hook_event_name: "SessionStart", cwd: `/repo/${session}` }, at);
  return send(state, session, { hook_event_name: "UserPromptSubmit", prompt: "go" }, at);
}

describe("the order the sidebar reads in", () => {
  it("puts a permission block above an idle one, and both above anything running", () => {
    // rank(): permission 0, idle 1, active 2, rest 3. #348 dropped idle out of
    // the COUNT and it has to stay in the ORDER — the sidebar is the surface
    // idle keeps, so the two questions are separable and this is the one that
    // says the second answer did not follow the first. Fails if the tiers are
    // reordered in any way, which the regex this replaced did not.
    seq = 0;
    let state = initialState();
    for (const s of ["running", "idle", "permission", "finished"]) state = start(state, s, 1_000);
    state = send(state, "finished", { hook_event_name: "Stop" }, 2_000);
    state = send(state, "permission", { hook_event_name: "Notification", ...NOTIFY.permission }, 3_000);
    state = send(state, "idle", { hook_event_name: "Notification", ...NOTIFY.idle }, 4_000);

    expect(buildRows(state, 9_000).map(r => r.sessionId))
      .toEqual(["permission", "idle", "running", "finished"]);
  });

  it("puts the longest-blocked session first, which is the opposite of every other tier", () => {
    // The one ordering on this list that runs oldest-first: on a blocked row the
    // number that decides whether you go look is how long it has been stuck.
    // A reversed comparator hands the top of the sidebar to the block that just
    // arrived — the one you already know about — and nothing failed.
    seq = 0;
    let state = initialState();
    for (const s of ["newest", "oldest", "middle"]) state = start(state, s, 1_000);
    state = send(state, "oldest", { hook_event_name: "Notification", ...NOTIFY.permission }, 2_000);
    state = send(state, "middle", { hook_event_name: "Notification", ...NOTIFY.permission }, 5_000);
    state = send(state, "newest", { hook_event_name: "Notification", ...NOTIFY.permission }, 8_000);

    const rows = buildRows(state, 9_000);
    expect(rows.map(r => r.sessionId)).toEqual(["oldest", "middle", "newest"]);
    expect(rows.map(r => r.waiting!.since)).toEqual([2_000, 5_000, 8_000]);
  });

  it("falls back to most-recent-first once nothing is blocked, which is the other direction", () => {
    // Both directions in one file on purpose: a comparator that sorted every
    // tier the same way would satisfy either case alone.
    seq = 0;
    let state = initialState();
    for (const s of ["stale", "recent"]) state = start(state, s, 1_000);
    state = send(state, "stale", { hook_event_name: "Stop" }, 2_000);
    state = send(state, "recent", { hook_event_name: "Stop" }, 7_000);

    expect(buildRows(state, 9_000).map(r => r.sessionId)).toEqual(["recent", "stale"]);
  });

  it("ranks by the shared alarm rule, so narrowing it moves the sidebar too", () => {
    // rank() asks isAlarming, the same function the topbar chip and the tab
    // strip ask. Called directly here so a rank() that grew its own idea of
    // what an alarm is — the exact shape #377 found in three other places —
    // fails rather than merely looking different.
    const at = (waiting: WaitingBlock | null, state: "active" | "done") =>
      rank({ sessionId: "s", label: "s", state, waiting, toolCount: 0, cost: 0, startedAt: 0, lastActivity: 0 });
    expect(at(PERMISSION, "active")).toBe(0);
    expect(at(IDLE, "active")).toBe(1);
    expect(at(null, "active")).toBe(2);
    expect(at(null, "done")).toBe(3);
    // Strictly increasing, which is what "above" means for a numeric rank.
    expect([at(PERMISSION, "active"), at(IDLE, "active"), at(null, "active"), at(null, "done")])
      .toEqual([0, 1, 2, 3]);
  });
});
