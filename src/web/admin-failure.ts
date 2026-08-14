// What the add-account dialog says when /api/claude-accounts/admin refuses.
//
// Two different things come back on a refusal and they are not interchangeable.
// `reason` is a code for a decision the server made, and the map below is that
// decision said in the product's voice. `detail`/`error` is the text the step
// that actually failed wrote down, and that is the half carrying the remedy:
// `cswap add` unable to read the macOS login keychain because the deck runs as a
// background service, or a `claude` that is not on PATH and the
// AGENTS_DECK_CLAUDE that points at it.
//
// Ranking the map above `error` unconditionally is how those sentences stopped
// reaching anyone. Reason "add_failed" has an entry, so "signed in, but
// claude-swap could not record the account" won every time — and the dialog's
// failure card renders this same string, so the remedy had nowhere else to
// surface and was simply lost.
//
// `error` cannot just win outright either, because it belongs to the login flow
// rather than to this response: a rejected code leaves its sentence on a flow
// that is still alive, so answering the next request out of it would tell
// someone who submitted an empty box that their code was not accepted. A flow
// that is over can no longer collect a newer error, which makes the one it holds
// its account of the ending. So the server's own words win exactly there, and
// the map speaks while the flow is still moving.
//
// Kept out of AddAccountDialog so the ranking can be tested without React or a
// DOM, the same reason login-flow.ts and login-announce.ts live out here.
import { isLoginOver } from "./login-flow";

/** A refusal from the admin route: the login actions carry the polled login
 *  state with them, the share/import ones answer with a reason alone. */
export type AdminFailure = {
  reason?: string;
  detail?: string;
  error?: string;
  state?: string | null;
} | null;

// Each is a decision the server made on purpose, so each gets a sentence rather
// than a code.
export const REASONS: Record<string, string> = {
  already_running: "a sign-in is already in progress",
  no_url: "the claude CLI did not offer a sign-in link — is it installed?",
  not_waiting: "that sign-in is no longer waiting for a code",
  not_prompted: "the CLI has not asked for a code yet",
  code_rejected: "that code was not accepted — copy it again from the browser",
  no_verdict: "the claude CLI has not answered — try the code again",
  empty_code: "paste the code from the browser first",
  login_failed: "the code was not accepted",
  no_identity: "signed in, but the CLI still reports nobody logged in",
  add_failed: "signed in, but claude-swap could not record the account",
  not_a_share: "that does not look like a shared account — it should start with ccdeck1:",
  corrupt: "that share is incomplete — copy the whole thing",
  wrong_version: "that share was made by a newer agents-deck",
  expired: "that share has expired — make a new one",
  import_failed: "claude-swap refused the import",
};

/** The one sentence to show for a refusal, most specific first. */
export function explainFailure(out: AdminFailure, fallback: string): string {
  // Written for this response and nothing else, so it needs no vetting.
  if (out?.detail) return out.detail;
  // The ending's own words, and the server knows the machine — which keychain,
  // which missing binary — in a way this map never can.
  if (out?.error && isLoginOver(out.state)) return out.error;
  if (out?.reason && REASONS[out.reason]) return REASONS[out.reason];
  // A crash in the handler sends `error` with no reason at all. Without this it
  // reached the user as the generic fallback, indistinguishable from a refusal,
  // and that is how a broken import spent a release looking like a rejected one.
  if (out?.error) return out.error;
  // A reason this build has no sentence for still names the thing that happened.
  return out?.reason || fallback;
}
