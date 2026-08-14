// What the deck says when the server refuses. Three rankings live here, one per
// shape of refusal — explainFailure for /api/claude-accounts/admin, whose free
// text is written for the user, explainCommandFailure below it for the routes
// that hand back a subprocess's own output, and explainCcusageFailure for the
// usage-history modal, whose subprocess is an external CLI the deck installs
// itself and so fails in ways the account routes have no code for.
//
// Two different things come back on an admin refusal and they are not
// interchangeable.
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
// Kept out of the components so the rankings can be tested without React or a
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

/**
 * A refusal from a route that answers with the subprocess's own bytes.
 *
 * /api/claude-accounts/switch sends `output` — 500 characters of whichever of
 * cswap's stderr and stdout is not empty — and /api/cswap-auto sends `detail`,
 * its stderr cut to 300. Neither was written for anybody to read, and the
 * accounts panel is 288px wide at 10px: a failed switch put a Python traceback,
 * or cmd.exe's two-line "'cswap' is not recognized …/operable program or batch
 * file.", into a box the width of a phone number, and the only alternative the
 * panel offered was the bare code `switch_failed`.
 */
export type CommandFailure = {
  reason?: string;
  output?: string;   // the switch route's name for it
  detail?: string;   // the auto-switch route's
  error?: string;    // /api/ccusage's
} | null;

// Every reason the two command routes can answer this panel with, said in the
// product's voice. The wording carries the machine's half of the remedy where
// there is one: cswap resolves through exec.mjs's candidate list, so "not
// found" means PATH on every platform and AGENTS_DECK_CSWAP is the answer on
// all three — a Windows .cmd shim that cmd.exe could not find arrives here as
// no_cswap like any other.
export const COMMAND_REASONS: Record<string, string> = {
  no_cswap: "claude-swap could not be run — it is not on this deck's PATH. Set AGENTS_DECK_CSWAP to its full path",
  timeout: "claude-swap took too long and was stopped — try again",
  switch_failed: "claude-swap refused the switch",
  bad_account: "that is not an account claude-swap has",
  unknown_setting: "claude-swap has no such setting",
  out_of_range: "that value is outside what the setting allows",
  bad_value: "claude-swap does not accept that value",
  set_failed: "claude-swap refused the change",
  command_failed: "claude-swap refused the command",
};

// The one remedy that only ever arrives inside the raw output, so hiding the
// output without it would lose the only actionable thing it ever said. A
// process with no GUI session cannot read the macOS login keychain, so a deck
// started as a background service fails every credential move with it — and
// "claude-swap refused the switch" is true, useless, and unfixable. Same test
// as cswap-admin.mjs's addFailureText, and inert off macOS, where the word
// never appears.
const KEYCHAIN =
  "claude-swap could not read the login keychain — start agents-deck from a Terminal window rather than a background service";

/**
 * The one sentence to show for a command refusal — never the raw output.
 *
 * The ranking is the inverse of explainFailure's on purpose. That one leads
 * with the free text because the admin route composes it with failureText(),
 * for this response, in sentences. Here the free text is whatever the child
 * printed on its way out, so the map speaks and the output stays evidence: the
 * caller keeps it for the element's title, where a traceback is one hover away
 * instead of on screen.
 */
export function explainCommandFailure(out: CommandFailure, fallback: string): string {
  // A tool that never started printed nothing of its own — anything in the
  // output there came from the shell that could not find it.
  if (out?.reason !== "no_cswap" && /keychain/i.test(commandOutput(out))) return KEYCHAIN;
  if (out?.reason && COMMAND_REASONS[out.reason]) return COMMAND_REASONS[out.reason];
  // A reason this build has no sentence for still names the thing that
  // happened, which is more than the subprocess's last line ever did.
  return out?.reason || fallback;
}

/** What the child actually printed. For a title attribute, never for the box. */
export function commandOutput(out: CommandFailure): string {
  return (out?.output || out?.detail || out?.error || "").trim();
}

/** A failed ccusage run, as /api/ccusage answers it: the reason the run ended,
 *  and under `error` whatever the thing that failed wrote down. */
export type CcusageFailure = CommandFailure;

// ccusage is not claude-swap and none of the codes above fit it. It is a package
// the deck installs into ~/.agents-deck and then runs, so its refusals are about
// installability and runnability: installs forbidden by AGENTS_DECK_NO_INSTALL,
// the 90s deadline, output that is not usage data, a run that exited on its own.
// The route collapsed all four into `error`, so the modal showed whatever
// `err.message` happened to be — "spawn npx ENOENT" as the entire account of a
// stats panel with nothing in it.
export const CCUSAGE_REASONS: Record<string, string> = {
  no_install: "ccusage is not installed, and AGENTS_DECK_NO_INSTALL=1 forbids fetching it — unset that variable and restart the deck, or install ccusage yourself",
  timeout: "ccusage took more than 90 seconds and was stopped — a narrower range usually finishes",
  bad_output: "ccusage ran but printed no usage data — try again, and run ccusage daily --json in a terminal if it keeps happening",
  run_failed: "ccusage could not report usage — try again",
  // The browser's own failure, not the server's: the deck never answered, so
  // there is no reason code to send and the client writes this one itself.
  unreachable: "the deck did not answer — check it is still running, then try again",
};

// The one remedy that only ever arrives inside ccusage's own bytes, the same
// exception KEYCHAIN is above. The npx fallback runs through a shell, so a
// machine without npx never produces a spawn error for us to code: /bin/sh
// exits 127 with "npx: command not found", dash writes "npx: not found", and
// cmd.exe writes "'npx' is not recognized as an internal or external command".
// All three reach us as run_failed carrying the shell's line, and "ccusage
// could not report usage" is true, useless, and unfixable by trying again.
const NO_NPX =
  "ccusage could not be started — npx is not on this deck's PATH. Install Node's npm/npx, or put ccusage on PATH yourself";

/** Every platform's way of saying the shell could not find npx. */
function npxMissing(text: string): boolean {
  return /\bnpx\b/i.test(text)
    && /(command not found|not found|not recognized|ENOENT)/i.test(text);
}

/**
 * The one sentence to show for a failed ccusage run — never the raw output.
 * Same ranking as explainCommandFailure: the map speaks, and `error` stays
 * evidence the modal hangs on the status line's title.
 */
export function explainCcusageFailure(out: CcusageFailure, fallback: string): string {
  if (npxMissing(commandOutput(out))) return NO_NPX;
  if (out?.reason && CCUSAGE_REASONS[out.reason]) return CCUSAGE_REASONS[out.reason];
  // A build talking to a newer server still names the thing that happened,
  // which is more than the CLI's last line ever did.
  return out?.reason || fallback;
}

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
