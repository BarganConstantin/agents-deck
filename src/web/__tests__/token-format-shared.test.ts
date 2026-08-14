// One token count, three formatters, two answers. App.tsx and UsagePanel.tsx
// each carried a byte-identical private `fmtTokens` that stopped at millions,
// and UsageHistoryModal.tsx carried `fmtN` — the same function plus a billions
// tier (#257). Below 1e9 all three agreed, which is why the split lasted; above
// it the usage panel printed "2300.00M" for a cache-read total the modal beside
// it printed as "2.30B".
//
// The four-tier copy won, so the only value that moves is one past a billion.
// This file pins both halves of that claim: the tier boundaries and their
// rounding carries exactly as the old copies rendered them, and a sweep against
// the retired three-tier formula proving nothing below 1e9 changed. It also
// pins the two unrelated `fmtN` helpers that a blind rename would have eaten.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fmtTokens } from "../token-format";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** What App.tsx and UsagePanel.tsx rendered before this was shared. */
function threeTier(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

describe("the shared token formatter", () => {
  it("prints a count below a thousand as itself", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(7)).toBe("7");
    expect(fmtTokens(999)).toBe("999");
  });

  it("switches to thousands at exactly a thousand", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(87_400)).toBe("87.4k");
  });

  it("switches to millions at exactly a million", () => {
    expect(fmtTokens(1_000_000)).toBe("1.00M");
    expect(fmtTokens(1_234_567)).toBe("1.23M");
  });

  it("names a billion instead of printing four digits of millions", () => {
    // The whole of the divergence: these four read 1000.00M, 2300.00M,
    // 12000.00M and 1000000.00M in the usage panel and the toolbar chip.
    expect(fmtTokens(1_000_000_000)).toBe("1.00B");
    expect(fmtTokens(2_300_000_000)).toBe("2.30B");
    expect(fmtTokens(12_000_000_000)).toBe("12.00B");
    expect(fmtTokens(1_000_000_000_000)).toBe("1000.00B");
  });

  it("keeps the rounding carry the old copies had at the top of each tier", () => {
    // 999_950 rounds up into a fourth digit rather than tipping into "1.00M",
    // and 999_999_999 does the same one tier up. Both shared by all three
    // copies, so unifying them was never a choice between two renderings —
    // pinned here so a future change to either is deliberate.
    expect(fmtTokens(999_949)).toBe("999.9k");
    expect(fmtTokens(999_950)).toBe("1000.0k");
    expect(fmtTokens(999_999)).toBe("1000.0k");
    expect(fmtTokens(999_999_999)).toBe("1000.00M");
  });

  it("renders nothing a browser's locale can move", () => {
    // Built from toFixed and an ASCII suffix, never toLocaleString: a host set
    // to de-DE would otherwise print "1.234.567" into a padded table cell and
    // take the column width with it.
    expect(fmtTokens.toString()).not.toMatch(/toLocaleString/);
    for (const n of [0, 999, 1000, 999_999, 1_000_000, 2_300_000_000, 1e12]) {
      expect(fmtTokens(n)).toMatch(/^\d+(\.\d+)?[kMB]?$/);
    }
  });

  it("hands back a count that is not a real number rather than dressing it up", () => {
    // No caller can produce these, and every copy rendered them this way. A
    // guard would turn a broken count into a plausible-looking one.
    expect(fmtTokens(-1)).toBe("-1");
    expect(fmtTokens(-1_000_000)).toBe("-1000000");
    expect(fmtTokens(-Infinity)).toBe("-Infinity");
    expect(fmtTokens(NaN)).toBe("NaNB");
    expect(fmtTokens(Infinity)).toBe("InfinityB");
  });

  it("agrees with the retired three-tier copies everywhere below a billion", () => {
    // Collected rather than asserted per step: an expect() per iteration would
    // dominate the suite's runtime, and the list names every value that moved.
    const moved: Array<{ n: number; was: string; now: string }> = [];
    const check = (n: number) => {
      const now = fmtTokens(n), was = threeTier(n);
      if (now !== was) moved.push({ n, was, now });
    };
    for (let n = 0; n <= 3000; n++) check(n);
    for (let n = 0; n < 1_000_000_000; n += 9973) check(n);
    for (const n of [999, 1000, 1001, 999_999, 1_000_000, 1_000_001, 999_999_998, 999_999_999]) check(n);
    expect(moved).toEqual([]);
  });
});

describe("the three panels that showed token counts", () => {
  const app = src("../App.tsx");
  const panel = src("../components/UsagePanel.tsx");
  const modal = src("../components/UsageHistoryModal.tsx");

  it("take their counts from the shared formatter", () => {
    expect(app).toMatch(/import \{ fmtTokens \} from "\.\/token-format";/);
    expect(panel).toMatch(/import \{ fmtTokens \} from "\.\.\/token-format";/);
    expect(modal).toMatch(/import \{ fmtTokens \} from "\.\.\/token-format";/);
  });

  it("declare no second token formatter of their own", () => {
    for (const file of [app, panel, modal]) {
      expect(file).not.toMatch(/function fmtTokens\b/);
      expect(file).not.toMatch(/function fmtN\b/);
    }
  });
});

describe("the two unrelated fmtN helpers", () => {
  it("keep formatting their own tooltip and context rows", () => {
    // Same name, different job: these group digits for a monospaced table and
    // have no tiers at all, so folding them in would have changed real output.
    expect(src("../components/AgentNode.tsx")).toMatch(/const fmtN = \(n: number\) => n\.toLocaleString\(\);/);
    expect(src("../components/ContextModal.tsx")).toMatch(/function fmtN\(n: number\): string \{ return n\.toLocaleString\(\); \}/);
  });
});
