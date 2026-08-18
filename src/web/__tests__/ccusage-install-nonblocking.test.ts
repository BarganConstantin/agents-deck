// #476. The boot-time ccusage install froze the whole process for as long as
// npm took — up to INSTALL_TIMEOUT_MS, two minutes — on exactly the machine
// where npm is slowest: a first run with nothing cached.
//
// The wrapper read as if it did not:
//
//     _installing = (async () => { installSync(spec); })()
//
// An async function body runs synchronously up to its first `await`, and there
// was none, so the IIFE converted a throw into a rejection and bought no
// asynchrony at all. `installSync` — a `spawnSync` of `npm install ccusage` —
// ran on the caller's stack, and the caller is `primeCcusage`, which bin/deck.js
// calls at boot beside genuinely async neighbours (ensureCswap, versionReport)
// and which answers `{ state: "installing" }`, a sentence that says the wait was
// deferred. It was not: no HTTP accept, no SSE write, no hook ingestion and no
// pulse line could happen until npm exited.
//
// The stubs below are the whole argument. One `npm install` takes NPM_MS either
// way — the difference is only WHERE those milliseconds are spent. `spawnSync`
// spends them on the caller's stack, which is what a busy-wait models honestly:
// a synchronous spawn is not a sleep the loop can do something else during.
// `spawn` spends them off it, and answers through the event loop like the real
// thing. A timer scheduled BEFORE the prime, due immediately, is then the
// probe: it cannot fire while the stack is busy, and its lateness is the length
// of the freeze.
//
// The rest pins what the fix may not cost: the vector npm is handed (#456's
// absolute `npm.cmd`, the quoted `--prefix` of #362, `windowsHide`, no shell),
// the deadline, the shared-promise dedupe, and the post-check that refuses to
// call a zero exit a success when nothing runnable came of it (#432).
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** How long one `npm install` takes in this file, on either path. Long enough
 *  that a freeze of that length cannot be mistaken for scheduler jitter, short
 *  enough to pay a handful of times. */
const NPM_MS = 200;

const { calls, npm } = vi.hoisted(() => ({
  calls: [] as { how: "sync" | "async"; file: string; args: string[]; opts: Record<string, unknown> }[],
  npm: {
    ms: 200,
    exit: 0,
    started: 0,
    finished: 0,
    /** What a successful `npm install --prefix` leaves on disk. Null is the
     *  #432 machine: a zero exit with nothing runnable behind it. */
    land: null as null | (() => void),
  },
}));

// Nothing real is executed and nothing is downloaded: both spawns are recorded
// and answered from `npm` above, so no test here can install anything onto the
// machine running the suite.
vi.mock("node:child_process", () => {
  type Sub = (v?: unknown) => void;
  return {
    // `npm install` as spawnSync runs it: on the caller's own stack, with no
    // yield anywhere in it. The busy-wait is not a caricature — it is what a
    // synchronous child costs this process, to the millisecond.
    spawnSync: (file: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
      calls.push({ how: "sync", file, args, opts });
      npm.started++;
      const until = Date.now() + npm.ms;
      while (Date.now() < until) { /* npm, working, right here */ }
      if (npm.exit === 0) npm.land?.();
      npm.finished++;
      return { status: npm.exit, stdout: "", stderr: npm.exit === 0 ? "" : "npm said no" };
    },
    // The same npm, the same duration, off this stack — reporting through the
    // event loop the way a real child does.
    spawn: (file: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
      calls.push({ how: "async", file, args, opts });
      npm.started++;
      const out: Sub[] = [], err: Sub[] = [], self: Record<string, Sub[]> = {};
      setTimeout(() => {
        if (npm.exit === 0) npm.land?.();
        else err.forEach(cb => cb("npm said no"));
        npm.finished++;
        self.close?.forEach(cb => cb(npm.exit));
      }, npm.ms);
      return {
        pid: 4242,
        stdout: { on: (_e: string, cb: Sub) => { out.push(cb); } },
        stderr: { on: (_e: string, cb: Sub) => { err.push(cb); } },
        on: (e: string, cb: Sub) => { (self[e] ||= []).push(cb); },
        kill: () => {},
        unref: () => {},
      };
    },
    // exec.mjs — reached through ccusage.mjs for spawnSpec and killTree —
    // imports it by name, and a name the mock omits is a load error.
    execFile: () => { throw new Error("test: execFile blocked"); },
  };
});

// ccusage.mjs resolves ~/.agents-deck/ccusage at import time out of os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows. Both point into a
// temp directory BEFORE the module loads, so nothing here can see — or write to
// — the developer's real managed install on any platform. PATH goes with them:
// #433 taught the deck to run a ccusage the user put on PATH, and this file is
// about the machine that has none, so a developer with `npm i -g ccusage` must
// not take that route instead of the install.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-block-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PATH: process.env.PATH,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  AGENTS_DECK_CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.PATH = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { installSpec, primeCcusage } = await import("../../server/ccusage.mjs");

