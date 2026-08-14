import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { quotaFromStore, maySelfPoll, freshest, parseResetToSec, buildQuotaShellCmd } from "../../server/quota.mjs";

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
  // Every instant below is built from local calendar parts and "now" is passed
  // in, so these expectations hold in any timezone and on any day of the year.
  const at = (year: number, month: number, day: number, hour: number, min: number) =>
    new Date(year, month, day, hour, min, 0, 0).getTime();
  const sec = (ms: number) => ms / 1000;
  const JUNE = at(2026, 5, 17, 12, 0);

  it("reads an on-the-hour time that carries no minutes", () => {
    expect(parseResetToSec("Jun 21, 9am", JUNE)).toBe(sec(at(2026, 5, 21, 9, 0)));
    expect(parseResetToSec("Jun 21, 12am", JUNE)).toBe(sec(at(2026, 5, 21, 0, 0)));
    expect(parseResetToSec("Jun 21, 12pm", JUNE)).toBe(sec(at(2026, 5, 21, 12, 0)));
  });

  it("still reads the minute-bearing form the CLI usually prints", () => {
    expect(parseResetToSec("Jun 18, 4:09pm", JUNE)).toBe(sec(at(2026, 5, 18, 16, 9)));
    expect(parseResetToSec("Jun 21, 8:59am", JUNE)).toBe(sec(at(2026, 5, 21, 8, 59)));
    expect(parseResetToSec("Jun 21, 9 AM", JUNE)).toBe(sec(at(2026, 5, 21, 9, 0)));
  });

  // The reset string carries no year, so the parser has to supply one. Stamping
  // the current year onto it put a window that resets in January eleven months
  // into the past every new year's eve: the countdown disappeared and the pace
  // marker sat at 100% on a brand-new weekly window.
  it("carries a reset past new year into the year it belongs to", () => {
    expect(parseResetToSec("Jan 2, 9:00am", at(2026, 11, 30, 12, 0)))
      .toBe(sec(at(2027, 0, 2, 9, 0)));
    expect(parseResetToSec("Jan 1, 3am", at(2026, 11, 31, 23, 30)))
      .toBe(sec(at(2027, 0, 1, 3, 0)));
  });

  it("leaves a reset read just after new year in the year that ended", () => {
    expect(parseResetToSec("Dec 31, 11:59pm", at(2027, 0, 1, 0, 30)))
      .toBe(sec(at(2026, 11, 31, 23, 59)));
  });

  it("has nothing to say about an empty reset", () => {
    expect(parseResetToSec(null, JUNE)).toBeNull();
    expect(parseResetToSec("", JUNE)).toBeNull();
  });
});

// Source 3 — `claude --print /usage` — is the only self-service path left once
// the OAuth token in ~/.claude/.credentials.json has expired and claude-swap has
// no fresh row, and on Windows it was structurally dead for anyone who used the
// native installer: that one ships %USERPROFILE%\.local\bin\claude.exe with no
// .cmd shim, and the branch probed a hardcoded AppData\Roaming npm path before
// giving up on the literal `claude.cmd`, which cmd.exe cannot resolve to an
// .exe. The quota bar stayed dark while `claude --print /usage` worked fine in
// the user's own terminal. Platform, environment, home and the existence check
// are all injected, so the Windows branch is exercised wherever this runs and
// nothing here touches the real home directory.
describe("buildQuotaShellCmd", () => {
  const HOME_WIN = "C:\\Users\\dorin";
  const HOME_NIX = "/home/dorin";
  const none = () => false;
  /** An existence check that says yes to exactly these paths. */
  const only = (...present: string[]) => (p: string) => present.includes(p);

  it("finds the native Windows install, which has no .cmd shim", () => {
    const exe = "C:\\Users\\dorin\\.local\\bin\\claude.exe";
    expect(buildQuotaShellCmd("win32", {}, HOME_WIN, only(exe)))
      .toBe(`"${exe}" --print /usage < nul`);
  });

  it("respects a roaming profile's APPDATA rather than assuming the home dir", () => {
    const roaming = "\\\\server\\profiles\\dorin\\AppData\\Roaming";
    const shim = `${roaming}\\npm\\claude.cmd`;
    expect(buildQuotaShellCmd("win32", { APPDATA: roaming }, HOME_WIN, only(shim)))
      .toBe(`"${shim}" --print /usage < nul`);
  });

  it("still finds the npm shim under an unset APPDATA", () => {
    const shim = "C:\\Users\\dorin\\AppData\\Roaming\\npm\\claude.cmd";
    expect(buildQuotaShellCmd("win32", {}, HOME_WIN, only(shim)))
      .toBe(`"${shim}" --print /usage < nul`);
  });

  it("falls back to the bare name, which PATHEXT can resolve to either spelling", () => {
    // `claude.cmd` here is the bug: cmd.exe answers "is not recognized" on a
    // machine whose claude is an .exe, however well it is on PATH.
    expect(buildQuotaShellCmd("win32", {}, HOME_WIN, none))
      .toBe("claude --print /usage < nul");
  });

  it("leaves the POSIX side asking the shell, as it always has", () => {
    expect(buildQuotaShellCmd("darwin", {}, HOME_NIX, none))
      .toBe("claude --print /usage < /dev/null");
    expect(buildQuotaShellCmd("linux", {}, HOME_NIX, none))
      .toBe("claude --print /usage < /dev/null");
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
