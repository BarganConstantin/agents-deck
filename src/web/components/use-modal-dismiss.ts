// The one way a modal in this app answers Escape, holds Tab, and gives focus
// back.
//
// Every modal used to spell its own dismissal, which is how two of the five
// ended up with no Escape handler at all and how the three that had one fought
// the window-level handler in App.tsx. The rules live in modal-dismiss.ts; this
// is the React that attaches them, so the sixth modal cannot forget them and
// there is no fourth spelling to keep in step.
//
// Focus is the same story one layer down. Three of the six never took focus at
// all when they opened, and none of the six kept it: a dialog claiming
// `aria-modal="true"` sat over a document whose every control was still a Tab
// away, behind a scrim that paints over all of it. So the same hook now owns
// where focus starts, where Tab may go while the dialog is up, and where focus
// lands when it closes — one place, six overlays.
import { useEffect, useRef, type RefObject } from "react";
import {
  isScrollStop,
  isTabbable,
  modalStack,
  shouldRestoreFocus,
  TABBABLE_SELECTOR,
  trapTab,
  type Dismisser,
} from "../modal-dismiss";
import { isBrowserChord } from "../shortcuts";

interface Options {
  /** Focused on mount, when the right first stop is not simply the first
   *  control in the dialog — Cancel rather than the × on the clear prompt, the
   *  primary button rather than a tab strip on the sign-in dialog. Left unset,
   *  the dialog's first tabbable control gets it. */
  focusRef?: RefObject<HTMLElement | null>;
  /** Higher answers Escape first — see CONFIRM_LAYER in modal-dismiss.ts. */
  layer?: number;
}

/** Everywhere inside the dialog Tab can land, in document order: its controls,
 *  and the scrollable regions the browsers put in the tab order themselves.
 *
 *  One sweep of the subtree rather than one selector per kind, because the two
 *  have to come back interleaved in the order Tab visits them, and only the DOM
 *  knows that order.
 *
 *  Read fresh on every keystroke rather than cached on open, because these
 *  dialogs change shape while they are up: the sign-in dialog swaps its whole
 *  body between five branches, and the usage modal disables its ↻ for as long
 *  as ccusage runs. */
function tabbablesIn(dialog: HTMLElement | null): HTMLElement[] {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll<HTMLElement>("*")).filter(el => {
    if (el.matches(TABBABLE_SELECTOR)) {
      return isTabbable({
        disabled: (el as HTMLElement & { disabled?: boolean }).disabled,
        tabIndex: el.tabIndex,
        // Nothing in these dialogs is hidden by CSS today; this is here because
        // a selector cannot see a `display: none` ancestor and a trap that wraps
        // onto an invisible control is a trap that loses the user.
        rendered: el.getClientRects().length > 0,
      });
    }
    const overflowing = el.scrollHeight > el.clientHeight;
    // The style engine and a second selector sweep are asked only where content
    // actually overflows, which is one or two elements in a dialog rather than
    // all of them.
    return overflowing && isScrollStop({
      overflowing,
      overflow: getComputedStyle(el).overflowY,
      hasFocusable: el.querySelector(TABBABLE_SELECTOR) != null,
    });
  });
}

/** The stops for this keystroke: everything above, plus the focused element
 *  itself when it is inside the dialog and the sweep did not name it. Nothing
 *  in these six dialogs is reachable that way today — it is here because a
 *  browser deciding some element of its own is focusable must not turn into
 *  this trap yanking the user off it. The trap closes the exit; it never takes
 *  a stop away. */
function stopsFor(dialog: HTMLElement, active: HTMLElement | null): HTMLElement[] {
  const stops = tabbablesIn(dialog);
  if (!active || !dialog.contains(active) || stops.includes(active)) return stops;
  const after = stops.findIndex(s => (active.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  return after === -1 ? [...stops, active] : [...stops.slice(0, after), active, ...stops.slice(after)];
}

/** Hands back the ref the dialog surface — the element with role="dialog", not
 *  the backdrop — must carry. That element is the boundary of the trap, so
 *  without it there is nothing to hold Tab inside.
 *
 *  Generic over the element only so a call site needs no cast: all six of the
 *  deck's dialog surfaces are a <div>, which is why that is the default. */
export function useModalDismiss<T extends HTMLElement = HTMLDivElement>(
  onDismiss: () => void,
  opts: Options = {},
): RefObject<T> {
  const { focusRef, layer } = opts;
  const dialogRef = useRef<T | null>(null);

  // App.tsx hands these modals a fresh arrow on every render, so a stack entry
  // holding the function itself would have to be re-registered four times a
  // second (the snapshot tick) just to stay current, and each churn is a chance
  // to lose the overlay's place in the order.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // One dismisser for the life of the mount, and the same one the stack holds:
  // isTop() compares by identity, and a new arrow on every render would never
  // match the entry that was pushed.
  const dismissRef = useRef<Dismisser | null>(null);
  if (dismissRef.current === null) dismissRef.current = () => onDismissRef.current();
  const dismiss = dismissRef.current;

  useEffect(() => modalStack.push(dismiss, layer), [dismiss, layer]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Where the keyboard starts. React has attached dialogRef by the time an
    // effect runs, so the dialog's own controls can be read here — which is
    // what makes "the modal takes focus" true for the three that named no
    // focusRef, instead of leaving the user parked on the bubble they clicked
    // while a dialog claiming aria-modal covers the screen.
    (focusRef?.current ?? tabbablesIn(dialogRef.current)[0])?.focus();
    return () => {
      if (shouldRestoreFocus(opener, document.activeElement)) opener!.focus();
    };
    // Mount and unmount only: this is where focus enters the dialog and where
    // it goes back, and re-running it on a prop change would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // On window rather than on the dialog, because focus is not always inside
    // it: clicking a paragraph of modal text drops focus on <body>, and a
    // listener attached to the dialog would never see the Tab that then walks
    // off into the document behind the scrim.
    const onKey = (e: KeyboardEvent) => {
      // Shift is the only modifier a wrap reads, and it means the same thing on
      // Linux, macOS and Windows. Ctrl+Tab switches browser tabs and Alt/Cmd+Tab
      // switches windows — the same chords the deck's own shortcuts already
      // stand aside for, through the same rule, so there is one answer to "is
      // this the browser's keystroke" and not two.
      if (e.key !== "Tab" || isBrowserChord(e)) return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const active = document.activeElement as HTMLElement | null;
      const inside = active != null && dialog.contains(active);
      // Two overlays can be on screen at once — the clear prompt raised over a
      // session summary — and both are listening. Only the one Escape would
      // close may claim a Tab it cannot see the origin of; the other stays out
      // of it unless focus is genuinely within its own walls.
      if (!inside && !modalStack.isTop(dismiss)) return;
      const stops = stopsFor(dialog, active);
      const move = trapTab({
        count: stops.length,
        index: active ? stops.indexOf(active) : -1,
        shiftKey: e.shiftKey,
      });
      if (move.kind === "allow") return;
      e.preventDefault();
      if (move.kind === "focus") stops[move.index]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  return dialogRef;
}
