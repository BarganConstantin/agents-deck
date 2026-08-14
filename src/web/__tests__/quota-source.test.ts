import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { quotaFromStore, maySelfPoll, freshest, parseResetToSec } from "../../server/quota.mjs";

const MIN = 60_000;

/** A claude-swap row as activeAccountUsage() returns it. */
const entry = (lastGood: unknown, fetchedAt = 1_000_000) => ({
  num: 2, email: "a@b.c", lastGood, fetchedAt,
});

describe("quotaFromStore", () => {
  it("maps both windows and keeps the data's own timestamp", () => {
    const q = quotaFromStore(entry({
      five_hour: { pct: 41, resets_at: "2026-08-12T14:40:00Z" },
      seven_day: { pct: 18, resets_at: "2026-08-19T04:00:00Z" },
    }, 1_700_000_000_000));

    expect(q.ok).toBe(true);
    expect(q.source).toBe("claude-swap");
    expect(q.session5hPct).toBe(41);
    expect(q.week7dPct).toBe(18);
    expect(q.session5hResetAt).toBe(Date.parse("2026-08-12T14:40:00Z") / 1000);
    // Age of the numbers, not of our read of them.
    expect(q.fetchedAt).toBe(1_700_000_000_000);
  });

  it("names the per-model windows claude-swap reports positionally", () => {
    const q = quotaFromStore(entry({
      five_hour: { pct: 10 },
      seven_day: { pct: 20 },
      scoped: [{ name: "Sonnet", pct: 33 }, { name: "Opus", pct: 44 }, { name: "Fable", pct: 5 }],
    }));
    expect(q.weekSonnetPct).toBe(33);
    expect(q.weekOpusPct).toBe(44);
  });

  it("falls back to the 7d window when there is no 5h one", () => {
    const q = quotaFromStore(entry({ seven_day: { pct: 62 } }));
    expect(q.session5hPct).toBe(62);
    expect(q.week7dPct).toBe(62);
  });

  it("returns null when there is nothing to show", () => {
    expect(quotaFromStore(null)).toBeNull();
    expect(quotaFromStore(entry(null))).toBeNull();
    expect(quotaFromStore(entry({}))).toBeNull();
    // A row can exist with no numbers in it — that is not 0%.
    expect(quotaFromStore(entry({ five_hour: {}, seven_day: {} }))).toBeNull();
  });

  it("clamps out-of-range percentages rather than trusting them", () => {
    const q = quotaFromStore(entry({ five_hour: { pct: 140 }, seven_day: { pct: -3 } }));
    expect(q.session5hPct).toBe(100);
    expect(q.week7dPct).toBe(0);
  });
});

describe("parseResetToSec", () => {
  // The CLI prints its reset times in the user's local zone with no timezone,
  // and drops ":00" on the hour — "resets Jun 21, 9am". Those used to fall out
  // of the parser as null, which cost the bar its countdown and its pace line.
  const local = (month: number, day: number, hour: number, min: number) =>
    new Date(new Date().getFullYear(), month, day, hour, min, 0, 0).getTime() / 1000;

  it("reads an on-the-hour time that carries no minutes", () => {
    expect(parseResetToSec("Jun 21, 9am")).toBe(local(5, 21, 9, 0));
    expect(parseResetToSec("Jun 21, 12am")).toBe(local(5, 21, 0, 0));
    expect(parseResetToSec("Jun 21, 12pm")).toBe(local(5, 21, 12, 0));
  });

  it("still reads the minute-bearing form the CLI usually prints", () => {
    expect(parseResetToSec("Jun 18, 4:09pm")).toBe(local(5, 18, 16, 9));
    expect(parseResetToSec("Jun 21, 8:59am")).toBe(local(5, 21, 8, 59));
    expect(parseResetToSec("Jun 21, 9 AM")).toBe(local(5, 21, 9, 0));
  });

  it("has nothing to say about an empty reset", () => {
    expect(parseResetToSec(null)).toBeNull();
    expect(parseResetToSec("")).toBeNull();
  });
});

describe("maySelfPoll", () => {
  const now = 10 * 60 * MIN;

  it("holds a normal poll to one every five minutes", () => {
    expect(maySelfPoll({ now, force: false, lastSelfPollAt: now - 4 * MIN, rateLimitedUntil: 0 })).toBe(false);
    expect(maySelfPoll({ now, force: false, lastSelfPollAt: now - 5 * MIN, rateLimitedUntil: 0 })).toBe(true);
  });

  it("lets the refresh button beat that floor, but not by much", () => {
    expect(maySelfPoll({ now, force: true, lastSelfPollAt: now - 30_000, rateLimitedUntil: 0 })).toBe(false);
    expect(maySelfPoll({ now, force: true, lastSelfPollAt: now - 61_000, rateLimitedUntil: 0 })).toBe(true);
  });

  it("never polls during a 429 cooldown, however it was asked", () => {
    const cooling = { now, lastSelfPollAt: 0, rateLimitedUntil: now + MIN };
    expect(maySelfPoll({ ...cooling, force: false })).toBe(false);
    expect(maySelfPoll({ ...cooling, force: true })).toBe(false);
  });

  it("polls on the first ask of a fresh process", () => {
    expect(maySelfPoll({ now, force: false, lastSelfPollAt: 0, rateLimitedUntil: 0 })).toBe(true);
  });
});

describe("freshest", () => {
  // Observed on 2026-08-13: a deck booted with a 48-minute-old claude-swap row
  // fell through to the CLI and served a correct 3%, then reverted to the
  // store's 23% one poll later. The store had not moved; the CLI reading was
  // simply discarded. Worse than stale — the five-hour window had reset in
  // between, so the older number was wrong, not merely old.
  const store = { source: "claude-swap", session5hPct: 23, fetchedAt: 1_000_000 };
  const cli = { source: "cli", session5hPct: 3, fetchedAt: 1_048_000 };

  it("keeps the reading we already paid for when the store is behind", () => {
    expect(freshest(store, cli)).toBe(cli);
  });

  it("prefers the store once it catches up", () => {
    const moved = { ...store, session5hPct: 4, fetchedAt: 1_090_000 };
    expect(freshest(moved, cli)).toBe(moved);
  });

  it("holds whichever side exists when the other does not", () => {
    expect(freshest(null, cli)).toBe(cli);
    expect(freshest(store, null)).toBe(store);
    expect(freshest(null, null)).toBeNull();
  });

  it("treats a missing timestamp as the oldest possible reading", () => {
    expect(freshest({ session5hPct: 99 }, cli)).toBe(cli);
  });
});
