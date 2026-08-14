// What the sign-in dialog should do with the state the server reports.
//
// `claude auth login` runs on the server, not in the tab, so the dialog only
// ever sees it through a poll — and the server can lose that flow while the
// dialog is still watching it. GET /api/claude-accounts/login answers
// `{state:"idle"}` whenever the in-memory login is gone: a second tab pressed
// Escape and its login-cancel cleared it, or the deck restarted and killed the
// `claude auth login` child on its way out.
//
// "idle" is not a step in a sign-in. It is a sign-in that ended without a
// verdict, and the dialog had no branch for it: the poll stopped only on
// "done" and "failed", and every other state fell through to "Asking the claude
// CLI for a sign-in link…". So a sign-in that died elsewhere left a spinner
// that never resolved above a request every 1.5s for a flow that is never
// coming back.
//
// Both rules live here, out of AddAccountDialog, so they can be tested without
// React or a DOM — the repo's usual home for a decision a component makes.

/** Every state the login route can report. */
export type LoginServerState =
  | "idle" | "awaiting_url" | "awaiting_code" | "registering" | "done" | "failed";

/** The states in which the server still has a login that can change under us. */
const LIVE = new Set<string>(["awaiting_url", "awaiting_code", "registering"]);

/**
 * Keep polling only while something is actually moving on the server.
 *
 * A whitelist rather than "stop on the endings we know about", because that is
 * the shape that produced the endless loop: a state nobody listed kept the
 * interval alive forever. An unrecognised state now ends the poll, and
 * `isLoginOver` gives it somewhere to render.
 */
export function shouldPollLogin(state: string | null | undefined): boolean {
  return state != null && LIVE.has(state);
}

/** Whether the sign-in is over without having succeeded. */
export function isLoginOver(state: string | null | undefined): boolean {
  return state != null && state !== "done" && !LIVE.has(state);
}

/** Said when the server has forgotten a sign-in the dialog was still watching. */
export const LOGIN_VANISHED =
  "the sign-in ended before it finished — the deck restarted, or it was cancelled in another tab";

/** Said when the server called it a failure but sent no reason with it. */
export const LOGIN_FAILED = "the sign-in did not complete";

/**
 * The heading and sentence for an ended sign-in.
 *
 * A vanished login is not a failed one — nothing was rejected, the flow simply
 * stopped existing — so it gets its own heading and its own sentence instead of
 * the blank paragraph the failure branch would have rendered for it. A message
 * this request already earned still wins: "that sign-in is no longer waiting
 * for a code", from a code posted after another tab cancelled, says more than
 * the generic sentence does.
 */
export function loginEndNotice(
  { state, serverError, localError }:
  { state?: string | null; serverError?: string | null; localError?: string | null },
): { title: string; message: string } {
  const vanished = state === "idle";
  return {
    title: vanished ? "Sign-in ended" : "Sign-in failed",
    message: localError || serverError || (vanished ? LOGIN_VANISHED : LOGIN_FAILED),
  };
}
