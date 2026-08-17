// Where OpenAI Codex lives on this machine: its home directory, its rollout
// tree, and the walk over that tree — the Codex-side mirror of claude-dir.mjs.
//
// CODEX_HOME relocates ~/.codex wholesale, exactly as CLAUDE_CONFIG_DIR does on
// the Claude side, and five modules used to answer the question for themselves
// in three different spellings (#375):
//
//   index.mjs        CODEX_HOME ? resolve(CODEX_HOME) : join(homedir(), ".codex")
//   installer.mjs    the same
//   codex-usage.mjs  CODEX_HOME ? CODEX_HOME         : join(homedir(), ".codex")
//   codex-auth.mjs   CODEX_HOME ?? join(homedir(), ".codex")
//   codex-quota.mjs  the same
//
// The three spellings disagree on two inputs that a shell profile produces by
// accident rather than by intent, and both disagreements are silent:
//
//   CODEX_HOME=""    — what `export CODEX_HOME=$SOME_UNSET_VAR` leaves behind.
//     `??` only falls back on null and undefined, so the two modules spelled
//     that way kept the empty string and then joined onto it: join("",
//     "auth.json") is "auth.json", a CWD-RELATIVE path. codex-auth.mjs is the
//     module that writes the rotated OpenAI refresh token back to disk, and
//     OpenAI rotates that token single-use — so writing it to whatever
//     directory the deck happened to be started from does not merely lose a
//     read, it burns the credential and costs the user a `codex login`.
//
//   CODEX_HOME=./relative — kept verbatim by three of the five, so the tree
//     they read was resolved against the CWD at the moment of each readdir()
//     rather than once at startup. Two modules therefore read a different
//     directory than the other three whenever the deck was started from
//     anywhere but the parent of that relative path.
//
// This module is the single answer to all of it, and every reader now imports
// it. The rule is the `resolve()` + truthiness form index.mjs and installer.mjs
// already used, because it is the one the installer writes against and the one
// that treats an empty value as "not set" — see codexHome() for why that is the
// right way round rather than merely the majority.
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix as posixPath, win32 as winPath } from "node:path";

/**
 * Absolute path of the Codex home directory: $CODEX_HOME or ~/.codex.
 *
 * WHY AN EMPTY VALUE FALLS BACK. An empty environment variable is not a path.
 * It is what a shell leaves behind when the variable it was assigned from does
 * not exist, and treating it as "the current directory" turns a typo in a
 * profile into a deck that reads and WRITES Codex state in whatever directory
 * it was launched from. Falling back to ~/.codex is the only reading that can
 * be right by accident; there is no user who means "put my Codex credentials in
 * $PWD" and spells it by leaving the variable empty.
 *
 * WHY IT IS TRIMMED. Same argument one step further: `CODEX_HOME=" "` is the
 * same accident with a stray space in the profile line, and claudeConfigDir()
 * has trimmed for exactly this reason since it was written. Trimming only ever
 * removes leading and trailing whitespace, so a real path that CONTAINS spaces
 * — `/Users/me/Library/Application Support/codex` — is untouched, which is the
 * case worth protecting on macOS and Windows both.
 *
 * WHY resolve() AND NOT realpath(). resolve() makes a relative value absolute
 * once, here, instead of leaving every later readdir() to resolve it against
 * whatever the CWD is by then. It deliberately does NOT follow symlinks:
 * ~/.codex is often a link into a dotfiles repo or an encrypted volume, and
 * canonicalising it would (a) require the directory to already exist, which it
 * does not before the first `codex login`, and (b) make the deck rename over
 * the link's target instead of through the link — the very thing codex-auth.mjs
 * resolves symlinks at WRITE time to avoid. A symlinked CODEX_HOME therefore
 * stays spelled the way the user spelled it, on purpose.
 *
 * The environment, home directory and platform are parameters purely so this
 * rule can be checked for a machine the author is not sitting at: the Windows
 * answer — drive letters, backslashes, a trailing `\` — is only ever verifiable
 * from a POSIX box if the path flavour follows the argument rather than the
 * host, the same trick exec.mjs and claudeCliCandidates() already use. Every
 * caller in the deck passes nothing and gets the real machine's answer.
 */
