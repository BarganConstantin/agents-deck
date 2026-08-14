// The category filter bar floats over the canvas. Panning is the user's
// decision and nothing re-frames a viewport they chose, so cards and tool
// bubbles end up beneath the bar and stay there — reported with a screenshot of
// a Bash bubble half-eaten by it, and a workaround of pressing Clear after
// every update. The bar now yields when something is under it, which makes
// "is something under it" a decision worth pinning down.
import { describe, it, expect } from "vitest";
import { boxesTouch, anyTouches } from "../visibility";

const box = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h });

const BAR = box(14, 14, 430, 34);   // roughly the real bar, top-left of the canvas

describe("boxesTouch", () => {
  it("sees a card sitting under the bar", () => {
    expect(boxesTouch(BAR, box(120, 20, 220, 130))).toBe(true);
  });

  it("ignores a card that only shares a row further right", () => {
    expect(boxesTouch(BAR, box(600, 20, 220, 130))).toBe(false);
  });

  it("ignores a card below it", () => {
    expect(boxesTouch(BAR, box(120, 60, 220, 130))).toBe(false);
  });

  it("counts edge contact, but not a hairline gap", () => {
    expect(boxesTouch(BAR, box(444, 14, 100, 34))).toBe(false); // exactly abutting
    expect(boxesTouch(BAR, box(443, 14, 100, 34))).toBe(true);
  });

  it("yields early when given slack — the point of the pad", () => {
    // Dimming at the moment of contact reads as a glitch; dimming a few pixels
    // before reads as the bar getting out of the way.
    const nearMiss = box(120, 54, 220, 130);              // 6px below the bar
    expect(boxesTouch(BAR, nearMiss)).toBe(false);
    expect(boxesTouch(BAR, nearMiss, 8)).toBe(true);
  });
});

describe("anyTouches", () => {
  it("is true when one of many overlaps", () => {
    expect(anyTouches(BAR, [box(600, 20, 100, 40), box(100, 10, 80, 30)])).toBe(true);
  });

  it("is false for an empty canvas", () => {
    expect(anyTouches(BAR, [])).toBe(false);
  });

  it("is false when there is no bar to occlude", () => {
    // Fewer than two categories present: the bar is not rendered at all, and
    // the poll must not claim otherwise.
    expect(anyTouches(null, [box(0, 0, 999, 999)])).toBe(false);
  });
});

// A share is a live credential with a ten-minute life. The countdown is the
// only thing on screen that says so, which makes its wording and its colour
// part of the security story rather than decoration.
import { shareExpiry } from "../components/AccountsPanel";

describe("shareExpiry", () => {
  /** `left` is how many seconds remain, so the sign reads the way it is said. */
  const withLeft = (left: number) => shareExpiry(1_800_000_000_000, 1_800_000_000 - left);

  it("counts minutes while there is time", () => {
    expect(withLeft(600)).toEqual({ text: "expires in 10m", tone: "ok" });
  });

  it("switches to seconds, and to a warning colour, in the last minute", () => {
    expect(withLeft(45)).toEqual({ text: "expires in 45s", tone: "soon" });
  });

  it("says expired rather than counting into the negative", () => {
    expect(withLeft(0)).toEqual({ text: "expired", tone: "gone" });
    expect(withLeft(-30)).toEqual({ text: "expired", tone: "gone" });
  });
});

// Reported with a screenshot: the ACTIVE account showing a bare `invalid_grant`
// with nothing to do about it. That string is claude-swap's, not ours, and the
// two codes that mean "the stored login is dead" are the only failures here that
// waiting does not fix — so they say so, and the row offers the fix.
import { errorText } from "../components/AccountsPanel";

describe("errorText", () => {
  it("turns a dead refresh token into a sentence and an offer", () => {
    for (const code of ["invalid_grant", "no_refresh_token"]) {
      const e = errorText(code);
      expect(e.text).toBe("login expired");
      expect(e.fixable).toBe(true);
      expect(e.hint).toMatch(/sign/i);
    }
  });

  it("does not offer a re-login for something that clears itself", () => {
    expect(errorText("http-429")).toMatchObject({ text: "rate limited", fixable: false });
    expect(errorText("transient")).toMatchObject({ fixable: false });
    expect(errorText("timeout")).toMatchObject({ text: "timed out", fixable: false });
  });

  it("still shows a code it has never seen, rather than swallowing it", () => {
    const e = errorText("teapot");
    expect(e.text).toBe("teapot");
    expect(e.fixable).toBe(false);
    expect(e.hint).toMatch(/teapot/);
  });
});
