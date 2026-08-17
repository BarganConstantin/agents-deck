// Which CLIs this deck is watching, as the browser is allowed to believe it.
//
// The deck supports "Claude Code CLI or OpenAI Codex CLI (or both)", and the UI
// used to draw both sides on every machine because nothing ever told it which.
// A Codex-only machine got the accounts panel — Claude-only, backed entirely by
// claude-swap, with an empty state instructing a `claude auth login` against a
// CLI that is not installed. A Claude-only machine got the mirror: a Codex quota
// section permanently reading "Quota unavailable. / Run codex login to
// authenticate." One missing fact, two wrong panels (#402).
//
// GET /api/health answers it now, in `providers`. Kept out of App.tsx for the
// same reason emptyScope is: the interesting branch is the one nobody exercises
// by hand — an older deck, or the first render before the fetch lands — and it
// can be read and tested here without React.

export interface Providers {
  /**
   * Which branch produced this. "reported" means the server said; "assumed"
   * means it could not be asked — a deck older than this field, a health
   * request that has not landed yet, or one that failed.
   */
  kind: "reported" | "assumed";
  /** Show the accounts panel and everything else that is Claude Code's alone. */
  claude: boolean;
  /** Show the Codex quota section. */
  codex: boolean;
}

/** What to believe when the server has not said: both, which is what every deck
 *  before this field effectively reported, and what the UI has always drawn. */
export const ASSUMED: Providers = { kind: "assumed", claude: true, codex: true };

/**
 * Read `providers` out of a /api/health body.
 *
 * Every unknown answers `true`, and deliberately so: showing a panel for a CLI
 * that is not there is the bug this fixes, but hiding one for a CLI that IS
 * there is worse — the accounts panel is the only way to switch accounts, and a
 * user whose deck guessed wrong has no control anywhere to turn it back on. So
 * a missing object, a missing field, and a field of the wrong type all mean
 * "show it", and only an explicit `false` hides anything.
 *
 * @param health the parsed JSON body, or null when the request failed.
 */
export function readProviders(health: unknown): Providers {
  if (!health || typeof health !== "object") return ASSUMED;
  const raw = (health as { providers?: unknown }).providers;
  if (!raw || typeof raw !== "object") return ASSUMED;
  const p = raw as { claude?: unknown; codex?: unknown };
  // Each field is judged on its own: a server that learns to report one of them
  // before the other must not drag the field it does get right back to a guess.
  return {
    kind: "reported",
    claude: p.claude === false ? false : true,
    codex: p.codex === false ? false : true,
  };
}
