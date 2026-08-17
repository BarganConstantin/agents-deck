// The two numbers the alarm surfaces are driven from, and the one predicate
// that decides what an alarm is.
//
// #377: the alarm rule used to be written out by hand in four places — App.tsx's
// blocked memo, SessionList.tsx's header count, SessionList.tsx's row sort, and
// a copy inside ambient-signal.test.ts that carried the comment "exactly what
// App.tsx's two memos compute". #348 narrowed the rule to permission-only and
// reached the three in the app; the one in the test was never touched, so for
// thirty-odd releases the suite asserted the superseded counting as correct
// behaviour and would have gone green on the day the regression came back. The
// only thing standing between the codebase and that was two `toMatch` regexes
// over App.tsx's source text, which any rephrasing of the expression breaks and
// any comment containing the same words satisfies.
//
// A rule that has to be mirrored by hand is a rule that drifts, and prose in a
// test cannot stop it. So the rule lives here exactly once, the call sites call
// it, and the tests import the same function the app runs — which makes a
// revert of the counting rule a change to THIS file, and a change to this file
// fails the assertions rather than passing them.
//
// Pure, and importing nothing but types, because the suite runs in bare node
// with no DOM: the counting has to be testable without rendering a React tree,
// which is precisely the property whose absence let the drift happen.
import type { AgentNodeData, WaitingBlock } from "./types";

/**
 * Is this block worth raising an alarm about?
 *
 * PERMISSION ONLY, and that is the difference between an alarm and noise. Both
 * kinds are a human being waited on, but only one is urgent: a permission
 * prompt is a session that cannot proceed until you decide, while an idle
 * prompt is a turn that ended and has not been picked back up — the node is
 * already `done` and says so more quietly two columns away. On the log #348 was
 * measured against the split ran 16 idle to 5 permission, so counting both put
 * roughly three quarters noise into the topbar chip, the tab title and the
 * favicon, which are the three surfaces whose whole value is that they are
 * rare.
 *
 * Idle keeps everything that is not an alarm: its row in the sidebar, its card
 * line, its sort position above running, and CC's verbatim sentence in the
 * tooltip. It just stops shouting.
 */
export function isAlarming(waiting: WaitingBlock | null | undefined): boolean {
  return waiting?.kind === "permission";
}

/** One row of the topbar's blocked chip: which session, what to call it, and
 *  the block itself so the caller can word the tooltip and age the readout. */
export interface BlockedSession {
  id: string;
  label: string;
  waiting: WaitingBlock;
}

/**
 * Sessions blocked on a human, longest-blocked first — which is the one the
 * topbar count's own click goes to.
 *
 * Only roots carry `waiting` (see types.ts: `Notification` has no
 * parent_tool_use_id to attribute to a subagent, and the block is on the
 * session as a whole), so the `kind` check is belt-and-braces against a future
 * shape rather than deduplication that is load-bearing today.
 *
 * Counted over the map the canvas draws from, on every frame, rather than kept
 * as a tally: the map forgets. `pruneOldAgents` and `pruneDoneSessions` evict
 * finished agents outright, and a number that was only ever incremented would
 * go on reporting sessions that are no longer on the board — a tab title
 * claiming a block with nothing behind it to click through to.
 */
export function blockedSessions(agents: Iterable<AgentNodeData>): BlockedSession[] {
  const blocked: BlockedSession[] = [];
  for (const a of agents) {
    if (a.kind === "root" && isAlarming(a.waiting)) {
      blocked.push({ id: a.id, label: a.label, waiting: a.waiting! });
    }
  }
  return blocked.sort((x, y) => x.waiting.since - y.waiting.since);
}

/**
 * Sessions with an agent still working — the other half of what the tab strip
 * reports, and the answer to the lesser question the favicon falls back to.
 *
 * SESSIONS rather than agents, so a fan-out of six subagents is still one
 * thing moving; and recomputed from the map for the same eviction reason
 * `blockedSessions` is.
 */
export function runningSessionCount(agents: Iterable<AgentNodeData>): number {
  const live = new Set<string>();
  for (const a of agents) {
    if (a.state === "active") live.add(a.sessionId);
  }
  return live.size;
}
