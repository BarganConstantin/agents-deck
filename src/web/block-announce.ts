// What the deck says out loud, and — much more of the work — what it refuses to
// say.
//
// #372 found the deck holding both ends of the wrong stick. The topbar's stat
// strip carried `role="status"`, which is a live region, around a readout whose
// events counter increments on EVERY hook event the server forwards; and
// `role="status"` carries an implicit `aria-atomic="true"` (ARIA 1.2, the
// `status` role's implicit values), so a screen reader did not merely say
// "1433" — it re-read the entire strip, "live 4 sessions 14 agents 1433 events
// 4.21M tokens mcp $1164 cost", once per event, for as long as anything was
// running. Meanwhile the one fact the deck exists to deliver — a session that
// has stopped and cannot restart until a human answers a permission prompt —
// reached the tab title, the favicon, an amber chip and a card row, all four of
// them silent, and was announced nowhere at all.
//
// The sessions, agents and events counters in that utterance have since been
// removed from the strip; tokens and cost still climb on their own, so the row
// is the same wrong content for a live region that it was, with fewer numbers.
//
// So the rule this module encodes is that a live region earns its keep by being
// quiet. It says something when a person's attention is actually required, it
// says nothing on the frames in between, and it never repeats itself.
//
// Pure and DOM-free, importing nothing but a shape, for the reason
// ambient-counts.ts gives at length: the suite runs in bare node with no jsdom
// and React cannot be rendered, so a rule spelled out inside a component is a
// rule the tests cannot call — and a rule the tests cannot call is one that
// gets copied and then drifts. The decision lives here, App.tsx does the DOM
// write, and block-announce.test.ts calls exactly what ships.

/** Enough of a blocked session to word the sentence. The real input is
 *  `BlockedSession[]` from ambient-counts.ts; only the label is read, so the
 *  parameter is typed structurally and the test does not have to build whole
 *  `WaitingBlock`s to exercise the wording. */
export interface Blocked {
  label: string;
}

/**
 * The sentence spoken once every blocked session has been dealt with.
 *
 * This string does a second job that is easy to delete by accident, so it is
 * named rather than inlined. A live region only speaks when its TEXT CHANGES,
 * and clearing a region to the empty string announces nothing — the default
 * `aria-relevant` is `"additions text"`, so a removal is not a change anybody
 * hears. Without an explicit all-clear the region would therefore go
 * "docs is waiting for your permission" → (silence) → "docs is waiting for your
 * permission", and that second announcement, being byte-identical to the text
 * already sitting in the region, would never be spoken. The user would be told
 * about the first block of the day and about none of the ones after it.
 *
 * The all-clear is what sits between the two and makes the repeat a change
 * again. That it is also the honest thing to say — the deck retracts a claim it
 * made rather than leaving the user believing a session is still stuck — is the
 * reason it is worth saying at all, but the mechanical role is why removing it
 * breaks more than it looks like it would.
 *
 * It matters for a second reason too: a block can clear with no human involved.
 * `sweepStaleSessions` (#350) reaps a session that has been silent for ninety
 * minutes and drops its `waiting` block on the way out, and a subagent's own
 * PostToolUse answers a prompt that subagent raised (#361). In both cases the
 * amber chip simply vanishes, which is a retraction only an eye can see.
 */
export const ALL_CLEAR = "No sessions are waiting for you.";

/**
 * What the deck should be saying right now, given the sessions blocked on a
 * human — or the empty string when it should be saying nothing.
 *
 * NAMES THE SESSION RATHER THAN ONLY COUNTING IT, and specifically names
 * `blocked[0]`. `blockedSessions()` sorts longest-blocked first and the topbar
 * chip's click goes to that same session, so the announcement names the one
 * place the user is about to be sent — "1 session is waiting" would make them
 * go and look for which.
 *
 * Naming it also closes a hole that a bare count cannot. If one session's block
 * clears in the same render in which another's begins, the count goes 1 → 1 and
 * a count-shaped sentence is unchanged, so nothing is spoken and the deck now
 * points at the wrong session. The label moves, so the sentence moves, so it is
 * spoken.
 *
 * Beyond the first, sessions are counted rather than listed. A live region is
 * heard serially at roughly 200 words a minute and cannot be skimmed, so five
 * labels read out in a row is five seconds of speech the user has to sit
 * through to reach the number they were after. One name and a tally is the
 * shape that stays short as the fan-out grows.
 *
 * "your permission" rather than "waiting for you", because `blockedSessions()`
 * counts permission blocks only — `isAlarming` in ambient-counts.ts, per #348 —
 * and an idle block is a finished turn, not a stopped session. Saying "waiting
 * for you" here would claim the quieter kind is included when it is deliberately
 * not.
 */
export function blockedAnnouncement(blocked: readonly Blocked[]): string {
  if (blocked.length === 0) return "";
  const [first, ...rest] = blocked;
  if (rest.length === 0) return `${first.label} is waiting for your permission.`;
  const others = `${rest.length} more session${rest.length === 1 ? "" : "s"}`;
  return `${first.label} and ${others} are waiting for your permission.`;
}

/**
 * The text the live region should carry next, given what it is carrying now.
 *
 * A pure reducer over the announcement itself rather than a stateful latch
 * object, which is what lets the caller drive it with `setState(prev => …)`.
 * That distinction is not stylistic: React may render a component and throw the
 * render away, so a latch advanced during render can be advanced by a state the
 * user never saw and answer the next real change with a stale one. A reducer
 * threaded through committed state cannot — the only `said` it is ever handed is
 * one that was actually on the screen.
 *
 * Returning the SAME string when nothing has changed is the whole quietness
 * mechanism, and it is why this is a function rather than an effect that pushes
 * text at the DOM. React bails out of a state update to an identical string, so
 * an unchanged announcement does not even re-render, let alone re-announce; the
 * frames where nothing worth saying happened cost one string comparison and
 * produce silence. That is the property the stat strip did not have.
 *
 * The three transitions, in full:
 *
 *   ""                 → "docs is waiting…"   a block began; spoken
 *   "docs is waiting…" → ALL_CLEAR            the last block cleared; spoken
 *   ALL_CLEAR          → ALL_CLEAR            still clear; silent, and stays
 *                                             put rather than emptying, since
 *                                             emptying a live region is a
 *                                             removal some screen readers do
 *                                             read out
 *
 * and the resting state before anything has ever blocked is `""`, so a deck
 * that opens on a quiet machine says nothing rather than opening with an
 * all-clear for an alarm that never sounded.
 *
 * A deck that opens on a machine which IS blocked does announce on mount, and
 * that is intended: the block is the state of the world at load, the user asked
 * for this page, and a polite announcement queues behind whatever the screen
 * reader is already saying about the page rather than cutting it off.
 */
export function nextAnnouncement(said: string, now: string): string {
  if (now !== "") return now;
  return said === "" ? "" : ALL_CLEAR;
}
