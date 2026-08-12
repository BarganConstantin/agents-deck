// `pruneDoneSessions` keeps the board from silting up: a day of heavy use
// parks hundreds of completed sessions on the canvas and buries the handful
// that are current. The policy under test:
//   - only sessions where EVERY agent is done are eviction candidates,
//   - candidates are dropped oldest-finished first, whole subtree at a time,
//   - a session that finished less than `graceMs` ago is exempt from being
//     dropped but still counts against the cap (so the board settles at
//     `cap` instead of briefly overshooting it).
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, pruneDoneSessions, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

let seq = 1;
function envelope(payload: HookPayload, at: number): HookEnvelope {
  return {
    seq: seq++,
    receivedAt: at,
    source: "hook",
    payload,
  };
}

function feed(state: GraphState, events: HookEnvelope[]): GraphState {
  let s = state;
  for (const e of events) s = applyEvent(s, e);
  return s;
}

// The prune always runs "at NOW"; session timestamps are expressed as
// "finished N minutes ago", which is the axis the cap + grace reason on.
const NOW = Date.now();
const MIN = 60_000;
const ago = (ms: number): number => NOW - ms;

// Mirrors DONE_SESSION_GRACE_MS in App.tsx.
const GRACE_MS = 2 * MIN;

const subKey = (sessionId: string, i: number): string => `${sessionId}-tu-${i}`;
const subId = (sessionId: string, i: number): string => `${sessionId}::${subKey(sessionId, i)}`;

interface SessionSpec {
  id: string;
  startedAt: number;
  /** When the root stopped. Omit to leave the session running. */
  endedAt?: number;
  /** How many subagents run under the root. */
  subs?: number;
  /** Never emit SubagentStop for subagent #0 — keeps the session "live". */
  runningSub?: boolean;
}

function sessionEvents(spec: SessionSpec): HookEnvelope[] {
  const { id, startedAt, endedAt, subs = 0, runningSub = false } = spec;
  const events: HookEnvelope[] = [
    envelope({ hook_event_name: "SessionStart", session_id: id, cwd: "/repo" }, startedAt),
  ];
  for (let i = 0; i < subs; i++) {
    const key = subKey(id, i);
    events.push(envelope(
      { hook_event_name: "SubagentStart", session_id: id, parent_tool_use_id: key, subagent_type: "worker" },
      startedAt + 100 + i,
    ));
    // Subagents always stop before their root does, so the session's
    // finished-at is the root's endedAt.
    if (endedAt != null && !(runningSub && i === 0)) {
      events.push(envelope(
        { hook_event_name: "SubagentStop", session_id: id, parent_tool_use_id: key },
        endedAt - 1_000 + i,
      ));
    }
  }
  if (endedAt != null) {
    events.push(envelope({ hook_event_name: "Stop", session_id: id }, endedAt));
  }
  return events;
}

function build(specs: SessionSpec[]): GraphState {
  seq = 1;
  let state = initialState();
  for (const spec of specs) state = feed(state, sessionEvents(spec));
  return state;
}

/** Session ids still present in state (roots are keyed by session id). */
function liveSessions(state: GraphState): string[] {
  return [...new Set([...state.agents.values()].map(a => a.sessionId))].sort();
}

