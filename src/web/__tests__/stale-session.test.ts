// #350: a permission block on a session whose terminal died stood forever, and
// since #348 a `permission` block is exactly what lights the topbar chip, the
// tab title and the favicon. The card and the sidebar row print the block's own
// age beside it, so a stale one there reads as stale; the title carries a bare
// count and the favicon is a coloured dot, and neither can say how old it is. A
// killed session holding those two is the failure #348 was built to avoid — a
// signal rare enough to be trusted, reporting something untrue.
//
// Nothing reaped it. `sweepStaleTools` finalises ToolCalls and never looks
// above them, `pruneOldAgents` wants `state === "done"` and `pruneDoneSessions`
// wants a session with nothing live in it — and this session is `active`,
// because a permission prompt arrives mid-turn and the event that would have
// ended that turn is the one that never came.
//
// The fix is the staleness underneath rather than a TTL bolted onto `waiting`:
// the stale block and the stale `active` beside it are one bug. `sweepStaleSessions`
// settles the session, and the block goes with it — so #348's counters, which
// read `kind` off the block, fall to zero without knowing anything about this.
//
// THE CLOCK IS THE LAST EVENT, NEVER THE BLOCK'S OWN `since`. Those are
// different numbers: `since` is when the prompt arrived, and a human can take an
// hour to answer one. A threshold measured against `since` would cancel real
// blocks; measured against the last event, a session that is still being heard
// from is never touched however long it has been blocked. The first describe
// below is that property, and it is the one that stops this fix from being worse
// than the bug.
//
// No DOM — plain node, vitest — so this drives the reducer directly and
// re-derives #348's alarm counters from the same shape App.tsx builds them from.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyEvent,
  initialState,
  STALE_SESSION_MS,
  sweepStaleSessions,
  type GraphState,
} from "../reducer";
import { ambientSignal } from "../ambient";
import { blockedSessions } from "../ambient-counts";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-350";
const MIN = 60_000;
/** Where every scenario starts, so "T0 + 3 hours" is a readable number. */
const T0 = 1_700_000_000_000;

/** The two payloads CC actually emits, verbatim from a real events.jsonl. */
const PERMISSION = { notification_type: "permission_prompt", message: "Claude needs your permission" };
const IDLE = { notification_type: "idle_prompt", message: "Claude is waiting for your input" };

let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: "hook",
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

/** A session mid-turn, blocked on a permission prompt at T0 — the exact state
 *  the issue describes, and the one no sweep used to touch. */
