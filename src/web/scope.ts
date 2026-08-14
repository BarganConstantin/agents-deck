// What the detail panel is allowed to say about why the canvas is empty.
//
// It used to say the deck "is in `--all` mode and listens to every workspace".
// Two things wrong with one sentence. `--all` is parsed in bin/deck.js and then
// never read — the comment there calls it a legacy no-op, because machine-wide
// has been the default for a long time — so the copy named a flag that does
// nothing. And it is simply false for anyone who started the deck with
// `--workspace <path>` or `--scope`, which really does restrict capture: the
// one piece of text that appears when nothing shows up told that user scope
// could not be the cause and sent them off to settings.json and their hooks.
//
// So the sentence is derived from the scope the server reports (GET
// /api/health, `workspace`) instead of asserted. Kept out of App.tsx so the
// three branches can be read and tested without React — and because the
// unknown branch is the one nobody exercises by hand: it is what an older deck,
// or a health request that has not landed yet, produces.

/** The empty-state sentence, split where a path has to be set in `<code>`. */
export interface EmptyScope {
  /** Which branch produced this, so the caller can tell them apart. */
  kind: "unknown" | "machine" | "scoped";
  /** Everything before the path. The whole sentence when there is no path. */
  lead: string;
  /** The tree this deck is restricted to, or null when it captures the lot. */
  workspace: string | null;
  /** Everything after the path. Empty when there is no path. */
  tail: string;
}

/**
 * @param workspace what /api/health reports: "" for a machine-wide deck, a path
 *   for a scoped one, and null while the answer is still missing — an older
 *   server that does not report it, or the first render before the fetch lands.
 */
export function emptyScope(workspace: string | null | undefined): EmptyScope {
  // Nothing known about the scope. Say only what holds in either case: a claim
  // about coverage is exactly what this branch cannot make.
  if (workspace == null) {
    return {
      kind: "unknown",
      lead: "No data yet. Start a Claude Code or Codex session — it appears here as soon as its first hook fires.",
      workspace: null,
      tail: "",
    };
  }
  const scoped = workspace.trim();
  if (scoped === "") {
    return {
      kind: "machine",
      lead: "No data yet. Start a Claude Code or Codex session anywhere on this machine — this deck is unscoped and captures every workspace.",
      workspace: null,
      tail: "",
    };
  }
  return {
    kind: "scoped",
    lead: "No data yet. This deck only captures sessions running under",
    workspace: scoped,
    tail: " — start one there, or restart it without --workspace/--scope to watch the whole machine.",
  };
}
