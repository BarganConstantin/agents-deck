// A model id becomes a label here, and nowhere else.
//
// #462: the GPT branch matched `gpt-<version>` and returned before it looked at
// anything that followed, so `gpt-5.4-nano` at $0.20/Mtok and `gpt-5.4-pro` at
// $30/Mtok both printed "GPT-5.4". pricing.ts holds an ordered row per variant
// and bills each of them correctly, which is what made this the bad kind of
// label bug rather than a cosmetic one: the usage-history modal could stack two
// rows a 150x price apart under one word, with the money right and the names
// identical, and a reader comparing them had no way to conclude anything except
// that the deck was wrong.
//
// The issue named three families. Sweeping every id pricing.ts prices, every id
// CODEX_CONTEXT_DEFAULTS sizes and every id this machine's own event log and
// Codex rollouts carry found ELEVEN labels standing for more than one model, and
// the widest price spread was not in any of the three: "GPT-5" covered
// `gpt-5-pro` ($15/$120 per Mtok) and `gpt-5-nano` ($0.05/$0.40), a 300x step
// under a single word. The corpus, and the eleven groups, are pinned in
// model-label-variants.test.ts so the next family added here is swept the same
// way rather than eyeballed.
//
// The label is load-bearing past the chip it was written for, which is why this
// is a fix to the function and not a `title` attribute over it:
//
//   * search-match.ts indexes the model TWICE, on the raw id and on this label,
//     because neither string contains the other (#418). Two models sharing a
//     label means a query for the words the user just read off a card returns
//     both of them, on a canvas where nothing explains the second hit.
//   * UsagePanel's by-model table is keyed by the raw id and prints this label
//     beside a dollar column — and, since #400, `not priced` beside the models
//     this build holds no rate for. The money was never wrong; two rows carrying
//     one name over two different figures is what was.
//
// WHY THIS IS ITS OWN MODULE. `shortModel` lived in AgentNode.tsx, and #418 left
// a note about it: search-match.ts is a pure rule with no DOM that was importing
// a `.tsx` component — dragging React, reactflow and ContextModal behind it —
// to reach one string function, and the note said the import should follow the
// helper if it were ever extracted. It is extracted now because this fix had to
// edit it and the suite that proves the fix should not have to render a card to
// call it. #374 ("nine duplicated helpers") still owns the wider consolidation:
// this moves ONE helper, the one #462 is about, and touches none of the other
// eight.

/** Family names and variant qualifiers are printed in one casing, whatever the
 *  id spells them in, so `GPT-5.3 Codex` and `GPT-5.3 Codex Spark` read as two
 *  members of one family rather than two unrelated strings. The issue proposed
 *  `GPT-5.4 nano` beside `GPT-5.4 Pro`; that mixed casing would have made the
 *  suffix look like part of the version in one label and a word in the other,
 *  and `Codex` — the one qualifier that already shipped — was capitalised. */
