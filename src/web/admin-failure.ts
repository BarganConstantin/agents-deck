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
import { PRODUCT } from "./brand";

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
  wrong_version: `that share was made by a newer ${PRODUCT}`,
  expired: "that share has expired — make a new one",
  import_failed: "claude-swap refused the import",
  // The alias field is the only free text this route accepts, so it is the only
  // one that can be refused for its spelling. Naming the allowed characters is
  // the difference between a rule and a wall.
  bad_value: "an alias can only use letters, numbers, spaces, dots, dashes and underscores, up to 64 characters",
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
  `claude-swap could not read the login keychain — start ${PRODUCT} from a Terminal window rather than a background service`;

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
  // The route refusing a `since`/`until` that is not a YYYYMMDD date. The modal
  // only ever sends presetSince()'s output, so this is unreachable from the deck
  // itself and is here for the build that talks to a server it does not match.
  bad_range: "that date range is not a YYYYMMDD date — reopen the modal and pick one of the presets",
  // The browser's own failure, not the server's: the deck never answered, so
  // there is no reason code to send and the client writes this one itself.
  unreachable: "the deck did not answer — check it is still running, then try again",
};

// The one remedy that only ever arrives inside ccusage's own bytes, the same
// exception KEYCHAIN is above. A machine without npx says so in four different
// ways depending on how the fallback was launched: spawned directly it is a
// plain "spawn npx ENOENT", and through cmd.exe on Windows it is "'npx.cmd' is
// not recognized as an internal or external command" — with the two shell
// spellings, /bin/sh's "npx: command not found" and dash's "npx: not found",
// still reachable from an older deck. All four arrive as run_failed carrying
// that line, and "ccusage could not report usage" is true, useless, and
// unfixable by trying again. All four are also a machine that does not HAVE
// npx; the fifth way that sentence gets said — npx present and broken — is
// npxBroken below, and it needs a different remedy.
const NO_NPX =
  "ccusage could not be started — npx is not on this deck's PATH. Install Node's npm/npx, or put ccusage on PATH yourself";

/** Every platform's way of saying the shell could not find npx. */
function npxMissing(text: string): boolean {
  return /\bnpx\b/i.test(text)
    && /(command not found|not found|not recognized|ENOENT)/i.test(text);
}

// The fifth shape, and the one the four above cannot see: npm and npx are on
// PATH, they launch, and NODE fails to load the script the shim points at.
// Reported from Windows (#432) — `%~dp0` inside npm.cmd and npx.cmd had
// resolved to the user's home root, so both shims ran and both died with
//
//     Error: Cannot find module 'C:\Users\…\node_modules\npm\bin\npx-cli.js'
//     code: 'MODULE_NOT_FOUND'
//
// None of npxMissing's four alternates matches that: `MODULE_NOT_FOUND` is not
// `not found`, the underscore is not a space. So it fell through to
// CCUSAGE_REASONS.run_failed — "ccusage could not report usage — try again" —
// and trying again is the one thing that cannot work when the wrong script is
// being loaded. Every retry re-runs the identical spawn for the identical stack.
//
// It gets its own sentence rather than a fifth alternate on NO_NPX because the
// remedy is a different one. NO_NPX says npx is not on PATH and to install
// Node's npm/npx; here npx IS on PATH and it launched, so saying "not on this
// deck's PATH" to someone who can see it on their PATH is the kind of wrong
// that makes a reader stop believing the rest.
//
// What this sentence must NOT do is name a cause it cannot see, which is what
// #450 was: it read this shape as "the machine's npm is damaged" and told a
// Windows user to reinstall Node. Their npm demonstrably worked — they had
// started the deck with `npx ccdeck` moments earlier, and `npm i -g ccdeck`
// installed twelve packages cleanly on the same machine. The same stack is
// produced by the deck reaching the WRONG npx: `npx ccdeck` prepends a
// `node_modules\.bin` for every ancestor of the cwd onto the deck's PATH
// (measured: 19 entries from a plain shell, 29 under npx), and fallbackSpec
// asks cmd.exe for a bare `npx.cmd`, so a project-local shim earlier on that
// PATH computes `%~dp0\node_modules\npm\bin\npx-cli.js` against its own `.bin`
// folder and dies exactly like a damaged install would. Node's stderr cannot
// tell the two apart, so this says what was run and what came back, and hands
// over the check that does tell them apart.
//
// The diagnostic names both spellings because this modal is the same build on
// every platform: `where` is cmd.exe's, `which` is the shell's, and a reader on
// the wrong one would otherwise be handed a command that does not exist.
const NPX_UNLOADABLE =
  "ccusage could not be started — the deck launched npx and Node could not load the npm script it points at. The deck may have reached the wrong npx rather than a damaged one: run `where npx` (`which npx` off Windows) and `npm config get prefix` in a plain terminal, and if npx works there, start the deck from a global install instead of `npx ccdeck`";

