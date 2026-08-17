// `save` was disabled the instant the manage block opened, and disabled is the
// state it spent almost all of its life in: the draft is seeded from the stored
// alias, so `draft === stored` is true before the user has touched anything.
// Combined with the dimming that came with it, the largest control in the top
// row rendered at 1.98:1 — the first impression the whole feature makes, and it
// looked broken rather than inactive.
//
// So the button is always live and the comparison moves here, where it decides
// whether a click needs to reach the server rather than whether the button may
// be pressed. Both answers end in the same transient `saved`, which is the
// panel's existing idiom for "that landed" (`copied`, `shareCopied`): a click
// on an unchanged alias is honest — it IS saved — and a click on a changed one
// says so once the store agrees.
//
// The trim is the other half. The old comparison trimmed the draft and the POST
// did not, so typing a trailing space stored `"work "`, and every subsequent
// comparison of `"work"` against `"work "` disagreed — the button stayed
// enabled for good, and every press re-sent the same value. One spelling of the
// alias, decided in one place.

/**
 * The longest alias the store will accept, in characters.
 *
 * This is the upper bound of `ALIAS_OK` in src/server/cswap-admin.mjs, which
 * rejects anything longer with `bad_value`. The field had no bound at all, so
 * the only way to learn where the limit was was to type past it and read a
 * failure; `maxLength` moves that answer to the moment of typing. It is the
 * server's number and not a smaller round one on purpose — a field that
 * silently refuses a name the store would have taken is its own small lie.
 *
 * It is not, however, what keeps a long alias from widening the accounts panel.
 * The deck only reads claude-swap's store, and `cswap alias` writes it from the
 * command line without passing through here, so the panel has to survive an
 * alias of any length whatever this field allows — that guard is the ellipsis
 * and `max-width` on `.ap-alias` in styles.css.
 */
export const ALIAS_MAX_LENGTH = 64;

/** What a press of `save` should do. */
export interface AliasSave {
  /** Whether the store has to be told. False when it already holds this alias. */
  commit: boolean;
  /** The alias to send — trimmed, which is the only form ever compared. */
  alias: string;
}

/**
 * The alias a press of `save` should store, and whether storing it is a change.
 *
 * `stored` is claude-swap's current alias for the account, which is null for an
 * account that has never had one; an empty draft and a missing alias are the
 * same state and neither is worth a round trip.
 */
export function aliasSave(draft: string, stored: string | null | undefined): AliasSave {
  const alias = draft.trim();
  return { alias, commit: alias !== (stored ?? "").trim() };
}
