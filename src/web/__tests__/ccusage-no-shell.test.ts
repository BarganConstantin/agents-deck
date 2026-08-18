// The ccusage fallback run — `npx -y ccusage@latest daily --json --since <x>`,
// taken when the managed install is missing AND `npm install` failed — was
// spawned with `shell: true`, because npx on Windows is a .cmd shim that spawn
// cannot launch any other way. Node's shell mode joins the file and its
// arguments with single spaces and no quoting and hands the string to
// /bin/sh -c, and the last of those arguments is whatever GET /api/ccusage was
// asked for: `?since=1;id;` ran `id`. The same reasoning the install path
// already carried (see ccusage-install-args.test.ts) applies here with a sharper
// edge, because this argv has an attacker's string in it.
//
// These pin the fallback command line on both platforms and pin that neither
// runner branch is given a shell.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nothing real is executed: every spawn is recorded and answered with a fake
// child that prints an empty usage report, so no test here can install or run
// anything on the machine running the suite.
const { calls, fakeChild } = vi.hoisted(() => {
  type Sub = (v?: unknown) => void;
  return {
    calls: [] as { file: string; args: string[]; opts: Record<string, unknown> }[],
    // Just enough of a ChildProcess for runCcusage: the listeners go on
    // synchronously the moment spawn returns, so the output and the exit are
    // delivered a tick later.
    fakeChild: (stdout: string) => {
      const out: Sub[] = [], err: Sub[] = [], self: Record<string, Sub[]> = {};
      setTimeout(() => {
        out.forEach(cb => cb(stdout));
        self.close?.forEach(cb => cb(0));
      }, 0);
      return {
        pid: 4242,
        stdout: { on: (_ev: string, cb: Sub) => { out.push(cb); } },
        stderr: { on: (_ev: string, cb: Sub) => { err.push(cb); } },
        on: (ev: string, cb: Sub) => { (self[ev] ||= []).push(cb); },
        kill: () => {},
        unref: () => {},
      };
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: (file: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    calls.push({ file, args, opts });
    return fakeChild(`{"daily":[],"totals":null}`);
  },
  // npm is unavailable, which is exactly the precondition for the npx fallback:
  // the managed install cannot be created, so getRunner falls through to it.
  spawnSync: (file: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    calls.push({ file, args, opts });
    return { status: 1, stdout: "", stderr: "test: no npm here" };
  },
  // exec.mjs — reached through ccusage.mjs for both spawnSpec and killTree —
  // imports it by name, and a name the mock omits is a load error.
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// ccusage.mjs resolves ~/.agents-deck/ccusage at import time from os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows. Both point at a temp
// directory BEFORE the module loads, so nothing here can see — or write to —
// the developer's real managed install on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-shell-"));
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
// #433 added a third runner — a ccusage the user provided, at
// AGENTS_DECK_CCUSAGE or on PATH — and it is tried before the npx fallback this
// file is about. Both are emptied so the fallback is what gets reached: a
// developer with `npm i -g ccusage` would otherwise never spawn npx here, and
// the file would be checking nothing on their machine.
process.env.PATH = FAKE_HOME;
delete process.env.AGENTS_DECK_CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { fallbackSpec, fetchCcusageDaily } = await import("../../server/ccusage.mjs");

const PKG_DIR = join(FAKE_HOME, ".agents-deck", "ccusage", "node_modules", "ccusage");

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
 * The single command-line argument cmd.exe is handed, back as the list npx will
 * actually see. The whole line is itself wrapped in quotes, the way `cmd /c`
 * wants it, so that pair comes off before the per-argument ones are read.
 */
function cmdTokens(line: string) {
  const inner = line.replace(/^"/, "").replace(/"$/, "");
  return [...inner.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

const DAILY = ["daily", "--json", "--since", "20260101"];

describe("the ccusage npx fallback command line", () => {
  it("spawns npx directly, with the argument vector intact, off Windows", () => {
    for (const platform of ["linux", "darwin"]) {
      const { file, args, opts } = fallbackSpec(DAILY, platform);
      expect(file).toBe("npx");
      expect(args).toEqual(["-y", "ccusage@latest", ...DAILY]);
      expect(opts).toEqual({}); // no shell, no verbatim arguments
    }
  });

  it("routes the .cmd shim through cmd.exe with every argument quoted on Windows", () => {
    const { file, args, opts } = fallbackSpec(DAILY, "win32");

    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    expect(opts.shell).toBeUndefined();
    // `npx.cmd`, not `npx`: only a .cmd/.bat name routes through cmd.exe at all,
    // and a bare `npx` cannot be spawned on Windows without a shell to apply
    // PATHEXT — asking for it would trade the injection for an ENOENT.
    expect(cmdTokens(args[3])).toEqual(["npx.cmd", "-y", "ccusage@latest", ...DAILY]);
  });

  it("keeps a metacharacter inside one argument instead of ending the command", () => {
    // The shape of the original report. Nothing legitimate looks like this — the
    // route refuses it now — but the sink has to be inert on its own, because
    // that is what makes the gate a second lock rather than the only one.
    const nasty = ["daily", "--json", "--since", "1;id;", "--until", "20260101 & whoami"];

    // POSIX: still one element per argument, so /bin/sh never sees a string.
    expect(fallbackSpec(nasty, "linux").args).toEqual(["-y", "ccusage@latest", ...nasty]);

    // Windows: each argument is separately quoted into the cmd.exe line, so the
    // `;`, the `&` and the space stay inside their own token.
    const win = fallbackSpec(nasty, "win32");
    expect(cmdTokens(win.args[3])).toEqual(["npx.cmd", "-y", "ccusage@latest", ...nasty]);
  });
});

describe("what fetchCcusageDaily actually spawns", () => {
  it("never gives the npx fallback a shell", async () => {
    // No managed install and npm fails, which is the only way to reach the npx
    // fallback at all — the precondition the original report named.
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });

    await fetchCcusageDaily({ since: "20260201" });

    const run = calls.find(c => JSON.stringify(c.args).includes("ccusage@latest") && !c.args.includes("install"));
    expect(run).toBeDefined();

    const spec = fallbackSpec(["daily", "--json", "--since", "20260201"], process.platform);
    expect(run!.file).toBe(spec.file);
    expect(run!.args).toEqual(spec.args);
    // The regression, in one line: shell mode is what pasted the argv into a
    // string for /bin/sh -c.
    expect(run!.opts.shell).toBeUndefined();
    // And no other spawn this provoked — the failed `npm install` included —
    // asks for one either.
    for (const c of calls) expect(c.opts.shell).toBeUndefined();
  });

  it("never gives the managed install a shell either", async () => {
    mkdirSync(join(PKG_DIR, "src"), { recursive: true });
    writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "1.0.0", bin: "./src/cli.js" }));
    writeFileSync(join(PKG_DIR, "src", "cli.js"), "");
    process.env.AGENTS_DECK_NO_INSTALL = "1"; // no background `npm view` in the way

    await fetchCcusageDaily({ since: "20260202" });
    delete process.env.AGENTS_DECK_NO_INSTALL;

    const run = calls.find(c => c.args.some(a => a.endsWith("cli.js")));
    expect(run).toBeDefined();
    // `node <entry> daily --json --since …` — the healthy path, and the reason
    // the hole was closed on most machines most of the time.
    expect(run!.file).toBe(process.execPath);
    expect(run!.args.slice(1)).toEqual(["daily", "--json", "--since", "20260202"]);
    expect(run!.opts.shell).toBeUndefined();
  });
});