// A copy of ccusage that npx itself fetched, and that will not load. This is the
// deck's own doing twice over — the deck asked npx for the package, and npx put
// it under its cache — so nothing about it is evidence against the user's Node.
//
// It needs saying separately because "try again" is wrong here in a way it is
// not wrong for the managed install: ~/.agents-deck/ccusage is thrown away and
// rebuilt by discardDamagedInstall on the very next call, so trying again IS the
// repair there, while nothing in this deck ever rewrites npx's cache. Left to
// the reason map, a half-unpacked tarball under `_npx` would re-run identically
// for as long as the cache survives.
const NPX_CACHE_UNLOADABLE =
  "ccusage could not be started — the copy npx fetched will not load: Node could not resolve a file inside it. That copy is in npx's own cache, which the deck never rewrites, so clear it with `npm cache clean --force` and reopen this modal";

/** Node saying it could not load a file it was pointed at, in either module
 *  system: CommonJS throws `MODULE_NOT_FOUND`, ESM `ERR_MODULE_NOT_FOUND` with
 *  "Cannot find package" for a bare specifier. Mirrors cannotLoadModule in
 *  ccusage.mjs, which is the server half of the same judgement. */
const cannotLoad = (text: string): boolean =>
  /\b(?:ERR_)?MODULE_NOT_FOUND\b|cannot find (?:module|package)/i.test(text);

/**
 * The unloadable file is one of npm's OWN program files.
 *
 * This is the half #450 got wrong, and the correction is the whole fix. The old
 * test was "the text mentions npm or npx anywhere", which sounds like a
 * discriminator and is not one: npx runs every package it fetches out of a
 * directory NAMED after npm — `AppData\Local\npm-cache\_npx\…` on Windows,
 * `~/.npm/_npx/…` on POSIX (verified on a working machine) — and `\bnpm\b`
 * matches the `npm` in `npm-cache` and in `.npm` just as happily as the one in
 * `node_modules\npm\bin`, because `-` and `.` are word boundaries. So on the npx
 * fallback branch the old predicate had no discriminating power at all: every
 * module-resolution failure inside ccusage was reported as a damaged npm.
 *
 * Asking instead which FILE Node could not load is the discriminator, and it is
 * the one npxFailureHint in npx.mjs already uses, so the repo gains no second
 * spelling. npm's program files live in the `bin` directory of a
 * `node_modules/npm`; the basename alternates catch a message that quotes only
 * the file, and tolerate the `.cmd` spelling a shim-relative path can carry.
 */
const NPM_OWN_PROGRAM =
  /node_modules[\\/]npm[\\/]bin[\\/]|\bnpm-prefix\.js\b|\bnp[mx][-.][\w.-]*cli\.js\b/i;

/** Anywhere under npx's package cache. `_npx` is npm's own name for that
 *  subdirectory on every platform, and nothing else in a path is spelled it. */
const NPX_CACHE = /[\\/]_npx[\\/]/i;

/**
 * The one sentence to show for a failed ccusage run — never the raw output.
 * Same ranking as explainCommandFailure: the map speaks, and `error` stays
 * evidence the modal hangs on the status line's title.
 */
export function explainCcusageFailure(out: CcusageFailure, fallback: string): string {
  const text = commandOutput(out);
  if (cannotLoad(text)) {
    // The deck's own fetched copy first. A file under `_npx` is one npx put
    // there because this deck asked for it, so it is never evidence about the
    // user's npm installation — even on the exotic day the unloadable file
    // inside that cache happens to be an npm program file itself.
    if (NPX_CACHE.test(text)) return NPX_CACHE_UNLOADABLE;
    if (NPM_OWN_PROGRAM.test(text)) return NPX_UNLOADABLE;
    // Everything else that cannot load a module is the managed install under
    // ~/.agents-deck, which ccusage.mjs discards and rebuilds by itself — so the
    // reason map's "try again" is not a shrug here, it is the instruction that
    // triggers the repair.
  }
  if (npxMissing(text)) return NO_NPX;
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
