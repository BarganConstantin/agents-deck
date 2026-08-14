// Clear is the only irreversible control on the deck, and it had no guard.
//
// The toolbar button called handleClear directly and a bare "c" on window
// called the same function. handleClear POSTs /api/clear, which empties the
// server's ring buffer and truncates events.jsonl — the file replayLog()
// rebuilds the canvas from after a restart — and then throws away the stored
// layout, the pins and the selection. One mistyped letter with the canvas
// focused destroyed every session the deck had recorded, with no prompt and no
// undo, in an app that already arms-then-confirms the far cheaper "remove
// account" button.
//
// Half of this was fixed in v1.33.89: ownsKeystroke() in shortcuts.ts keeps a
// bare letter to whichever button, select or contenteditable has focus. Focus
// on the canvas is the normal state, though, so the destructive half survived
// untouched — that is what the gate below is for.
//
// The shortcut stays a bare "c" to match r/f/l/h/u/a/j/k/t. A modifier looks
// like extra safety and buys none: Ctrl+C and Cmd+C are copy on Linux/Windows
// and macOS respectively, and isBrowserChord() hands both back to the browser
// before the letter is ever read, while Shift+C is what a Caps-locked keyboard
// sends for the same bare letter. The guard that actually holds is this one,
// where no keystroke can reach anything destructive.
//
// Kept out of App.tsx so the rule can be tested without React or a DOM, and so
// a confirmation the button honours but the shortcut skips is not expressible.

/** Where a request to clear came from. `confirmation` is the dialog's own
 *  confirm button — the one source allowed to destroy anything. */
export type ClearSource = "button" | "shortcut" | "confirmation";

/** What else is on screen when the request arrives. */
export interface ClearContext {
  /** The clear dialog is mounted and waiting for an answer. */
  confirmOpen: boolean;
  /** One of the deck's other modals is up. */
  modalOpen: boolean;
}

/** The outcome of a clear request: wipe, ask first, or drop it. */
export type ClearAction = "clear" | "confirm" | "ignore";

export function clearActionFor(source: ClearSource, ctx: ClearContext): ClearAction {
  if (source === "confirmation") {
    // Answering a question nobody asked. A second click landing after the
    // dialog has already closed would otherwise wipe a canvas that has since
    // refilled.
    return ctx.confirmOpen ? "clear" : "ignore";
  }
  // A clear dialog stacked on top of another modal is a second thing on screen
  // competing for the same keys — before modal-dismiss.ts a single Escape took
  // both down together — and the user who typed "c" into an open tool modal
  // never meant to reach Clear at all.
  if (ctx.modalOpen) return "ignore";
  // Holding "c" repeats the keydown and the button is still under the pointer
  // for a double click: neither may answer the prompt it has just raised.
  if (ctx.confirmOpen) return "ignore";
  return "confirm";
}
