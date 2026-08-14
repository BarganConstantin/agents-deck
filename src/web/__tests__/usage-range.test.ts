// The usage-history presets used to derive their range start from
// `toISOString()`, i.e. the UTC calendar date, while ccusage buckets its daily
// rows by LOCAL calendar date. For part of every day outside UTC the two
// disagree, so the chart drew six bars under the 7d tab (west of UTC, local
// evening) or thirty-one under 30d (east of UTC, local early morning).
//
// The suite itself runs in whatever timezone the machine happens to be in, so
// nothing here may assume one: the ambient-zone cases assert the invariant
// (exactly N local day buckets, ending today) and the regression cases pin a
// zone explicitly with a Date whose local getters report a chosen wall clock.
import { describe, it, expect } from "vitest";
import { presetSince } from "../usage-range";

// Local calendar date of an instant, derived through Intl rather than through
// Date's own getters so the expectation does not lean on the code under test.
// `formatToParts` is asked for the Gregorian calendar and read by part type, so
// neither the machine's locale nor its part ordering can change the answer.
const PARTS = new Intl.DateTimeFormat("en-US", {
  calendar: "gregory",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function localDay(t: Date): string {
  const p: Record<string, string> = {};
  for (const part of PARTS.formatToParts(t)) p[part.type] = part.value;
  return `${p.year.padStart(4, "0")}${p.month}${p.day}`;
}

// How many local calendar days the range [since … today] spans, counted by
// stepping one civil day at a time. Civil arithmetic in UTC, where a day is
// always 24h, so a daylight-saving transition inside the range cannot skew it.
function daysCovered(since: string, today: string): number {
  const y = Number(since.slice(0, 4)), m = Number(since.slice(4, 6)), d = Number(since.slice(6, 8));
  let cursor = Date.UTC(y, m - 1, d);
  for (let n = 1; n <= 400; n++) {
    if (new Date(cursor).toISOString().slice(0, 10).replace(/-/g, "") === today) return n;
    cursor += 86400_000;
  }
  return -1; // start is after today, or absurdly far behind it
}

/**
 * A `Date` pinned to a fixed UTC offset: the underlying instant is real, but
 * the local getters report the wall clock of that zone. Lets a test stand in
 * Chicago or Kolkata without touching `process.env.TZ`, which Node does not
 * honour reliably once the process is running (notably on Windows).
 */
class ZonedNow extends Date {
  private readonly wall: Date;
  constructor(wallClock: string, offsetHours: number) {
    const wall = new Date(`${wallClock}Z`);
    super(wall.getTime() - offsetHours * 3600_000);
    this.wall = wall;
  }
  getFullYear(): number { return this.wall.getUTCFullYear(); }
  getMonth(): number { return this.wall.getUTCMonth(); }
  getDate(): number { return this.wall.getUTCDate(); }
}

const PRESETS = [7, 14, 30, 90];

describe("presetSince", () => {
  it("covers exactly N local days ending today, at every hour of the day", () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(midnight.getTime() + hour * 3600_000 + 1800_000);
      for (const days of PRESETS) {
        expect(daysCovered(presetSince(days, now), localDay(now))).toBe(days);
      }
    }
  });

  it("holds the same invariant in a zone pinned well east and west of UTC", () => {
    for (const offset of [-12, -5, -3.5, 0, 5.5, 9, 14]) {
      for (let hour = 0; hour < 24; hour++) {
        const clock = `2026-03-08T${String(hour).padStart(2, "0")}:30:00`;
        const now = new ZonedNow(clock, offset);
        const today = `20260308`;
        for (const days of PRESETS) {
          expect(daysCovered(presetSince(days, now), today)).toBe(days);
        }
      }
    }
  });

  it("asks for the local range start in the evening west of UTC, where UTC is already tomorrow", () => {
    // 20:00 in UTC-5 is 01:00 the next UTC day: reading the UTC date lost a day
    // and the 7d tab drew six bars.
    const now = new ZonedNow("2026-08-14T20:00:00", -5);
    expect(now.toISOString().slice(0, 10)).toBe("2026-08-15");
    expect(presetSince(7, now)).toBe("20260808");
    expect(presetSince(30, now)).toBe("20260716");
  });

  it("asks for the local range start in the early morning east of UTC, where UTC is still yesterday", () => {
    // 00:30 in UTC+5:30 is 19:00 the previous UTC day: reading the UTC date
    // gained a day and the 30d tab drew thirty-one bars.
    const now = new ZonedNow("2026-08-14T00:30:00", 5.5);
    expect(now.toISOString().slice(0, 10)).toBe("2026-08-13");
    expect(presetSince(7, now)).toBe("20260808");
    expect(presetSince(30, now)).toBe("20260716");
  });

  it("rolls back across month and year boundaries", () => {
    expect(presetSince(7, new ZonedNow("2026-01-03T23:45:00", 13))).toBe("20251228");
    expect(presetSince(90, new ZonedNow("2026-03-01T00:15:00", -8))).toBe("20251202");
    expect(presetSince(14, new ZonedNow("2024-03-05T09:00:00", 1))).toBe("20240221"); // leap year
  });

  it("returns today for a single-day range", () => {
    expect(presetSince(1, new ZonedNow("2026-08-14T23:59:00", -11))).toBe("20260814");
  });
});
