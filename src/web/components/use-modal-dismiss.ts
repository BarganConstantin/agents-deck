// The one way a modal in this app answers Escape and gives focus back.
//
// Every modal used to spell its own dismissal, which is how two of the five
// ended up with no Escape handler at all and how the three that had one fought
// the window-level handler in App.tsx. The rules live in modal-dismiss.ts; this
// is the four lines of React that attach them, so the sixth modal cannot
// forget them and there is no fourth spelling to keep in step.
import { useEffect, useRef, type RefObject } from "react";
import { modalStack, shouldRestoreFocus } from "../modal-dismiss";

interface Options {
  /** Focused on mount, so the keyboard starts inside the dialog rather than
   *  wherever it was. Left unset by the modals that already choose their own
   *  first field. */
  focusRef?: RefObject<HTMLElement | null>;
  /** Higher answers Escape first — see CONFIRM_LAYER in modal-dismiss.ts. */
  layer?: number;
}

export function useModalDismiss(onDismiss: () => void, opts: Options = {}): void {
  const { focusRef, layer } = opts;

  // App.tsx hands these modals a fresh arrow on every render, so a stack entry
  // holding the function itself would have to be re-registered four times a
  // second (the snapshot tick) just to stay current, and each churn is a chance
  // to lose the overlay's place in the order.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => modalStack.push(() => onDismissRef.current(), layer), [layer]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    focusRef?.current?.focus();
    return () => {
      if (shouldRestoreFocus(opener, document.activeElement)) opener!.focus();
    };
    // Mount and unmount only: this is where focus enters the dialog and where
    // it goes back, and re-running it on a prop change would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
