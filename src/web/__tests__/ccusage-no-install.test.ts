// AGENTS_DECK_NO_INSTALL=1 is documented as "never install or update
// claude-swap / ccusage, and never ask npm about releases", but only the
// startup priming in bin/deck.js honoured it. Opening the usage-history modal
// called /api/ccusage → fetchCcusageDaily → getRunner, which on a machine with
// no managed install ran `npm install ccusage@latest` (or `npx -y
// ccusage@latest`) — a registry download the user had explicitly forbidden —
// and, when ccusage was already installed, still ran `npm view ccusage
// version` plus a background upgrade. These tests pin all three refusals.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every spawn is recorded and none is executed, so a regression that reaches
// the install path shows up as a recorded `npm install` instead of actually
// downloading anything onto the machine running the suite.
const { calls } = vi.hoisted(() => ({ calls: [] as { cmd: string; args: string[] }[] }));
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[] = []) => {
    calls.push({ cmd, args });
    throw new Error("test: spawn blocked");
  },
  spawnSync: (cmd: string, args: string[] = []) => {
    calls.push({ cmd, args });
    return { status: 1, stdout: "", stderr: "test: spawnSync blocked" };
  },
  // Nothing here calls it, but exec.mjs — reached through ccusage.mjs for
  // killTree — imports it by name, and a name the mock omits is a load error.
  execFile: (cmd: string, args: string[] = []) => {
    calls.push({ cmd, args });
    throw new Error("test: execFile blocked");
  },
}));

// ccusage.mjs resolves ~/.agents-deck/ccusage at import time from os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows. Both point at a temp
// directory BEFORE the module loads, so nothing here can see — or write to —
// the developer's real managed install on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevNoInstall = process.env.AGENTS_DECK_NO_INSTALL;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

// @ts-expect-error — .mjs server module, no types
const { fetchCcusageDaily, primeCcusage } = await import("../../server/ccusage.mjs");

const PKG_DIR = join(FAKE_HOME, ".agents-deck", "ccusage", "node_modules", "ccusage");

const restore = (key: "HOME" | "USERPROFILE" | "AGENTS_DECK_NO_INSTALL", was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("AGENTS_DECK_NO_INSTALL", prevNoInstall);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => { calls.length = 0; });

describe("fetchCcusageDaily under AGENTS_DECK_NO_INSTALL=1", () => {
  it("installs nothing when ccusage is missing, and says why", async () => {
    process.env.AGENTS_DECK_NO_INSTALL = "1";
    // Distinct --since per test: results are cached per range for two minutes.
    const res = await fetchCcusageDaily({ since: "20260101" });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("AGENTS_DECK_NO_INSTALL");
    // Not one npm install, and not the npx fallback either — `npx -y
    // ccusage@latest` downloads and runs the same package.
    expect(calls).toEqual([]);
  });

  it("uses an already-installed ccusage without asking npm for a newer one", async () => {
    process.env.AGENTS_DECK_NO_INSTALL = "1";
    mkdirSync(join(PKG_DIR, "src"), { recursive: true });
    writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "1.0.0", bin: "./src/cli.js" }));
    writeFileSync(join(PKG_DIR, "src", "cli.js"), "");

    // The run itself is allowed: the promise is about installing, not about
    // refusing to use what is already on disk.
    await fetchCcusageDaily({ since: "20260102" });

    expect(primeCcusage()).toEqual({ state: "present", version: "1.0.0" });
    // The installed copy is what ran, and npm was never consulted.
    expect(calls.some(c => c.args.some(a => a.endsWith("cli.js")))).toBe(true);
    for (const c of calls) {
      expect(c.args).not.toContain("view");    // `npm view ccusage version`
      expect(c.args).not.toContain("install"); // background upgrade
    }
  });
});

describe("fetchCcusageDaily without the opt-out", () => {
  it("still reaches the install path, so the tests above prove the guard", async () => {
    delete process.env.AGENTS_DECK_NO_INSTALL;
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });

    await fetchCcusageDaily({ since: "20260103" });

    const install = calls.find(c => c.args.includes("install"));
    expect(install).toBeDefined();
    expect(install!.args).toContain("ccusage@latest");
    // Belt and braces: the install this test provokes was aimed at the temp
    // home, so no test in this file could have touched the real one.
    expect(install!.args[install!.args.indexOf("--prefix") + 1]).toContain(FAKE_HOME);
  });
});
