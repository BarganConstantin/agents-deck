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
//
// Naming it after the package alone was not enough, and that is pinned here
// too: two `npx ccdeck` decks share one _npx directory, so they run the same
// package at the same version out of the same home, and the deck that never
// asked for an update read the other one's failure as its own — "update failed"
// in a tab nobody had touched, with its first ever click labelled "Retry
// update". The note is named after the supervisor that wrote it as well.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
const prevSupervisor = process.env.AGENTS_DECK_SUPERVISOR_PID;
const prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
// Nothing under test reads these, and that is exactly why they are pinned
// inside the sandbox too: the real ~/.claude and ~/.codex stay out of reach
// however this file grows.
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
// No registry call, from any test in this file.
process.env.AGENTS_DECK_NO_UPDATE_CHECK = "1";

// Two decks of one package, sharing this home: A is the one whose npx upgrade
// failed, B is the one that never asked for anything. Every worker learns which
// it is from the environment its supervisor spawned it with, so these are the
// supervisors' pids — and this process pretends to be A's worker throughout.
const DECK_A = "4821";
const DECK_B = "9137";
process.env.AGENTS_DECK_SUPERVISOR_PID = DECK_A;

const {
  claimRestartFailureKey, clearRestartFailure, readRestartFailure, recordRestartFailure,
  restartFailureFileName, restartFailureKey, restartFailureNotice, versionReport,
// @ts-expect-error — .mjs server module, no types
} = await import("../../server/self-update.mjs");

const MARKER_DIR = join(FAKE_HOME, ".agents-deck");
if (!MARKER_DIR.startsWith(FAKE_HOME)) throw new Error("refusing to run: marker dir escaped the sandbox");

// A package root that is not a git checkout and not an npx cache, so
// upgradeBlock answers about the filesystem rather than about this repo.
const PKG_ROOT = join(FAKE_HOME, "pkg");
mkdirSync(PKG_ROOT, { recursive: true });
writeFileSync(join(PKG_ROOT, "package.json"), JSON.stringify({ name: "agents-deck", version: "1.33.76" }));

type EnvKey =
  | "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME"
  | "AGENTS_DECK_NO_UPDATE_CHECK" | "AGENTS_DECK_SUPERVISOR_PID";
