// What the usage-history modal is allowed to show for one render. Kept out of
// the component so it can be unit-tested without React or a DOM, the same
// reason usage-range.ts and latest.ts live out here.
//
// The modal used to gate its busy line on `days.length === 0`, which is true
// exactly once — before the first response ever lands. Every later ↻ and every
// range preset click therefore changed nothing on screen: the chart, the totals
// strip and the legend kept answering the PREVIOUS question underneath the
// newly highlighted tab, and seconds later the numbers rewrote themselves. The
// rule below is that a response is only ever shown against the range it was
// asked for, so clicking 7d can never be answered with 30d totals — not while
// the request is in flight, and not in the render between the click and the
// fetch, where `loading` is not true yet either.

export type UsagePhase = "busy" | "error" | "empty" | "chart";

/** A response that landed, tagged with the range it was requested for.
 *  The tag is the preset the client asked for rather than the `since` the
 *  server echoes, so a modal left open across local midnight — where the same
 *  preset resolves to a different `--since` — keeps reading as an answer. */
export interface UsageAnswer {
  range: number;
  ok: boolean;
  days: number;
}

export interface UsageView {
  phase: UsagePhase;
  /** What is on screen does answer the selected range, but a newer request for
   *  that same range is still running: dim it rather than present numbers that
   *  are about to move as final. */
  stale: boolean;
}

export function usageView(s: {
  loading: boolean;
  want: number;
  answer: UsageAnswer | null;
}): UsageView {
  // Nothing on screen answers the selected range. Whatever else is true, the
  // only honest thing to show is that ccusage is running — a previous range's
  // numbers, and a previous range's failure, are both answers to a question the
  // user has stopped asking.
  if (!s.answer || s.answer.range !== s.want) return { phase: "busy", stale: false };
  if (!s.answer.ok) return { phase: "error", stale: s.loading };
  return { phase: s.answer.days > 0 ? "chart" : "empty", stale: s.loading };
}
