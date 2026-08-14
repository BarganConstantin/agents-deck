// Which keystrokes the deck is allowed to claim.
//
// The canvas shortcuts are bare letters — c clears, r re-lays-out, f fits — and
// a keydown for Ctrl+C or Cmd+C arrives with e.key set to that same bare "c".
// Without a modifier check the deck answers the browser's own chords: copying a
// line of tool output ran Clear, which empties the server's ring buffer and
// truncates the events file it replays from, and every Ctrl+R refresh threw
// away the layout the persistence feature exists to keep.
//
// Ctrl and Cmd both count, because the copy/refresh chord is Ctrl on Linux and
// Windows and Cmd on macOS, and a build has no way to know which one is in
// front of it. Alt joins them for the menu chords (Alt+F opens the browser's
// File menu). Shift deliberately does not: the handler already treats "C" and
// "c" alike, so Shift+letter is ours to keep.
//
// Kept out of App.tsx so the rule can be tested without a DOM.

/** The modifier flags every KeyboardEvent carries. Structural so a test can
 *  pass a plain object instead of synthesising a real event. */
export interface ChordModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** True when the keystroke belongs to the browser or the OS rather than to the
 *  deck's single-key shortcuts. */
export function isBrowserChord(e: ChordModifiers): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}
