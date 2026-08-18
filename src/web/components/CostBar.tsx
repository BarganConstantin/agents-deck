import React from "react";
import { fmtCost, type CostBreakdown } from "../pricing";

// The stacked cost bar, once, for the three panels that draw it.
//
// WHY THIS MODULE EXISTS (#374). This component was written out three times —
// `CostBar` in App.tsx, `CostBar` in UsagePanel.tsx and `SsCostBar` in
// SessionSummary.tsx. Normalising whitespace left exactly three differences
// across all three: the prop type was spelled `ReturnType<typeof costForUsage>`
// in two of them and `CostBreakdown` in the third (the same type — that is what
// `costForUsage` returns), one wrapped its returned element in redundant
// parens, and the SessionSummary copy added one class, `cost-bar-lg`. Every
// other byte — the `total <= 0` guard, the four segments, the `cb-input` /
// `cb-output` / `cb-cache-r` / `cb-cache-w` classes, the percentage width and
// the `title` template — was identical.
//
// It had already started to drift the way the token formatter did before #323
// retired its copies. `cacheWriteBreakdown` (pricing.ts) splits cache writes
// into a 5-minute and a 1-hour tier priced differently, and the cost tooltip on
// the agent card already prints that split, while all three bars flatten it
// into one segment. A fifth segment added to a bar that exists three times
// reaches one panel out of three, and nothing fails.
//
// #381 is the other half of the argument. `aria-label` on a <div> with no role
// is not a weak name — the accessibility tree DROPS it, so the label had never
// once been announced. That fix had to be made three times because the bar
// existed three times, and the test that pins it had to name three files. One
// component means the next such fix is made once.

/** How large the bar is drawn. `lg` is the session summary's taller bar; the
 *  class it adds is the ONLY thing that ever differed between the three copies
 *  of this component, which is why it is the only prop besides the figures. */
export type CostBarSize = "md" | "lg";

/**
 * Stacked bar showing the cost split across input / output / cache-read /
 * cache-write. Each segment's width is its share of the total, and a segment
 * with no cost is omitted rather than drawn at zero width.
 *
 * Nothing is drawn at all for a total of zero or less — an unpriced session, or
 * one that has not billed anything yet, gets no bar rather than an empty one.
 *
 * `role="img"` is load-bearing and not decoration: without it the `aria-label`
 * beside it is discarded, because a <div> with no role resolves to `generic`
 * and a generic element cannot carry a name (#381). img is the right role for
 * THIS bar and the wrong one for the usage history's chart, which looks
 * identical and is not — img makes the whole subtree presentational, which is a
 * lie when the subtree holds focusable buttons and the plain truth when it
 * holds four coloured spans that nothing can reach.
 *
 * What the label SAYS — a category rather than the figures the segments are
 * drawn from — is a separate question and a copy one; the role is what makes it
 * possible for it to say anything.
 */
export default function CostBar({ cost, size = "md" }: { cost: CostBreakdown; size?: CostBarSize }) {
  const total = cost.total;
  if (total <= 0) return null;
  const seg = (val: number, cls: string, label: string) => {
    if (val <= 0) return null;
    const pct = (val / total) * 100;
    return (
      <span
        key={cls}
        className={`cb-seg ${cls}`}
        style={{ width: `${pct}%` }}
        title={`${label}: ${fmtCost(val)} (${pct.toFixed(0)}%)`}
      />
    );
  };
  // Both class strings are spelled out whole rather than assembled from a stem
  // and a suffix, and the size is compared HERE rather than inside the
  // attribute, because the suite's unstyled-class detector reads every quoted
  // literal inside a `className={…}` as a class name: a name built at runtime
  // leaves it a stub it cannot resolve, and `"lg"` left in the attribute would
  // be read as a class of its own.
  const large = size === "lg";
  return (
    <div className={large ? "cost-bar cost-bar-lg" : "cost-bar"} role="img" aria-label="Cost breakdown">
      {seg(cost.input, "cb-input", "input")}
      {seg(cost.output, "cb-output", "output")}
      {seg(cost.cacheRead, "cb-cache-r", "cache read")}
      {seg(cost.cacheWrite, "cb-cache-w", "cache write")}
    </div>
  );
}
