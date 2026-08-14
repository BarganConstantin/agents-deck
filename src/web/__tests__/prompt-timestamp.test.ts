// The prompt log rendered `new Date(pr.at).toLocaleTimeString()` and nothing
// else — a time of day, with no date and no `title` to recover one from. Decks
// are left open for days, so a prompt from yesterday and one from this
// afternoon both read "14:07:33" and there was no way to tell them apart. It
// was also the only absolute clock in the primary UI: the session list, the
// agent node, the accounts and usage panels and the version chip all show
// elapsed time with the exact moment in a tooltip.
//
// So the label is relative, the date joins it once the entry is not from today,
// and the absolute value lives in the tooltip — where it is formatted by Intl
// in the browser's own locale, not a hand-written US pattern.
//
// Every instant below is built with the local-time Date constructor, so this
// file asserts the same thing in every timezone the suite might run in.
import { describe, it, expect } from "vitest";
import { promptTime, sameLocalDay, shortAgo } from "../relative-time";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Mid-afternoon, so adding or subtracting a few hours stays inside the day. */
const NOW = new Date(2026, 7, 14, 15, 30, 0).getTime();

/** Locales with Latin digits and genuinely different date orders. */
const LOCALES = ["en-US", "en-GB", "de-DE", "ja-JP", "fr-FR"];
/** A Node built with small-icu answers every locale in en-US; the ordering
 *  assertion below would be testing that build, not the code. */
const FULL_ICU = Intl.DateTimeFormat.supportedLocalesOf(["de-DE"]).length > 0;

describe("a prompt from today", () => {
  it("is labelled by how long ago it was, the way the rest of the deck reads time", () => {
    expect(promptTime(NOW - 3 * MIN, NOW).label).toBe("3m ago");
    expect(promptTime(NOW - 2 * HOUR, NOW).label).toBe("2h ago");
    expect(promptTime(NOW - 10_000, NOW).label).toBe("just now");
  });

  it("carries no date, because today is the one day that needs no saying", () => {
    expect(promptTime(NOW - 3 * MIN, NOW, "en-US").label).not.toMatch(/\d{1,2}$/);
    expect(promptTime(NOW - 3 * MIN, NOW, "en-US").label).not.toContain("·");
  });
});

describe("a prompt from another day", () => {
  it("puts the date beside the elapsed count, where a bare age is easiest to misread", () => {
    const label = promptTime(NOW - 30 * HOUR, NOW, "en-US").label;
    expect(label).toContain("1d ago");
    expect(label).toContain("Aug 13");
  });

  it("is told apart from one the same number of hours later, which the old wall clock could not do", () => {
    const yesterday = new Date(2026, 7, 13, 14, 7, 33).getTime();
    const today = new Date(2026, 7, 14, 14, 7, 33).getTime();
    // Both rendered "14:07:33" before, label and tooltip alike.
    expect(promptTime(yesterday, NOW, "en-US").label).not.toBe(promptTime(today, NOW, "en-US").label);
    expect(promptTime(yesterday, NOW, "en-US").title).not.toBe(promptTime(today, NOW, "en-US").title);
  });

  it("counts days by the calendar, not by a 24-hour window", () => {
    // 11pm last night is ~16 hours ago and still not today.
    const lastNight = new Date(2026, 7, 13, 23, 0, 0).getTime();
    expect(sameLocalDay(new Date(lastNight), new Date(NOW))).toBe(false);
    expect(promptTime(lastNight, NOW, "en-US").label).toContain("Aug 13");
  });
});

describe("the tooltip", () => {
  it("is a full date and time, never the bare wall clock the log used to show", () => {
    for (const locale of LOCALES) {
      const { title } = promptTime(NOW - 30 * HOUR, NOW, locale);
      expect(title, locale).not.toBe(new Date(NOW - 30 * HOUR).toLocaleTimeString(locale));
      expect(title, locale).toContain("2026");
      expect(title, locale).toContain("13");
    }
  });

  it("is written in the reader's locale rather than one format for everybody", () => {
    if (!FULL_ICU) return;
    const at = NOW - 30 * HOUR;
    const rendered = new Set(LOCALES.map(l => promptTime(at, NOW, l).title));
    expect(rendered.size).toBeGreaterThan(1);
  });
});

describe("shortAgo", () => {
  it("reads as a sentence fragment at every scale the deck shows", () => {
    expect(shortAgo(0)).toBe("just now");
    expect(shortAgo(59_000)).toBe("just now");
    expect(shortAgo(60_000)).toBe("1m ago");
    expect(shortAgo(HOUR)).toBe("1h ago");
    expect(shortAgo(DAY)).toBe("1d ago");
  });

  it("clamps a clock that has been set back instead of counting into the future", () => {
    expect(shortAgo(-5 * HOUR)).toBe("just now");
    expect(promptTime(NOW + HOUR, NOW, "en-US").label).toBe("just now");
  });
});
