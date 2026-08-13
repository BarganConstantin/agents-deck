// When it is safe for the deck to restart itself.
//
// Kept out of App.tsx because this is the one decision in the feature that can
// lose data. Hook events are fire-and-forget — hook/hook.js gives each POST a
// 1s timeout, swallows ECONNREFUSED and never retries — so anything fired
// during the second or so the server is down is gone for good, and the canvas
// is left with tools stuck in flight until the stale sweeper reaps them.
//
// The rule is therefore not "restart when convenient" but "restart only when
// nothing has been happening for a while", and it is worth being able to test
// that rule without a browser.

/** How long everything must stay quiet before a restart is allowed. */
export const IDLE_BEFORE_RESTART_MS = 30_000;

/**
 * Whether the page is running older code than the server it is talking to.
 *
 * The same drift, one layer up. A restart replaces the server's modules, but an
 * open tab keeps executing whatever bundle it downloaded — so the deck can be
 * answering from v1.32.0 while the UI in front of you is v1.31.0 and missing
 * the controls that version added. It looks like a bug in the feature; it is
 * the feature's own problem, unsolved for the browser.
 *
 * `lastTried` makes this fire at most once per server version. Without it, a
 * build whose bundle genuinely does not match the package version — `npm
 * version` without a rebuild, which is every checkout mid-release — would
 * reload forever.
 */
export function shouldReloadBundle(
  { bundle, running, lastTried }: { bundle: string | null | undefined; running: string | null | undefined; lastTried: string | null },
): boolean {
  if (!bundle || !running) return false;
  if (bundle === running) return false;
  return lastTried !== running;
}

export type RestartGate = {
  /** The user's preference. Off means the button is the only path. */
  enabled: boolean;
  /** The kind of notice showing, if any. Only "restart" is free — an upgrade
   *  needs an install we deliberately never perform. */
  kind: string | null | undefined;
  /** The server's own verdict: supervised, and writing an event log. */
  canRestart: boolean;
  /** Any agent currently running. */
  busy: boolean;
  /** When the current quiet stretch began, or null if it has not begun. */
  idleSince: number | null;
  now: number;
  thresholdMs?: number;
};

export type RestartStep = {
  /** The quiet stretch to carry into the next tick. */
  idleSince: number | null;
  /** Ask the server to restart, now. */
  restart: boolean;
};

/**
 * One tick of the idle watch. Pure, so the caller owns the timer and the state.
 *
 * Returns `idleSince: null` for every condition that disqualifies a restart,
 * which means the clock restarts from zero rather than resuming — a burst of
 * work in the middle of a quiet stretch buys another full window, not the
 * remainder of the old one.
 */
export function autoRestartStep(g: RestartGate): RestartStep {
  const threshold = g.thresholdMs ?? IDLE_BEFORE_RESTART_MS;
  if (!g.enabled || g.kind !== "restart" || !g.canRestart) return { idleSince: null, restart: false };
  if (g.busy) return { idleSince: null, restart: false };
  if (g.idleSince == null) return { idleSince: g.now, restart: false };
  // Clocks move backwards — a laptop waking, an NTP correction — and a negative
  // elapsed must not read as "not yet" forever. Treat it as a fresh start.
  if (g.now < g.idleSince) return { idleSince: g.now, restart: false };
  return { idleSince: g.idleSince, restart: g.now - g.idleSince >= threshold };
}
