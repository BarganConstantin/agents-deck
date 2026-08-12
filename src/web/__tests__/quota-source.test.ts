import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { quotaFromStore, maySelfPoll } from "../../server/quota.mjs";

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
