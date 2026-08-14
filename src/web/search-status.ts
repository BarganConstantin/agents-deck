// What the /-search is allowed to claim about its own result.
//
// The field had no readout at all. A query that matched nothing asked every
// node and every bubble to drop to 22% opacity and desaturate, and said
// nothing else: no count, no zero-result line. A typo and "every session has
// aged out" produce the same screen, and the board reads as broken rather than
// filtered. It is the only filter in the app with no state on show — the tool
// category chips and the selection ribbon both report theirs.
//
// Two rules live here. A count, so the filter says how much it kept; and the
// refusal to dim on a zero-match query, because dimming everything is a
// statement that some things matched. When nothing does, the honest output is
// a sentence, not a grey canvas.
//
// Note for whoever fixes #316: the dimming is currently masked anyway. Both
// `.react-flow__node` (nodeSpawn) and `.tool-burst` (bubble-spawn) run their
// spawn animation with `fill: both`, and both animations end on an `opacity: 1`
// keyframe — an animation keeps applying its filled values over author
// declarations, so `.rf-dim`/`.tool-burst.dim` lose the cascade for the life of
// the element. So the count and the message below are not a garnish on a
// working dim; right now they are the only feedback the search gives.

export interface SearchStatus {
  /** Whether a query is filtering anything at all. */
  active: boolean;
  matched: number;
  total: number;
  /** "3 of 11" — null when no query is active. */
  count: string | null;
  /** A query is active and nothing matched it. */
  empty: boolean;
  /** The zero-result sentence, or null when there is a result to look at. */
  message: string | null;
  /** Whether unmatched nodes and bursts should be dimmed. */
  dim: boolean;
}

/**
 * Should the canvas dim what the query did not match?
 *
 * Only when the query kept something. Dimming the whole board says "the ones
 * you want are the bright ones" about a screen with no bright ones.
 */
export function shouldDimUnmatched(query: string, matched: number): boolean {
  return query !== "" && matched > 0;
}

/**
 * @param matched agents that match and are on the canvas
 * @param total agents on the canvas — both counted over the visible set, so
 *   the readout can never say "0 of 11" while something is still lit up
 */
export function searchStatus(query: string, matched: number, total: number): SearchStatus {
  if (query === "") {
    return { active: false, matched, total, count: null, empty: false, message: null, dim: false };
  }
  return {
    active: true,
    matched,
    total,
    count: `${matched} of ${total}`,
    empty: matched === 0,
    // The query is quoted back rather than described: it is what the user has
    // to correct, and on a narrow field it may be scrolled out of sight.
    message: matched === 0 ? `No agents match “${query}”` : null,
    dim: shouldDimUnmatched(query, matched),
  };
}
