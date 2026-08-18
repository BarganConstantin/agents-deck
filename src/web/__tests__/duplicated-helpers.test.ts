// #374, the round after #323: seven helpers written out more than once, and
// four of the pairs already printing different strings for the same input on
// two surfaces a user sees together.
//
// The pattern this file exists to break is the one #377 named. Correcting a
// copy leaves it able to drift again, and — worse — a suite that only checks
// the copy would still pass if the shipped rule were reverted. So every
// assertion below comes in two halves: the shared function is swept against a
// LOCAL RE-IMPLEMENTATION of each copy it replaced, across the inputs those
// copies actually saw, and the files that used to hold them are read as text to
// prove none of them kept one.
//
// Comments are stripped before every "appears nowhere" assertion. This repo's
// prose quotes the code it retired — the paragraphs explaining why `fmtTok` and
// `SsCostBar` are gone contain their names — and a search over raw source would
// find the sentence saying a thing is gone and conclude that it is not.
//
// Plain node, no DOM. The helpers are pure, so they are called directly; the
// one component is a function that returns an element tree, which is walked
// rather than rendered.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fmtTokens } from "../token-format";
import { elapsed, toolDuration } from "../duration";
import { resetCountdown, shortAgo, shortAgoSec } from "../relative-time";
import { isOlder } from "../../server/self-update.mjs";
import { resetLabel, resetLabelIso } from "../../server/reset-label.mjs";
import CostBar from "../components/CostBar";
import type { CostBreakdown } from "../pricing";
import type { ToolCall } from "../types";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The same text with its comments gone — the only form an "appears nowhere"
 *  assertion may read, for the reason in the header. Block comments first, then
 *  whole-line `//`, which is how landmark-outline.test.ts does it and covers
 *  every comment this repo writes above a declaration. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

const app = src("../App.tsx");
const agentNode = src("../components/AgentNode.tsx");
const usagePanel = src("../components/UsagePanel.tsx");
const accountsPanel = src("../components/AccountsPanel.tsx");
const sessionSummary = src("../components/SessionSummary.tsx");
const toolModal = src("../components/ToolModal.tsx");
const costBarSrc = src("../components/CostBar.tsx");
const cswapInstall = src("../../server/cswap-install.mjs");
const codexQuota = src("../../server/codex-quota.mjs");
const quota = src("../../server/quota.mjs");

// ── 1. the token formatter #323 missed ──────────────────────────────────────

