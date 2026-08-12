import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { freshenDue, freshenAllowed, nextReadAt } from "../../server/claude-accounts.mjs";

const NOW = 1_800_000_000_000;
const sec = (ms: number) => ms / 1000;
const MIN = 60_000;

/** A healthy usage row, fetched `ageMs` ago. */
const row = (ageMs: number, extra: Record<string, unknown> = {}) => ({
  fetchedAt: sec(NOW - ageMs),
  consecutiveFailures: 0,
  ...extra,
});

describe("freshenDue", () => {
  it("waits out claude-swap's serve TTL — asking earlier fetches nothing", () => {
    expect(freshenDue(row(170_000), NOW)).toBe(false);
    expect(freshenDue(row(200_000), NOW)).toBe(true);
  });

  it("stays out of the way while an account is recovering from a 429", () => {
    // claude-swap's AIMD is deliberately backing off; polling through it would
    // re-saturate the window it is waiting to drain.
    expect(freshenDue(row(10 * MIN, { last429At: sec(NOW - 20 * MIN) }), NOW)).toBe(false);
    // Past its recovery window, the account is ordinary again.
    expect(freshenDue(row(10 * MIN, { last429At: sec(NOW - 61 * MIN) }), NOW)).toBe(true);
  });

  it("respects an explicit backoff and any failure streak", () => {
    expect(freshenDue(row(10 * MIN, { backoffUntil: sec(NOW + MIN) }), NOW)).toBe(false);
    expect(freshenDue(row(10 * MIN, { backoffUntil: sec(NOW - MIN) }), NOW)).toBe(true);
    expect(freshenDue(row(10 * MIN, { consecutiveFailures: 1 }), NOW)).toBe(false);
  });

  it("leaves a never-fetched row to the ordinary collection path", () => {
    expect(freshenDue(null, NOW)).toBe(false);
    expect(freshenDue({ fetchedAt: null }, NOW)).toBe(false);
  });
});

describe("nextReadAt", () => {
  const planned = (atMs: number) => ({ ...row(10 * MIN), nextPollAt: sec(atMs) });

  it("promises the freshen tick when it beats a stretched plan", () => {
    // Plan says 20 minutes out; the row was read 10 minutes ago, so the
    // freshen tick reaches it far sooner.
    const r = planned(NOW + 20 * MIN);
    expect(nextReadAt(r, true, NOW - 10 * MIN, true, NOW)).toBe(NOW - 10 * MIN + 190_000);
  });

  it("promises the plan when the plan is sooner", () => {
    // Read a minute ago, so the freshen tick is still ~2 minutes out.
    const r = { ...row(MIN), nextPollAt: sec(NOW + 30_000) };
    expect(nextReadAt(r, true, NOW - MIN, true, NOW)).toBe(NOW + 30_000);
  });

  it("returns a past time when the read is already overdue", () => {
    const r = planned(NOW + 20 * MIN);
    // Freshen was due 400s ago; the panel renders that as "due" rather than a
    // negative countdown.
    expect(nextReadAt(r, true, NOW - 10 * MIN, true, NOW)).toBeLessThan(NOW);
  });

  it("does not promise a freshen tick for an inactive account", () => {
    const r = planned(NOW + 20 * MIN);
    expect(nextReadAt(r, true, NOW - 10 * MIN, false, NOW)).toBe(NOW + 20 * MIN);
  });

  it("does not promise one for an account in 429 recovery either", () => {
    const r = { ...planned(NOW + 20 * MIN), last429At: sec(NOW - 5 * MIN) };
    expect(nextReadAt(r, true, NOW - 10 * MIN, true, NOW)).toBe(NOW + 20 * MIN);
  });

  it("is null when neither side has an answer", () => {
    expect(nextReadAt({ fetchedAt: null }, true, null, true, NOW)).toBeNull();
  });
});

describe("freshenAllowed", () => {
  it("is off entirely when the user opts out", () => {
    process.env.AGENTS_DECK_NO_FRESHEN = "1";
    try {
      expect(freshenAllowed(row(10 * MIN), NOW)).toBe(false);
      expect(freshenDue(row(10 * MIN), NOW)).toBe(false);
    } finally {
      delete process.env.AGENTS_DECK_NO_FRESHEN;
    }
    expect(freshenAllowed(row(10 * MIN), NOW)).toBe(true);
  });
});
