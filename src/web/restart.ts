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

/** What a tab does with the version the server just reported: reload into the
 *  new bundle, confirm the restart it was waiting on, or neither. */
export type LandingStep = "wait" | "reload" | "confirm";

/**
 * The single decision a tab makes when `running` moves.
 *
 * One function rather than two, because the two halves have to agree on who
 * consumes the pending marker and they cannot when they are separate effects on
 * the same dependency: React flushes those in one synchronous pass, and
 * `location.reload()` merely schedules a navigation — the task runs to
 * completion. So the reload was asked for, and then the confirmation half went
 * on to delete the marker meant to survive it, synchronously, into a
 * sessionStorage that outlives the navigation. The new bundle came up, found
 * nothing pending, and the "Restarted — now running vX" banner never showed for
 * the one case it exists for: a restart that actually changed the version.
 *
 * `lastTried` is what separates "a reload is coming, leave the marker for the
 * bundle that will be able to show it" from "a reload already happened and the
 * bundle is STILL behind" — `npm version` without a rebuild, every checkout
 * mid-release. In that second case no further reload is coming, so this page is
 * the last one that can confirm, and it does.
 */
export function restartLandingStep(
  { bundle, running, pending, lastTried }: {
    bundle: string | null | undefined;
    running: string | null | undefined;
    /** The version the restart was promised to land on, "" when it was a plain
     *  restart with no notice, or null when no restart is being waited on. */
    pending: string | null;
    lastTried: string | null;
  },
): LandingStep {
  if (!running) return "wait";
  // Ahead of the pending check on purpose: a restart from a terminal moves
  // `running` with nothing pending in this tab, and that stale bundle still has
  // to reload.
  if (shouldReloadBundle({ bundle, running, lastTried })) return "reload";
  if (pending == null) return "wait";
  if (pending && pending !== running) return "wait"; // still the old process
  return "confirm";
}

/** What /api/version says about the last upgrade attempt, as far as this file
 *  cares. `at` and `error` are the note the supervisor leaves behind when
 *  `npx -y <spec>@latest` fails; the in-process installer fills the same shape. */
export type UpgradeReport = {
  state?: string | null;
  error?: string | null;
  at?: number | null;
} | null | undefined;

/**
 * A reported upgrade failure reduced to something two polls can be compared on,
 * or null when no failure is being reported.
 *
 * Deliberately not the state alone: a retry that fails the same way reports the
 * same command and the same error text, and the only thing separating it from
 * the failure before it is when it happened. The supervisor stamps `at` as it
 * writes the note, so a note with a different stamp is a different failure.
 */
export function upgradeFailureId(upgrade: UpgradeReport): string | null {
  if (!upgrade || upgrade.state !== "failed") return null;
  return `${typeof upgrade.at === "number" ? upgrade.at : 0}:${upgrade.error ?? ""}`;
}

/**
 * Whether the restart being waited on has already ended, badly.
 *
 * A failed npx upgrade is the one ending nothing else reports. npx cannot
 * fetch, the supervisor relaunches the copy on disk on the same port, and the
 * tab's only completion check — `running` moving to the version it was promised
 * — waits for a version that is never coming. Left to itself the button stayed
 * disabled and labelled "fetching…" for the full three minutes of askRestart's
 * timeout, beside a banner already saying the update failed.
 *
 * `asked` is the failure the server was reporting when the click went out,
 * `reported` what it says now; only a failure we had not already seen ends this
 * attempt. Trusting `state === "failed"` on its own would end the retry the
 * instant it began: the previous note stays on disk until the supervisor clears
 * it at the top of the next attempt, and while npx is fetching the tab cannot
 * reach a server to hear about it.
 */
export function restartEndedInFailure(
  { asked, reported }: { asked: string | null; reported: string | null },
): boolean {
  if (!reported) return false;
  return reported !== asked;
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