function blocked(): GraphState {
  seq = 0;
  let state = send(initialState(), T0 - 30_000, { hook_event_name: "SessionStart", cwd: "/repo" });
  state = send(state, T0 - 20_000, { hook_event_name: "UserPromptSubmit", prompt: "ship it" });
  state = send(state, T0 - 10_000, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
  return send(state, T0, { hook_event_name: "Notification", ...PERMISSION });
}

const root = (state: GraphState) => state.agents.get(SESSION)!;

/** How many alarms this board is raising, through the counter the app itself
 *  runs. What is being pinned here is that the number falls to zero without
 *  either CALL SITE being changed — the sweep does it by clearing the block in
 *  the reducer — and asking ambient-counts.ts is what makes that a claim about
 *  the shipped counter rather than about a copy of it. #377 is the bill for the
 *  other choice: a re-derived counter that #348 never reached went on asserting
 *  the superseded rule as correct for thirty releases. */
const alarms = (state: GraphState): number => blockedSessions(state.agents.values()).length;

describe("a session that is still being heard from", () => {
  it("keeps its permission block standing far past the threshold", () => {
    // The load-bearing test. The human is thinking — CC's permission prompt has
    // been up for three hours, twice the threshold — but the deck is still
    // receiving this session's traffic, so the session is alive and the block is
    // real. What arrives is the traffic a blocked session actually produces: the
    // fan-out re-delivering the notification, and the server's own transcript
    // scans, which are the events #337 deliberately does NOT treat as movement.
    let state = blocked();
    for (let t = T0; t <= T0 + 180 * MIN; t += 10 * MIN) {
      state = send(state, t + 1_000, { hook_event_name: "Notification", ...PERMISSION });
      state = send(state, t + 2_000, { hook_event_name: "UsageObserved", usage: { input_tokens: 10, output_tokens: 2 } });
      // Swept on every step, the way the 250ms tick in App.tsx sweeps.
      expect(sweepStaleSessions(state, t + 3_000, STALE_SESSION_MS)).toBe(false);
    }
    expect(root(state).waiting?.kind).toBe("permission");
    expect(root(state).state).toBe("active");
    expect(alarms(state)).toBe(1);
  });

  it("measures the threshold against the last event, not against `since`", () => {
    // The same three hours, stated as the distinction that decides it: the block
    // is 180 minutes old and the session was heard from 1 minute ago. A TTL on
    // `since` reaps this; the last-event clock does not go near it.
    let state = blocked();
    state = send(state, T0 + 179 * MIN, { hook_event_name: "ModelObserved", model: "claude-opus-5" });
    const now = T0 + 180 * MIN;
    expect(now - root(state).waiting!.since).toBeGreaterThan(STALE_SESSION_MS);
    expect(now - root(state).lastEventAt!).toBeLessThan(STALE_SESSION_MS);
    expect(sweepStaleSessions(state, now, STALE_SESSION_MS)).toBe(false);
    expect(root(state).waiting?.kind).toBe("permission");
  });

  it("counts a subagent's traffic as the session moving, whoever it is attributed to", () => {
    // A Task running under the root emits no root-attributed events at all, and
    // resolveOwner hands every one of them to the subagent. If the stamp went on
    // the owner rather than on the session, a root whose whole turn is one long
    // subagent would read as silent and be reaped while its child worked.
    let state = blocked();
    state = send(state, T0 + 1_000, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    for (let t = T0 + 10 * MIN; t <= T0 + 200 * MIN; t += 10 * MIN) {
      state = send(state, t, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `t-${t}` });
      expect(sweepStaleSessions(state, t + 1, STALE_SESSION_MS)).toBe(false);
    }
    expect(root(state).state).toBe("active");
    expect(state.agents.get(`${SESSION}::sub-1`)!.state).toBe("active");
  });
});

describe("a session that stops being heard from at all", () => {
  it("drops out of the alarm counts once the threshold passes", () => {
    // The reported bug: the terminal was killed while the prompt was up, so no
    // Stop and no SessionEnd will ever arrive.
    const state = blocked();
    expect(alarms(state)).toBe(1);
    expect(ambientSignal({ waiting: alarms(state), running: 1 }).icon).toBe("waiting");

    expect(sweepStaleSessions(state, T0 + STALE_SESSION_MS + 1, STALE_SESSION_MS)).toBe(true);

    expect(alarms(state)).toBe(0);
    expect(root(state).waiting).toBeFalsy();
    expect(ambientSignal({ waiting: alarms(state), running: 0 })).toEqual({ title: "ccdeck", icon: "idle" });
  });

  it("settles the state that kept both pruners away from it", () => {
    // pruneOldAgents wants `done`, pruneDoneSessions wants nothing live. The
    // block was only the visible half of the bug — the node reads `live` forever
    // for the same killed session, and one reaper has to answer for both.
    const state = blocked();
    expect(root(state).state).toBe("active");
    sweepStaleSessions(state, T0 + STALE_SESSION_MS + 1, STALE_SESSION_MS);
    expect(root(state).state).toBe("done");
    expect(root(state).reaped).toBe(true);
  });

  it("stamps the end at the last event rather than at the moment we gave up", () => {
    // T0 is the last thing we have evidence of. Stamping `now` would claim the
    // session ran for another ninety minutes it spent dead, and would restart
    // both pruners' grace periods from a time nothing happened at.
    const state = blocked();
    sweepStaleSessions(state, T0 + 5 * 60 * MIN, STALE_SESSION_MS);
    expect(root(state).endedAt).toBe(T0);
  });

  it("is untouched at the threshold and reaped one millisecond past it", () => {
    const early = blocked();
    expect(sweepStaleSessions(early, T0 + STALE_SESSION_MS, STALE_SESSION_MS)).toBe(false);
    expect(early.agents.get(SESSION)!.waiting?.kind).toBe("permission");

    const late = blocked();
    expect(sweepStaleSessions(late, T0 + STALE_SESSION_MS + 1, STALE_SESSION_MS)).toBe(true);
    expect(late.agents.get(SESSION)!.waiting).toBeFalsy();
  });

  it("is idempotent — a second sweep over the same silence changes nothing", () => {
    // It runs four times a second. Reporting a change on every one of them would
    // re-render the canvas forever for a session that is already settled.
    const state = blocked();
    expect(sweepStaleSessions(state, T0 + 3 * 60 * MIN, STALE_SESSION_MS)).toBe(true);
    expect(sweepStaleSessions(state, T0 + 3 * 60 * MIN, STALE_SESSION_MS)).toBe(false);
    expect(sweepStaleSessions(state, T0 + 9 * 60 * MIN, STALE_SESSION_MS)).toBe(false);
  });
});

describe("SessionEnd, which needs no threshold at all", () => {
  it("clears the block the moment it lands", () => {
    // A session that says goodbye is not a staleness problem, and must not have
    // to wait ninety minutes to stop being an alarm. #337's clear matrix owns
    // this and the sweep must not have taken it over.
    let state = blocked();
    state = send(state, T0 + 500, { hook_event_name: "SessionEnd" });
    expect(root(state).waiting).toBeFalsy();
    expect(root(state).state).toBe("done");
    expect(alarms(state)).toBe(0);
    // And it is a real ending, not a guess — nothing may resurrect it.
    expect(root(state).reaped).toBeFalsy();
  });

  it("still clears immediately when it arrives after the sweep already gave up", () => {
    const state = blocked();
    sweepStaleSessions(state, T0 + 4 * 60 * MIN, STALE_SESSION_MS);
    const ended = send(state, T0 + 5 * 60 * MIN, { hook_event_name: "SessionEnd" });
    expect(root(ended).state).toBe("done");
    expect(root(ended).endedAt).toBe(T0 + 5 * 60 * MIN);
    expect(root(ended).reaped).toBeFalsy();
    expect(root(ended).waiting).toBeFalsy();
  });
});

describe("a reaped session that turns out to have been alive", () => {
  it("comes back on the first event newer than the moment it was given up", () => {
    // The human answered after lunch. The guess was wrong, and the deck has to
    // be able to say so — the same way a late PostToolUse resurrects a tool the
    // stale sweep had already marked failed.
    const state = blocked();
    sweepStaleSessions(state, T0 + 2 * 60 * MIN, STALE_SESSION_MS);
    expect(root(state).state).toBe("done");

    const back = send(state, T0 + 3 * 60 * MIN, { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok" });
    expect(root(back).state).toBe("active");
    expect(root(back).endedAt).toBeUndefined();
    expect(root(back).reaped).toBeFalsy();
  });

  it("does not un-finish a session that genuinely stopped", () => {
    // The reason the reap is flagged rather than inferred from `done`. The
    // server's transcript scans land seconds after the hook that triggered them,
    // so a real Stop is routinely followed by more events for the same session —
    // and none of them means the turn restarted.
    let state = blocked();
    state = send(state, T0 + 1_000, { hook_event_name: "Stop" });
    expect(root(state).state).toBe("done");
    state = send(state, T0 + 3_000, { hook_event_name: "UsageObserved", usage: { input_tokens: 1, output_tokens: 1 } });
    expect(root(state).state).toBe("done");
    expect(root(state).endedAt).toBe(T0 + 1_000);
  });

  it("is not resurrected by a stale copy of an old event from another deck", () => {
    // Several decks share one events.jsonl and each re-delivers what it sees, so
    // a copy of an event the reducer already applied can land long afterwards
    // carrying its ORIGINAL receivedAt, under a seq the epoch guard lets past.
    // Order independence is this reducer's contract: an old event is not news,
    // and must not undo a reap on evidence older than the moment we gave up.
    const state = blocked();
    sweepStaleSessions(state, T0 + 2 * 60 * MIN, STALE_SESSION_MS);
    const late = send(state, T0 - 5_000, { hook_event_name: "UsageObserved", usage: { input_tokens: 1, output_tokens: 1 } });
    expect(root(late).lastEventAt).toBe(T0);
    expect(root(late).state).toBe("done");
    expect(root(late).reaped).toBe(true);

    // A stale copy that walks through a handler CAN still write to the node —
    // the clear matrix and the per-case branches are not timestamp-aware, and
    // teaching all of them to be would be a far bigger change than the flicker
    // is worth. What matters is that it cannot hold: the clock did not move, so
    // the very next tick takes it away again.
    const replayed = send(late, T0 - 4_000, { hook_event_name: "Notification", ...PERMISSION });
    expect(root(replayed).waiting?.kind).toBe("permission");
    expect(sweepStaleSessions(replayed, T0 + 2 * 60 * MIN, STALE_SESSION_MS)).toBe(true);
    expect(root(replayed).waiting).toBeFalsy();
  });
});

describe("more than one session on the board", () => {
  it("reaps the one that went quiet and leaves the working one alone", () => {
    seq = 0;
    let state = initialState();
    const at = (id: string, t: number, payload: HookPayload) => {
      seq++;
      state = applyEvent(state, { seq, receivedAt: t, source: "hook", payload: { session_id: id, ...payload } });
    };
    for (const id of ["dead", "alive"]) {
      at(id, T0 - 10_000, { hook_event_name: "SessionStart", cwd: "/repo" });
      at(id, T0 - 5_000, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `${id}-t1` });
      at(id, T0, { hook_event_name: "Notification", ...PERMISSION });
    }
    // Only "alive" keeps being heard from.
    at("alive", T0 + 100 * MIN, { hook_event_name: "Notification", ...PERMISSION });

    expect(alarms(state)).toBe(2);
    expect(sweepStaleSessions(state, T0 + 100 * MIN + 1_000, STALE_SESSION_MS)).toBe(true);
    expect(alarms(state)).toBe(1);
    expect(state.agents.get("dead")!.state).toBe("done");
    expect(state.agents.get("alive")!.state).toBe("active");
    expect(state.agents.get("alive")!.waiting?.kind).toBe("permission");
  });
});

describe("what the sweep takes with it, and what it leaves", () => {
  it("settles the dead session's subagents alongside its root", () => {
    // A session nothing has been heard from has no live children either, and a
    // subagent left `active` would keep pruneDoneSessions off the whole tree
    // forever — the session would be settled and still unreclaimable.
    let state = blocked();
    state = send(state, T0 - 5_000, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    // The re-block. It used to be load-bearing — SubagentStart counted as the
    // session moving and took the block away — and since #361 a subagent
    // announcing itself no longer clears a permission prompt the root is sitting
    // on, so this second delivery is a duplicate of the first: same kind, same
    // message, `since` still T0. Kept because what this test needs is a blocked
    // session with a live subagent underneath it, and it must hold whichever of
    // the two rules is in force. The assertion below is the one that says so.
    state = send(state, T0, { hook_event_name: "Notification", ...PERMISSION });
    const sub = state.agents.get(`${SESSION}::sub-1`)!;
    expect(sub.state).toBe("active");
    expect(root(state).waiting).toEqual({ kind: "permission", message: PERMISSION.message, since: T0 });

    sweepStaleSessions(state, T0 + 2 * 60 * MIN, STALE_SESSION_MS);
    expect(sub.state).toBe("done");
    expect(sub.endedAt).toBe(T0);
    // Only the root is flagged: a subagent that was mid-flight when the session
    // went quiet is genuinely over, and SubagentStart is what brings one back.
    expect(sub.reaped).toBeFalsy();
  });

  it("keeps an errored node's error rather than flattening it to done", () => {
    const state = blocked();
    root(state).state = "err";
    sweepStaleSessions(state, T0 + 2 * 60 * MIN, STALE_SESSION_MS);
    expect(root(state).state).toBe("err");
    // The block still goes: the session is stale whatever its node says.
    expect(root(state).waiting).toBeFalsy();
  });

  it("drops an idle block on a session that stopped hours ago, without re-finishing it", () => {
    // An idle_prompt is not an alarm post-#348, but it does sort to the top of
    // the sidebar and print "waiting 8h". One rule — a session nobody has heard
    // from is not current — rather than one for the state and another for the
    // badge.
    let state = blocked();
    state = send(state, T0 + 1_000, { hook_event_name: "Stop" });
    state = send(state, T0 + 60_000, { hook_event_name: "Notification", ...IDLE });
    expect(root(state).waiting?.kind).toBe("idle");

    sweepStaleSessions(state, T0 + 5 * 60 * MIN, STALE_SESSION_MS);
    expect(root(state).waiting).toBeFalsy();
    expect(root(state).state).toBe("done");
    // Its own ending stands: the sweep must not overwrite a real endedAt with
    // the last-event stamp, or the session's run time changes retroactively.
    expect(root(state).endedAt).toBe(T0 + 1_000);
    expect(root(state).reaped).toBeFalsy();
  });

  it("never reaps a session on its very first event", () => {
    // A root created by a REPLAY carries an ancient receivedAt, and the sweep
    // runs 250ms later against wall-clock now. If ensureRoot did not seed
    // lastEventAt, `now - undefined` would make every replayed session stale on
    // arrival and the canvas would come up grey after every refresh.
    seq = 0;
    const state = send(initialState(), T0, { hook_event_name: "SessionStart", cwd: "/repo" });
    expect(root(state).lastEventAt).toBe(T0);
    expect(sweepStaleSessions(state, T0 + 1_000, STALE_SESSION_MS)).toBe(false);
    expect(root(state).state).toBe("active");
  });
});

describe("the threshold and the wiring", () => {
  it("survives the longest silence a live session can produce", () => {
    // CC caps a foreground Bash at 600_000ms, so ten minutes covers the longest
    // build or `sleep` a single tool call can hold with no other traffic. The
    // long pole is the human: an hour on a permission prompt is the case #350
    // names, and the threshold clears it by half again.
    expect(STALE_SESSION_MS).toBeGreaterThan(10 * MIN);
    expect(STALE_SESSION_MS).toBeGreaterThanOrEqual(90 * MIN);
    // And not so long that a dead session holds the favicon through a whole
    // working day, which is the failure this exists to end.
    expect(STALE_SESSION_MS).toBeLessThanOrEqual(2 * 60 * MIN);
  });

  it("runs on the tick that already carries the other three sweeps", () => {
    // The one reason #341 gave for shipping without a TTL that is actually a
    // cost — "it would mean inventing a periodic mechanism" — was already paid:
    // App.tsx runs sweepStaleTools and both pruners on a 250ms interval. A sweep
    // nobody calls is a sweep that fixes nothing, and no test that drives the
    // reducer directly would ever notice.
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toMatch(/sweepStaleSessions\(stateRef\.current, t, STALE_SESSION_MS\)/);
    expect(app).toMatch(/import \{[^}]*sweepStaleSessions[^}]*\} from "\.\/reducer"/);
  });
});
