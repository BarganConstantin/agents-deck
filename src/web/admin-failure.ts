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

/**
 * One of the three maps below, read by a reason code — and undefined when this
 * build has no sentence for that code.
 *
 * `Object.hasOwn` rather than `MAP[reason]` (#474). A reason is a string off an
 * HTTP reply, and every member of `Object.prototype` answers a plain bracket
 * read with an inherited value that is neither nullish nor falsy: a reply
 * saying `"toString"` would pass the `&&` guard and put a FUNCTION on screen
 * where a sentence belongs. Asking whether the map has a ROW is the question
 * all three callers were already trying to ask, so no known code moves.
 */
function sentenceFor(map: Record<string, string>, reason: string | undefined): string | undefined {
  return reason && Object.hasOwn(map, reason) ? map[reason] : undefined;
}

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
  const mapped = sentenceFor(COMMAND_REASONS, out?.reason);
  if (mapped) return mapped;
  // A reason this build has no sentence for still names the thing that
  // happened, which is more than the subprocess's last line ever did.
  return out?.reason || fallback;
}

/** What the child actually printed. For a title attribute, never for the box. */
export function commandOutput(out: CommandFailure): string {
  return (out?.output || out?.detail || out?.error || "").trim();
}

/**
 * A failed ccusage run, as /api/ccusage answers it: the reason the run ended,
 * and under `error` whatever the thing that failed wrote down.
 *
 * `stage` and `install` are the two the route used to keep to itself. ccusage
 * has three paths — a copy the user provided, the managed install under
 * ~/.agents-deck/ccusage, and the `npx -y ccusage@latest` fallback taken when
 * that install is missing AND could not be created — and `error` is only ever
 * the LAST one's output. Which path that was, and what the install said on its
 * way out, were nowhere in the response at all: they were guessed at from the
 * shape of the stack trace, and that guess is what shipped two wrong diagnoses
 * in a row (#432, #450) while the install's own words sat on a terminal row the
 * deck had already repainted.
 *
 * `bin` arrived with the third path (#433). A stage of "path" says the user's
 * own copy failed and stops there, and on a machine that has an override, a
 * PATH entry and a managed install, "which copy" is precisely the thing the
 * reader cannot work out for themselves.
 *
 * All three are optional because an older deck does not send them, and because
 * nothing has a stage until something has run.
 */
export type CcusageFailure = (CommandFailure & {
  /** Which path produced `error`: "managed", "path" or "npx". */
  stage?: string;
  /** The managed install's own account of why it is not there, one line. */
  install?: string;
  /** The file that ran, when it was one the deck did not install. */
  bin?: string;
}) | null;

