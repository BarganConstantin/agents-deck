// On 2026-08-12 a deck that had been running since before v1.30.4 kept polling
// Anthropic's usage endpoint once a minute — the exact bug v1.30.4 fixed — because
// Node had cached the old modules at import and `npm i -g` only replaced the files
// on disk. Nothing in the product said so: the terminal banner still showed the
// boot version, and the browser bundle shows whichever version it was served.
// These tests pin the three-way comparison that makes that state visible.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { isOlder, pickNotice, isNpxInstall, upgradeCommand, upgradeBlockedReason, lastMeaningfulLine, npxRoot, bareSpecName, npxSpecFromMeta, upgradeMode } from "../../server/self-update.mjs";

describe("isOlder", () => {
  it("compares numerically, not lexically", () => {
    // "1.9.0" > "1.10.0" as strings; the whole point of the helper.
    expect(isOlder("1.9.0", "1.10.0")).toBe(true);
    expect(isOlder("1.10.0", "1.9.0")).toBe(false);
    expect(isOlder("1.30.3", "1.30.7")).toBe(true);
  });

  it("is false for equal versions, so a healthy deck says nothing", () => {
    expect(isOlder("1.30.7", "1.30.7")).toBe(false);
  });

  it("pads missing segments and survives prerelease tails", () => {
    expect(isOlder("1.30", "1.30.1")).toBe(true);
    expect(isOlder("1.30.1", "1.30")).toBe(false);
    expect(isOlder("1.31.0-beta.1", "1.31.0")).toBe(false); // 1.31.0.0 vs 1.31.0
  });

  it("never claims an order it cannot compute", () => {
    expect(isOlder(null, "1.0.0")).toBe(false);
    expect(isOlder("1.0.0", undefined)).toBe(false);
  });
});

describe("pickNotice", () => {
  it("names the restart when the fix is already on disk", () => {
    expect(pickNotice({ running: "1.30.3", installed: "1.30.7", latest: "1.30.7" }))
      .toEqual({ kind: "restart", from: "1.30.3", to: "1.30.7" });
  });

  it("prefers the restart over the upgrade — the free fix comes first", () => {
    // Both are true here. Restarting is one keystroke and needs no network;
    // the upgrade notice returns on the next check if it is still due.
    expect(pickNotice({ running: "1.30.3", installed: "1.30.7", latest: "1.31.0" }).kind)
      .toBe("restart");
  });

  it("names the upgrade against what is installed, not what is running", () => {
    // Otherwise a deck sitting one restart behind would be told to upgrade to a
    // version it already has.
    expect(pickNotice({ running: "1.30.7", installed: "1.30.7", latest: "1.31.0" }))
      .toEqual({ kind: "upgrade", from: "1.30.7", to: "1.31.0" });
  });

  it("stays silent when everything matches", () => {
    expect(pickNotice({ running: "1.30.7", installed: "1.30.7", latest: "1.30.7" })).toBeNull();
  });

  it("stays silent when the registry is unreachable and disk agrees", () => {
    expect(pickNotice({ running: "1.30.7", installed: "1.30.7", latest: null })).toBeNull();
  });

  it("never reports a downgrade, whichever side moved backwards", () => {
    // A published version can be unpublished or a dist-tag rolled back; neither
    // is a reason to nag someone running newer code.
    expect(pickNotice({ running: "1.31.0", installed: "1.30.7", latest: "1.30.7" })).toBeNull();
    expect(pickNotice({ running: "1.31.0", installed: "1.31.0", latest: "1.30.7" })).toBeNull();
  });

  it("falls back to the running version when package.json is unreadable", () => {
    expect(pickNotice({ running: "1.30.7", installed: null, latest: "1.31.0" }))
      .toEqual({ kind: "upgrade", from: "1.30.7", to: "1.31.0" });
  });
});

