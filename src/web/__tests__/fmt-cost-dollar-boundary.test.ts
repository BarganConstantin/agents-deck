// fmtCost renders sub-dollar totals in cents, but the cents string is rounded
// before it is printed, so for totals in [0.995, 1) the rounding carried into
// three digits and the chip read "100¢" — a unit that does not exist. The
// number is user-visible on agent cards, the session summary, the session list
// and every burn-rate chip, so the cents branch has to hand off to the dollar
// branch whenever rounding reaches a full dollar.
import { describe, it, expect } from "vitest";
import { fmtCost, fmtCostRate } from "../pricing";

describe("fmtCost never prints a three-digit cents value", () => {
  it("renders dollars for totals that round up to a full dollar", () => {
    expect(fmtCost(0.996)).toBe("$1.00");
    expect(fmtCost(0.999)).toBe("$1.00");
    expect(fmtCost(0.9999)).toBe("$1.00");
  });

  it("keeps printing cents right below the carry", () => {
    expect(fmtCost(0.99)).toBe("99¢");
    expect(fmtCost(0.994)).toBe("99¢");
  });

  it("holds across the whole sub-dollar range", () => {
    // Every hundredth of a cent from 0.01¢ to 99.99¢: whenever the result is
    // a cents value it must be under 100, and it must otherwise be dollars.
    for (let i = 1; i < 10_000; i++) {
      const rendered = fmtCost(i / 10_000);
      if (rendered.endsWith("¢") && rendered !== "<1¢") {
        expect(Number(rendered.slice(0, -1))).toBeLessThan(100);
      }
    }
  });

  it("leaves the other formatting branches untouched", () => {
    expect(fmtCost(0)).toBe("—");
    expect(fmtCost(-1)).toBe("—");
    expect(fmtCost(0.0049)).toBe("<1¢");
    expect(fmtCost(0.0995)).toBe("10.0¢");  // the parallel 10¢ carry is valid
    expect(fmtCost(0.1)).toBe("10¢");
    expect(fmtCost(1)).toBe("$1.00");
    expect(fmtCost(42.5)).toBe("$42.50");
    expect(fmtCost(100)).toBe("$100");
    expect(fmtCost(12_345)).toBe("$12.3k");
  });
});

describe("the burn-rate chip inherits the fix", () => {
  it("prints dollars per minute rather than 100¢/min", () => {
    // $0.998 of cost over exactly one minute of activity.
    expect(fmtCostRate(0.998, 60)).toBe("$1.00/min");
  });
});