describe("the agent card's token count", () => {
  /** `fmtTok`, exactly as AgentNode.tsx declared it — byte for byte the two
   *  copies #323 deleted from App.tsx and UsagePanel.tsx, which is what made
   *  this the FOURTH copy rather than a fourth variant. */
  function fmtTok(n: number): string {
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  it("renders every count below a billion exactly as the card's own copy did", () => {
    // Collected rather than asserted per step: an expect() per iteration would
    // dominate the suite's runtime, and the list names every value that moved.
    const moved: Array<{ n: number; was: string; now: string }> = [];
    const check = (n: number) => {
      const was = fmtTok(n), now = fmtTokens(n);
      if (was !== now) moved.push({ n, was, now });
    };
    for (let n = 0; n <= 3000; n++) check(n);
    for (let n = 0; n < 1_000_000_000; n += 9973) check(n);
    for (const n of [999, 1000, 1001, 999_999, 1_000_000, 1_000_001, 999_999_998, 999_999_999]) check(n);
    expect(moved).toEqual([]);
  });

  it("stops printing four digits of millions once the count passes a billion", () => {
    // The whole of the change, and the reason the swap is a fix and not only a
    // merge: the card carried the pre-#323 rendering, which is the one
    // token-format.ts's header was written to describe.
    expect(fmtTok(1_000_000_000)).toBe("1000.00M");
    expect(fmtTokens(1_000_000_000)).toBe("1.00B");
    expect(fmtTok(2_300_000_000)).toBe("2300.00M");
    expect(fmtTokens(2_300_000_000)).toBe("2.30B");
  });

  it("comes from the shared formatter, and the card keeps no second one", () => {
    expect(agentNode).toMatch(/import \{ fmtTokens \} from "\.\.\/token-format";/);
    expect(code(agentNode)).not.toMatch(/function fmtTok\b/);
    expect(code(agentNode)).toMatch(/\{fmtTokens\(data\.usage\.inputTokens \+ data\.usage\.outputTokens\)\}/);
  });
});

// ── 2. the cost bar, three copies ───────────────────────────────────────────

/** One segment of the bar as the assertions below compare them: the class, the
 *  width the browser would resolve, and the tooltip. */
interface Seg { cls: string; width: string; title: string }

/** Walk what the component returned. It is a function that builds an element
 *  tree, so it can be called directly — no DOM, no renderer, and the props are
 *  the same objects React would hand the host. */
function segmentsOf(el: ReturnType<typeof CostBar>): Seg[] | null {
  if (el == null) return null;
  const children = (el.props as { children: unknown[] }).children;
  return children
    .filter((c): c is { props: { className: string; style: { width: string }; title: string } } => c != null)
    .map(c => ({ cls: c.props.className, width: c.props.style.width, title: c.props.title }));
}

function classOf(el: ReturnType<typeof CostBar>): string | null {
  return el == null ? null : (el.props as { className: string }).className;
}

describe("the stacked cost bar", () => {
  /** Costs that exercise every branch: all four segments, a zero segment that
   *  must be omitted, a single-segment bar, a total of zero, and a total the
   *  segments do not sum to (which is what an unpriced model produces). */
  const CASES: CostBreakdown[] = [
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    { input: 0, output: 2, cacheRead: 0, cacheWrite: 4, total: 6 },
    { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
    { input: 0.0001, output: 0.00002, cacheRead: 0.5, cacheWrite: 123.456, total: 123.9561 },
    { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 400 },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: -3 },
  ];

  it("emits the segments the three retired copies emitted, for every shape of cost", () => {
    // The three copies differed by their name, their prop type's spelling and
    // one class. Everything a reader can see — which segments appear, how wide
    // each one is, and what its tooltip says — was identical, and this is that
    // claim rather than a claim about the source.
    for (const cost of CASES) {
      const md = segmentsOf(CostBar({ cost }));
      const lg = segmentsOf(CostBar({ cost, size: "lg" }));
      expect(md, JSON.stringify(cost)).toEqual(lg);
      if (cost.total <= 0) {
        expect(md, JSON.stringify(cost)).toBeNull();
        continue;
      }
      // What the retired bodies computed, restated here: every segment with a
      // positive cost, in this order, at this width, with this tooltip.
      const want: Seg[] = [];
      const push = (val: number, cls: string, label: string) => {
        if (val <= 0) return;
        const pct = (val / cost.total) * 100;
        want.push({ cls: `cb-seg ${cls}`, width: `${pct}%`, title: `${label}: ${fmtCostLocal(val)} (${pct.toFixed(0)}%)` });
      };
      push(cost.input, "cb-input", "input");
      push(cost.output, "cb-output", "output");
      push(cost.cacheRead, "cb-cache-r", "cache read");
      push(cost.cacheWrite, "cb-cache-w", "cache write");
      expect(md, JSON.stringify(cost)).toEqual(want);
    }
  });

  it("draws nothing at all when there is no cost to split", () => {
    expect(CostBar({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })).toBeNull();
    expect(CostBar({ cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: -1 } })).toBeNull();
  });

  it("keeps the taller class the session summary's copy added, and only there", () => {
    const cost: CostBreakdown = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 };
    expect(classOf(CostBar({ cost }))).toBe("cost-bar");
    expect(classOf(CostBar({ cost, size: "md" }))).toBe("cost-bar");
    expect(classOf(CostBar({ cost, size: "lg" }))).toBe("cost-bar cost-bar-lg");
  });

  it("carries the role that makes its label reach the accessibility tree", () => {
    // #381's fix, which had to be applied three times because the bar existed
    // three times. A <div> with no role resolves to `generic`, and a generic
    // element cannot be named — so without this the label is not weak, it is
    // discarded. Asserted on the returned props rather than the source, so it
    // is the thing the browser gets.
    const el = CostBar({ cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 } })!;
    expect((el.props as Record<string, unknown>).role).toBe("img");
    expect((el.props as Record<string, unknown>)["aria-label"]).toBe("Cost breakdown");
  });

  it("is drawn in one file, and the three panels import it", () => {
    expect(app).toMatch(/import CostBar from "\.\/components\/CostBar";/);
    expect(usagePanel).toMatch(/import CostBar from "\.\/CostBar";/);
    expect(sessionSummary).toMatch(/import CostBar from "\.\/CostBar";/);
    for (const [name, text] of [["App.tsx", app], ["UsagePanel.tsx", usagePanel], ["SessionSummary.tsx", sessionSummary]] as const) {
      expect(code(text), name).not.toMatch(/function (Ss)?CostBar\b/);
      expect(code(text), name).not.toMatch(/"cb-seg /);
      expect(code(text), name).not.toMatch(/className="cost-bar/);
    }
    // And exactly one file declares the segments at all.
    expect([...code(costBarSrc).matchAll(/"cb-(input|output|cache-r|cache-w)"/g)].map(m => m[1]))
      .toEqual(["input", "output", "cache-r", "cache-w"]);
  });
});

