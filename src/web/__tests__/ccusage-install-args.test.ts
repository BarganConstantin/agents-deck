// The managed ccusage install ran `npm install ccusage@latest --prefix
// ~/.agents-deck/ccusage` with `shell: true` on Windows, because npm there is a
// .cmd shim that spawn cannot launch any other way. Node's shell mode joins the
// file and its arguments with single spaces and no quoting, so on a profile like
// C:\Users\John Smith the command line read `--prefix C:\Users\John
// Smith\.agents-deck\ccusage`: npm took the prefix as C:\Users\John and the rest
// as a second package to install, exited non-zero, and the install never
// happened — every boot printed "install failed" and every usage-history modal
// fell back to the slow `npx -y ccusage@latest` path. These tests pin the
// command line the install gets on Windows and on POSIX.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nothing is executed: every spawn is recorded and refused, so a regression
// cannot install anything onto the machine running the suite.
const { calls } = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
}));
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[] = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    throw new Error("test: spawn blocked");
  },
  spawnSync: (cmd: string, args: string[] = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    return { status: 1, stdout: "", stderr: "test: spawnSync blocked" };
  },
  // exec.mjs (spawnSpec's module) imports this; unused here, but a mocked
  // module must still carry every export its importers name.
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// The bug only shows up when the home path contains a space, so the fake home
// has one. homedir() reads $HOME on POSIX and %USERPROFILE% on Windows; both
// point at the temp directory BEFORE the module loads, so no test here can read
// or write the developer's real managed install on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck ccusage "));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  PATH: process.env.PATH,
  CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;
// #433: primeCcusage now uses a ccusage the user already has — at
// AGENTS_DECK_CCUSAGE or on PATH — rather than fetching a second copy of it.
// This file is about the install it starts when there is no such thing, so
// there must be no such thing, whatever the developer running the suite has
// installed globally.
process.env.PATH = FAKE_HOME;
delete process.env.AGENTS_DECK_CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { installSpec, primeCcusage } = await import("../../server/ccusage.mjs");

const PREFIX = join(FAKE_HOME, ".agents-deck", "ccusage");
const INSTALL_ARGS = ["install", "ccusage@latest", "--prefix", PREFIX,
  "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"];

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE],
    ["AGENTS_DECK_NO_INSTALL", prev.NO_INSTALL], ["PATH", prev.PATH],
    ["AGENTS_DECK_CCUSAGE", prev.CCUSAGE]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => { calls.length = 0; });

/**
 * The single command-line argument cmd.exe is handed, back as the list npm will
 * actually see. The whole line is itself wrapped in quotes, the way `cmd /c`
 * wants it, so that pair comes off before the per-argument ones are read.
 */
function cmdTokens(line: string) {
  const inner = line.replace(/^"/, "").replace(/"$/, "");
  return [...inner.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

describe("the ccusage install command line", () => {
  it("keeps a home path with a space in one argument on Windows", () => {
    expect(PREFIX).toContain(" "); // the whole point of this file

    const { file, args, opts } = installSpec("latest", "win32");

    // Routed through cmd.exe the way Node's own shell mode does it, but with
    // each argument quoted here rather than pasted together.
    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    // And never `shell: true`, which is what concatenated them in the first place.
    expect(opts.shell).toBeUndefined();

    // npm.cmd sees the prefix as a single argument, spaces and all.
    expect(cmdTokens(args[3])).toEqual(["npm.cmd", ...INSTALL_ARGS]);
    // The regression: unquoted, npm read --prefix as the first word only and
    // the remainder as another package to install.
    expect(args[3]).not.toContain(`--prefix ${PREFIX}`);
  });

  it("spawns npm directly, with the argument vector intact, off Windows", () => {
    for (const platform of ["linux", "darwin"]) {
      const { file, args, opts } = installSpec("latest", platform);
      expect(file).toBe("npm");
      expect(args).toEqual(INSTALL_ARGS);
      expect(opts).toEqual({}); // no shell, no verbatim arguments
    }
  });

  it("is what the install actually spawns", () => {
    expect(primeCcusage()).toEqual({ state: "installing" });

    const spec = installSpec("latest", process.platform);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(spec.file);
    expect(calls[0].args).toEqual(spec.args);
    expect(calls[0].opts.shell).toBeUndefined();
    // Belt and braces: the install this test provokes was aimed at the temp
    // home, so nothing here could have touched the real one.
    expect(JSON.stringify(calls[0].args)).toContain(JSON.stringify(FAKE_HOME).slice(1, -1));
  });
});