describe("upgradeCommand", () => {
  it("tells npx users to re-run npx — there is no global install to upgrade", () => {
    const npx = "/Users/x/.npm/_npx/9a1c/node_modules/agents-deck";
    expect(isNpxInstall(npx)).toBe(true);
    expect(upgradeCommand(npx)).toBe("npx -y agents-deck@latest");
  });

  it("recognises the Windows npx cache too", () => {
    // Asserted with a literal backslash path rather than path.sep so the case
    // is covered no matter which OS runs the suite.
    expect(isNpxInstall("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\9a1c\\node_modules\\agents-deck")).toBe(true);
  });

  it("matches _npx as a path segment, not as a substring", () => {
    // A project literally named "my_npx-tools" is not an npx cache.
    expect(isNpxInstall("/Users/x/dev/my_npx-tools/agents-deck")).toBe(false);
  });

  it("defaults to the global install command", () => {
    expect(upgradeCommand("/usr/local/lib/node_modules/agents-deck")).toBe("npm i -g agents-deck@latest");
  });
});

describe("upgradeBlockedReason", () => {
  // The in-app installer writes to the user's machine, so the gate on it is the
  // one piece of this feature that must never be loose. Each refusal below is a
  // place where running `npm i -g` would do something the user did not ask for.
  const fine = { git: false, npx: false, writable: true, optedOut: false };

  it("allows a writable global install", () => {
    expect(upgradeBlockedReason(fine)).toBeNull();
  });

  it("refuses to install over a git checkout", () => {
    // The working copy leads npm, and npm would replace it with a tarball.
    expect(upgradeBlockedReason({ ...fine, git: true })).toBe("git_checkout");
  });

  it("refuses under npx, where there is nothing to upgrade in place", () => {
    // `npx agents-deck@latest` populates a DIFFERENT cache directory; this
    // process could not run it even after restarting.
    expect(upgradeBlockedReason({ ...fine, npx: true })).toBe("npx");
  });

  it("refuses a read-only install directory instead of failing inside npm", () => {
    expect(upgradeBlockedReason({ ...fine, writable: false })).toBe("not_writable");
  });

  it("honours the opt-out before anything else", () => {
    // AGENTS_DECK_NO_INSTALL means no installs, and the user should be told
    // that rather than a downstream consequence of it.
    expect(upgradeBlockedReason({ git: true, npx: true, writable: false, optedOut: true }))
      .toBe("opted_out");
  });
});

describe("lastMeaningfulLine", () => {
  it("pulls npm's actual complaint out of its noise", () => {
    const log = [
      "npm ERR! code EACCES",
      "npm ERR! syscall mkdir",
      "npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/agents-deck'",
      "",
      "npm ERR! A complete log of this run can be found in: /Users/x/.npm/_logs/2026.log",
    ].join("\n");
    expect(lastMeaningfulLine(log)).toContain("permission denied");
  });

  it("is empty rather than misleading when there is nothing to report", () => {
    expect(lastMeaningfulLine("")).toBe("");
    expect(lastMeaningfulLine(null)).toBe("");
    expect(lastMeaningfulLine("\n\n  \n")).toBe("");
  });

  it("caps the length so a stray blob cannot land in the banner", () => {
    expect(lastMeaningfulLine("x".repeat(1000)).length).toBe(300);
  });
});

describe("upgradeCommand — the command must match how this copy was installed", () => {
  // Reported: the Update button never appeared. It could not: a git checkout
  // skipped the registry lookup entirely, so `latest` was always null, so the
  // upgrade notice never rendered — and the "this is a checkout" explanation
  // lived inside that notice, with nowhere to appear. The lookup now runs
  // everywhere; only the command differs.
  it("tells a checkout to pull and rebuild, never to npm i -g over it", () => {
    // dist/ is built, not shipped, so a pull alone leaves the old bundle.
    expect(upgradeCommand(process.cwd())).toBe("git pull && npm run build");
  });

  it("still names npx for an npx cache", () => {
    // No metadata to read at that path, so it falls back to the package name
    // rather than inventing a spec.
    expect(upgradeCommand("/Users/x/.npm/_npx/9a1c/node_modules/agents-deck"))
      .toBe("npx -y agents-deck@latest");
  });

  it("still names the global install otherwise", () => {
    expect(upgradeCommand("/usr/local/lib/node_modules/agents-deck"))
      .toBe("npm i -g agents-deck@latest");
  });
});