const CCUSAGE_DIR = join(FAKE_HOME, ".agents-deck", "ccusage");
const PKG_DIR = join(CCUSAGE_DIR, "node_modules", "ccusage");
const ENTRY = join(PKG_DIR, "src", "cli.js");
if (!PKG_DIR.startsWith(FAKE_HOME)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${FAKE_HOME}`);

/** The tree a healthy `npm install ccusage --prefix` leaves behind, in the state
 *  resolveEntry accepts. */
const land = () => {
  mkdirSync(join(PKG_DIR, "src"), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "1.0.0", bin: "./src/cli.js" }));
  writeFileSync(ENTRY, "");
};

// note() truncates to the terminal's width, read per call from the real stream,
// and a narrow one would cut the substrings the diagnosis assertions look for.
const prevColumns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
Object.defineProperty(process.stderr, "columns", { value: 300, configurable: true, writable: true });

afterAll(() => {
  if (prevColumns) Object.defineProperty(process.stderr, "columns", prevColumns);
  else delete (process.stderr as unknown as { columns?: number }).columns;
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  npm.started = 0;
  npm.finished = 0;
  npm.exit = 0;
  npm.ms = NPM_MS;
  npm.land = land;
  rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
});

// An install left in flight would be handed to the next test by the shared
// `_installing` promise, which is the one piece of module state here that
// outlives a case. Waited out rather than reset, because that promise is not
// exported and reaching into it would be testing something else.
afterEach(async () => {
  const deadline = Date.now() + 5_000;
  while (npm.finished < npm.started && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5));
  }
  await new Promise(r => setTimeout(r, 20));
});

/** Poll until `ok` — never with fake timers, because what is under test here is
 *  whether the real loop gets a turn. */
async function until(ok: () => boolean, label: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

/** console.error is ccusage.mjs's only way out to the terminal; a failing
 *  install writes there, and the suite should not. */
function captured() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    lines: () => spy.mock.calls.map(a => a.map(String).join(" ")),
    done: () => spy.mockRestore(),
  };
}

describe("the boot-time ccusage install", () => {
  it("gives the event loop back before npm has finished", async () => {
    const said = captured();
    const t0 = Date.now();
    const fired: number[] = [];
    // Scheduled BEFORE the prime and due immediately, so nothing but a blocked
    // stack can keep it waiting. This is the probe the issue asked for.
    setTimeout(() => { fired.push(Date.now() - t0); }, 0);

    const state = primeCcusage();
    const returned = Date.now() - t0;

    // The state the deck reports is "the wait was deferred" …
    expect(state).toEqual({ state: "installing" });
    // … so the call itself must not have paid it.
    expect.soft(returned, `primeCcusage() itself took ${returned}ms`).toBeLessThan(NPM_MS / 2);

    // And the loop was genuinely free while npm ran: a timer due at 0ms fired
    // while the install was still in flight, instead of after it.
    await until(() => fired.length === 1, "the timer scheduled before the prime");
    expect.soft(fired[0], `a timer due at 0ms fired ${fired[0]}ms late`).toBeLessThan(NPM_MS / 2);

    // The stub is not a no-op, which is what makes the two numbers above mean
    // anything: npm really did take its NPM_MS, and really did install.
    await until(() => npm.finished === 1, "the install to finish");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(NPM_MS);
    expect(existsSync(ENTRY)).toBe(true);
    expect(said.lines()).toEqual([]);
    said.done();
  });

  it("starts npm with spawn, and never with spawnSync", async () => {
    primeCcusage();
    await until(() => npm.finished === 1, "the install to finish");

    // The mechanism, not the timing — spawnSync has no non-blocking form, so
    // any reappearance of it here is the freeze coming back.
    expect.soft(calls.map(c => c.how)).toEqual(["async"]);
    expect.soft(calls.some(c => c.how === "sync")).toBe(false);
  });

  it("costs one npm between two callers that arrive in the same tick", async () => {
    const said = captured();
    // The `_installing` dedupe, which only means anything while an install can
    // still be in flight when the second caller arrives. Blocking made this
    // unreachable: the first call could not return until the install was over.
    const first = primeCcusage();
    const second = primeCcusage();

    expect.soft(first).toEqual({ state: "installing" });
    expect.soft(second).toEqual({ state: "installing" });
    await until(() => npm.finished >= 1, "the install to finish");
    expect.soft(calls.filter(c => c.args.includes("install"))).toHaveLength(1);
    said.done();
  });
});

describe("what the install still reports when it goes wrong", () => {
  it("refuses to call a zero exit a success when nothing runnable came of it", async () => {
    // #432's shape, on the new path: npm exits 0, the tree is not there, and an
    // exit code is npm's opinion rather than a fact about the disk.
    npm.land = null;
    const said = captured();

    primeCcusage();
    await until(() => said.lines().length > 0, "the failure to be reported");

    const line = said.lines().join("\n");
    expect(line).toMatch(/install failed/);
    expect(line).toContain("exited 0");
    expect(line).toMatch(/is not there/); // which level of the tree is missing
    said.done();
  });

  it("carries npm's own words out of a non-zero exit, on one line", async () => {
    npm.exit = 1;
    const said = captured();

    primeCcusage();
    await until(() => said.lines().length > 0, "the failure to be reported");

    const line = said.lines().join("\n");
    expect(line).toMatch(/install failed/);
    expect(line).toContain("npm said no");
    // The deck repaints its pulse line with a bare \r, so nothing written while
    // it is painting may carry a newline (#432).
    expect(line).not.toMatch(/[\r\n]/);
    said.done();
  });
});

// ── the vector, which the move off spawnSync may not have touched ───────────
//
// #456 is the reason this is hashed rather than eyeballed. npm's `.cmd` shim
// locates its own payload relative to `%~dp0` — the command token cmd.exe was
// handed — so a bare `npm.cmd` made it look under the deck's working directory
// and died with `Cannot find module 'C:\Users\vceban\node_modules\npm\bin\…'` on
// a machine whose npm was perfectly healthy. The hashes below were taken from
// the source BEFORE this fix; they are here so a change to how the install is
// STARTED can never quietly change what is started.

const NODE_DIR = "C:\\Program Files\\nodejs";
/** The reported machine, as three injected values: nothing here touches the
 *  disk of whatever OS is running the suite. */
const STOCK_WINDOWS = {
  execPath: `${NODE_DIR}\\node.exe`,
  pathEnv: `C:\\Windows\\system32;${NODE_DIR}`,
  exists: (p: string) => p === `${NODE_DIR}\\npm.cmd`,
};
const WIN32_SPEC_SHA = "970c09196421c930cc703cdfacfeed83eb8597d80d76c12720a208881630a3d6";
const POSIX_SPEC_SHA = "37041109d386cc33a8a036c6f958b5d8b68a1df8f3717e756dfaddf0fe6c4cae";

/**
 * One spawn spec as a stable string. The prefix is this file's temp home, so it
 * is normalised out; `file` on Windows is whatever %COMSPEC% says, so only its
 * basename is kept. Everything that decides what npm actually does — the
 * argument vector, the cmd.exe line, the options — is hashed as it is.
 */
function hashOf(spec: { file: string; args: string[]; opts: Record<string, unknown> }) {
  const text = JSON.stringify({ file: basename(spec.file).toLowerCase(), args: spec.args, opts: spec.opts })
    .split(JSON.stringify(CCUSAGE_DIR).slice(1, -1)).join("<PREFIX>");
  return createHash("sha256").update(text).digest("hex");
}

describe("what the install spawns", () => {
  it("is installSpec's own vector, handed to spawn untouched", async () => {
    primeCcusage();
    await until(() => npm.started === 1, "the install to start");

    const spec = installSpec("latest", process.platform);
    const [call] = calls;
    expect(call.file).toBe(spec.file);
    expect(call.args).toEqual(spec.args);
    // windowsHide is what keeps a console window from flashing up on Windows,
    // and it was on the spawnSync options this replaced.
    expect(call.opts.windowsHide).toBe(true);
    // Never `shell: true`, which is what pasted `--prefix C:\Users\John Smith`
    // into two arguments in the first place (#362).
    expect(call.opts.shell).toBeUndefined();
    // And whatever spawnSpec asked for — windowsVerbatimArguments on Windows —
    // survives the spread.
    for (const [key, value] of Object.entries(spec.opts)) expect(call.opts[key]).toEqual(value);

    await until(() => npm.finished === 1, "the install to finish");
  });

  it("is byte-for-byte the vector #456 left behind, on Windows and on POSIX", () => {
    expect(hashOf(installSpec("latest", "win32", STOCK_WINDOWS))).toBe(WIN32_SPEC_SHA);
    expect(hashOf(installSpec("latest", "linux"))).toBe(POSIX_SPEC_SHA);
    expect(hashOf(installSpec("latest", "darwin"))).toBe(POSIX_SPEC_SHA);
    // Said again in words, because the hash alone would not say WHICH byte
    // matters: cmd.exe is handed the shim's full path, never the bare name.
    const win = installSpec("latest", "win32", STOCK_WINDOWS);
    expect(win.args[3]).toContain(`${NODE_DIR}\\npm.cmd`);
    expect(win.args[3]).not.toContain('""npm.cmd"');
  });
});