export function codexHome(env = process.env, home = homedir(), platform = process.platform) {
  // The path flavour follows the PLATFORM ARGUMENT, not the host, so that a
  // Windows value is normalised by Windows rules even when the check runs on a
  // Mac. On a real machine `platform` is `process.platform`, which makes this
  // the same `join`/`resolve` the module would have imported anyway.
  const path = platform === "win32" ? winPath : posixPath;
  const override = env.CODEX_HOME?.trim();
  return override ? path.resolve(override) : path.join(home, ".codex");
}

/**
 * Absolute path of the rollout tree: $CODEX_HOME/sessions.
 *
 * Codex writes one append-only JSONL file per session under
 * sessions/YYYY/MM/DD/, and this directory is the root of every walk below. It
 * lives here rather than being spelled `join(CODEX_HOME, "sessions")` at each
 * of the three walkers, because that spelling was already duplicated verbatim
 * in index.mjs and codex-usage.mjs and had no owner to drift away from.
 */
export function codexSessionsDir(env = process.env, home = homedir(), platform = process.platform) {
  const path = platform === "win32" ? winPath : posixPath;
  return path.join(codexHome(env, home, platform), "sessions");
}

/**
 * The answers for THIS process, resolved once at load.
 *
 * Every consumer imports these constants rather than calling the functions,
 * which is what makes it impossible for two modules to disagree: there is now a
 * single evaluation in the whole process instead of one per importing module.
 * The functions above stay exported because the constants cannot be re-derived
 * for a hypothetical environment, and the rule they encode is the thing worth
 * pinning against every shape a CODEX_HOME can take.
 */
export const CODEX_HOME = codexHome();
export const CODEX_SESSIONS_DIR = codexSessionsDir();

/**
 * Returned from a walkRolloutDays visitor to end the walk immediately.
 *
 * A symbol rather than `true` because two of the three callers build their
 * result by pushing into an array inside the visitor, and `Array.prototype.push`
 * returns a number — a truthy-return protocol would have made "I collected two
 * files" indistinguishable from "stop now".
 */
export const STOP = Symbol("stop-rollout-walk");

/**
 * Walk $CODEX_HOME/sessions/YYYY/MM/DD newest-first, handing each day directory
 * and the names inside it to `onDay(dir, files)`.
 *
 * Three callers walked this tree with the same four nested readdir-and-continue
 * blocks and differed only in the last few lines: find the file carrying a given
 * session id (index.mjs), collect everything in the newest two day directories
 * (index.mjs again, for the watcher), and collect everything whose filename
 * timestamp falls inside a rolling window (codex-usage.mjs). The walk is the
 * part that has to agree — a deck that tails one set of files and reports usage
 * from another is reporting on a session it is not showing.
 *
 * EVERY LEVEL SWALLOWS ITS OWN ERROR, which is deliberate rather than lazy. The
 * tree is written by another process while this one reads it: a day directory
 * can be created between the listing of its month and the listing of itself, a
 * year directory can be a broken symlink on a restored backup, and none of that
 * is a reason to stop reading the other 364 days. A missing sessions/ directory
 * is not an error at all — it is simply a machine where Codex has not run yet.
 *
 * `onYear` exists for the one caller that can rule out a whole year without
 * opening it. Years arrive newest-first, so returning STOP from it ends the
 * walk rather than skipping a year, which is what the caller wants: once the
 * years are older than the window, so is everything after them.
 */
export async function walkRolloutDays(onDay, { sessionsDir = CODEX_SESSIONS_DIR, onYear = null } = {}) {
  let years;
  // Only four-digit names are Codex's own. The filter also keeps a stray
  // `.DS_Store` or a `latest` symlink from costing a readdir that would fail.
  try { years = (await readdir(sessionsDir)).filter(d => /^\d{4}$/.test(d)).sort().reverse(); }
  catch { return; }
  for (const year of years) {
    if (onYear && (await onYear(year)) === STOP) return;
    let months;
    try { months = (await readdir(join(sessionsDir, year))).sort().reverse(); }
    catch { continue; }
    for (const month of months) {
      let days;
      try { days = (await readdir(join(sessionsDir, year, month))).sort().reverse(); }
      catch { continue; }
      for (const day of days) {
        const dir = join(sessionsDir, year, month, day);
        let files;
        try { files = await readdir(dir); }
        catch { continue; }
        if ((await onDay(dir, files)) === STOP) return;
      }
    }
  }
}
