// A freshly added account has no row in claude-swap's usage cache. The first
// version of this only asked "does any existing row say it is due?", so a store
// whose only account had never been fetched produced no rows, nothing was due,
// the collector was never asked, and the row never appeared. The panel showed
// "never fetched" forever unless the user ran cswap themselves.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { collectionDue } from "../../server/claude-accounts.mjs";

const NOW = 1_800_000_000_000;
const sec = (ms: number) => Math.floor(ms / 1000);

describe("collectionDue", () => {
  it("is true for an account that has never been fetched", () => {
    expect(collectionDue({}, ["1"], NOW)).toBe(true);
    expect(collectionDue({ "2": { nextPollAt: sec(NOW) + 600 } }, ["2", "3"], NOW)).toBe(true);
  });

  it("is true when a row's own schedule says so", () => {
    expect(collectionDue({ "1": { nextPollAt: sec(NOW) - 1 } }, ["1"], NOW)).toBe(true);
  });

  it("is false when every account has a row and none is due", () => {
    const rows = { "1": { nextPollAt: sec(NOW) + 300 }, "2": { nextPollAt: sec(NOW) + 900 } };
    expect(collectionDue(rows, ["1", "2"], NOW)).toBe(false);
  });

  it("is false with no accounts at all — nothing to collect for", () => {
    expect(collectionDue({}, [], NOW)).toBe(false);
  });

  it("treats a row with no schedule as fetched, not as due", () => {
    // Present but scheduleless: claude-swap has seen it. Re-asking every poll
    // would spend the account's request budget on nothing.
    expect(collectionDue({ "1": { fetchedAt: 123 } }, ["1"], NOW)).toBe(false);
  });
});
