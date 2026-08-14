// Changing an account's slot can move two accounts, and the manage block was
// written as if it moved one.
//
// `cswap move` into an OCCUPIED slot is a swap, not a relocation: the two
// accounts trade places and the displaced one takes the vacated slot
// (claude-swap's `move_account`). Everything the accounts panel remembers
// about its open manage block is keyed by slot number — which block is open,
// which account has a remove armed, which account the visible share blob
// belongs to — so after a swap every one of those numbers names the OTHER
// account. The block stayed open on it holding the first account's alias, with
// `save` enabled because that draft no longer matched the alias of whoever the
// number now pointed at, and one click renamed the wrong account. The armed
// remove and the share blob rode across the same way: a live login shown under
// an account it was never made for.
//
// So the panel follows the account rather than the number. The decision is
// here instead of in the onChange handler because the suite runs on plain node
// with no DOM — the panel cannot be rendered, and a rule that only exists
// inside JSX is a rule nothing can check.

/** The slot a swap pushed a second account into, and the block that should say so. */
export interface SwapNote {
  /** Where the account the user moved ended up — the block the notice belongs in. */
  at: number;
  /** The vacated slot, which the displaced account now occupies. */
  displaced: number;
}

/** What the server says came of a `move`. `to` is null when it could not tell. */
export interface MoveResult {
  ok?: boolean;
  from?: number | null;
  to?: number | null;
  swapped?: boolean;
}

/** Everything the manage block holds that a move can invalidate. */
export interface ManageState {
  /** Which slot's block is expanded, if any. */
  menuFor: number | null;
  /** Which slot has its remove armed, if any. */
  confirmRemove: number | null;
  /** Which slot the share blob on screen belongs to, if any. */
  shareFor: number | null;
  /** The "a second account moved too" notice, if one is up. */
  swapNote: SwapNote | null;
}

/**
 * The manage block after a move, or null to leave it exactly as it is.
 *
 * `moved` is the slot the user asked to move; `result` is the admin route's
 * answer. Null is the refusal case and it is deliberate: a move that failed
 * moved nothing, so the block must stay open, armed and usable on the account
 * the user opened it on, with the panel's failure box the only thing that
 * appears. Closing on failure would look exactly like success.
 */
export function manageAfterMove(
  state: ManageState,
  moved: number,
  result: MoveResult | null,
): ManageState | null {
  if (!result?.ok) return null;

  // A server that will not say where the account landed cannot be followed,
  // and guessing is the bug: a wrong number here is a rename aimed at whoever
  // holds it. Close the block instead — the roster below still shows the move.
  const to = Number.isInteger(result.to) ? (result.to as number) : null;
  if (to == null) return { menuFor: null, confirmRemove: null, shareFor: null, swapNote: null };

  // Moving an account to the slot it already occupies is claude-swap's no-op
  // case, and nothing traded places however the server labelled it.
  const swapped = result.swapped === true && to !== moved;

  // Both accounts a swap touched are followed, not just the one the user
  // picked: each block's alias draft belongs to its own account, and that
  // stays true wherever the account ended up.
  const menuFor =
    state.menuFor === moved ? to
    : swapped && state.menuFor === to ? moved
    : state.menuFor;

  return {
    menuFor,
    // Both are slot numbers that have just changed hands. An armed remove is a
    // four-second window aimed at one account, and a share blob is a live
    // login for one account; neither survives the renumbering, and re-arming
    // or re-sharing costs one click.
    confirmRemove: null,
    shareFor: null,
    swapNote: swapped ? { at: to, displaced: moved } : null,
  };
}
