// The other half of a failed upgrade: not repeating it forever.
//
// Reported from a terminal left unattended — the same version, the same npm
// error, the same teardown, four times in a row:
//
//   ↻  updating via npx…
//   agents-deck: npx ccdeck@latest exited 1 — staying on v1.33.88
//     notarget No matching version found for ccdeck@1.33.91.
//   ↻  restarted → v1.33.88 · http://127.0.0.1:4383
//   … (repeats)
//
// Nothing anywhere remembered that this exact target had already failed. The
// supervisor kept no count, the note on disk named only the version that was
// running, and the banner came back offering "Retry update" for the identical
// attempt. So the note now names the version that failed to ARRIVE and how many
// attempts it has cost, and this is the rule that reads it: the second attempt
// waits, and there is no third.
//
// Pure module, no filesystem and no environment — nothing here can reach a real
// ~/.claude or a real registry.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import {
  UPGRADE_COOLDOWN_MS, UPGRADE_MAX_ATTEMPTS, upgradeAttempt, upgradeRefusalText,
} from "../../server/supervisor.mjs";

const NOW = 1_800_000_000_000;
/** The note the supervisor leaves when a fetch fails. */
const note = (over: Record<string, unknown> = {}) => ({
  command: "npx -y ccdeck@latest",
  error: "notarget No matching version found for ccdeck@1.33.91.",
  version: "1.33.88",
  target: "1.33.91",
  attempts: 1,
  failedAt: NOW,
  at: NOW,
  ...over,
});

describe("upgradeAttempt with nothing to hold against the target", () => {
  it("allows the first attempt at a version that has never failed here", () => {
    expect(upgradeAttempt({ note: null, target: "1.33.91", now: NOW })).toEqual({ allow: true, attempt: 1 });
  });

  it("allows a newer target however badly the last one went", () => {
    // The release that fixes whatever broke must not be held back by the one
    // that broke. A moved dist-tag is a different question entirely.
    const twice = note({ attempts: UPGRADE_MAX_ATTEMPTS });
    expect(upgradeAttempt({ note: twice, target: "1.33.92", now: NOW }).allow).toBe(true);
  });

  it("does not count a note that is not a failure", () => {
    expect(upgradeAttempt({ note: note({ error: null }), target: "1.33.91", now: NOW }).allow).toBe(true);
    expect(upgradeAttempt({ note: note({ error: "" }), target: "1.33.91", now: NOW }).allow).toBe(true);
  });

  it("does not hold an older deck's note against a target it never named", () => {
    // Notes written before this rule existed carry no target at all. Treating
    // that unknown as "the version you are asking about" would refuse the first
    // click every deck makes after an upgrade to this version.
    const older = { command: "npx -y ccdeck@latest", error: "npx exited 1", version: "1.33.88", at: NOW };
    expect(upgradeAttempt({ note: older, target: "1.33.91", now: NOW }).allow).toBe(true);
  });
});

describe("upgradeAttempt against the target that just failed", () => {
  it("refuses the immediate retry the banner used to invite", () => {
    const got = upgradeAttempt({ note: note(), target: "1.33.91", now: NOW + 1000 });
    expect(got.allow).toBe(false);
    expect(got.reason).toBe("cooling");
    expect(got.waitMs).toBe(UPGRADE_COOLDOWN_MS - 1000);
  });

  it("allows one more once the wait is over, since a blip does pass", () => {
    expect(upgradeAttempt({ note: note(), target: "1.33.91", now: NOW + UPGRADE_COOLDOWN_MS }))
      .toEqual({ allow: true, attempt: 2 });
  });

  it("stops offering it after the second attempt, whatever the clock says", () => {
    // Offline, a proxy that blocks the registry, the broken npx shim of #184 —
    // none of them are fixed by trying again, and an unattended loop has to
    // terminate. The copyable command stays on screen as the way out.
    const twice = note({ attempts: 2 });
    for (const later of [NOW + 1000, NOW + UPGRADE_COOLDOWN_MS, NOW + 86_400_000]) {
      expect(upgradeAttempt({ note: twice, target: "1.33.91", now: later }))
        .toEqual({ allow: false, reason: "exhausted", attempt: 2, waitMs: 0 });
    }
  });

  it("counts a note with no count as the one failure it stands for", () => {
    const { attempts, ...noCount } = note();
    expect(upgradeAttempt({ note: noCount, target: "1.33.91", now: NOW + 1000 }).reason).toBe("cooling");
    expect(upgradeAttempt({ note: noCount, target: "1.33.91", now: NOW + UPGRADE_COOLDOWN_MS }).attempt).toBe(2);
  });

  it("measures the wait from the fetch, not from the last time it was asked", () => {
    // A refusal re-stamps `at` so the browser can tell it from the failure
    // before it. Measuring the cooldown on that would let a user pushing the
    // button hold their own retry off forever.
    const asked = note({ at: NOW + 4 * 60_000 });
    expect(upgradeAttempt({ note: asked, target: "1.33.91", now: NOW + UPGRADE_COOLDOWN_MS }).allow).toBe(true);
  });

  it("does not strand the deck when the clock moves backwards", () => {
    // A laptop waking, an NTP correction: an unmeasurable wait counts as
    // elapsed, and the attempt cap is what keeps that safe.
    expect(upgradeAttempt({ note: note(), target: "1.33.91", now: NOW - 86_400_000 }).allow).toBe(true);
  });

  it("treats two unknown targets as the same one rather than as two", () => {
    // The version check is cached for an hour and can be switched off, so the
    // supervisor can genuinely not know what it is fetching. Guessing
    // "different" there would hand back the unbounded retry.
    const unknown = note({ target: null, attempts: 2 });
    expect(upgradeAttempt({ note: unknown, target: null, now: NOW + 86_400_000 }).reason).toBe("exhausted");
  });
});

describe("upgradeRefusalText", () => {
  it("names the version, so the banner is about something the user can see", () => {
    const cooling = upgradeRefusalText({ reason: "cooling", waitMs: 240_000, attempt: 1 }, "1.33.91");
    expect(cooling).toContain("v1.33.91");
    expect(cooling).toContain("4m");
  });

  it("rounds a short wait to seconds rather than to a bare zero", () => {
    expect(upgradeRefusalText({ reason: "cooling", waitMs: 1200, attempt: 1 }, "1.33.91")).toContain("2s");
    expect(upgradeRefusalText({ reason: "cooling", waitMs: 0, attempt: 1 }, "1.33.91")).toContain("1s");
  });

  it("points at the command the user can run themselves once it gives up", () => {
    const done = upgradeRefusalText({ reason: "exhausted", attempt: 2 }, "1.33.91");
    expect(done).toContain("v1.33.91");
    expect(done).toMatch(/yourself/);
  });

  it("still says something when nothing knows which version this was", () => {
    expect(upgradeRefusalText({ reason: "exhausted", attempt: 2 }, null)).toMatch(/this update/);
  });
});