const restore = (key: EnvKey, was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

/**
 * A pid that is certainly not running — a supervisor that was killed before
 * anyone read its note. Picking a number and hoping is not cross-platform, so
 * we run a process that does nothing and wait for it to exit.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("exit", () => done());
  });
  return child.pid as number;
}

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("CLAUDE_CONFIG_DIR", prevClaudeDir);
  restore("CODEX_HOME", prevCodexHome);
  restore("AGENTS_DECK_NO_UPDATE_CHECK", prevNoCheck);
  restore("AGENTS_DECK_SUPERVISOR_PID", prevSupervisor);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(MARKER_DIR, { recursive: true, force: true });
  process.env.AGENTS_DECK_SUPERVISOR_PID = DECK_A;
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

  it("is per package, so decks of different packages do not answer for each other", () => {
    recordRestartFailure({ name: "ccdeck", error: "boom", version: "1.33.76" });

    expect(readRestartFailure("agents-deck")).toBe(null);
    expect(restartFailureFileName("ccdeck")).toBe(`.restart-failed-ccdeck-${DECK_A}`);
    // Same sanitising as the update markers: nothing here may become a path.
    expect(restartFailureFileName("@scope/pkg")).toBe(`.restart-failed-scope-pkg-${DECK_A}`);
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

describe("which deck of the same package the note is about", () => {
  it("is not read by a second deck running the same package and version", () => {
    recordRestartFailure({ name: "ccdeck", error: "boom", version: "1.33.76", key: DECK_A });

    // Deck B never asked for an update; the version rule cannot tell it apart,
    // because both decks are v1.33.76 out of the same _npx directory.
    expect(readRestartFailure("ccdeck", DECK_B)).toBe(null);
    expect(readRestartFailure("ccdeck", DECK_A).error).toBe("boom");
  });

  it("reaches the worker through the environment its supervisor spawned it with", () => {
    const supervisor: Record<string, string> = {};
    expect(claimRestartFailureKey(supervisor, 4821)).toBe(DECK_A);
    // Exactly what launch() hands the child: a copy of the supervisor's env.
    expect(restartFailureKey({ ...supervisor })).toBe(DECK_A);
    // And a deck the npx relaunch started inherits that env, so it must take
    // the key over rather than keep answering as its parent.
    claimRestartFailureKey(supervisor, 9137);
    expect(restartFailureKey(supervisor)).toBe(DECK_B);
    expect(restartFailureKey({})).toBe(null);
  });

  it("is not written or read at all by a worker with no supervisor", () => {
    expect(restartFailureFileName("ccdeck", null)).toBe(null);
    expect(restartFailureFileName("ccdeck", "npx")).toBe(null);
    recordRestartFailure({ name: "ccdeck", error: "boom", version: "1.33.76", key: null });

    // Least of all under the old shared name: falling back to it is the bug.
    expect(existsSync(join(MARKER_DIR, ".restart-failed-ccdeck"))).toBe(false);
    expect(readRestartFailure("ccdeck", null)).toBe(null);
    expect(() => clearRestartFailure("ccdeck", null)).not.toThrow();
  });

  it("stays a legal Windows file name whatever the package and the key are", () => {
    const name = restartFailureFileName("@scope/pkg:v2.", " 4821\n");
    expect(name).toBe(`.restart-failed-scope-pkg-v2-${DECK_A}`);
    for (const illegal of [":", "/", "\\"]) expect(name).not.toContain(illegal);
    // A trailing dot is dropped by Windows, so the note would be written to a
    // path that is not the one read back.
    expect(name.endsWith(".")).toBe(false);
  });
});

describe("a note whose deck is gone", () => {
  it("is swept when the next failure is recorded, and a live deck's is not", async () => {
    const gone = String(await deadPid());
    recordRestartFailure({ name: "ccdeck", error: "orphan", version: "1.33.76", key: gone });
    recordRestartFailure({ name: "ccdeck", error: "still here", version: "1.33.76", key: String(process.pid) });
    recordRestartFailure({ name: "ccdeck", error: "mine", version: "1.33.76", key: DECK_A });

    // Nothing else ever deletes one: the retry that clears a note is exactly
    // what the killed supervisor never got to do.
    expect(readRestartFailure("ccdeck", gone)).toBe(null);
    expect(readRestartFailure("ccdeck", String(process.pid)).error).toBe("still here");
    expect(readRestartFailure("ccdeck", DECK_A).error).toBe("mine");
  });

  it("takes the pre-fix shared note with it, since nothing reads that any more", () => {
    mkdirSync(MARKER_DIR, { recursive: true });
    writeFileSync(join(MARKER_DIR, ".restart-failed-ccdeck"), JSON.stringify({ error: "someone else's" }));
    // The registry markers live in the same directory and are nobody's note.
    writeFileSync(join(MARKER_DIR, ".self-update-check-ccdeck"), JSON.stringify({ at: 1, version: "1.33.90" }));

    recordRestartFailure({ name: "ccdeck", error: "mine", version: "1.33.76", key: DECK_A });

    expect(existsSync(join(MARKER_DIR, ".restart-failed-ccdeck"))).toBe(false);
    expect(existsSync(join(MARKER_DIR, ".self-update-check-ccdeck"))).toBe(true);
    expect(readRestartFailure("ccdeck", DECK_A).error).toBe("mine");
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

  it("stays idle for the deck next door, which never asked for an update", async () => {
    // Deck B's supervisor failed; this worker belongs to deck A. Same package,
    // same version, same home — the note is the other deck's to explain.
    recordRestartFailure({ name: "agents-deck", error: "boom", version: "1.33.76", key: DECK_B });

    const report = await versionReport({ running: "1.33.76", pkgRoot: PKG_ROOT });
    expect(report.upgrade.state).toBe("idle");
  });

  it("carries it to the worker the failed supervisor did launch", async () => {
    recordRestartFailure({ name: "agents-deck", error: "boom", version: "1.33.76", key: DECK_B });
    process.env.AGENTS_DECK_SUPERVISOR_PID = DECK_B;

    const report = await versionReport({ running: "1.33.76", pkgRoot: PKG_ROOT });
    expect(report.upgrade.state).toBe("failed");
    expect(report.upgrade.error).toBe("boom");
  });

  it("stays idle for a deck started without a supervisor", async () => {
    recordRestartFailure({ name: "agents-deck", error: "boom", version: "1.33.76", key: DECK_A });
    delete process.env.AGENTS_DECK_SUPERVISOR_PID;

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
