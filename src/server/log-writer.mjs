// Which of the running decks writes an event to the log they share?
//
// The hook already answers that for the events it delivers: it groups the decks
// it is about to post to by the log file each one names in its discovery record,
// elects one per file, and marks the request to every other one `?persist=0`.
// See electWriters in hook/hook.js.
//
// The Codex rollout watcher never goes through the hook — it builds its events
// inside the server by tailing ~/.codex/sessions/**/rollout-*.jsonl — so nothing
// suppressed the copies on that path: every deck tailing the same rollout
// appended its own line to the one events.jsonl they all default to, so each
// Codex tool call, prompt and session start landed there once per running deck.
// That is the duplication the hook election was added to end, still open on the
// path that is the only Codex capture there is on Windows, where Codex hooks
// never fire at all.
//
// So the server runs the same election, over the same discovery records, with
// the same tie-break. The rule is repeated here rather than imported from
// hook/hook.js because that file is copied out of the package and run standalone
// by the host CLI, with no path back to the module it came from — the same
// reason it re-derives the Claude config dir inline. The two copies are pinned
// equal by a test, as challengeProof's pair already is.
import { win32, posix } from "node:path";

/**
 * Does this platform's filesystem treat two spellings that differ only in case
 * as the same file? The platform is a parameter so both answers can be checked
 * from either kind of machine.
 *
 * Windows always does, and macOS does by default (APFS and HFS+ are formatted
 * case-insensitive unless the user deliberately chose otherwise). Linux does
 * not, and folding case there would be a bug of its own: /srv/a/events.jsonl and
 * /srv/A/events.jsonl are two real files, each of which needs a writer.
 */
export const foldsCase = (platform = process.platform) =>
  platform === "win32" || platform === "darwin";

/**
 * Of these decks, which ones write to disk? Returns the subset that should;
 * every other one is expected to draw the event and keep no record of it.
 *
 * Decks are grouped by the log file each one names in its discovery record and
 * one deck per group is elected. Grouping by the file rather than counting decks
 * is what keeps the overrides honest: a deck run with `--history` sits alone in
 * its own group and always writes, a deck run with `--no-persist` reports no
 * file and can never be elected to write for one that does, and a deck too old
 * to report either keeps the behaviour it had before this rule existed. Within a
 * group the lowest port wins — a fixed rule, so the same deck holds the file for
 * as long as it is up and the next one inherits it as soon as that deck is gone.
 *
 * Kept byte-for-byte equivalent to electWriters in hook/hook.js: the two decide
 * for the same decks over the same records, and a disagreement between them
 * means one log line written twice or none at all.
 */
export function electWriters(decks, platform = process.platform) {
  const byLog = new Map();
  for (const d of decks) {
    const log = typeof d.persist === "string" ? d.persist : "";
    // Two namespaces, so a deck with no log to share — and a deck too old to
    // report one — is alone in its group and cannot collide with a real path.
    const key = log
      ? `log:${foldsCase(platform) ? log.toLowerCase() : log}`
      : `deck:${d.pid}:${d.port}`;
    const held = byLog.get(key);
    // Ports are unique among live decks; pid only breaks a tie a stale
    // discovery file could invent, so the answer stays deterministic.
    if (!held || d.port < held.port || (d.port === held.port && d.pid < held.pid)) {
      byLog.set(key, d);
    }
  }
  return new Set(byLog.values());
}

/**
 * Would a deck scoped to `workspace` capture a rollout running in `cwd`? An
 * empty workspace is unscoped and captures every session; a rollout that never
 * said where it runs is inside no workspace, so only an unscoped deck draws it.
 *
 * This answers two questions with one function — whether THIS deck tails a
 * rollout, and whether another deck tails it too — and that is only sound while
 * the rule below is the rule every deck actually runs. Model another deck's
 * capture with anything else and the election covers the wrong set: a deck that
 * writes without being elected, or an elected deck that never opened the file.
 *
 * It is also the rule hook/hook.js runs for the sessions it delivers, under the
 * name capturesSession — that script is copied out of the package and run
 * standalone, so the two are written twice and pinned equal by a test walking
 * one table of paths through both. They were not equal: case was folded here on
 * every platform, so on Linux a deck scoped to /srv/proj captured Codex sessions
 * from /srv/Proj and Claude sessions from neither. Those are two real
 * directories there, and the hook's own comment says what folding them together
 * costs — a deck handed the events of a tree it was not scoped to. So the fold
 * is per-platform on both sides now, and `--workspace` means one thing.
 *
 * (The narrow window that opens: two decks on Linux whose workspaces differ only
 * in case, one of them old enough to still fold, both containing one rollout's
 * cwd. Each models the other as tailing the file; one of them is wrong, and the
 * cost is a single log line written twice.)
 *
 * The platform is a parameter, following the hook's cwdInWorkspace and
 * spawnSpec in src/server/exec.mjs, so the Windows separator is testable from a
 * POSIX machine.
 */
export function codexCwdInWorkspace(cwd, workspace, platform = process.platform) {
  if (!workspace || typeof workspace !== "string") return true;
  if (!cwd || typeof cwd !== "string") return false;
  const p = platform === "win32" ? win32 : posix;
  const fold = s => (foldsCase(platform) ? s.toLowerCase() : s);
  const a = fold(p.resolve(cwd));
  const b = fold(p.resolve(workspace));
  if (a === b) return true;
  // A root ("C:\", "/") already ends in the separator; appending a second one
  // would match nothing.
  return a.startsWith(b.endsWith(p.sep) ? b : b + p.sep);
}

/**
 * Does this deck append a rollout's events to its log, or is another deck doing
 * it? `decks` is every deck registered right now, `pid` identifies this one
 * among them, and `cwd` is the workspace the rollout is running in.
 *
 * The group is every deck that tails this same rollout: each deck decides for
 * itself, so all of them whose workspace contains the cwd read the file and all
 * of them would write it. The hook builds the same group the same way for the
 * events it delivers — it used to narrow them to the longest workspace match
 * first, which is the asymmetry the predicate above describes the end of. A deck
 * started with `--no-codex` tails nothing and is left out; electing it would
 * mean the rollout's events reach no log at all. A deck too old to say either
 * way is assumed to be tailing, which is what it was doing before this field
 * existed.
 */
export function writesCodexLog({ decks, pid, cwd, platform = process.platform }) {
  const live = Array.isArray(decks) ? decks : [];
  const self = live.find(d => d && d.pid === pid) ?? null;
  // No record of our own on disk — the window before the first heartbeat writes
  // it, or a deck that cannot write one at all. Nobody can elect us and we
  // cannot see who else is here, so keep what this deck did before the election
  // existed and write. A line written twice is recoverable; a deck that quietly
  // stops recording anything is not.
  if (!self || typeof self.persist !== "string" || self.persist === "") return true;

  const group = [self];
  for (const d of live) {
    if (!d || d.pid === self.pid) continue;
    if (d.codex === false) continue;
    if (!codexCwdInWorkspace(cwd, d.workspace ?? "", platform)) continue;
    group.push(d);
  }
  return electWriters(group, platform).has(self);
}
