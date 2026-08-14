// The version chip is the deck's manual "ask npm now" control, and it renders
// as a dim version number: everything that tells you it is a button, and
// everything that tells you what npm last said, lives in the two strings these
// pin. Copy that is merely plain is the reported bug; copy that is wrong would
// be worse, and there are three ways to get it wrong.
import { describe, it, expect } from "vitest";
import { versionChipLabel, versionChipTitle } from "../version-chip";

const BASE = { running: "1.33.77" };

describe("versionChipTitle", () => {
  it("says what npm has, when it said so, and that a click asks again", () => {
    const t = versionChipTitle({ ...BASE, latest: "1.34.0", checkedAgo: "12m ago" });
    expect(t).toBe("npm has v1.34.0 · checked 12m ago · re-checked periodically · click to check npm now");
  });

  it("does not claim a check ran when none has", () => {
    expect(versionChipTitle(BASE)).toContain("npm not reached yet");
    expect(versionChipTitle(BASE)).not.toContain("· checked ");
  });

  // The dist-tag moves before the tarball is servable, so a pending version
  // means the registry answered — the opposite of what a null `latest` alone
  // would have the chip say.
  it("distinguishes a version npm cannot serve yet from npm being unreachable", () => {
    const t = versionChipTitle({ ...BASE, latest: null, latestPending: "1.34.1", checkedAgo: "just now" });
    expect(t).toContain("v1.34.1");
    expect(t).toContain("cannot serve yet");
    expect(t).not.toContain("not reached");
  });

  it("prefers the installable version when both are known", () => {
    const t = versionChipTitle({ ...BASE, latest: "1.34.0", latestPending: "1.34.1" });
    expect(t).toContain("npm has v1.34.0");
    expect(t).not.toContain("1.34.1");
  });

  it("stops offering a check while one is in flight", () => {
    const t = versionChipTitle({ ...BASE, latest: "1.34.0", checking: true });
    expect(t).toBe("Asking npm for the newest release…");
  });

  it("explains itself rather than offering a check that cannot happen", () => {
    const t = versionChipTitle({ ...BASE, checkDisabled: true, checking: true });
    expect(t).toContain("AGENTS_DECK_NO_UPDATE_CHECK");
    expect(t).not.toContain("click");
  });
});

describe("versionChipLabel", () => {
  it("names both the version and the action, since the button shows only one", () => {
    const l = versionChipLabel(BASE);
    expect(l).toContain("v1.33.77");
    expect(l).toContain("check npm for a newer release");
  });

  it("announces the check in flight", () => {
    expect(versionChipLabel({ ...BASE, checking: true })).toContain("checking npm");
  });

  it("does not offer an action when checks are off", () => {
    const l = versionChipLabel({ ...BASE, checkDisabled: true, checking: true });
    expect(l).toBe("Version v1.33.77, update checks are off");
  });
});
