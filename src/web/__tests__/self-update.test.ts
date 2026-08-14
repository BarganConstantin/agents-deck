// On 2026-08-12 a deck that had been running since before v1.30.4 kept polling
// Anthropic's usage endpoint once a minute — the exact bug v1.30.4 fixed — because
// Node had cached the old modules at import and `npm i -g` only replaced the files
// on disk. Nothing in the product said so: the terminal banner still showed the
// boot version, and the browser bundle shows whichever version it was served.
// These tests pin the three-way comparison that makes that state visible.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nothing is executed: the install child and the kill that follows it are
// recorded and handed back as fakes, so no test in this file can install
// anything onto the machine running the suite or kill anything on it.
type FakeChild = {
  pid: number;
  stdout: { emit: (event: string, data: string) => void };
  stderr: { emit: (event: string, data: string) => void };
  emit: (event: string, ...args: unknown[]) => void;
  signals: (string | undefined)[];
};
const { spawns } = vi.hoisted(() => ({
  spawns: [] as { cmd: string; args: string[]; opts: Record<string, unknown>; child: FakeChild }[],
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  class Fake extends EventEmitter {
    pid = 4242;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    signals: (string | undefined)[] = [];
    kill(signal?: string) { this.signals.push(signal); return true; }
    unref() { /* the real one is unref'd so it cannot hold the process open */ }
  }
  return {
    spawn: (cmd: string, args: string[] = [], opts = {}) => {
      const child = new Fake();
      spawns.push({ cmd, args, opts, child: child as unknown as FakeChild });
      return child;
    },
    // exec.mjs names this import; nothing here should reach it.
    execFile: () => { throw new Error("test: execFile blocked"); },
  };
});

// @ts-expect-error — plain JS module, no types
import { isOlder, pickNotice, isNpxInstall, upgradeCommand, upgradeBlockedReason, lastMeaningfulLine, checkDue, nextMarker, npxRoot, bareSpecName, npxSpecFromMeta, upgradeMode, markerFileName, startUpgrade, upgradeStatus } from "../../server/self-update.mjs";

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

// Reported: a machine running `npx ccdeck` showed no update banner while an
// update existed. The check itself was fine — the marker was not. It cached
// npm's answer for 24 HOURS in a file every deck on the machine shares, so a
// deck started shortly before a release, or after another deck had already
// asked, showed nothing until the next day. npx runs are short-lived and each
// one inherited that same stale answer.
describe("checkDue", () => {
  const HOUR = 3600_000;
  const NOW = 1_800_000_000_000;

  it("asks on this process's first call, however fresh the marker is", () => {
    // The fix for the shared marker: a deck that just started is exactly where
    // the user expects the truth, and the request is ~20 bytes.
    expect(checkDue({ at: NOW - 1000, now: NOW, first: true })).toBe(true);
  });

  it("reuses the cached answer inside the window after that", () => {
    expect(checkDue({ at: NOW - 5 * 60_000, now: NOW })).toBe(false);
  });

  it("asks again once the window has passed", () => {
    expect(checkDue({ at: NOW - HOUR - 1, now: NOW })).toBe(true);
    expect(checkDue({ at: NOW - HOUR + 1, now: NOW })).toBe(false);
  });

  it("asks when told to, which is what the chip does", () => {
    expect(checkDue({ at: NOW, now: NOW, force: true })).toBe(true);
  });

  it("asks when there is no marker at all", () => {
    expect(checkDue({ at: undefined, now: NOW })).toBe(true);
    expect(checkDue({ at: null, now: NOW })).toBe(true);
  });

  it("asks when the marker is in the future, rather than trusting it forever", () => {
    // A clock moved backwards — by a VM resume or a timezone fix — would
    // otherwise silence the check until real time caught up.
    expect(checkDue({ at: NOW + 86_400_000, now: NOW })).toBe(true);
  });
});

// Reported with four decks alive at once: three served the same `checkedAt` to
// the millisecond, because one unsuffixed ~/.agents-deck/.self-update-check was
// shared by every deck on the machine — so the first one to ask npm pinned the
// answer for all of them, including a fresh `npx ccdeck` that had never written
// it and decks running an entirely different package. One file per name.
describe("markerFileName", () => {
  it("keys the marker by the package being asked about", () => {
    expect(markerFileName("ccdeck")).toBe(".self-update-check-ccdeck");
    expect(markerFileName("agents-deck")).toBe(".self-update-check-agents-deck");
    // The point of the fix: two aliases, two files, no shared window.
    expect(markerFileName("ccdeck")).not.toBe(markerFileName("agent-dag"));
  });

  it("never lets a scoped name become a path", () => {
    // `/` would nest the marker in a directory that does not exist, and `\` and
    // `:` are illegal in a Windows file name — the same string has to be a
    // usable file name on all three platforms.
    const n = markerFileName("@bargan/ccdeck");
    expect(n).toBe(".self-update-check-bargan-ccdeck");
    expect(n).not.toMatch(/[\\/:]/);
  });

  it("collapses anything else that cannot be in a file name", () => {
    expect(markerFileName("Deck Tools")).toBe(".self-update-check-deck-tools");
    expect(markerFileName("a*b?c")).toBe(".self-update-check-a-b-c");
    expect(markerFileName(" ccdeck ")).toBe(".self-update-check-ccdeck");
  });

  it("stays short enough to be a file name whatever it is given", () => {
    expect(markerFileName("x".repeat(300)).length).toBeLessThanOrEqual(84);
  });

  it("falls back to the default rather than to the shared file", () => {
    // A name that sanitises away must not land back on the unsuffixed marker
    // this whole change exists to stop sharing.
    for (const bad of [undefined, null, "", "   ", "@", "///", 7]) {
      expect(markerFileName(bad as never)).toBe(".self-update-check-agents-deck");
    }
  });
});

// Reported: a deck on a flaky line said "checked 2 minutes ago" and showed no
// banner, because a timeout was stamped into the marker exactly like an answer
// — same fresh timestamp, previous version — and then reported as the moment
// npm was asked. "npm has nothing newer" and "npm never replied" were the same
// state on the wire. These pin the two halves of telling them apart: the
// marker records the outcome, and a failure buys a short retry, not an hour.
describe("nextMarker", () => {
  const NOW = 1_800_000_000_000;
  const answered = { at: NOW - 3600_000, version: "1.33.0", failedAt: null };

  it("stamps the moment npm answered, and clears the last failure", () => {
    expect(nextMarker({ prev: { ...answered, failedAt: NOW - 60_000 }, now: NOW, ok: true, version: "1.34.0" }))
      .toEqual({ at: NOW, version: "1.34.0", failedAt: null });
  });

  it("records a failure as a failure, leaving the last real answer alone", () => {
    // The whole bug: `at` used to move to `now` here, so the UI reported an
    // hour-old version as freshly confirmed.
    expect(nextMarker({ prev: answered, now: NOW, ok: false, version: null }))
      .toEqual({ at: answered.at, version: "1.33.0", failedAt: NOW });
  });

  it("invents no check when the very first lookup fails", () => {
    // Nothing has ever been confirmed, so there is no timestamp to report and
    // no version to keep — but the attempt still has to be remembered, or the
    // backoff below has nothing to work from.
    expect(nextMarker({ prev: null, now: NOW, ok: false, version: null }))
      .toEqual({ at: null, version: null, failedAt: NOW });
  });
});

describe("checkDue after a failed lookup", () => {
  const HOUR = 3600_000;
  const RETRY = 300_000;
  const NOW = 1_800_000_000_000;

  it("retries sooner than it would after an answer", () => {
    // Rate-limiting exists so npm is not asked a question it already answered.
    // It answered nothing, so the hour does not apply.
    expect(checkDue({ at: NOW - 2 * HOUR, failedAt: NOW - RETRY - 1, now: NOW })).toBe(true);
  });

  it("still waits, so a registry that is down is not asked on every poll", () => {
    expect(checkDue({ at: NOW - 2 * HOUR, failedAt: NOW - 1000, now: NOW })).toBe(false);
  });

  it("does not read a first failed attempt as 'never checked'", () => {
    // `at` is null after a failure with no prior answer. Falling through to the
    // never-checked branch would fetch on every single /api/version call.
    expect(checkDue({ at: null, failedAt: NOW - 1000, now: NOW })).toBe(false);
    expect(checkDue({ at: null, failedAt: NOW - RETRY, now: NOW })).toBe(true);
  });

  it("yields to an explicit ask and to a fresh process", () => {
    // Clicking the chip while offline should retry, not repeat the backoff.
    expect(checkDue({ at: null, failedAt: NOW - 1000, now: NOW, force: true })).toBe(true);
    expect(checkDue({ at: null, failedAt: NOW - 1000, now: NOW, first: true })).toBe(true);
  });

  it("does not wait out a failure timestamp from the future", () => {
    expect(checkDue({ at: NOW - 2 * HOUR, failedAt: NOW + HOUR, now: NOW })).toBe(true);
  });
});

// The in-app `npm i -g` gets five minutes, for the cold install on a slow line
// the timeout exists for. Reaching that deadline used to be reported twice
// wrongly on Windows: npm is a .cmd shim spawned through cmd.exe, so the child
// is the wrapper and npm is a grandchild holding the inherited pipes — the kill
// stopped only the wrapper, and 'close' (which waits for those pipes) arrived
// minutes later, or never. Until it did, /api/version still said
// `state: "running"` and the button still said "installing…", with no retry
// possible; when it did, it carried the killed wrapper's status and the user
// was told "npm exited null" — sometimes while the drift notice, reading the
// files npm had gone on to write, offered a restart into the new version.
describe("an install that runs past its deadline", () => {
  const INSTALL_TIMEOUT_MS = 300_000;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let dir = "";
  let pkgRoot = "";
  let optOut: string | undefined;

  beforeEach(() => {
    spawns.length = 0;
    // Writable, no .git, no _npx — the one shape where an in-app install is
    // allowed. Under a temp directory, so nothing real is a candidate.
    dir = mkdtempSync(join(tmpdir(), "ccdeck-upgrade-"));
    pkgRoot = join(dir, "node_modules", "ccdeck");
    mkdirSync(pkgRoot, { recursive: true });
    optOut = process.env.AGENTS_DECK_NO_INSTALL;
    delete process.env.AGENTS_DECK_NO_INSTALL;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", platform);
    if (optOut === undefined) delete process.env.AGENTS_DECK_NO_INSTALL;
    else process.env.AGENTS_DECK_NO_INSTALL = optOut;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (os: string) => {
    // Windows is the platform this repo cannot execute, so it is claimed here;
    // killTree reads process.platform when the timer fires.
    Object.defineProperty(process, "platform", { value: os, configurable: true });
    expect(startUpgrade({ pkgRoot, name: "ccdeck" })).toMatchObject({ ok: true });
    expect(upgradeStatus().state).toBe("running");
    expect(spawns).toHaveLength(1);
    return spawns[0].child;
  };

  it("kills npm itself on Windows, not just the cmd.exe wrapper it hides behind", () => {
    const child = start("win32");
    vi.advanceTimersByTime(INSTALL_TIMEOUT_MS);

    expect(spawns).toHaveLength(2);
    expect(spawns[1].cmd.toLowerCase()).toContain("taskkill");
    // /T is the descendant walk; a plain kill is one TerminateProcess against
    // the wrapper and leaves npm writing to node_modules.
    expect(spawns[1].args).toEqual(["/pid", String(child.pid), "/T", "/F"]);
  });

  it("reports the timeout at the deadline, not whenever the pipes close", () => {
    const child = start("win32");
    vi.advanceTimersByTime(INSTALL_TIMEOUT_MS);

    // The regression: this stayed "running" — spinner and all, retries refused
    // — for as long as the unkilled grandchild kept the pipes open.
    expect(upgradeStatus()).toMatchObject({ state: "failed" });
    expect(upgradeStatus().error).toBe("timed out after 5 minutes");

    // And the wrapper's status, whenever it turns up, must not overwrite the
    // reason with a number nobody can act on.
    child.emit("close", null);
    expect(upgradeStatus()).toMatchObject({ state: "failed", error: "timed out after 5 minutes" });
  });

  it("signals the child directly off Windows, exactly as it did before", () => {
    for (const os of ["linux", "darwin"]) {
      spawns.length = 0;
      const child = start(os);
      vi.advanceTimersByTime(INSTALL_TIMEOUT_MS);

      expect(spawns).toHaveLength(1);      // no taskkill on a POSIX box
      expect(child.signals).toHaveLength(1); // the same plain kill as always
      child.emit("close", null, "SIGTERM");
      expect(upgradeStatus()).toMatchObject({ state: "failed", error: "timed out after 5 minutes" });
    }
  });

  it("counts an install that finished in the same breath as the timer as done", () => {
    // The files are on disk either way, and the drift notice is about to offer
    // the restart — saying "failed" next to it is the mismatch this fixes.
    const child = start("win32");
    vi.advanceTimersByTime(INSTALL_TIMEOUT_MS);
    child.emit("close", 0);
    expect(upgradeStatus()).toMatchObject({ state: "done", error: null });
  });

  it("still reports npm's own complaint when npm fails on its own", () => {
    const child = start("linux");
    child.stderr.emit("data", "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib'\n");
    child.emit("close", 1);
    expect(upgradeStatus()).toMatchObject({ state: "failed" });
    expect(upgradeStatus().error).toContain("permission denied");
  });
});
