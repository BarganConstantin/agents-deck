// Telling the panel behind the sign-in dialog that the roster changed — once
// per sign-in, not once per render.
//
// The announcement used to be an effect keyed on the very callback that carries
// it, and AccountsPanel mints that callback inline (`onChanged={() => load(true)}`),
// so a fresh identity arrived with every render of the panel. A finished
// sign-in keeps the dialog mounted behind its "Account N added" card, so the
// effect ran on every one of those renders: onChanged() reloaded the roster,
// the reload assigned freshly parsed objects React could not bail out of, the
// re-render minted another closure, and the effect fired again. Roughly one
// round trip per network turn — tens per second against localhost — for as long
// as the card stayed up, and every turn cost a full process-table enumeration
// on the server behind /api/cswap-auto: `ps -Ao args=` on macOS and Linux, a
// Get-CimInstance query through PowerShell on Windows.
//
// So the announcement has to belong to the sign-in reaching its end rather than
// to anything rendering. This latch lives in a ref next to a ref holding the
// current callback, which leaves the effect with nothing to depend on but the
// server's state string — the same move pause.ts makes to keep the SSE
// subscription off the render path. Kept out of AddAccountDialog so the rule
// can be tested without React or a DOM.

/** The one state that changes the roster: an account was just added, or an
 *  existing one had its stored credentials replaced. */
const ANNOUNCES = "done";

export interface LoginAnnouncer {
  /**
   * Whether the panel should reload the roster now. True exactly once per
   * arrival at "done" — asking again with the same state answers false, which
   * is what breaks the loop when the effect is re-run for reasons that have
   * nothing to do with the sign-in.
   */
  shouldAnnounce(state: string | null | undefined): boolean;
}

export function createLoginAnnouncer(): LoginAnnouncer {
  let announced = false;

  return {
    shouldAnnounce(state: string | null | undefined): boolean {
      // Anything but the end re-arms the latch: "Try again" clears the state
      // and runs a second sign-in in the same dialog, and that one has its own
      // roster change to report.
      if (state !== ANNOUNCES) { announced = false; return false; }
      if (announced) return false;
      announced = true;
      return true;
    },
  };
}
