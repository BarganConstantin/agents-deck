// Throwing away saved state that a new version can no longer read.
//
// The deck upgrades itself now, so a tab can go from one version to the next
// without anyone clearing anything. Most of what it stores is preferences —
// theme, which panels are open, whether auto-restart is on — and those survive
// any release. Two keys do not: the saved layout and the viewport hold the
// SHAPE the canvas code expected at the time, so a release that changes that
// shape leaves the next boot reading positions keyed to node ids that no longer
// exist. That is a broken canvas with no visible cause and no obvious fix
// besides "clear site data", which nobody thinks to do.
//
// The version number is deliberately NOT the package version. Clearing the
// layout on every patch release would throw away hand-arranged canvases for no
// reason; this is bumped by hand, in the same commit that changes the shape.

/** Bump ONLY when the stored shape of a key below changes. */
export const STATE_SCHEMA = "1";

export const SCHEMA_KEY = "agent-dag.schema";

/** Keys whose contents are tied to a version's data shape. Everything else in
 *  the agent-dag.* namespace is a preference and is kept across upgrades. */
export const SHAPE_KEYS = ["agent-dag.layout", "agent-dag.viewport"];

/**
 * One stored string, or null when it is absent OR the browser refuses the store.
 *
 * `window.localStorage` is a getter that THROWS — SecurityError under Safari's
 * "Block All Cookies", Chrome with site data blocked, Firefox in strict mode —
 * so the failing step is the property read itself and a try that only wraps
 * `getItem` never runs. App restores preferences inside useState initialisers,
 * and src/web has no error boundary, so one throw escaping there rejects
 * root.render() and leaves #root empty: a blank deck with no message, on a
 * browser profile the user cannot tell is the cause. A blocked store must cost
 * a preference and nothing more, so both failures collapse to "not stored" and
 * the caller falls back to its default.
 */
export function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

type Storeish = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Drop shape-bearing state written by an incompatible version. Returns the keys
 * removed, which is what makes it testable — the browser is not involved.
 *
 * An unstamped store is treated as CURRENT, not as stale: every existing user
 * has one, and their layouts are fine. The stamp is written on the way past so
 * the next bump has something to compare against.
 */
export function pruneStaleState(store: Storeish, schema: string = STATE_SCHEMA): string[] {
  let seen: string | null = null;
  try { seen = store.getItem(SCHEMA_KEY); } catch { return []; }
  if (seen === schema) return [];

  const removed: string[] = [];
  if (seen !== null) {
    for (const key of SHAPE_KEYS) {
      try {
        if (store.getItem(key) !== null) { store.removeItem(key); removed.push(key); }
      } catch { /* a locked-down store is not worth failing boot over */ }
    }
  }
  try { store.setItem(SCHEMA_KEY, schema); } catch { /* private mode */ }
  return removed;
}
