// #445. `endedAt` on a root was being asked a question it does not carry the
// answer to. Both providers end a TURN with `Stop` — Claude's Stop hook fires
// when the main agent finishes responding, and the Codex watcher maps
// `task_complete` / `turn_aborted` onto the same name deliberately and per turn
// (#395) — and `Stop` is what writes `endedAt`. `pruneDoneSessions` then read
// `endedAt` as "this session is over" and evicted whichever finished longest
// ago, which on a real board is mostly terminals the human is still sitting in
// front of, thinking.
//
// The measurement that makes it a bug rather than the cap doing its job. On this
// machine's two event logs (20,864 envelopes, 22 sessions), 250 `Stop`s: 248
// were followed by more traffic on the same session and 223 (89%) by another
// `UserPromptSubmit`. The gap from a `Stop` to the next prompt has a median of
// 228s and a 75th percentile of 12.8 minutes, so only 89 of those 223 turn
// boundaries came back inside the shipped 2-minute grace — for 60% of them the
// deck was holding a still-open terminal in the eviction queue. Replaying both
// logs through this reducer with the real tick and the shipped constants (cap 6,
// grace 2 minutes) evicted 20 sessions, 7 of which went on to produce more
// events: a card vanishing from canvas and sidebar mid-thought and coming back
// on the next prompt as a brand-new node with no prompts, no tool history, no
// `firstPrompt`, no model, and `startedAt` reset to now.
//
// The distinction is carried by `closedAt`, written only by an ending of the
// SESSION — `SessionEnd`, or `sweepStaleSessions` giving up after
// STALE_SESSION_MS — and never by `Stop`. It ranks the eviction queue and does
// nothing else: `state`, `endedAt` and `waiting` are untouched, so the card, the
// session list and the two ambient counts read exactly what they read before,
// and the cap still holds exactly, because absence of `closedAt` means "not
// known to be closed" (a killed CLI sends no `SessionEnd`, and Codex has no such
// record at all) and never "still open".
//
// The second half is `pruneOldAgents`, which evicts agents one at a time in
// `endedAt` order and so deleted a root that finished before one of its
// subagents — leaving a card whose `parentId` resolves to nothing: no edge on
// the canvas, no row in the sidebar, no cost roll-up. `pruneDoneSessions` has
// held the opposite invariant since it was written; this pins it on both.
//
// The third is what #442 left here: a `Stop` that lands while a subagent is
// still `active`. It is NOT settled here, and the tests below pin that, because
// the premise that would justify settling it is false on current Claude Code —
// background subagents outlive the turn that dispatched them. On the same logs a
// `Stop` stepped over a still-open subagent 65 times and in 65 of 65 that
// subagent went on to emit its own tool traffic afterwards, a median of 606s and
// up to 10,455s more work. `sweepStaleSessions` settles the genuinely stranded
// one, on evidence rather than on assumption.
//
// No DOM — plain node, vitest — so this drives the reducer directly and imports
// the alarm counts from the one module that owns them (#377) rather than
// restating the rule.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  pruneDoneSessions,
  pruneOldAgents,
  STALE_SESSION_MS,
  sweepStaleSessions,
  sweepStaleTools,
  type GraphState,
} from "../reducer";
import { blockedSessions, runningSessionCount } from "../ambient-counts";
import type { HookEnvelope, HookPayload } from "../types";

const SEC = 1_000;
const MIN = 60_000;
/** Where every scenario starts, so "T0 + 3 hours" reads as a number. */
const T0 = 1_700_000_000_000;

/** The shipped constants, from App.tsx. The point of the scenarios below is
 *  what the deck actually does to a user, so they are run at the numbers the
 *  user has. */
const DONE_SESSION_CAP = 6;
const DONE_SESSION_GRACE_MS = 2 * MIN;
const AGENT_GRACE_MS = 5 * MIN;

let seq = 0;

