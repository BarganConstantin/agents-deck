// How long something took, in the deck's voice — for the two surfaces that
// print the same span twice, side by side.
//
// WHY THIS MODULE EXISTS (#374). Both dialects below were written out more than
// once, and both pairs had already drifted into printing different strings for
// the same milliseconds on two surfaces a user sees together:
//
//   * `elapsed` lived in AgentNode.tsx and again, inline and unnamed, in
//     App.tsx's detail panel. The detail panel's copy had no sub-second tier,
//     so a just-started agent's card read "437ms" while the panel beside it —
//     which is only on screen BECAUSE that card is selected — read "0s". A
//     sweep of every millisecond from 1s to 3h found the two identical
//     (1,542,715 values, 0 disagreements); every one of the 6,000 values below
//     a second disagreed. The card's version is a strict superset and is the
//     one kept.
//
//   * the tool duration was `durLabel` in App.tsx's ToolRow and `dur` in
//     ToolModal.tsx. ToolRow IS the button that opens ToolModal for that exact
//     tool call, and the two rounded to different precisions — 599,001 of the
//     600,001 millisecond values from 0 to 600s printed differently, so a 1.24s
//     tool read "1.2s" in the row and "1.24s" in the dialog one click later.
//
// Neither dialect is folded into the other. They answer different questions —
// one is "how long has this agent been going", where a two-decimal second would
// be noise on a figure that ticks; the other is "how long did this call take",
// where the hundredths are the interesting part on a call that is over. What
// they have in common is that each of them is now written once.
//
// Deliberately NOT folded in, and why:
//
//   * `elapsedShort` (SessionList.tsx) — "<1s" / "42s" / "3m" / "1h 15m". It
//     drops the seconds above a minute and adds an hour tier, because it is a
//     compact table cell rather than a card. Folding it in would print
//     "75m 12s" where "1h 15m" is today.
//   * `durationLabel` (SessionSummary.tsx) — "42s" / "3m 07s" / "1h 15m". Same
//     hour tier, no sub-second tier, on a summary of a finished session.
//
// Both are genuinely different renderings rather than copies that drifted, and
// #374 says as much about the first of them. They stay where they are.

import type { ToolCall } from "./types";

/**
 * How long an agent, or a block it is waiting on, has been going: "437ms" /
 * "42s" / "3m 07s".
 *
 * `end` is undefined while the thing is still running, in which case `now` is
 * the end — which is what makes this a function of three arguments rather than
 * a formatter over one duration. A clock that has been set back can leave `now`
 * behind `start`; sub-second is clamped at zero rather than rendering a
 * negative count, exactly as the agent card has always done.
 *
 * The seconds are padded to two digits above a minute and NOT below one, which
 * is not an oversight: "3m 07s" is a pair of columns that stays put as the
 * second ticks, and "7s" on its own has nothing to line up with.
 */
export function elapsed(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${String(rs).padStart(2, "0")}s`;
}

/**
 * How long one tool call took: "842ms" / "1.24s", or `pending` while it is
 * still open.
 *
 * The sentinel is the only real difference between the two surfaces that print
 * this — the row in the detail panel writes "…" because it is one cell in a
 * list of them, and the dialog writes "in-flight…" because it has the room and
 * is the only place the word appears — so it is a parameter rather than a
 * second function.
 *
 * TWO DECIMALS, which is the dialog's rounding and not the row's. The pair had
 * to agree on one, and this is the direction that loses nothing: the row's
 * label is already five characters wide at the top of the sub-second tier
 * ("999ms"), so every duration from 1.00s to 9.99s costs it no width at all,
 * and above ten seconds it is one character wider than before. Rounding the
 * dialog to a tenth instead would have taken a digit out of the one surface
 * whose whole job is the detail — two calls at 1.24s and 1.21s would read as
 * the same number in the place you opened to tell them apart.
 *
 * There is no `now` parameter, unlike `elapsed` above, because neither copy
 * ever used one: the row computed `(t.endedAt ?? now) - t.startedAt` and then
 * discarded that value on the very branch where `endedAt` was null. A call
 * still open prints the sentinel, and a call that is over carries both of its
 * own timestamps.
 */
export function toolDuration(t: ToolCall, pending: string): string {
  if (t.endedAt == null) return pending;
  const ms = t.endedAt - t.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
