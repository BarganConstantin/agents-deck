// A failed `npx -y <spec>@latest` upgrade happens in the SUPERVISOR, after the
// worker that asked for it has already exited. Nothing told the next worker, so
// /api/version kept answering `upgrade: {state:"idle"}` — the banner still
// offered "Update & restart", the tab showed nothing, and the deck came back on
// the old version with no explanation anywhere but the terminal. Reported from
// Windows, where the failure was a broken npx shim and the terminal held a raw
// MODULE_NOT_FOUND stack.
//
// These pin the file the supervisor leaves behind and the rule that decides
// when it still describes this deck.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// self-update.mjs resolves ~/.agents-deck at import time from os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows. Both point at a temp
// directory BEFORE the module loads, so no test here can read or write the
// developer's real markers on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-restart-note-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevNoCheck = process.env.AGENTS_DECK_NO_UPDATE_CHECK;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
// No registry call, from any test in this file.
process.env.AGENTS_DECK_NO_UPDATE_CHECK = "1";

const {
  clearRestartFailure, readRestartFailure, recordRestartFailure,
  restartFailureFileName, restartFailureNotice, versionReport,
// @ts-expect-error — .mjs server module, no types
} = await import("../../server/self-update.mjs");

const MARKER_DIR = join(FAKE_HOME, ".agents-deck");
if (!MARKER_DIR.startsWith(FAKE_HOME)) throw new Error("refusing to run: marker dir escaped the sandbox");

// A package root that is not a git checkout and not an npx cache, so
// upgradeBlock answers about the filesystem rather than about this repo.
const PKG_ROOT = join(FAKE_HOME, "pkg");
mkdirSync(PKG_ROOT, { recursive: true });
writeFileSync(join(PKG_ROOT, "package.json"), JSON.stringify({ name: "agents-deck", version: "1.33.76" }));

const restore = (key: "HOME" | "USERPROFILE" | "AGENTS_DECK_NO_UPDATE_CHECK", was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("AGENTS_DECK_NO_UPDATE_CHECK", prevNoCheck);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(MARKER_DIR, { recursive: true, force: true });
});

describe("the note a failed npx relaunch leaves", () => {
  it("round-trips through a file the next process can read", () => {
    recordRestartFailure({
      name: "ccdeck",
      command: "npx -y ccdeck@latest",
      error: "Error: Cannot find module 'npx-cli.js'",
      version: "1.33.76",
      at: 1_700_000_000_000,
    });

    const back = readRestartFailure("ccdeck");
    expect(back.error).toContain("Cannot find module");
    expect(back.command).toBe("npx -y ccdeck@latest");
    expect(back.version).toBe("1.33.76");
    expect(back.at).toBe(1_700_000_000_000);
  });

  it("is per package, so decks sharing a home do not answer for each other", () => {
    recordRestartFailure({ name: "ccdeck", error: "boom", version: "1.33.76" });

    expect(readRestartFailure("agents-deck")).toBe(null);
    expect(restartFailureFileName("ccdeck")).toBe(".restart-failed-ccdeck");
    // Same sanitising as the update markers: nothing here may become a path.
    expect(restartFailureFileName("@scope/pkg")).toBe(".restart-failed-scope-pkg");
    expect(restartFailureFileName("../../etc/passwd")).not.toContain("/");
  });

  it("is cleared before the next attempt, so a retry answers for itself", () => {
    recordRestartFailure({ name: "ccdeck", error: "boom", version: "1.33.76" });
    clearRestartFailure("ccdeck");
    expect(readRestartFailure("ccdeck")).toBe(null);
    // And clearing one that was never written is not an error.
    expect(() => clearRestartFailure("ccdeck")).not.toThrow();
  });

  it("survives a home it cannot write, rather than taking the deck down", () => {
    // ~/.agents-deck as a FILE: mkdir and write both fail, which is the shape a
    // read-only or otherwise hostile home takes here. The supervisor is mid
    // relaunch when this runs, and losing the report is the acceptable half.
    writeFileSync(MARKER_DIR, "not a directory");
    expect(() => recordRestartFailure({ name: "ccdeck", error: "boom" })).not.toThrow();
    expect(readRestartFailure("ccdeck")).toBe(null);
    expect(() => clearRestartFailure("ccdeck")).not.toThrow();
    rmSync(MARKER_DIR, { force: true });
  });

  it("truncates an error long enough to be an install log", () => {
    recordRestartFailure({ name: "ccdeck", error: "x".repeat(5000), version: "1.33.76" });
    expect(readRestartFailure("ccdeck").error.length).toBe(300);
  });
});

describe("whether the note still describes this deck", () => {
  const note = { command: "npx -y ccdeck@latest", error: "Cannot find module", version: "1.33.76", at: 7 };

  it("reports a failure while the files on disk are the version that failed", () => {
    expect(restartFailureNotice(note, "1.33.76")).toEqual({
      state: "failed", command: "npx -y ccdeck@latest", error: "Cannot find module", at: 7,
    });
  });

  it("goes quiet once the deck is running a different version", () => {
    // Upgraded some other way — a fixed npm prefix, a manual npx, an `npm i -g`.
    // The note is about a deck that no longer exists.
    expect(restartFailureNotice(note, "1.33.90")).toBe(null);
  });

  it("says nothing for an absent, empty or malformed note", () => {
    expect(restartFailureNotice(null, "1.33.76")).toBe(null);
    expect(restartFailureNotice({}, "1.33.76")).toBe(null);
    expect(restartFailureNotice({ error: "" }, "1.33.76")).toBe(null);
    expect(restartFailureNotice({ error: 42 }, "1.33.76")).toBe(null);
  });

  it("keeps a note that predates version stamping", () => {
    expect(restartFailureNotice({ error: "boom" }, "1.33.76")?.state).toBe("failed");
  });
});

describe("what /api/version reports afterwards", () => {
  it("carries the failure, so the browser can say what the terminal said", async () => {
    recordRestartFailure({
      name: "agents-deck",
      command: "npx -y agents-deck@latest",
      error: "Error: Cannot find module 'npx-cli.js' — check `npm config get prefix`",
      version: "1.33.76",
      at: 5,
    });

    const report = await versionReport({ running: "1.33.76", pkgRoot: PKG_ROOT });

    expect(report.upgrade.state).toBe("failed");
    expect(report.upgrade.error).toContain("npm config get prefix");
    expect(report.upgrade.command).toBe("npx -y agents-deck@latest");
  });

  it("is idle again once the note is cleared", async () => {
    recordRestartFailure({ name: "agents-deck", error: "boom", version: "1.33.76" });
    clearRestartFailure("agents-deck");

    const report = await versionReport({ running: "1.33.76", pkgRoot: PKG_ROOT });
    expect(report.upgrade.state).toBe("idle");
  });

  it("ignores a note left by a version this deck is no longer running", async () => {
    recordRestartFailure({ name: "agents-deck", error: "boom", version: "1.30.0" });

    const report = await versionReport({ running: "1.33.76", pkgRoot: PKG_ROOT });
    expect(report.upgrade.state).toBe("idle");
  });

  it("does not confuse the note with the update marker", async () => {
    recordRestartFailure({ name: "agents-deck", error: "boom", version: "1.33.76" });
    await versionReport({ running: "1.33.76", pkgRoot: PKG_ROOT });

    // The registry side is untouched: a relaunch that failed is not a lookup
    // that failed, and reporting it as one would blame the network.
    expect(existsSync(join(MARKER_DIR, ".self-update-check-agents-deck"))).toBe(false);
  });
});
