// Which of the three published commands the user typed — and nothing else.
//
// The deck is on npm three times over: `agents-deck` (what this repo publishes),
// `agent-dag` (the same tarball under the name it shipped as first) and
// `ccdeck` (a stub that depends on agents-deck and spawns its bin). Every
// surface a human reads says ccdeck now, and 95% of the downloads are still on
// the other two, so nothing closes that split on its own. This file is the
// evidence behind saying so — once in the terminal, once in the browser.
//
// Two rules make that safe, and they are the whole of the file.
//
// It is never a refusal. A build that declined to boot under an old name would
// take the self-update path down with it: a user on `agents-deck` clicks
// "Update & restart", the copy that arrives refuses to run, and the deck is
// dead on the one machine where the deck was the thing that would have
// explained why.
//
// And it is never asked of the PACKAGE. `ccdeck/package.json` depends on
// `agents-deck`, and `ccdeck/bin/ccdeck.js` spawns
// `../../agents-deck/bin/agent-dag.js` — so "is this build agents-deck?" is
// true inside every ccdeck run, and a notice keyed on it would scold exactly
// the people who did what we asked. The question is which name the USER TYPED.
// That is a different question, with a different answer, and on one platform
// with no answer at all:
//
//   npx, everywhere — npm writes the literal spec into
//     `_npx/<hash>/package.json` as `_npx.packages`, which npxRestartSpec
//     already reads to decide what a restart re-runs. Reused rather than
//     re-derived; the only difference here is that this caller has no fallback
//     to offer, since a guess is the one answer it must not give.
//
//   a global install on macOS or Linux — npm links <prefix>/bin/<name> at the
//     package's bin/agent-dag.js, and node does not resolve that symlink for
//     argv[1]. All three names reach one file and only argv[1] tells them
//     apart, so its last segment is the command that was typed. Verified with
//     npm's own layout: a symlink named `ccdeck` gives argv[1] `…/bin/ccdeck`.
//
//   a global install on Windows — nowhere. npm writes <name>.cmd, <name>.ps1
//     and an extensionless sh shim, each of which runs
//     `node "…\node_modules\agents-deck\bin\agent-dag.js" %*` (npm's cmd-shim).
//     The typed name is the shim's FILENAME and never becomes an argument, and
//     there is no other carrier — npm_config_user_agent and friends are not set
//     for a direct bin invocation. So Windows answers null.
//
//   a git checkout — nothing was typed. `node bin/agent-dag.js` is not any of
//     the three names.
//
// Which leaves the callers one rule: positive identification, or silence. A
// notice shown to somebody who already types `ccdeck` is worse than a notice
// missed, because it is the failure that teaches everyone to ignore the next
// one.
import { bareSpecName, isNpxInstall, npxRestartSpec } from "./self-update.mjs";

/** The command every surface promotes. Deliberately not brand.mjs's PRODUCT:
 *  that is the name a human reads, this is an npm bin name the user types, and
 *  the two are the same string only because the rename made them so —
 *  invoked-as.test.ts pins them against each other rather than assuming it. */
export const PREFERRED = "ccdeck";

/** Every command an install of this package provides, which is every name that
 *  can be typed. package.json's `bin` block is the other half of this list. */
export const COMMANDS = [PREFERRED, "agents-deck", "agent-dag"];

/** `value` when it is one of those three, and null for everything else — a shim
 *  filename with an extension on it, a path, a spec that resolved to some other
 *  package, an environment variable somebody set by hand. None of those are
 *  evidence of anything, and this function is the only place that decides so. */
export function knownCommand(value) {
  return typeof value === "string" && COMMANDS.includes(value) ? value : null;
}

/** The last segment of a path, split on both separators rather than `path.sep`
 *  — the same reason isNpxInstall gives: a Windows path can reach a POSIX
 *  process through a test or a config file, and a separator-agnostic split is
 *  what keeps this one function on all three platforms. */
function lastSegment(path) {
  if (typeof path !== "string") return null;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * The name the user typed, when we can prove it. Null means unknown, and
 * unknown must never produce a notice.
 */
export function invokedAs({ pkgRoot, argv1, platform = process.platform } = {}) {
  // npx first, and alone: under npx argv[1] is a path inside the cache
  // directory, so the metadata is not the better answer, it is the only one.
  // The explicit null fallback is the point of the call — npxRestartSpec's
  // default is the package name, which is right for "what do I re-run" and
  // would be a guess wearing an answer's clothes here.
  if (isNpxInstall(pkgRoot)) return knownCommand(bareSpecName(npxRestartSpec(pkgRoot, null)));
  // See the header: on Windows the shim eats the name. Decided on the platform
  // rather than left to the extension check below, so that a Windows path that
  // somehow did end in a bare name still cannot become a guess.
  if (platform === "win32") return null;
  return knownCommand(lastSegment(argv1));
}

/**
 * The same question, answered for the process that is asking it.
 *
 * bin/deck.js — and the server running inside it — is spawned BY the
 * supervisor, so its own argv[1] is `…/bin/deck.js` every single time: the
 * typed name reached bin/agent-dag.js and stopped there. The supervisor answers
 * once and passes the answer down in AGENTS_DECK_INVOKED_AS, which is read back
 * through knownCommand rather than trusted, since an environment variable is
 * user input like any other. The fall-through still answers the npx half for a
 * worker started with no supervisor above it.
 */
export function invokedName({
  env = process.env, pkgRoot, argv1 = process.argv[1], platform = process.platform,
} = {}) {
  return knownCommand(env?.AGENTS_DECK_INVOKED_AS) ?? invokedAs({ pkgRoot, argv1, platform });
}

/**
 * What the terminal says about it, or null when there is nothing to say.
 *
 * Two lines, because the second one is where the value is. Someone who ran
 * `npm i -g agents-deck` has nothing to install and nothing to download — the
 * same install already put a `ccdeck` on their PATH, and all they have to do is
 * type it. Handing them an install command instead would be work we invented.
 * Under npx there is no such install, so the fix there is the command itself.
 *
 * `dash` comes from the caller's glyph tier: an em dash is as absent from a
 * legacy Windows console as a check mark is, and this file must not be the one
 * place that forgets it.
 */
export function renameNotice({ invoked, pkgRoot, dash = "—", preferred = PREFERRED } = {}) {
  const name = knownCommand(invoked);
  if (!name || name === preferred) return null;
  return {
    // Leads with the reassurance on purpose. Nothing is breaking here, no
    // command is being taken away, and a line that opened with the rename would
    // read as one that was.
    said: `${name} still works ${dash} the deck is called ${preferred} now`,
    fix: isNpxInstall(pkgRoot)
      ? `next time: npx ${preferred}`
      : `${preferred} already works here ${dash} same install, no download`,
  };
}
