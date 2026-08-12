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
    expect(collectionDue(
      { "2": { fetchedAt: sec(NOW) - 60, nextPollAt: sec(NOW) + 600 } }, ["2", "3"], NOW)).toBe(true);
  });

  it("is true when a row's own schedule says so", () => {
    expect(collectionDue(
      { "1": { fetchedAt: sec(NOW) - 900, nextPollAt: sec(NOW) - 1 } }, ["1"], NOW)).toBe(true);
  });

  it("is false when every account has a row and none is due", () => {
    const rows = {
      "1": { fetchedAt: sec(NOW) - 120, nextPollAt: sec(NOW) + 300 },
      "2": { fetchedAt: sec(NOW) - 120, nextPollAt: sec(NOW) + 900 },
    };
    expect(collectionDue(rows, ["1", "2"], NOW)).toBe(false);
  });

  it("is false with no accounts at all — nothing to collect for", () => {
    expect(collectionDue({}, [], NOW)).toBe(false);
  });

  it("is true for a row that exists but has never been fetched", () => {
    // claude-swap writes the row when an account is added and fills in the
    // numbers on its first poll. This is the state a new account sits in, and
    // reading the row's existence as proof of a fetch is what left the panel
    // saying "never fetched" indefinitely.
    expect(collectionDue({ "1": { fetchedAt: null, nextPollAt: null } }, ["1"], NOW)).toBe(true);
    expect(collectionDue({ "1": {} }, ["1"], NOW)).toBe(true);
  });

  it("ignores rows belonging to accounts that no longer exist", () => {
    // A removed account leaves a row behind that is permanently overdue and
    // can never be collected. Counting it made something always due, so the
    // collector was asked every minute forever.
    const rows = {
      "1": { fetchedAt: sec(NOW) - 86400, nextPollAt: sec(NOW) - 3600 },  // gone
      "2": { fetchedAt: sec(NOW) - 60, nextPollAt: sec(NOW) + 600 },      // current
    };
    expect(collectionDue(rows, ["2"], NOW)).toBe(false);
  });
});