// An npx run cannot be upgraded in place — npx hashes the SPEC and unpacks into
// its own directory, so `npm i -g` would upgrade something this process can
// never reach. Re-running the spec is the only path, and these pin the two
// things that have to be right for it: which directory holds the metadata, and
// which of the three published names the user actually typed.
describe("npxRoot", () => {
  it("stops at the hash directory, not at the package", () => {
    expect(npxRoot("/Users/x/.npm/_npx/007bf1a1643dbf9a/node_modules/agents-deck"))
      .toBe("/Users/x/.npm/_npx/007bf1a1643dbf9a");
  });

  it("keeps Windows separators, because the path has to be usable there", () => {
    expect(npxRoot("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\9a1c\\node_modules\\ccdeck"))
      .toBe("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\9a1c");
  });

  it("is null outside an npx cache", () => {
    expect(npxRoot("/usr/local/lib/node_modules/agents-deck")).toBeNull();
    expect(npxRoot("/Users/x/.npm/_npx")).toBeNull(); // no hash directory
    expect(npxRoot(null)).toBeNull();
  });
});

describe("bareSpecName", () => {
  it("drops the version but keeps the scope", () => {
    expect(bareSpecName("ccdeck@1.33.1")).toBe("ccdeck");
    expect(bareSpecName("ccdeck")).toBe("ccdeck");
    expect(bareSpecName("@scope/pkg")).toBe("@scope/pkg");
    expect(bareSpecName("@scope/pkg@2.0.0")).toBe("@scope/pkg");
  });

  it("refuses anything that is not a plain name", () => {
    // A tarball or git spec cannot have "@latest" appended to it, and running
    // whatever it points at would be running something the user never chose.
    expect(bareSpecName("https://example.com/pkg.tgz")).toBeNull();
    expect(bareSpecName("file:../local")).toBeNull();
    expect(bareSpecName("")).toBeNull();
    expect(bareSpecName(null)).toBeNull();
  });
});

describe("npxSpecFromMeta", () => {
  it("re-runs the name the user typed, not the package it resolved to", () => {
    // `npx ccdeck` lands in a directory whose node_modules holds agents-deck —
    // re-running "agents-deck" would work, but would quietly move them off the
    // name they chose.
    expect(npxSpecFromMeta({ _npx: { packages: ["ccdeck"] } })).toBe("ccdeck@latest");
    expect(npxSpecFromMeta({ _npx: { packages: ["agent-dag@1.33.1"] } })).toBe("agent-dag@latest");
  });

  it("falls back to the package name when the metadata is missing or unusable", () => {
    expect(npxSpecFromMeta(null)).toBe("agents-deck@latest");
    expect(npxSpecFromMeta({})).toBe("agents-deck@latest");
    expect(npxSpecFromMeta({ _npx: { packages: ["file:../local"] } })).toBe("agents-deck@latest");
  });
});

describe("upgradeMode", () => {
  it("installs where an install is allowed", () => {
    expect(upgradeMode(null)).toBe("install");
  });

  it("treats npx as a different route, not as a refusal", () => {
    // The distinction the UI hangs on: "npx" blocks `npm i -g` while still
    // leaving a way to update, so the banner shows a button rather than only a
    // command to paste.
    expect(upgradeMode("npx")).toBe("npx");
  });

  it("has no route for a checkout, an unwritable prefix, or an opt-out", () => {
    expect(upgradeMode("git_checkout")).toBeNull();
    expect(upgradeMode("not_writable")).toBeNull();
    // AGENTS_DECK_NO_INSTALL=1 is checked first, so opting out also turns off
    // the npx route — one switch, not two.
    expect(upgradeMode("opted_out")).toBeNull();
  });
});
