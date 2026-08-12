// This guard decides whether the deck may run `cswap add` — a write to a
// credential store — so it only ever gets to say yes on a confident zero.
//
// It said yes once when it should not have. claude-swap writes `accounts` as an
// object keyed by slot number, and the first version tested Array.isArray, so a
// populated store read as empty and `cswap add` ran against it. These pin the
// shapes down.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { accountCount } from "../../server/claude-accounts.mjs";

describe("accountCount", () => {
  it("reads the object-keyed-by-slot shape claude-swap actually writes", () => {
    expect(accountCount({ accounts: { "2": { email: "a" }, "3": { email: "b" } } })).toBe(2);
    expect(accountCount({ activeAccountNumber: 2, sequence: [2, 3], accounts: { "2": {} } })).toBe(1);
  });

  it("also accepts a list, in case that shape ever appears", () => {
    expect(accountCount({ accounts: [{}, {}, {}] })).toBe(3);
    expect(accountCount({ accounts: [] })).toBe(0);
  });

  it("counts a store with no accounts key as genuinely empty", () => {
    expect(accountCount({})).toBe(0);
    expect(accountCount({ accounts: null })).toBe(0);
  });

  it("refuses to call anything unreadable empty", () => {
    // -1, never 0: a store that cannot be understood must not authorise a write.
    expect(accountCount(null)).toBe(-1);
    expect(accountCount(undefined)).toBe(-1);
    expect(accountCount("garbage")).toBe(-1);
    expect(accountCount(42)).toBe(-1);
    expect(accountCount({ accounts: "nonsense" })).toBe(-1);
  });
});