function send(state: GraphState, sessionId: string, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: payload.provider === "codex" ? "codex" : "hook",
    payload: { session_id: sessionId, ...payload },
  };
  return applyEvent(state, env);
}

function fresh(): GraphState {
  seq = 0;
  return initialState();
}

/** A session that ran one turn and then stopped talking: SessionStart, a
 *  prompt, a tool call, `Stop`. This is the idle-but-open terminal — the human
 *  is reading the answer, and the CLI has not gone anywhere. */
function idleSession(state: GraphState, id: string, startedAt: number, stoppedAt: number): GraphState {
  let s = state;
  s = send(s, id, startedAt, { hook_event_name: "SessionStart", cwd: "/repo" });
  s = send(s, id, startedAt + SEC, { hook_event_name: "UserPromptSubmit", prompt: `what does ${id} do?` });
  s = send(s, id, startedAt + 2 * SEC, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `${id}-t1` });
  s = send(s, id, startedAt + 3 * SEC, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `${id}-t1` });
  s = send(s, id, stoppedAt, { hook_event_name: "Stop" });
  return s;
}

/** The same session, closed properly afterwards — the human typed `/exit`, and
 *  CC sent the one event that says the session and not just the turn is over. */
function closedSession(state: GraphState, id: string, startedAt: number, stoppedAt: number): GraphState {
  let s = idleSession(state, id, startedAt, stoppedAt);
  return send(s, id, stoppedAt + SEC, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
}

/** Session ids still on the board — roots are keyed by session id. */
function liveSessions(state: GraphState): string[] {
  return [...new Set([...state.agents.values()].map(a => a.sessionId))].sort();
}

/** The invariant `prune-done-sessions.test.ts` asserts about its own pruner,
 *  stated once so both pruners can be held to it. */
function expectNoOrphans(state: GraphState): void {
  for (const a of state.agents.values()) {
    if (a.parentId == null) continue;
    expect(state.agents.has(a.parentId), `${a.id} -> ${a.parentId}`).toBe(true);
  }
}

describe("what a Stop means", () => {
  it("ends the turn and leaves the session open", () => {
    let s = fresh();
    s = idleSession(s, "sess-idle", T0, T0 + 5 * MIN);
    const root = s.agents.get("sess-idle")!;

    // Unchanged, and deliberately so: the card, the session list and the sort
    // all read `state`, and a session between turns really is idle. Reading
    // `live` forever would be a worse lie than reading `done` early.
    expect(root.state).toBe("done");
    expect(root.endedAt).toBe(T0 + 5 * MIN);
    // What it must NOT claim is that the session itself is over.
    expect(root.closedAt).toBeUndefined();
  });

  it("a SessionEnd is the ending that means the session", () => {
    let s = fresh();
    s = closedSession(s, "sess-closed", T0, T0 + 5 * MIN);
    const root = s.agents.get("sess-closed")!;

    expect(root.state).toBe("done");
    expect(root.closedAt).toBe(T0 + 5 * MIN + SEC);
    // And it is not a guess, so it carries none of `reaped`'s meaning.
    expect(root.reaped).toBeFalsy();
  });

  it("a Codex turn end is still a turn end (#395)", () => {
    // The watcher maps `task_complete` / `turn_aborted` onto `Stop` per turn,
    // and that decision is upheld here rather than worked around: Codex writes
    // no session-close record at all, so its sessions are ended by the stale
    // sweep and by nothing else.
    let s = fresh();
    s = send(s, "sess-codex", T0, { hook_event_name: "SessionStart", provider: "codex", cwd: "/repo" });
    s = send(s, "sess-codex", T0 + SEC, { hook_event_name: "UserPromptSubmit", provider: "codex", prompt: "hi" });
    s = send(s, "sess-codex", T0 + 2 * MIN, { hook_event_name: "Stop", provider: "codex" });

    const root = s.agents.get("sess-codex")!;
    expect(root.state).toBe("done");
    expect(root.endedAt).toBe(T0 + 2 * MIN);
    expect(root.closedAt).toBeUndefined();

    // The sweep is what closes a Codex session, on the same window it uses for
    // everything else.
    sweepStaleSessions(s, T0 + 2 * MIN + STALE_SESSION_MS + MIN, STALE_SESSION_MS);
    expect(s.agents.get("sess-codex")!.closedAt).toBe(T0 + 2 * MIN);
  });
});

describe("pruneDoneSessions spends the closed sessions first", () => {
  it("evicts a session that is over ahead of one that merely finished a turn earlier", () => {
    let s = fresh();
    // The idle one finished its turn FIRST, so the old rule reached for it.
    s = idleSession(s, "sess-idle", T0, T0 + 5 * MIN);
    s = closedSession(s, "sess-closed", T0 + 10 * MIN, T0 + 20 * MIN);
    const now = T0 + 40 * MIN;

    expect(pruneDoneSessions(s, now, 1, DONE_SESSION_GRACE_MS)).toBe(true);
    expect(liveSessions(s)).toEqual(["sess-idle"]);
  });

  it("leaves the idle terminal's history intact when there is a closed one to spend", () => {
    // The cost of getting this wrong is not the card blinking — it is that the
    // node comes back empty on the next prompt.
    let s = fresh();
    s = idleSession(s, "sess-idle", T0, T0 + 5 * MIN);
    s = closedSession(s, "sess-closed", T0 + 10 * MIN, T0 + 20 * MIN);

    pruneDoneSessions(s, T0 + 40 * MIN, 1, DONE_SESSION_GRACE_MS);

    const root = s.agents.get("sess-idle")!;
    expect(root.startedAt).toBe(T0);
    expect(root.prompts.map(p => p.text)).toEqual(["what does sess-idle do?"]);
    expect(root.firstPrompt).toBe("what does sess-idle do?");
    expect(root.toolCount).toBe(1);

    // And the next turn continues the same session rather than founding a new
    // one: same node, same start, both prompts.
    s = send(s, "sess-idle", T0 + 41 * MIN, { hook_event_name: "UserPromptSubmit", prompt: "and now?" });
    const after = s.agents.get("sess-idle")!;
    expect(after.startedAt).toBe(T0);
    expect(after.state).toBe("active");
    expect(after.prompts).toHaveLength(2);
  });

  it("still evicts the oldest when nothing on the board is known to be closed", () => {
    // Absence of `closedAt` is not a veto. A board of nothing but idle sessions
    // — every Codex board, and every board belonging to somebody who closes
    // terminals by closing the window — settles at the cap exactly as before.
    let s = fresh();
    for (let i = 0; i < 8; i++) s = idleSession(s, `sess-${i}`, T0 + i * MIN, T0 + (i + 1) * MIN);
    const now = T0 + 60 * MIN;

    expect(pruneDoneSessions(s, now, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS)).toBe(true);
    expect(liveSessions(s)).toEqual(["sess-2", "sess-3", "sess-4", "sess-5", "sess-6", "sess-7"]);
    expect(pruneDoneSessions(s, now, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS)).toBe(false);
  });

  it("ranks a session the sweep gave up on with the closed ones, not with the idle ones", () => {
    // The case that makes `closedAt` need a second writer. A terminal killed
    // without exiting sends no `SessionEnd`, so if only `SessionEnd` wrote the
    // flag, this morning's abandoned sessions would sit at the BACK of the queue
    // forever and the board would fill with them while today's honest endings
    // were evicted around them.
    let s = fresh();
    // Ended its turn first, but is still being heard from — an idle_prompt
    // notification landed ten minutes ago, so the session is demonstrably there.
    s = idleSession(s, "sess-open", T0, T0 + 1 * MIN);
    s = send(s, "sess-open", T0 + 170 * MIN, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" });
    // Ended its turn LATER and has said nothing since — silent for 149 minutes.
    s = idleSession(s, "sess-gone", T0 + 30 * MIN, T0 + 31 * MIN);

    const now = T0 + 180 * MIN;
    sweepStaleSessions(s, now, STALE_SESSION_MS);
    expect(s.agents.get("sess-gone")!.closedAt).toBe(T0 + 31 * MIN);
    expect(s.agents.get("sess-open")!.closedAt).toBeUndefined();

    expect(pruneDoneSessions(s, now, 1, DONE_SESSION_GRACE_MS)).toBe(true);
    expect(liveSessions(s)).toEqual(["sess-open"]);
  });

  it("keeps the grace period and the cap arithmetic exactly as they were", () => {
    // A session inside the grace period is exempt from eviction but still counts
    // against the cap, so the board settles at `cap` rather than overshooting.
    // Ranking must not touch that: it decides WHICH goes, never HOW MANY.
    let s = fresh();
    s = closedSession(s, "sess-closed-old", T0, T0 + 5 * MIN);
    s = idleSession(s, "sess-idle-old", T0 + 10 * MIN, T0 + 15 * MIN);
    const now = T0 + 60 * MIN;
    // Finished 30 seconds ago — still fading out.
    s = closedSession(s, "sess-fresh", now - 2 * MIN, now - 31 * SEC);

    expect(pruneDoneSessions(s, now, 2, DONE_SESSION_GRACE_MS)).toBe(true);
    // Exactly one eviction (3 finished − cap 2), and the fresh closed session is
    // exempt despite being closed, so the spend falls on the closed one that is
    // out of grace.
    expect(liveSessions(s)).toEqual(["sess-fresh", "sess-idle-old"]);
  });
});

describe("an ending that turns out to be wrong is withdrawn", () => {
  it("a late event un-reaps the root and takes the sweep's ending with it", () => {
    let s = fresh();
    s = send(s, "sess-quiet", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-quiet", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "long one" });

    const reapedAt = T0 + SEC + STALE_SESSION_MS + MIN;
    expect(sweepStaleSessions(s, reapedAt, STALE_SESSION_MS)).toBe(true);
    const reaped = s.agents.get("sess-quiet")!;
    expect(reaped.reaped).toBe(true);
    expect(reaped.closedAt).toBe(T0 + SEC);

    // The human was there the whole time; they just took their time.
    s = send(s, "sess-quiet", reapedAt + MIN, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "late-1" });
    const back = s.agents.get("sess-quiet")!;
    expect(back.reaped).toBe(false);
    expect(back.state).toBe("active");
    expect(back.endedAt).toBeUndefined();
    expect(back.closedAt).toBeUndefined();
  });

  it("typing into a session that had ended re-opens it", () => {
    // `--resume` is documented to keep a session id, and a resumed terminal
    // ranked as closed for the rest of the day is the exact mistake this flag
    // exists to stop making.
    let s = fresh();
    s = closedSession(s, "sess-resumed", T0, T0 + 5 * MIN);
    expect(s.agents.get("sess-resumed")!.closedAt).toBe(T0 + 5 * MIN + SEC);

    s = send(s, "sess-resumed", T0 + 30 * MIN, { hook_event_name: "UserPromptSubmit", prompt: "back again" });
    expect(s.agents.get("sess-resumed")!.closedAt).toBeUndefined();
    s = send(s, "sess-resumed", T0 + 31 * MIN, { hook_event_name: "Stop" });
    expect(s.agents.get("sess-resumed")!.closedAt).toBeUndefined();

    // ...and it is now ranked as what it is: a session between turns, which
    // loses its place in the queue to one that is genuinely over.
    s = closedSession(s, "sess-done", T0 + 32 * MIN, T0 + 33 * MIN);
    expect(pruneDoneSessions(s, T0 + 60 * MIN, 1, DONE_SESSION_GRACE_MS)).toBe(true);
    expect(liveSessions(s)).toEqual(["sess-resumed"]);
  });

  it("a SessionStart re-opens it too", () => {
    let s = fresh();
    s = closedSession(s, "sess-restart", T0, T0 + 5 * MIN);
    s = send(s, "sess-restart", T0 + 20 * MIN, { hook_event_name: "SessionStart", source: "resume", cwd: "/repo" });
    expect(s.agents.get("sess-restart")!.closedAt).toBeUndefined();
    expect(s.agents.get("sess-restart")!.state).toBe("active");
  });
});

describe("the alarm surfaces do not move", () => {
  it("counts the same things before and after a turn boundary", () => {
    let s = fresh();
    s = send(s, "sess-a", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-a", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    expect(runningSessionCount(s.agents.values())).toBe(1);

    s = send(s, "sess-a", T0 + 2 * SEC, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Bash?" });
    expect(blockedSessions(s.agents.values()).map(b => b.id)).toEqual(["sess-a"]);

    // The turn ends. `Stop` is root traffic, so it clears the block, and the
    // session stops counting as running — both exactly as before #445, because
    // neither count reads `closedAt`.
    s = send(s, "sess-a", T0 + 5 * MIN, { hook_event_name: "Stop" });
    expect(runningSessionCount(s.agents.values())).toBe(0);
    expect(blockedSessions(s.agents.values())).toEqual([]);
    expect(s.agents.get("sess-a")!.closedAt).toBeUndefined();

    // And a session that is genuinely over counts no differently from one that
    // is merely idle — the flag ranks the eviction queue and nothing else.
    s = send(s, "sess-a", T0 + 5 * MIN + SEC, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    expect(runningSessionCount(s.agents.values())).toBe(0);
    expect(blockedSessions(s.agents.values())).toEqual([]);
  });
});

describe("#442's leftover: a subagent that outlives the Stop", () => {
  it("keeps working, and the deck keeps saying so", () => {
    // Settling it at `Stop` would draw a background subagent `done` while its
    // own tool bubbles were still firing underneath. 65 of 65 measured cases.
    let s = fresh();
    s = send(s, "sess-bg", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-bg", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    s = send(s, "sess-bg", T0 + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "worker" });
    s = send(s, "sess-bg", T0 + 5 * MIN, { hook_event_name: "Stop" });

    const sub = s.agents.get("sess-bg::A")!;
    expect(s.agents.get("sess-bg")!.state).toBe("done");
    expect(sub.state).toBe("active");
    // Which is what the ambient counts should say: one session still moving.
    expect(runningSessionCount(s.agents.values())).toBe(1);

    // Its own traffic keeps landing on it, ten minutes past the Stop.
    s = send(s, "sess-bg", T0 + 15 * MIN, { hook_event_name: "PreToolUse", agent_id: "A", tool_name: "Grep", tool_use_id: "bg-1" });
    expect(s.agents.get("sess-bg::A")!.tools).toHaveLength(1);

    // And the session is not a prune candidate while it is going, at any cap.
    expect(pruneDoneSessions(s, T0 + 60 * MIN, 0, DONE_SESSION_GRACE_MS)).toBe(false);
    expect(s.agents.has("sess-bg::A")).toBe(true);
  });

  it("is settled by the stale sweep when its SubagentStop really was lost", () => {
    // The genuinely stranded case, ended on evidence — a session nothing has
    // been heard from for STALE_SESSION_MS has nothing live under it, because a
    // subagent doing long work stamps the root's `lastEventAt` on every call it
    // makes.
    let s = fresh();
    s = send(s, "sess-lost", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-lost", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "fan out" });
    s = send(s, "sess-lost", T0 + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "worker" });
    s = send(s, "sess-lost", T0 + 5 * MIN, { hook_event_name: "Stop" });

    const now = T0 + 5 * MIN + STALE_SESSION_MS + MIN;
    expect(sweepStaleSessions(s, now, STALE_SESSION_MS)).toBe(true);
    expect(s.agents.get("sess-lost::A")!.state).toBe("done");
    expect(runningSessionCount(s.agents.values())).toBe(0);
    // The whole session is now over, and ranks with the sessions that are.
    expect(s.agents.get("sess-lost")!.closedAt).toBe(T0 + 5 * MIN);
    expect(pruneDoneSessions(s, now, 0, DONE_SESSION_GRACE_MS)).toBe(true);
    expect(s.agents.size).toBe(0);
  });
});

describe("pruneOldAgents never leaves an agent pointing at a deleted parent", () => {
  it("does not delete a root that finished before its own subagent", () => {
    // The ordinary shape of a background subagent: the turn ends, the subagent
    // reports twenty minutes later. Sorted by `endedAt` the root is the older
    // agent, so it used to be deleted on its own and the subagent was left
    // pointing at nothing. The tree leaves together instead.
    let s = fresh();
    s = send(s, "sess-p", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-p", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    s = send(s, "sess-p", T0 + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "worker" });
    s = send(s, "sess-p", T0 + 2 * MIN, { hook_event_name: "Stop" });
    s = send(s, "sess-p", T0 + 20 * MIN, { hook_event_name: "SubagentStop", agent_id: "A" });
    // A newer session, so the cap has something to keep.
    s = idleSession(s, "sess-keep", T0 + 30 * MIN, T0 + 31 * MIN);

    // Cap 2 against 3 agents, so exactly one eviction is called for: the old
    // rule spent it on the root and stopped, which is precisely the state that
    // leaves a card with no edge, no sidebar row and no cost roll-up.
    expect(pruneOldAgents(s, T0 + 60 * MIN, 2, AGENT_GRACE_MS)).toBe(true);
    expect(s.agents.has("sess-p::A")).toBe(false);
    expect(s.agents.has("sess-p")).toBe(false);
    expect(liveSessions(s)).toEqual(["sess-keep"]);
    expectNoOrphans(s);
  });

  it("holds the root while a subagent under it is still running", () => {
    let s = fresh();
    s = send(s, "sess-q", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-q", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    s = send(s, "sess-q", T0 + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "worker" });
    s = send(s, "sess-q", T0 + 2 * MIN, { hook_event_name: "Stop" });

    // Nothing to evict: the subagent is not a candidate (it is `active`), and
    // taking the root would orphan it. Deferring rather than cascading, because
    // the child is a card the user is watching work.
    expect(pruneOldAgents(s, T0 + 60 * MIN, 1, AGENT_GRACE_MS)).toBe(false);
    expect(s.agents.has("sess-q")).toBe(true);
    expect(s.agents.has("sess-q::A")).toBe(true);
    expectNoOrphans(s);
  });

  it("takes a whole finished session in one pass, children before root", () => {
    // The deferral must not cost the cap a pass: within one call, the root is
    // freed by the same loop that evicted its children.
    let s = fresh();
    s = send(s, "sess-r", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-r", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    for (const key of ["A", "B", "C"]) {
      s = send(s, "sess-r", T0 + 2 * SEC, { hook_event_name: "SubagentStart", agent_id: key, agent_type: "worker" });
      s = send(s, "sess-r", T0 + 10 * MIN, { hook_event_name: "SubagentStop", agent_id: key });
    }
    s = send(s, "sess-r", T0 + 2 * MIN, { hook_event_name: "Stop" });
    // A second session, newer, that the cap is meant to keep.
    s = idleSession(s, "sess-keep", T0 + 30 * MIN, T0 + 31 * MIN);
    expect(s.agents.size).toBe(5);

    expect(pruneOldAgents(s, T0 + 60 * MIN, 1, AGENT_GRACE_MS)).toBe(true);
    expect(liveSessions(s)).toEqual(["sess-keep"]);
    expectNoOrphans(s);
  });

  it("still releases only the ids the departing agent still owns (#443)", () => {
    let s = fresh();
    s = send(s, "sess-t", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-t", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    // The root has a call of its own that never settles, and the root itself is
    // still running — so only the subagent is a candidate.
    s = send(s, "sess-t", T0 + 2 * SEC, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "root-call" });
    s = send(s, "sess-t", T0 + 3 * SEC, { hook_event_name: "SubagentStart", agent_id: "A", agent_type: "worker" });
    // ...and so does the subagent.
    s = send(s, "sess-t", T0 + 4 * SEC, { hook_event_name: "PreToolUse", agent_id: "A", tool_name: "Grep", tool_use_id: "sub-call" });
    s = send(s, "sess-t", T0 + 20 * MIN, { hook_event_name: "SubagentStop", agent_id: "A" });

    // Cap 1: the subagent goes, the root is kept.
    expect(pruneOldAgents(s, T0 + 60 * MIN, 1, AGENT_GRACE_MS)).toBe(true);
    // The evicted agent's in-flight id went with it...
    expect(s.toolIndex.has("sub-call")).toBe(false);
    expect(s.toolOwner.has("sub-call")).toBe(false);
    // ...and the surviving root's did not, because the root was never deleted.
    expect(s.toolIndex.has("root-call")).toBe(true);
    expect(s.toolOwner.get("root-call")).toBe("sess-t");
  });
});

describe("the neighbouring rules still hold", () => {
  it("#436: a tool settles on the SESSION's silence, not on its own age", () => {
    let s = fresh();
    s = send(s, "sess-436", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-436", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "build it" });
    s = send(s, "sess-436", T0 + 2 * SEC, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "slow-build" });

    // Ten minutes in, the session is still talking — the call is slow, not lost.
    s = send(s, "sess-436", T0 + 10 * MIN, { hook_event_name: "PreToolUse", agent_id: "A", tool_name: "Read", tool_use_id: "other" });
    expect(sweepStaleTools(s, T0 + 11 * MIN, STALE_SESSION_MS)).toBe(false);
    expect(s.agents.get("sess-436")!.tools[0].endedAt).toBeUndefined();

    // Silence for the full window is what settles it, at the last moment there
    // was evidence it was running.
    const now = T0 + 10 * MIN + STALE_SESSION_MS + MIN;
    expect(sweepStaleTools(s, now, STALE_SESSION_MS)).toBe(true);
    const call = s.agents.get("sess-436")!.tools[0];
    expect(call.ok).toBe(false);
    expect(call.endedAt).toBe(T0 + 10 * MIN);
    expect(call.errorPreview).toBe("session ended before this call returned");
  });

  it("#444: a re-delivered PostToolUse still changes nothing", () => {
    let s = fresh();
    s = send(s, "sess-444", T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    s = send(s, "sess-444", T0 + SEC, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    s = send(s, "sess-444", T0 + 2 * SEC, { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "dup" });
    const outcome = {
      hook_event_name: "PostToolUse" as const,
      tool_name: "Task",
      tool_use_id: "dup",
      tool_response: { usage: { input_tokens: 100, output_tokens: 20 } },
    };
    s = send(s, "sess-444", T0 + 3 * SEC, outcome);
    const once = { ...s.agents.get("sess-444")!.usage };
    const endedAt = s.agents.get("sess-444")!.tools[0].endedAt;

    // Same outcome, delivered again by another deck's fan-out.
    s = send(s, "sess-444", T0 + 9 * SEC, outcome);
    expect(s.agents.get("sess-444")!.usage).toEqual(once);
    expect(s.agents.get("sess-444")!.tools[0].endedAt).toBe(endedAt);
    expect(s.agents.get("sess-444")!.tools).toHaveLength(1);
  });
});