function titleWord(word: string): string {
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/** Render model ids into compact display labels:
 *    "claude-opus-4-7-20250101"            → "Opus 4.7"
 *    "claude-haiku-4-5"                    → "Haiku 4.5"
 *    "anthropic.claude-sonnet-4-5-…-v1:0"  → "Sonnet 4.5"
 *    "gpt-5.3-codex"                       → "GPT-5.3 Codex"
 *    "gpt-5.3-codex-spark"                 → "GPT-5.3 Codex Spark"
 *    "gpt-5.4-nano"                        → "GPT-5.4 Nano"
 *    "gpt-5"                               → "GPT-5"
 *    "o3-mini"                             → "o3-mini"
 *  Falls back to the raw id if the shape is unfamiliar so we never hide info.
 *
 *  Two things are dropped before matching, because an id carries them and a
 *  chip has no room for them: Bedrock's `anthropic.` namespace, and the release
 *  date Anthropic stamps on every Claude id. The date was being read as a third
 *  version component ever since this was written — "Opus 4.7.20250101", against
 *  the "Opus 4.7" promised right above — because eight digits satisfy the same
 *  `\d+` as the one or two a version number has. Length is what tells them
 *  apart. The usage-history modal used to carry a second labeller purely to
 *  strip both; one function now, so a family added here reaches every panel
 *  rather than four out of five.
 *
 *  Everything after a GPT version is KEPT, one title-cased word per `-` or `_`
 *  group, and that single rule replaces the `-codex` special case that used to
 *  sit above the general one. Codex was never special; it was the only suffix
 *  anybody had needed yet, and the moment a second one mattered the special case
 *  was the thing standing in the way of `-codex-max` and `-codex-mini` being
 *  told apart. The qualifier must be introduced by a separator and the whole
 *  remainder must be separator-delimited words, so `gpt-4o` — a version digit
 *  with a letter fused onto it — reaches no branch and comes back as itself,
 *  which is the docstring's promise rather than the "GPT-4 O" a looser pattern
 *  would invent. The Claude branch is deliberately NOT anchored the same way:
 *  a Bedrock id ends in `-v1:0`, which is a deployment suffix and not a model,
 *  and anchoring would push every Bedrock id into the raw-id fallback.
 *
 *  WIDTH, because the label got longer and the card it goes on had its geometry
 *  pinned by #369 and #380. Two bounds, one structural and one measured.
 *
 *  Structural: every branch either shortens the id or preserves its length
 *  exactly — `gpt-` becomes `GPT-`, each `-` or `_` becomes one space or one
 *  dot, and `anthropic.` and the 8-digit date are removed — so
 *  `shortModel(id).length <= id.length` for every id there is. The raw id was
 *  always a legal return value from this function, so no label can now be wider
 *  than something the surfaces already had to be able to draw.
 *
 *  Measured: the longest label the known corpus produces is 19 characters
 *  ("GPT-5.3 Codex Spark", "GPT-5.1 Chat Latest"), and the six surfaces that
 *  print it have this much room —
 *    · node chip — `.agent-node` is max-width 260px with `box-sizing:
 *      border-box`, so 16px+12px of padding and two 1px borders leave 230px of
 *      content. `.sub` spends 46px of it on "session" (7 characters at 11px in
 *      the mono stack, whose advance is 0.602em), and the chip adds 22px of
 *      chrome (6px margin, 2×7px padding, 2×1px border) to text set at 10px
 *      with 0.02em tracking, i.e. 6.22px per character. 19 characters is a
 *      140px chip in a 184px hole.
 *    · usage-history day breakdown — `.uh-model-row` gives the name a hard
 *      130px column, less an 8px dot and a 5px gap, so 117px at 11px in the UI
 *      sans stack, where 19 mixed-case characters measure about 105px. This is
 *      the tightest of the four, which is why the label span ellipsises there
 *      and carries the full id in a `title`.
 *    · usage panel by-model table — `.up-model-name` is max-width 120px with
 *      `text-overflow: ellipsis` and a `title` of the raw id already.
 *    · usage-history legend — `.uh-legend` is a wrapping flex row with no
 *      column to overflow.
 *    · session-list row and the selected ribbon — the chip sits in a flex row
 *      beside a label that is `flex: 1` with `min-width: 0` and an ellipsis, so
 *      the chip is never the thing that overflows; a wider chip spends its
 *      extra pixels on the session name's truncation, which is where #369's
 *      containment work put them. Six characters of qualifier is about 37px off
 *      a name that was already being ellipsised on a long workspace path.
 *  A twentieth character would not break any of them; the point of writing the
 *  numbers down is that the next qualifier is measured against them rather than
 *  guessed at. */
export function shortModel(id: string): string {
  const bare = id.replace(/^anthropic\./, "").replace(/[-_]\d{8}(?!\d)/, "");
  const claude = bare.match(/^claude[-_](opus|sonnet|haiku|fable|mythos)[-_](\d+(?:[-_.]\d+)*)/i);
  if (claude) {
    const family = titleWord(claude[1]);
    const version = claude[2].replace(/[-_]/g, ".");
    return `${family} ${version}`;
  }
  const gpt = bare.match(/^gpt[-_](\d+(?:[-_.]\d+)*)((?:[-_][A-Za-z0-9.]+)*)$/i);
  if (gpt) {
    const version = gpt[1].replace(/[-_]/g, ".");
    const qualifiers = gpt[2].split(/[-_]/).filter(Boolean).map(titleWord);
    return [`GPT-${version}`, ...qualifiers].join(" ");
  }
  return id;
}