describe("pruneDoneSessions", () => {
  it("removes nothing while finished sessions are at or under the cap", () => {
    const state = build([
      { id: "sess-1", startedAt: ago(50 * MIN), endedAt: ago(40 * MIN), subs: 2 },
      { id: "sess-2", startedAt: ago(40 * MIN), endedAt: ago(30 * MIN), subs: 1 },
      { id: "sess-3", startedAt: ago(30 * MIN), endedAt: ago(20 * MIN) },
    ]);
    const before = [...state.agents.keys()].sort();

    // Under the cap.
    expect(pruneDoneSessions(state, NOW, 5, GRACE_MS)).toBe(false);
    // Exactly at the cap — still nothing to do.
    expect(pruneDoneSessions(state, NOW, 3, GRACE_MS)).toBe(false);
    expect([...state.agents.keys()].sort()).toEqual(before);
  });

  it("evicts the oldest-finished sessions and keeps the newest `cap`", () => {
    const state = build([
      { id: "sess-oldest", startedAt: ago(60 * MIN), endedAt: ago(50 * MIN) },
      { id: "sess-older", startedAt: ago(50 * MIN), endedAt: ago(40 * MIN) },
      { id: "sess-mid", startedAt: ago(40 * MIN), endedAt: ago(30 * MIN) },
      { id: "sess-newer", startedAt: ago(30 * MIN), endedAt: ago(20 * MIN) },
      { id: "sess-newest", startedAt: ago(20 * MIN), endedAt: ago(10 * MIN) },
    ]);

    expect(pruneDoneSessions(state, NOW, 3, GRACE_MS)).toBe(true);
    expect(liveSessions(state)).toEqual(["sess-mid", "sess-newer", "sess-newest"]);
    expect(state.agents.has("sess-oldest")).toBe(false);
    expect(state.agents.has("sess-older")).toBe(false);

    // Idempotent: a second pass is already at the cap.
    expect(pruneDoneSessions(state, NOW, 3, GRACE_MS)).toBe(false);
  });

  it("never evicts a session with a still-running agent, even the oldest one", () => {
    const state = build([
      // Root stopped long ago but subagent #0 never reported SubagentStop.
      { id: "sess-live", startedAt: ago(90 * MIN), endedAt: ago(80 * MIN), subs: 2, runningSub: true },
      { id: "sess-a", startedAt: ago(50 * MIN), endedAt: ago(40 * MIN) },
      { id: "sess-b", startedAt: ago(40 * MIN), endedAt: ago(30 * MIN) },
      { id: "sess-c", startedAt: ago(30 * MIN), endedAt: ago(20 * MIN) },
    ]);
    expect(state.agents.get(subId("sess-live", 0))!.state).toBe("active");

    expect(pruneDoneSessions(state, NOW, 1, GRACE_MS)).toBe(true);

    // Two oldest FINISHED sessions went; the older-but-live one survived whole.
    expect(liveSessions(state)).toEqual(["sess-c", "sess-live"]);
    expect(state.agents.has("sess-live")).toBe(true);
    expect(state.agents.has(subId("sess-live", 0))).toBe(true);
    expect(state.agents.has(subId("sess-live", 1))).toBe(true);

    // Cap of 0 still can't touch it — a live session is not a candidate.
    expect(pruneDoneSessions(state, NOW, 0, GRACE_MS)).toBe(true);
    expect(liveSessions(state)).toEqual(["sess-live"]);
    expect(pruneDoneSessions(state, NOW, 0, GRACE_MS)).toBe(false);
  });

  it("exempts a session inside the grace period but still counts it against the cap", () => {
    const state = build([
      { id: "sess-old", startedAt: ago(50 * MIN), endedAt: ago(40 * MIN) },
      { id: "sess-mid", startedAt: ago(40 * MIN), endedAt: ago(30 * MIN) },
      // Finished 30s ago — inside the 2-minute grace, still fading out.
      { id: "sess-fresh", startedAt: ago(2 * MIN), endedAt: ago(30_000) },
    ]);

    expect(pruneDoneSessions(state, NOW, 2, GRACE_MS)).toBe(true);

    // The fresh one counted toward the cap, so the oldest got evicted in its
    // place rather than the board overshooting to 3.
    expect(liveSessions(state)).toEqual(["sess-fresh", "sess-mid"]);
    expect(state.agents.has("sess-old")).toBe(false);
  });

  it("removes nothing when every over-cap session is still inside the grace period", () => {
    const state = build([
      { id: "sess-fresh-1", startedAt: ago(5 * MIN), endedAt: ago(60_000) },
      { id: "sess-fresh-2", startedAt: ago(4 * MIN), endedAt: ago(30_000) },
      { id: "sess-fresh-3", startedAt: ago(3 * MIN), endedAt: ago(5_000) },
    ]);

    expect(pruneDoneSessions(state, NOW, 1, GRACE_MS)).toBe(false);
    expect(liveSessions(state)).toEqual(["sess-fresh-1", "sess-fresh-2", "sess-fresh-3"]);
  });

  it("evicts whole subtrees — no agent is left pointing at a deleted parent", () => {
    const state = build([
      { id: "sess-old", startedAt: ago(60 * MIN), endedAt: ago(50 * MIN), subs: 3 },
      { id: "sess-keep", startedAt: ago(30 * MIN), endedAt: ago(20 * MIN), subs: 2 },
    ]);
    expect(state.agents.size).toBe(7); // 2 roots + 5 subagents

    expect(pruneDoneSessions(state, NOW, 1, GRACE_MS)).toBe(true);

    // Every agent of the evicted session is gone, root and children alike.
    expect(state.agents.has("sess-old")).toBe(false);
    for (let i = 0; i < 3; i++) expect(state.agents.has(subId("sess-old", i))).toBe(false);
    expect(state.agents.size).toBe(3);

    // No orphans: every parentId still resolves to a surviving agent.
    for (const a of state.agents.values()) {
      if (a.parentId == null) continue;
      expect(state.agents.has(a.parentId), `${a.id} -> ${a.parentId}`).toBe(true);
    }
  });

  it("returns false for an empty board", () => {
    const state = initialState();
    expect(pruneDoneSessions(state, NOW, 6, GRACE_MS)).toBe(false);
    expect(pruneDoneSessions(state, NOW, 0, GRACE_MS)).toBe(false);
    expect(state.agents.size).toBe(0);
  });

  it("returns false when no session has finished at all", () => {
    const state = build([
      { id: "sess-run-1", startedAt: ago(30 * MIN), subs: 2 },
      { id: "sess-run-2", startedAt: ago(20 * MIN) },
      { id: "sess-run-3", startedAt: ago(10 * MIN), subs: 1 },
    ]);
    const before = [...state.agents.keys()].sort();

    expect(pruneDoneSessions(state, NOW, 1, GRACE_MS)).toBe(false);
    expect([...state.agents.keys()].sort()).toEqual(before);
  });
});