// ccusage is not claude-swap and none of the codes above fit it. It is a package
// the deck installs into ~/.agents-deck and then runs, so its refusals are about
// installability and runnability: installs forbidden by AGENTS_DECK_NO_INSTALL,
// the 90s deadline, output that is not usage data, a run that exited on its own.
// The route collapsed all four into `error`, so the modal showed whatever
// `err.message` happened to be — "spawn npx ENOENT" as the entire account of a
// stats panel with nothing in it.
export const CCUSAGE_REASONS: Record<string, string> = {
  // The second half of this was a dead end until #433: the deck refused to
  // install and then never looked for the copy it had just told the reader to
  // install, so AGENTS_DECK_NO_INSTALL=1 had no working configuration at all.
  // It looks on PATH now, which is what lets the sentence stay.
  no_install: "ccusage is not installed, and AGENTS_DECK_NO_INSTALL=1 forbids fetching it — unset that variable and restart the deck, or install ccusage yourself so it is on this deck's PATH",
  // An AGENTS_DECK_CCUSAGE that names nothing. Its own sentence rather than a
  // fall-through, because falling through would report "npx is not on this
  // deck's PATH" to somebody who never asked the deck to use npx — true, and
  // about a completely different thing than the setting they got wrong. The
  // server puts the path in `error`, which is where a value from the user's own
  // environment belongs.
  bad_override: "AGENTS_DECK_CCUSAGE names a file that is not there — correct it to the full path of your ccusage, or unset it to let the deck find its own",
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
//
// The second clause — "or put ccusage on PATH yourself" — was a lie until #433.
// Nothing in the deck had ever looked at PATH for ccusage: getRunner knew the
// managed install and npx and nothing else, so a reader who did exactly what
// this told them, and could prove it with `ccusage --version` in their own
// shell, got this identical box on the next click. The words are kept because
// the deck now does what they say — userCcusage in ccusage.mjs — and because
// this is the machine that most needs the escape route: no npx means no
// fallback, and a fresh install cannot be fetched either.
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
// This sentence has now been wrong twice, and both times for naming a cause on
// the user's machine that was never there.
//
// #432 read the shape as "the machine's npm is damaged" and told a Windows user
// to reinstall Node. Their npm demonstrably worked: they had started the deck
// with `npx ccdeck` moments earlier, and `npm i -g ccdeck` installed twelve
// packages cleanly on the same machine.
//
// #450 then removed the verdict but kept a diagnostic — run `where npx` and
// `npm config get prefix`, and if npx works there, start from a global install
// — built on the theory that the deck had reached the WRONG npx off an
// npx-extended PATH. The same user ran it: `where npx` printed
// `C:\Program Files\nodejs\npx.cmd` and the prefix was the stock
// `%APPDATA%\npm`. Nothing was wrong with either.
//
// #456 is what it actually was, and it is ours. The deck asked cmd.exe for a
// BARE `npx.cmd`, so the shim's `%~dp0` — where it looks for npx-cli.js — came
// out as the deck's working directory instead of its own:
//
//     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npx-cli.js'
//
// `C:\Users\vceban` is where the deck was started from. The deck now hands
// cmd.exe the shim's full path (see shimPath in exec.mjs), so this sentence has
// nothing left to ask the user to check — the remedy is a newer deck. It is
// kept, rather than deleted, because a browser can be newer than the deck it is
// talking to, and that is exactly the deck this shape now means.
const NPX_UNLOADABLE =
  "ccusage could not be started — the deck launched npx and Node could not load the npm script it points at. An older deck asked cmd.exe for a bare npx.cmd, which made the shim look for that script under the deck's working directory instead of beside itself; update the deck and reopen this modal";

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

/** The managed install, named without a path. The directory is the server's to
 *  spell — it is already in the `install` line below, resolved against the real
 *  home rather than a `~` nobody can paste — and display-name.test.ts holds the
 *  client to naming no on-disk product directory of its own. */
const MANAGED = `the copy of ccusage ${PRODUCT} installed for itself`;

/** The install's own line, made safe for a sentence: one line, and short enough
 *  that the remedy after it is still on screen. The whole of it is in the
 *  deck's terminal output, which is where a dump belongs. */
function installLine(out: CcusageFailure): string {
  const said = String(out?.install ?? "").replace(/\s+/g, " ").trim();
  return said.length > 240 ? `${said.slice(0, 239)}…` : said;
}

/**
 * The one sentence to show for a failed ccusage run — never the raw output.
 *
 * Two jobs, in this order. `rankCcusageFailure` below picks the remedy, exactly
 * as it always has and from the text alone; this wrapper then says WHICH of
 * ccusage's two paths the remedy is about, because the reader cannot tell and
 * neither could we. Three rounds of this bug were spent diagnosing the npx
 * fallback's stderr while the managed install failed first and silently, and
 * the only place that fact ever appeared was a hover title — if it appeared at
 * all, which it did not, because the install's output was thrown away.
 *
 * A reply with no `stage` is answered exactly as before, byte for byte: that is
 * an older deck, or a caller building the object by hand, and neither has an
 * answer to give.
 */
export function explainCcusageFailure(out: CcusageFailure, fallback: string): string {
  const said = rankCcusageFailure(out, fallback);
  const install = installLine(out);
  switch (out?.stage) {
    case "npx":
      // The reported shape, and the one that cost three rounds. The install
      // goes FIRST because it failed first and because it is the half nobody
      // has been able to see; the fallback's remedy follows, still whole.
      return install
        ? `ccusage failed on both of its paths. The managed install failed first — ${install} — and the deck then fell back to npx, where ${lowerFirst(said)}`
        : `there is no managed copy of ccusage on this machine, and the npx fallback failed: ${lowerFirst(said)}`;
    case "managed":
      return `${MANAGED} failed to run: ${lowerFirst(said)}`;
    case "path":
      // The copy the reader provided, and the one sentence where naming the
      // file is not a detail. This path is reached because the deck FOUND
      // something — on PATH, or at AGENTS_DECK_CCUSAGE — so "your ccusage
      // failed" without saying which file leaves them checking the wrong one,
      // and a stale global copy shadowing a good one is the likeliest way to
      // land here at all.
      return out.bin
        ? `the ccusage this deck found at ${out.bin} failed to run: ${lowerFirst(said)}`
        : `the ccusage this deck found on your PATH failed to run: ${lowerFirst(said)}`;
    default:
      // Including a stage this build has no wording for — a newer deck must not
      // cost the reader the sentence that is already correct.
      return said;
  }
}

/** Joining two sentences into one: the second stops being a sentence. Only the
 *  first character, and only when it is not part of a name the reader needs —
 *  `ccusage`, `npx` and `npm` are all already lower case, so this is a no-op
 *  for every sentence in the maps above except by accident. */
const lowerFirst = (s: string): string =>
  (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * The remedy, from the text and the reason code alone. Same ranking as
 * explainCommandFailure: the map speaks, and `error` stays evidence the modal
 * hangs on the status line's title.
 */
function rankCcusageFailure(out: CcusageFailure, fallback: string): string {
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
  const mapped = sentenceFor(CCUSAGE_REASONS, out?.reason);
  if (mapped) return mapped;
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
  const mapped = sentenceFor(REASONS, out?.reason);
  if (mapped) return mapped;
  // A crash in the handler sends `error` with no reason at all. Without this it
  // reached the user as the generic fallback, indistinguishable from a refusal,
  // and that is how a broken import spent a release looking like a rejected one.
  if (out?.error) return out.error;
  // A reason this build has no sentence for still names the thing that happened.
  return out?.reason || fallback;
}
