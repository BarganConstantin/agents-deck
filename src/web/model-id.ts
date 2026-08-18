// The vendor namespace a third-party provider puts in front of a Claude model
// id, and the one place it is taken off again.
//
// Claude Code speaks to seven providers, and only two of them change the SHAPE
// of the id it then writes into the transcript. Read off Claude Code 2.1.234's
// own model catalog rather than guessed at — each entry carries a
// `provider_ids` block, e.g. for Opus 4.5:
//
//   first_party:  "claude-opus-4-5-20251101"
//   bedrock:      "us.anthropic.claude-opus-4-5-20251101-v1:0"
//   vertex:       "claude-opus-4-5@20251101"
//   foundry:      "claude-opus-4-5"
//   mantle:       "anthropic.claude-opus-4-5-…"
//
// So:
//   · BEDROCK prefixes a cross-region inference profile with a region token and
//     the `anthropic.` namespace. The token comes from a closed list the CLI
//     carries verbatim — ["us","eu","apac","jp","au","us-gov","global"] — and
//     is overridable with ANTHROPIC_BEDROCK_REGION_PREFIX.
//   · MANTLE, and a Bedrock foundation model addressed without an inference
//     profile, use the bare `anthropic.` namespace with no region.
//   · VERTEX takes NO prefix: current-generation models use the bare
//     first-party id and dated snapshots use an `@` separator
//     (`claude-opus-4-5@20251101`). Nothing here has to touch them, and the
//     rate table already matched them — the `\b` after a version digit is
//     satisfied by `@` as readily as by `-`.
//
// WHY A STRIP AND NOT A LOOSER PATTERN. Every model regex in this codebase is
// `^`-anchored, and the anchors are load-bearing: pricing.ts holds `gpt-5`,
// `gpt-5-mini` and `gpt-5.1` as separate rows that depend on anchoring plus
// list order to pick the right one, and a 300x price step sits inside that
// family. Unanchoring thirty patterns to admit a ten-character prefix would
// let `gpt-5` win a rate from the middle of an unrelated id. Removing the
// prefix once, at the top of each lookup, leaves every pattern exactly as
// strict as it was.
//
// The list is deliberately closed rather than `[a-z-]+\.anthropic\.`. A region
// token is a fact about AWS, not a shape to be guessed: an open pattern would
// also swallow `evil.anthropic.claude-opus-5` and price it as Opus 5, and the
// closed list costs one line to extend the day AWS adds a region.

/** Region tokens Claude Code will put in front of `anthropic.`, longest first
 *  so the alternation reads in the order a human would check it. */
const BEDROCK_REGIONS = ["us-gov", "global", "apac", "us", "eu", "jp", "au"] as const;

/** `<region>.anthropic.` or a bare `anthropic.`, and nothing else. Exported so
 *  the gates that only need to RECOGNISE a prefixed id — reducer.ts's
 *  `MODEL_PATTERN` — can build on the same list instead of a second one. */
export const VENDOR_PREFIX_RE = new RegExp(
  `^(?:(?:${BEDROCK_REGIONS.join("|")})\\.)?anthropic\\.`,
  "i",
);

/** A model id with its provider namespace removed, ready to be matched by the
 *  `^`-anchored tables. A first-party, Vertex or Foundry id carries no such
 *  namespace and comes back unchanged, which is what makes this safe to put in
 *  front of every lookup rather than behind a provider check. */
export function bareModelId(id: string): string {
  return id.replace(VENDOR_PREFIX_RE, "");
}
