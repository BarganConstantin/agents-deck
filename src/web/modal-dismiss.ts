// Escape had no owner. Three of the deck's five modals registered a window
// keydown listener of their own, ContextModal and SessionSummary registered
// none, and App.tsx's global handler mapped the same key to clearSelection() —
// so one press did two unrelated things for three of them (close the tool
// modal, and wipe the canvas selection behind it) and nothing at all for the
// other two, where the only way out was to Tab to the ×.
//
// Stacking was the sharper edge. No listener stopped propagation, so every
// modal on screen answered the same Escape: the clear prompt raised over a
// session summary took the summary down with it. clearActionFor() refuses to
// open the prompt over a modal for exactly that reason, but a summary arrives
// on its own from a Stop hook and can still land while the prompt is up, where
// it would have answered an Escape that was aimed at the prompt.
//
// So the overlays queue here instead. Each registers a dismisser for as long as
// it is mounted, the one window listener in App.tsx asks who answers, and only
// the top of the queue does. Layer beats arrival order because the clear prompt
// is rendered last on purpose — it paints above a summary that arrives after
// it, and the thing on top is the thing Escape means.
//
// Kept out of React so the ordering rule can be tested in a plain node
// environment, the way clear-confirm.ts and shortcuts.ts are.

/** What an overlay runs when Escape reaches it — its own onClose/onCancel. */
export type Dismisser = () => void;

/** The layer of an overlay that is rendered last so it paints over every other
 *  modal, whichever of them mounted more recently. Only the clear prompt is
 *  drawn that way. */
export const CONFIRM_LAYER = 1;

interface Entry {
  dismiss: Dismisser;
  layer: number;
  /** Mount order, so two overlays on the same layer resolve to the newer. */
  seq: number;
}

export interface DismissStack {
  /** Registers an overlay and hands back the unregister its unmount must call. */
  push(dismiss: Dismisser, layer?: number): () => void;
  /** Dismisses the overlay on top. False when there was none, which is the
   *  signal to App.tsx that Escape belongs to the canvas. */
  dismissTop(): boolean;
  /** How many overlays are on screen. */
  depth(): number;
}

export function createDismissStack(): DismissStack {
  const entries: Entry[] = [];
  let seq = 0;
  return {
    push(dismiss, layer = 0) {
      const entry: Entry = { dismiss, layer, seq: seq++ };
      entries.push(entry);
      // Removal by identity, not by position: overlays do not close in the
      // order they opened, and splicing the last one would unregister whichever
      // modal happened to arrive most recently instead.
      return () => {
        const i = entries.indexOf(entry);
        if (i !== -1) entries.splice(i, 1);
      };
    },
    dismissTop() {
      let top: Entry | undefined;
      for (const e of entries) {
        if (!top || e.layer > top.layer || (e.layer === top.layer && e.seq > top.seq)) top = e;
      }
      if (!top) return false;
      top.dismiss();
      return true;
    },
    depth() {
      return entries.length;
    },
  };
}

/** The one stack the app runs on. A module-level singleton because the modals
 *  are siblings scattered across the tree with no common provider, and Escape
 *  arrives on window rather than through any of them. */
export const modalStack = createDismissStack();

export interface EscapeContext {
  /** An overlay is mounted, so the key is spoken for. */
  overlayOpen: boolean;
  /** Focus is in text the user is writing. */
  typing: boolean;
}

/** The three things Escape can mean, exactly one of which happens. */
export type EscapeOutcome = "dismiss" | "blur" | "clear-selection";

/** Precedence, not a list of things that all fire. The old handler blurred the
 *  field and cleared the canvas selection while the modal on screen was closing
 *  itself on the very same press. An overlay outranks a text field because a
 *  dialog that closes on Escape from inside its own input is what the sign-in
 *  dialog already did, and a keyboard user pressing Escape in a dialog means
 *  the dialog. */
export function escapeOutcome(ctx: EscapeContext): EscapeOutcome {
  if (ctx.overlayOpen) return "dismiss";
  if (ctx.typing) return "blur";
  return "clear-selection";
}

/** The handful of node properties the focus-restore rule reads. Structural, and
 *  deliberately not an Element, so the rule can be tested where there is no DOM
 *  — the same shape trick FocusTarget uses in shortcuts.ts. */
export interface FocusNode {
  tagName?: string | null;
  isConnected?: boolean | null;
}

function isBody(n: FocusNode): boolean {
  return String(n.tagName ?? "").toUpperCase() === "BODY";
}

/** Whether closing an overlay should hand focus back to whatever opened it.
 *
 *  Only when focus fell to the floor: React has already removed the dialog by
 *  the time the cleanup runs, so focus that was inside it has landed on <body>,
 *  and that is the case worth repairing — dismissing the context modal left a
 *  keyboard user at the top of the document instead of on the .ctx-donut they
 *  came from. If focus has since moved somewhere real, moving it again would be
 *  the deck stealing it. The opener itself may also be gone (a node re-rendered
 *  away while the modal was up), and focusing <body> is not a restoration. */
export function shouldRestoreFocus(opener: FocusNode | null | undefined, active: FocusNode | null | undefined): boolean {
  if (!opener || !opener.isConnected || isBody(opener)) return false;
  return active == null || isBody(active);
}
