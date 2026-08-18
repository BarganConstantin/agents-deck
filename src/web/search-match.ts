// What the /-search is allowed to find, and why the list is exactly this long.
//
// #418: a card on the canvas reads `GPT-5.3 Codex`, the user types `codex`, and
// the board answers "No agents match “codex”". The matcher walked label, cwd,
// cwd basename, session id, first prompt and tool names — six fields, none of
// which is the model, and none of which is the provider. So the one filter a
// mixed-CLI canvas most obviously wants ("show me the Codex ones") was the one
// filter that could not be expressed, and the deck was refusing to find a string
// it had just drawn on screen.
//
// The issue's title says provider and model are "the two things the node card
// shows as a chip". Only half of that is true, and the half that is false is the
// interesting half: the card renders ONE chip, `shortModel(data.model)`, and
// `provider` is rendered nowhere at all — codex-approval.ts:59 says so in as many
// words ("`provider` is stamped on the node and rendered nowhere"). That changes
// what each of the two fields has to do here.
//
// THE MODEL IS MATCHED TWICE, on the id and on the chip's own label, because
// they are different strings and the user can reasonably type either. The id is
// `claude-opus-4-7-20250101`; the chip says `Opus 4.7`. Substring-matching the id
// alone finds `opus` and `claude` and misses `opus 4.7` — the space and the dot
// exist only in the label, and the label is the thing the user is looking at
// while they type. Matching the label alone would lose `claude-` and `-codex`
// and the release date, which are what someone pasting an id from a config file
// has in their clipboard. Neither string is a superset of the other, so both are
// indexed, and the label comes from the SAME `shortModel` the chip calls rather
// than a second abbreviator — a private copy here would drift from the card the
// first time a model family is added, and then the search would be unable to
// find a chip that renders perfectly (this is the failure ambient-counts.ts was
// written to stop, one surface further out). Sharing the labeller is also what
// makes the label side of the index a real filter: until #462 it abbreviated
// `gpt-5.4-nano` and `gpt-5.4-pro` to the same "GPT-5.4", so a user who typed
// the words off one card got back both models and neither card explained the
// other. The helper moved to ./model-label in that fix, which is what the note
// left here asked for — a pure rule should not be importing a React component
// to reach one string function.
//
// THE PROVIDER IS MATCHED BY PREFIX, and it is the only field here that is not a
// substring match. Two reasons, both consequences of it being invisible:
//
//   * It is a closed vocabulary of two words. Every other searchable field holds
//     a value that differs per agent, so a sloppy substring hit still narrows
//     the board — a `de` that happens to hit one session id is a filter with a
//     bad result, not the absence of a filter. `provider` has exactly two values
//     across every card on screen, so a substring hit on it matches EVERY agent
//     of that provider at once: under substring rules the letters c, l, a, u, d,
//     e, o and x each match the whole canvas, and so do `de`, `ex`, `od` and
//     `lau`. That does not degrade the filter, it deletes it, and it deletes the
//     count in the corner along with it.
//
//   * Nothing on the card explains the hit. A user who types `ex` looking for a
//     workspace and gets back every Codex session is looking at a set of cards
//     with no `ex` anywhere on them. A search that keeps rows for reasons the
//     screen cannot show is worse than one that keeps too few.
//
//   Prefix keeps everything anyone actually types, because incremental typing IS
//   a prefix: c, co, cod, code, codex all match, and `c` matching both providers
//   is honest — at one letter the query genuinely does not distinguish them. It
//   is not a query language: the user types a word, not an operator.
//
// No synonym table. `codex` and `claude` are the two spellings, and they are the
// two values — the CLIs' own names for themselves, which is what a user calls
// them too. `gpt`, `opus`, `sonnet` and `haiku` are model queries and land on the
// model id and the chip label above; they are deliberately NOT aliased onto a
// provider, so `gpt` finds the sessions whose model really is a GPT rather than
// every Codex session including the ones running something else.
//
// CASE FOLDING is `toLowerCase`, which is the Unicode default case conversion and
// locale-INDEPENDENT — the same answer on Linux, macOS and Windows, and under
// every host locale. `toLocaleLowerCase` was not used and must not be: in tr-TR
// and az it folds `I` to dotless `ı`, so a user in Istanbul typing `api` would
// stop matching their own `~/Projects/API` while the identical deck two desks
// over still matched it. The values being searched are ASCII identifiers minted
// by the two CLIs, not text in the user's language, so there is no locale in
// which a locale-sensitive fold is the more correct one.
//
// Pure, and living here rather than inside App.tsx, for the reason
// ambient-counts.ts, canvas-keys.ts and codex-approval.ts each moved a rule out:
// the suite runs in bare node with no DOM and cannot render a React tree, so a
// rule buried in a 3,000-line component can only ever be tested by regex over
// its own source text — which passes on any comment containing the right words
// and fails on any rephrasing of the right code.
import { shortModel } from "./model-label";
import type { AgentNodeData } from "./types";

/**
 * The field's own promise about what it searches.
 *
 * It lives beside the matcher because it is a claim ABOUT the matcher, and the
 * two went out of sync the moment the fields grew: the old wording was "Search
 * agents, cwd, tools…" while the function underneath also read session ids and
 * first prompts, and after #418 also reads the model and the provider.
 *
 * `cwd` left the sentence to make room for `model` rather than because it
 * stopped working. The field is 220px wide and a placeholder is clipped, not
 * ellipsised, when it overruns; and of the two, `cwd` is the one already implied
 * — a root agent's label IS its workspace basename (see types.ts), so "agents"
 * already promises the cwd match anybody would think to try. What the sentence
 * could not afford to keep implying was that the model chip is not searchable,
 * which is the whole of what #418 reported.
 */
export const SEARCH_PLACEHOLDER = "Search agents, tools, model…";

/**
 * Does this agent survive the current query?
 *
 * An empty query keeps everything — the search is off, not failing. Every field
 * is optional except the three the reducer always sets, and an agent that has
 * not reported a model yet (a synthetic node, or a session before its first
 * model-bearing event) simply does not answer a model query; it must never
 * throw, because the canvas re-runs this on every keystroke for every card.
 */
export function matchesQuery(a: AgentNodeData, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (a.label.toLowerCase().includes(needle)) return true;
  if (a.cwd?.toLowerCase().includes(needle)) return true;
  if (a.cwdBasename?.toLowerCase().includes(needle)) return true;
  if (a.sessionId.toLowerCase().includes(needle)) return true;
  if (a.firstPrompt?.toLowerCase().includes(needle)) return true;
  // Both spellings of the model: the raw id the tooltip carries, and the short
  // label the chip prints. See the header — neither contains the other.
  if (a.model) {
    if (a.model.toLowerCase().includes(needle)) return true;
    if (shortModel(a.model).toLowerCase().includes(needle)) return true;
  }
  // Prefix, not substring, and only for this field. See the header for why a
  // two-valued invisible field cannot be matched the way the others are.
  if (a.provider?.toLowerCase().startsWith(needle)) return true;
  for (const t of a.tools) if (t.name.toLowerCase().includes(needle)) return true;
  return false;
}
