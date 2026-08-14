// The accounts panel keys its open manage block by slot number, and a slot
// number is not a stable name for an account: `cswap move` into an occupied
// slot is a swap, so the two accounts trade places and both numbers change
// hands. The block stayed where the number was rather than where the account
// went, which put account B's row under account A's alias draft with `save`
// enabled — the draft no longer matched the alias of whoever held the number,
// which is precisely the condition that ENABLES the button — and one click
// renamed the wrong account. The armed remove and the on-screen share blob
// rode across the same way.
//
// The panel cannot be rendered here (plain node, no DOM), so these pin the
// rule itself: after a move the block follows its account, everything keyed by
// the old number is dropped, and a refused move changes nothing at all.
import { describe, it, expect } from "vitest";
import { manageAfterMove, type ManageState } from "../account-move";

/** The manage block open on slot 2, nothing armed, no share showing. */
const open2: ManageState = { menuFor: 2, confirmRemove: null, shareFor: null, swapNote: null };

/** Slot 2 moved into occupied slot 3: they trade places. */
const swap = { ok: true, from: 2, to: 3, swapped: true };
/** Slot 2 moved into free slot 5: nothing else moves. */
const relocate = { ok: true, from: 2, to: 5, swapped: false };

describe("manageAfterMove", () => {
  it("follows the account into the slot it was swapped into", () => {
    // The reported bug: menuFor stayed 2, which after the swap is the OTHER
    // account, so the block sat open on someone the user never opened.
    expect(manageAfterMove(open2, 2, swap)?.menuFor).toBe(3);
  });

  it("never leaves the block on a number that changed hands", () => {
    // Whatever the answer is — follow or close — the one thing it must not be
    // is the slot the mover left, because the displaced account is there now.
    for (const result of [swap, relocate, { ok: true, to: null, swapped: false }]) {
      expect(manageAfterMove(open2, 2, result)?.menuFor).not.toBe(2);
    }
  });

  it("follows a plain relocation into a free slot too", () => {
    const next = manageAfterMove(open2, 2, relocate);
    expect(next?.menuFor).toBe(5);
    // Nobody was displaced, so there is nothing to announce.
    expect(next?.swapNote).toBeNull();
  });

  it("says which slot the account nobody selected was pushed into", () => {
    // A swap relocates a second account and the roster shows the result
    // without ever saying it happened.
    expect(manageAfterMove(open2, 2, swap)?.swapNote).toEqual({ at: 3, displaced: 2 });
  });

  it("drops the armed remove and the visible share, which name slots too", () => {
    const armed: ManageState = { menuFor: 2, confirmRemove: 2, shareFor: 2, swapNote: null };
    const next = manageAfterMove(armed, 2, swap);
    // An armed remove that survived the swap is a delete aimed at whoever now
    // holds the number, and a share blob is a live login for one account.
    expect(next?.confirmRemove).toBeNull();
    expect(next?.shareFor).toBeNull();
  });

  it("changes nothing when the move was refused", () => {
    // Nothing moved, so the block stays open, armed and pointed where the user
    // left it — the failure box is the only thing that should appear. Closing
    // on a refusal would look exactly like a move that worked.
    const armed: ManageState = { menuFor: 2, confirmRemove: 2, shareFor: 2, swapNote: null };
    expect(manageAfterMove(armed, 2, { ok: false })).toBeNull();
    expect(manageAfterMove(armed, 2, null)).toBeNull();
    expect(manageAfterMove(armed, 2, { ok: false, to: 3, swapped: true })).toBeNull();
  });

  it("closes the block rather than guess when the server will not say where", () => {
    // A guessed slot number is the bug itself. An older server, or a move the
    // store did not confirm, gets the safe answer.
    expect(manageAfterMove(open2, 2, { ok: true, to: null, swapped: false })).toEqual({
      menuFor: null, confirmRemove: null, shareFor: null, swapNote: null,
    });
  });

  it("treats a move to the account's own slot as the no-op it is", () => {
    const next = manageAfterMove(open2, 2, { ok: true, from: 2, to: 2, swapped: true });
    // claude-swap's first case: nothing traded places however it was labelled,
    // so nothing is announced and the block does not move.
    expect(next?.menuFor).toBe(2);
    expect(next?.swapNote).toBeNull();
  });

  it("follows the displaced account's block as well, not only the mover's", () => {
    // Both halves of a swap are accounts someone may have open, and each
    // block's alias draft belongs to its own account wherever it ended up.
    const open3: ManageState = { menuFor: 3, confirmRemove: null, shareFor: null, swapNote: null };
    expect(manageAfterMove(open3, 2, swap)?.menuFor).toBe(2);
  });

  it("leaves a block open on a slot the move never touched", () => {
    const open9: ManageState = { menuFor: 9, confirmRemove: null, shareFor: null, swapNote: null };
    expect(manageAfterMove(open9, 2, swap)?.menuFor).toBe(9);
  });

  it("clears a stale swap notice when the next move displaces nobody", () => {
    const noted: ManageState = { menuFor: 3, confirmRemove: null, shareFor: null, swapNote: { at: 3, displaced: 2 } };
    expect(manageAfterMove(noted, 3, { ok: true, from: 3, to: 5, swapped: false })?.swapNote).toBeNull();
  });
});
