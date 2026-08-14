// Token counts in the deck's voice: "999", "1.5k", "3.40M", "2.30B".
//
// Three copies of this lived in the tree: byte-identical private `fmtTokens`
// functions in App.tsx and UsagePanel.tsx, plus `fmtN` in UsageHistoryModal.tsx
// — the same function with a billions tier bolted on the end. They agreed on
// every value below 1e9, so nothing ever looked wrong when two of them were on
// screen together, and that is exactly why the divergence survived: the usage
// panel's cache-read total passes a billion after a day of heavy cache hits and
// printed "2300.00M", while the history modal beside it printed "2.30B" for the
// same tokens. The modal grew the extra tier because it sums a whole month.
//
// The four-tier version won. Below 1e9 it is the other two byte for byte, so
// nothing a normal session shows moves; above it, the reader stops counting
// zeroes. Negative and non-finite inputs are left rendering as they always did
// — no caller can produce one, and a guard here would dress a broken count up
// as a plausible number instead of letting it show.
//
// Built from `toFixed` and an ASCII suffix rather than `toLocaleString`: these
// land in padded table cells and a grouping separator that changes with the
// host's locale would change the column width with it.

/** Token count as a short magnitude — see the note above on the four tiers. */
export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
