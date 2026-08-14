// Clear was the deck's one irreversible action and it asked nothing. The
// toolbar button called handleClear directly, and a bare "c" on window called
// the same function — handleClear POSTs /api/clear, and the server empties its
// ring buffer and truncates events.jsonl, the log a restarted deck replays to
// rebuild the canvas. With focus anywhere on the canvas, one mistyped letter
// destroyed every session the deck had recorded, with no prompt and no undo.
//
// ownsKeystroke() (v1.33.89) already stops the letter that lands on a button,
// a <select> or a contenteditable. It cannot help the canvas, which is where
// focus normally is. These pin the other half: that neither entry point can
// reach the wipe without an answered confirmation, and that the confirmation
// cannot be answered by the same press that raised it.
import { describe, it, expect } from "vitest";
import { clearActionFor, type ClearContext } from "../clear-confirm";

/** Nothing on screen but the canvas — the state a stray "c" arrives in. */
const idle: ClearContext = { confirmOpen: false, modalOpen: false };

describe("clearActionFor", () => {
  it("never lets a keystroke wipe the event log on its own", () => {
    expect(clearActionFor("shortcut", idle)).toBe("confirm");
    expect(clearActionFor("shortcut", { confirmOpen: true, modalOpen: false })).not.toBe("clear");
    expect(clearActionFor("shortcut", { confirmOpen: false, modalOpen: true })).not.toBe("clear");
  });

  it("puts the toolbar button through the very same gate as the shortcut", () => {
    // A confirmation only the button honours would leave the keystroke — the
    // path a user takes by accident — as destructive as it ever was.
    for (const ctx of [idle, { confirmOpen: true, modalOpen: false }, { confirmOpen: false, modalOpen: true }]) {
      expect(clearActionFor("button", ctx)).toBe(clearActionFor("shortcut", ctx));
    }
  });

  it("clears only when the dialog that asked is still up to be answered", () => {
    expect(clearActionFor("confirmation", { confirmOpen: true, modalOpen: false })).toBe("clear");
    expect(clearActionFor("confirmation", { confirmOpen: true, modalOpen: true })).toBe("clear");
  });

  it("drops a confirmation that arrives after its dialog has gone", () => {
    // A second click landing on a dialog that has already closed would wipe a
    // canvas that has since refilled.
    expect(clearActionFor("confirmation", idle)).toBe("ignore");
    expect(clearActionFor("confirmation", { confirmOpen: false, modalOpen: true })).toBe("ignore");
  });

  it("does not let a held-down c answer the prompt it just raised", () => {
    // A held key repeats the keydown, and the button is still under the
    // pointer for a double click. Two presses must not equal a wipe.
    const armed: ClearContext = { confirmOpen: true, modalOpen: false };
    expect(clearActionFor("shortcut", armed)).toBe("ignore");
    expect(clearActionFor("button", armed)).toBe("ignore");
  });

  it("stays out of the way while another modal is open", () => {
    // Every modal in the deck closes on a window-level Escape and none of them
    // stop propagation, so a clear dialog stacked on a tool modal would take
    // that modal down with it when the user backed out.
    expect(clearActionFor("shortcut", { confirmOpen: false, modalOpen: true })).toBe("ignore");
    expect(clearActionFor("button", { confirmOpen: false, modalOpen: true })).toBe("ignore");
  });

  it("still opens the prompt on the first press with a clear screen", () => {
    expect(clearActionFor("shortcut", idle)).toBe("confirm");
    expect(clearActionFor("button", idle)).toBe("confirm");
  });
});