/** `fmtCost` restated, so the tooltip comparison above is against a formula
 *  written out here rather than against the same import the component uses —
 *  otherwise a change to fmtCost would move both sides together and the
 *  assertion would prove nothing. Kept in step with pricing.ts by the
 *  boundaries pinned in fmt-cost-dollar-boundary.test.ts. */
function fmtCostLocal(usd: number): string {
  if (usd <= 0) return "—";
  if (usd < 0.005) return "<1¢";
  if (usd < 1) {
    const cents = (usd * 100).toFixed(usd < 0.1 ? 1 : 0);
    if (Number(cents) < 100) return `${cents}¢`;
  }
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 10_000) return `$${usd.toFixed(0)}`;
  return `$${(usd / 1000).toFixed(1)}k`;
}

// ── 3. the elapsed clock the card and the panel disagreed on ────────────────

describe("the elapsed clock", () => {
  /** The detail panel's inline version, restated. No sub-second tier. */
  function detailInline(start: number, end: number | undefined, now: number): string {
    const ms = (end ?? now) - start;
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  }

  it("prints what BOTH surfaces printed, for every span of a second or more", () => {
    const moved: Array<{ ms: number; was: string; now: string }> = [];
    for (let ms = 1000; ms <= 3 * 3600_000; ms += 7) {
      const was = detailInline(0, undefined, ms), is = elapsed(0, undefined, ms);
      if (was !== is) moved.push({ ms, was, now: is });
    }
    expect(moved).toEqual([]);
  });

  it("gives the panel the sub-second tier the card beside it always had", () => {
    // The one change, and the reason it is a fix: selecting an agent puts the
    // card and the panel on screen together, so a just-started agent read
    // "437ms" on one and "0s" on the other, for the same agent, at the same
    // instant.
    expect(detailInline(0, undefined, 437)).toBe("0s");
    expect(elapsed(0, undefined, 437)).toBe("437ms");
    expect(elapsed(0, undefined, 0)).toBe("0ms");
    expect(elapsed(0, undefined, 999)).toBe("999ms");
    expect(elapsed(0, undefined, 1000)).toBe("1s");
  });

  it("clamps a clock that has been set back rather than counting backwards", () => {
    expect(elapsed(5000, undefined, 0)).toBe("0ms");
  });

  it("reads the same function from both surfaces", () => {
    expect(agentNode).toMatch(/import \{ elapsed \} from "\.\.\/duration";/);
    expect(app).toMatch(/import \{ elapsed, toolDuration \} from "\.\/duration";/);
    expect(code(agentNode)).not.toMatch(/function elapsed\b/);
    expect(code(app)).not.toMatch(/const elapsedLabel = elapsedSec < 60/);
    expect(code(app)).toMatch(/const elapsedLabel = elapsed\(agent\.startedAt, agent\.endedAt, now\);/);
  });

  it("left the two genuinely different dialects where they are", () => {
    // Neither is a copy that drifted: SessionList's drops the seconds above a
    // minute and adds an hour tier because it is a table cell, and
    // SessionSummary's has the hour tier without the sub-second one because it
    // recaps a finished session. Folding either in would print "75m 12s" where
    // "1h 15m" is today, which is a change and not a merge.
    expect(code(src("../components/SessionList.tsx"))).toMatch(/function elapsedShort\(/);
    expect(code(sessionSummary)).toMatch(/\$\{Math\.floor\(sec \/ 3600\)\}h \$\{Math\.floor\(\(sec % 3600\) \/ 60\)\}m/);
  });
});

// ── 4. one tool, two durations, one click apart ─────────────────────────────

describe("a tool call's duration", () => {
  const call = (ms: number | null): ToolCall => ({
    id: "t", name: "Bash", startedAt: 0, endedAt: ms == null ? undefined : ms,
  } as unknown as ToolCall);

  /** ToolRow's, restated — one decimal above a second. */
  const rowCopy = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  /** ToolModal's, restated — two. */
  const modalCopy = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;

  it("prints what both copies printed for every call that finished inside a second", () => {
    const moved: number[] = [];
    for (let ms = 0; ms < 1000; ms++) {
      const got = toolDuration(call(ms), "…");
      if (got !== rowCopy(ms) || got !== modalCopy(ms)) moved.push(ms);
    }
    expect(moved).toEqual([]);
  });

  it("keeps the dialog's rounding above a second, which is the copy that lost nothing", () => {
    const moved: Array<{ ms: number; was: string; now: string }> = [];
    for (let ms = 1000; ms <= 600_000; ms += 3) {
      const got = toolDuration(call(ms), "…");
      if (got !== modalCopy(ms)) moved.push({ ms, was: modalCopy(ms), now: got });
    }
    expect(moved).toEqual([]);
    // And this is what moves: the ROW's label, by one digit, on the surface
    // whose sub-second labels are already five characters wide.
    expect(rowCopy(1240)).toBe("1.2s");
    expect(toolDuration(call(1240), "…")).toBe("1.24s");
    expect(toolDuration(call(999), "…")).toBe("999ms");
    expect("999ms".length).toBeGreaterThanOrEqual(toolDuration(call(9990), "…").length);
  });

  it("keeps each surface's own word for a call that has not finished", () => {
    expect(toolDuration(call(null), "…")).toBe("…");
    expect(toolDuration(call(null), "in-flight…")).toBe("in-flight…");
  });

  it("is one function, called from the row and the dialog it opens", () => {
    expect(toolModal).toMatch(/import \{ toolDuration \} from "\.\.\/duration";/);
    expect(code(app)).toMatch(/const durLabel = toolDuration\(t, "…"\);/);
    expect(code(toolModal)).toMatch(/toolDuration\(tool, "in-flight…"\)/);
    expect(code(toolModal)).not.toMatch(/function dur\(/);
    expect(code(app)).not.toMatch(/toFixed\(1\)\}s/);
  });
});

// ── 5. the accounts panel's second relative-time dialect ────────────────────

describe("how long ago something happened", () => {
  /** AccountsPanel's private `ago`, restated. */
  function agoCopy(ms: number, nowSec: number): string {
    const s = nowSec - Math.floor(ms / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  /** `shortAgo`'s body before it was defined in terms of the seconds form. */
  function shortAgoCopy(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  it("answers what the accounts panel's own copy answered, at second resolution", () => {
    // The panel does not hold a millisecond `now` — it ticks
    // Math.floor(Date.now() / 1000) — so the wrapper it keeps subtracts in
    // seconds and calls the seconds form. Swept across four hundred days of
    // stamps, each with a different sub-second remainder, because flooring on
    // the wrong side of the subtraction is exactly the mistake that would land
    // a second off and only show at a threshold.
    const moved: Array<{ at: number; nowSec: number; was: string; now: string }> = [];
    for (let nowMs = 1_700_000_000_000; nowMs < 1_700_000_000_000 + 400 * 86400_000; nowMs += 997_003) {
      const nowSec = Math.floor(nowMs / 1000);
      for (const off of [0, 1, 137, 500, 999]) {
        const at = nowMs - (nowMs % 1000) - off;
        const was = agoCopy(at, nowSec);
        const now = shortAgoSec(nowSec - Math.floor(at / 1000));
        if (was !== now) moved.push({ at, nowSec, was, now });
      }
    }
    expect(moved).toEqual([]);
  });

  it("walks every threshold in step with the copy, one second at a time", () => {
    // The sweep above steps in ~997s and would skip a boundary; this one does
    // not. Both sides of 60s, 3600s and 86400s, and the day counts past them.
    const moved: number[] = [];
    for (let s = -120; s <= 3 * 86400; s++) {
      if (agoCopy(0, s) !== shortAgoSec(s)) moved.push(s);
    }
    expect(moved).toEqual([]);
    expect(shortAgoSec(59)).toBe("just now");
    expect(shortAgoSec(60)).toBe("1m ago");
    expect(shortAgoSec(3599)).toBe("59m ago");
    expect(shortAgoSec(3600)).toBe("1h ago");
    expect(shortAgoSec(86399)).toBe("23h ago");
    expect(shortAgoSec(86400)).toBe("1d ago");
  });

  it("says the same thing for a clock that has been set back as the copy did", () => {
    // The copy did not clamp and did not need to: any negative age is also
    // below sixty, so it fell into the same branch. The shared one clamps, and
    // lands on the same word.
    for (let s = -1; s >= -100_000; s -= 137) {
      expect(shortAgoSec(s), String(s)).toBe(agoCopy(0, s));
      expect(shortAgoSec(s), String(s)).toBe("just now");
    }
  });

  it("did not move the milliseconds form the version chip and prompt log use", () => {
    const moved: number[] = [];
    for (let ms = -5_000; ms <= 400 * 86400_000; ms += 999_983) {
      if (shortAgo(ms) !== shortAgoCopy(ms)) moved.push(ms);
    }
    for (let ms = -2000; ms <= 90_000; ms += 7) {
      if (shortAgo(ms) !== shortAgoCopy(ms)) moved.push(ms);
    }
    expect(moved).toEqual([]);
  });

  it("leaves no second dialect in the accounts panel", () => {
    expect(accountsPanel).toMatch(/import \{ resetCountdown, shortAgoSec \} from "\.\.\/relative-time";/);
    expect(code(accountsPanel)).not.toMatch(/return "just now"/);
    expect(code(accountsPanel)).toMatch(/return shortAgoSec\(nowSec - Math\.floor\(ms \/ 1000\)\);/);
  });

  it("left the usage panel's age label alone, because it is a different rule", () => {
    // `ageLabel` calls anything under ten seconds "just now" and then counts
    // SECONDS — "40s ago" — where these count minutes. Two thresholds and a
    // whole tier apart, so it is a third rule rather than a third copy, and
    // folding it in would have changed what the panel says.
    expect(code(usagePanel)).toMatch(/if \(s < 10\)\s+return "just now";/);
    expect(code(usagePanel)).toMatch(/if \(s < 60\)\s+return `\$\{s\}s ago`;/);
  });
});

// ── 6. two countdowns to the same quota reset ───────────────────────────────

describe("the countdown to a quota reset", () => {
  /** AccountsPanel's `countdown`, restated — branches on whole days. */
  function accountsCopy(resetAtSec: number, nowSec: number): string | null {
    const diff = resetAtSec - nowSec;
    if (diff <= 0) return null;
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  /** UsagePanel's `fmtCountdown`, restated — branches on total hours. */
  function usageCopy(resetAtSec: number, nowSec: number): string | null {
    const diff = resetAtSec - nowSec;
    if (diff <= 0) return null;
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (h > 23) {
      const d = Math.floor(diff / 86400);
      const rh = Math.floor((diff % 86400) / 3600);
      return `${d}d ${rh}h`;
    }
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  it("answers what both copies answered, at every whole second out to forty days", () => {
    // `d > 0` and `h > 23` are the same test — both mean `diff >= 86400` — but
    // that is an argument, and this is the proof. Every second, no sampling,
    // because a countdown is read at exactly the boundaries.
    const moved: Array<{ diff: number; accounts: string | null; usage: string | null; now: string | null }> = [];
    for (let diff = -100; diff <= 40 * 86400; diff++) {
      const a = accountsCopy(1000 + diff, 1000);
      const u = usageCopy(1000 + diff, 1000);
      const now = resetCountdown(1000 + diff, 1000);
      if (a !== now || u !== now) moved.push({ diff, accounts: a, usage: u, now });
    }
    expect(moved).toEqual([]);
  });

  it("says nothing once the window has already reset", () => {
    expect(resetCountdown(1000, 1000)).toBeNull();
    expect(resetCountdown(999, 1000)).toBeNull();
    expect(resetCountdown(1001, 1000)).toBe("0m");
  });

  it("is read from one place by both panels", () => {
    expect(usagePanel).toMatch(/import \{ resetCountdown \} from "\.\.\/relative-time";/);
    expect(accountsPanel).toMatch(/\bresetCountdown\b/);
    expect(code(usagePanel)).not.toMatch(/function fmtCountdown\b/);
    expect(code(accountsPanel)).not.toMatch(/function countdown\b/);
  });
});

// ── 7. two semver comparators, one of them tested ───────────────────────────

describe("the version comparator", () => {
  /** cswap-install's private copy, restated — the same body without the type
   *  guard, which was the whole of the difference. */
  function cswapCopy(a: string, b: string): boolean {
    const seg = (v: string) => v.split(/[.\-+]/).map(n => parseInt(n, 10)).map(n => Number.isNaN(n) ? 0 : n);
    const x = seg(a), y = seg(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d !== 0) return d < 0;
    }
    return false;
  }

  it("orders every pair of version strings the way the copy ordered them", () => {
    const parts = ["0", "1", "2", "9", "10", "30", "99", "100"];
    const versions: string[] = [];
    for (const a of parts) for (const b of parts) for (const c of parts) versions.push(`${a}.${b}.${c}`);
    versions.push("1.30", "1.9", "2", "0.1.2-beta.1", "1.0.0+build.7", "1.0.0-rc1", "", "0.9.11", "0.10.0");
    const moved: Array<[string, string]> = [];
    for (const a of versions) for (const b of versions) {
      if (isOlder(a, b) !== cswapCopy(a, b)) moved.push([a, b]);
    }
    expect(moved).toEqual([]);
  });

  it("keeps the ordering the copy's own call site depends on", () => {
    expect(isOlder("1.30", "1.30.1")).toBe(true);
    expect(isOlder("1.9.0", "1.10.0")).toBe(true);
    expect(isOlder("1.10.0", "1.9.0")).toBe(false);
    expect(isOlder("1.0.0", "1.0.0")).toBe(false);
  });

  it("answers false on a non-string instead of throwing, which the copy could not", () => {
    // Unreachable at the call site — both arguments are behind
    // `typeof v === "string"` checks — so this is the tested copy absorbing the
    // untested one rather than a bug fix. Pinned so the guard is not dropped as
    // dead weight later.
    for (const v of [null, undefined, 1, {}, []] as unknown[]) {
      expect(isOlder(v as string, "1.0.0")).toBe(false);
      expect(() => cswapCopy(v as string, "1.0.0")).toThrow(TypeError);
    }
  });

  it("is imported by the installer rather than written out there again", () => {
    expect(cswapInstall).toMatch(/import \{ isOlder \} from "\.\/self-update\.mjs";/);
    expect(code(cswapInstall)).not.toMatch(/function isOlder\b/);
    expect(code(cswapInstall)).toMatch(/isOlder\(existing, latest\)/);
  });
});

// ── 8. the reset label whose comment claimed a match it did not have ────────

describe("when a quota window resets", () => {
  /** codex-quota's `fmtReset`, restated — the comma stripped and the whole
   *  string lower-cased after the same option bag. */
  function codexCopy(unixSec: number): string | null {
    if (!unixSec) return null;
    return new Date(unixSec * 1000).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    }).replace(",", "").toLowerCase().replace(/\s+am/, "am").replace(/\s+pm/, "pm");
  }
  /** quota.mjs's `fmtResetIso`, restated — the rendering that was kept. */
  function claudeCopy(iso: string): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    }).replace(/\s+(AM|PM)/, (_, p: string) => p.toLowerCase());
  }

  // Every assertion here is written to be timezone-independent: the host's zone
  // decides which hour and day these render, and CI, a laptop in Chisinau and a
  // Windows box set to UTC must all agree on the test. So the claims are about
  // one string equalling another and about the shape, never about a literal.

  it("prints exactly what the Claude lane printed, over forty days of instants", () => {
    const moved: Array<{ t: number; was: string | null; now: string | null }> = [];
    for (let t = 1_750_000_000; t < 1_750_000_000 + 40 * 86400; t += 1237) {
      const was = claudeCopy(new Date(t * 1000).toISOString());
      const now = resetLabel(t);
      if (was !== now) moved.push({ t, was, now });
    }
    expect(moved).toEqual([]);
  });

  it("prints the same string from a Unix second and from the ISO instant beside it", () => {
    // The two entry points exist because Codex answers in seconds and Anthropic
    // in ISO-8601. That is the only difference there is meant to be.
    for (let t = 1_750_000_000; t < 1_750_000_000 + 40 * 86400; t += 3607) {
      expect(resetLabelIso(new Date(t * 1000).toISOString()), String(t)).toBe(resetLabel(t));
    }
  });

  it("is the change the Codex lanes needed, and it is a change", () => {
    // The retired Codex copy really did disagree with the Claude one on every
    // instant, not at a boundary — the difference was two unconditional string
    // operations. Called out as a fix rather than a merge because the string a
    // user reads on the Codex lanes moves.
    const same: number[] = [];
    for (let t = 1_750_000_000; t < 1_750_000_000 + 40 * 86400; t += 1237) {
      if (codexCopy(t) === resetLabel(t)) same.push(t);
    }
    expect(same).toEqual([]);
    const t = 1_750_000_000;
    expect(codexCopy(t)).toBe(codexCopy(t)!.toLowerCase());
    expect(codexCopy(t)).not.toContain(",");
    expect(resetLabel(t)).toContain(",");
    // Three or four letters of month: CLDR 42 changed en-US's short September
    // from "Sep" to "Sept", so a `{2}` here would pass on one Node and fail on
    // another for no reason this test is about. (The instant above is in June
    // in every zone, but the next reader will copy this pattern.)
    expect(resetLabel(t)).toMatch(/^[A-Z][a-z]{2,3} \d{1,2}, \d{1,2}:\d{2}(am|pm)$/);
  });

  it("answers nothing rather than a broken date when there is no reset to name", () => {
    expect(resetLabel(0)).toBeNull();
    expect(resetLabel(NaN)).toBeNull();
    expect(resetLabel(1e300)).toBeNull();
    expect(resetLabelIso("")).toBeNull();
    expect(resetLabelIso("not a date")).toBeNull();
  });

  it("names an instant at the Unix epoch, which routing ISO through seconds would drop", () => {
    // `resetLabelIso` deliberately does not call `resetLabel(d.getTime()/1000)`:
    // that would send a valid instant through a falsy guard and answer null.
    expect(resetLabelIso("1970-01-01T00:00:00.000Z")).not.toBeNull();
  });

  it("is read from one module by both quota sources", () => {
    expect(quota).toMatch(/import \{ resetLabelIso \} from "\.\/reset-label\.mjs";/);
    expect(codexQuota).toMatch(/import \{ resetLabel \} from "\.\/reset-label\.mjs";/);
    for (const [name, text] of [["quota.mjs", quota], ["codex-quota.mjs", codexQuota]] as const) {
      expect(code(text), name).not.toMatch(/toLocaleString\("en-US"/);
      expect(code(text), name).not.toMatch(/hour12: true/);
    }
  });
});

// ── 9. and nothing anywhere kept a copy ─────────────────────────────────────

describe("the shapes these helpers replaced", () => {
  /** Every source file the deck ships, comment-stripped. */
  const FILES: Array<[string, string]> = [
    ["App.tsx", app],
    ["AgentNode.tsx", agentNode],
    ["UsagePanel.tsx", usagePanel],
    ["AccountsPanel.tsx", accountsPanel],
    ["SessionSummary.tsx", sessionSummary],
    ["ToolModal.tsx", toolModal],
    ["CostBar.tsx", costBarSrc],
    ["cswap-install.mjs", cswapInstall],
    ["codex-quota.mjs", codexQuota],
    ["quota.mjs", quota],
  ].map(([n, t]) => [n, code(t)]);

  it("appear in none of the files they were removed from", () => {
    const RETIRED: Array<[string, RegExp]> = [
      ["the three-tier token formatter", /\(n \/ 1_000_000\)\.toFixed\(2\)\}M/],
      ["a private cost bar", /const seg = \(val: number, cls: string, label: string\)/],
      ["a private semver compare", /const seg = \(v\) => v\.split\(\/\[\.\\-\+\]\//],
      ["a hand-rolled reset label", /replace\(\/\\s\+\(AM\|PM\)\//],
      ["the coarse tool duration", /\(dur \/ 1000\)\.toFixed\(1\)/],
    ];
    const found: string[] = [];
    for (const [name, text] of FILES) {
      for (const [what, re] of RETIRED) {
        // CostBar.tsx is allowed to hold the one cost-bar body there is.
        if (name === "CostBar.tsx" && what === "a private cost bar") continue;
        if (re.test(text)) found.push(`${name}: ${what}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("is not a vacuous sweep — the detectors still find the shapes that stayed", () => {
    // Each pattern above is matched against a string it must hit, so a typo in
    // a regex cannot quietly turn one of these assertions into a no-op.
    expect(/\(n \/ 1_000_000\)\.toFixed\(2\)\}M/.test(src("../token-format.ts"))).toBe(true);
    expect(/const seg = \(val: number, cls: string, label: string\)/.test(costBarSrc)).toBe(true);
    expect(/const seg = \(v\) => v\.split\(\/\[\.\\-\+\]\//.test(src("../../server/self-update.mjs"))).toBe(true);
    expect(/replace\(\/\\s\+\(AM\|PM\)\//.test(src("../../server/reset-label.mjs"))).toBe(true);
  });

  it("reads its sources with the comments taken out, or the sweep proves nothing", () => {
    // The header's claim, made checkable. Every paragraph explaining a removal
    // names the thing removed, so a search over raw text finds the explanation
    // and calls it a copy.
    expect(agentNode).toMatch(/private three-tier `fmtTok`/);
    expect(code(agentNode)).not.toMatch(/fmtTok`/);
    expect(sessionSummary).toMatch(/`SsCostBar`/);
    expect(code(sessionSummary)).not.toMatch(/SsCostBar/);
  });
});
