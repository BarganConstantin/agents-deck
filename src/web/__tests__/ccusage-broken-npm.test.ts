// A Windows machine whose npm.cmd / npx.cmd shims are broken — `%~dp0` resolved
// to the user's home root, so both shims launch and Node then cannot load the
// script they point at (#432). Two things went wrong that are ours.
//
// The modal said "ccusage could not report usage — try again". npxMissing, the
// one place a missing npx turns into an actionable sentence, tests for four
// spellings of "the shell could not find it" and this is a fifth shape: the
// shim WAS found, and `MODULE_NOT_FOUND` is not `not found` — the underscore is
// not a space. So it fell through to the reason map, and trying again is the
// one thing that cannot work while npm is broken on disk.
//
// And both failures were handed to console.error carrying a subprocess's entire
// stderr, which is a fifteen-line Node stack trace. The deck repaints its pulse
// line every 800ms with a bare `\r` (see term.mjs), so that dump landed over
// its own boot report — and primeCcusage runs at boot, so on such a machine it
// was the first thing on screen.
//
// These pin the fifth sentence, the four older ones that must not lose theirs,
// the one-line rule for anything written while the deck is painting, and the
// one failure in ccusage.mjs that really was permanent: a managed install that
// resolves but cannot run, which nothing ever re-checked.
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCUSAGE_REASONS, explainCcusageFailure } from "../admin-failure";
// @ts-expect-error — .mjs server module, no types
import { oneLine } from "../../server/term.mjs";

// The verbatim stderr from the report, both halves. Written with real \n here;
// the Windows form of the same bytes is checked separately below.
const NPX_STACK = [
  "node:internal/modules/cjs/loader:1573",
  "  throw err;",
  "  ^",
  "",
  "Error: Cannot find module 'C:\\Users\\vceban\\node_modules\\npm\\bin\\npx-cli.js'",
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1569:15)",
  "    at defaultResolveImpl (node:internal/modules/cjs/loader:1025:19)",
  "    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1030:22)",
  "    at Module._load (node:internal/modules/cjs/loader:1179:37)",
  "    at TraceSpan.traceSync (node:internal/trace_events_async_hooks:35:20)",
  "    at Module.runMain (node:internal/modules/run_main:123:12)",
  "    at node:internal/main/run_main_module:36:49 {",
  "  code: 'MODULE_NOT_FOUND',",
  "  requireStack: []",
  "}",
  "",
  "Node.js v26.7.0",
].join("\n");

const NPM_STACK = NPX_STACK.replace("npx-cli.js", "npm-prefix.js");

// ── the sentence the modal shows ────────────────────────────────────────────

// The name is deliberately about the OBSERVATION rather than the cause: #450
// established that the deck cannot see which of the two produced this stack.
describe("npx launched and Node could not load the script it points at", () => {
  const said = (error: string) => explainCcusageFailure({ reason: "run_failed", error }, "x");

  it("does not tell the user to try again, which is the one thing that cannot work", () => {
    // The exact fall-through the report caught: npxMissing sees the word npx
    // and no failure word it knows, so the reason map answered.
    expect(said(NPX_STACK)).not.toBe(CCUSAGE_REASONS.run_failed);
    expect(said(NPX_STACK)).not.toMatch(/try again/i);
  });

  it("names what the deck ran and what came back, without a verdict on the machine", () => {
    // This assertion used to require the words "damaged" and "reinstall", which
    // is the claim #450 removed. Node's stderr here is produced by a damaged npm
    // AND by the deck's own spawn reaching the wrong npx — `npx ccdeck` prepends
    // a `node_modules\.bin` for every ancestor of the cwd onto PATH, and
    // fallbackSpec asks cmd.exe for a bare `npx.cmd` — and nothing in the text
    // separates them. The reported user's npm worked (`npm i -g ccdeck` added
    // twelve packages on the same machine), so the reinstall cost them an hour
    // and could not have helped. What survives is the part that was right: the
    // sentence names npx, says what failed, and offers a remedy that is not
    // "try again".
    const out = said(NPX_STACK);
    expect(out).toMatch(/npm|npx/);
    expect(out).toMatch(/could not load/i);
    expect(out).not.toMatch(/reinstall/i);
    // A check the user can run in thirty seconds, which is what tells the two
    // causes apart.
    expect(out).toMatch(/where npx|npm config get prefix/);
  });

  it("does not claim npx is missing from PATH, because it is on PATH and ran", () => {
    // The older sentence says "npx is not on this deck's PATH". Saying that to
    // someone who can see npx on their PATH is how a reader stops believing the
    // rest of the message.
    expect(said(NPX_STACK)).not.toMatch(/not on this deck's PATH/);
  });

  it("says the same for the npm half, which is how the managed install died", () => {
    expect(said(NPM_STACK)).toBe(said(NPX_STACK));
  });

  it("reads the Windows form of those bytes — CRLF, and the .cmd shim's name", () => {
    // Windows is the platform this failure was reported from, and a child there
    // ends its lines with \r\n. Nothing in the matching may depend on \n alone.
    const crlf = NPX_STACK.replace(/\n/g, "\r\n").replace("npx-cli.js", "npx.cmd-cli.js");
    expect(said(crlf)).toBe(said(NPX_STACK));
  });

  it("still tells a machine that has no npx at all to install one", () => {
    // The four older spellings, which are a DIFFERENT machine — npx absent
    // rather than damaged — and must keep the PATH remedy rather than being
    // swept into the new sentence.
    const ABSENT = [
      "/bin/sh: 1: npx: not found",
      "sh: npx: command not found",
      "zsh: command not found: npx",
      "'npx.cmd' is not recognized as an internal or external command,\r\noperable program or batch file.",
      "spawn npx ENOENT",
    ];
    for (const text of ABSENT) {
      expect(said(text), text).toMatch(/PATH/);
      expect(said(text), text).not.toMatch(/reinstall/i);
    }
  });

  it("does not blame the machine's npm for the deck's own half-written copy", () => {
    // ccusage.mjs rebuilds this one by itself, and it has nothing to do with the
    // user's Node — so sending them to reinstall it would be advice for a
    // machine that is fine. The discriminator is that npm and npx are not named.
    const ours = [
      "node:internal/modules/esm/resolve:272",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module "
        + "'C:\\Users\\vceban\\.agents-deck\\ccusage\\node_modules\\ccusage\\dist\\chunk.js' "
        + "imported from C:\\Users\\vceban\\.agents-deck\\ccusage\\node_modules\\ccusage\\src\\cli.js",
      "  code: 'ERR_MODULE_NOT_FOUND'",
    ].join("\n");
    expect(said(ours)).toBe(CCUSAGE_REASONS.run_failed);
  });
});

// ── the one-line rule ───────────────────────────────────────────────────────

describe("what may be written while the deck is painting its own rows", () => {
  it("reduces a stack trace to one line, and to the line that names the failure", () => {
    const out = oneLine(NPX_STACK, 200);
    expect(out).not.toContain("\n");
    // Not the first line, which is `node:internal/modules/cjs/loader:1573` and
    // says nothing; the reader wants the one five rows further down.
    expect(out).toContain("Cannot find module");
    expect(out).not.toContain("at Module._resolveFilename");
  });

  it("leaves no carriage return in it, which on Windows is where they come from", () => {
    // A lone \r is a cursor jump to column 0. A CRLF dump that only had its \n
    // removed would still overwrite whatever the deck had drawn on that row —
    // so this is the Windows half of the same rule, and the reported machine's.
    const out = oneLine(NPX_STACK.replace(/\n/g, "\r\n"), 200);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toContain("Cannot find module");
  });

  it("carries no escape sequence out of a string the deck did not write", () => {
    const out = oneLine("\u001b[31mError: boom\u001b[0m\nsecond line", 200);
    expect(out).toBe("Error: boom");
  });

  it("stays inside the room it was given, so one line cannot become two", () => {
    const out = oneLine(NPX_STACK, 40);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it("has nothing to say about nothing", () => {
    expect(oneLine("", 80)).toBe("");
    expect(oneLine(undefined, 80)).toBe("");
    expect(oneLine("\n\n   \n", 80)).toBe("");
  });

  it("keeps a plain one-line message as it is", () => {
    expect(oneLine("ccusage exited 3", 80)).toBe("ccusage exited 3");
  });
});

// ── the server, with every spawn faked ──────────────────────────────────────
//
// Nothing real is executed and nothing is installed: spawn is recorded and
// answered from a plan, and spawnSync — the `npm install` — always fails, which
// is the precondition for both cases below.

const { calls, plan, fakeChild } = vi.hoisted(() => {
  type Sub = (v?: unknown) => void;
  type Reply = { stdout?: string; stderr?: string; code: number };
  return {
    calls: [] as { file: string; args: string[] }[],
    plan: [] as Reply[],
    fakeChild: (reply: Reply) => {
      const out: Sub[] = [], err: Sub[] = [], self: Record<string, Sub[]> = {};
      setTimeout(() => {
        if (reply.stdout) out.forEach(cb => cb(reply.stdout));
        if (reply.stderr) err.forEach(cb => cb(reply.stderr));
        self.close?.forEach(cb => cb(reply.code));
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
  spawn: (file: string, args: string[] = []) => {
    calls.push({ file, args });
    return fakeChild(plan.shift() ?? { stdout: `{"daily":[],"totals":null}`, code: 0 });
  },
  // A broken npm on this machine, which is what sends every case through the
  // fallback — and what leaves a half-written managed install behind in the
  // first place. Its stderr is the reported machine's, a stack trace and not a
  // line, because that is the whole point: this is what used to be printed.
  spawnSync: (file: string, args: string[] = []) => {
    calls.push({ file, args });
    return {
      status: 1,
      stdout: "",
      stderr: [
        "node:internal/modules/cjs/loader:1573",
        "  throw err;",
        "Error: Cannot find module 'C:\\Users\\vceban\\node_modules\\npm\\bin\\npm-prefix.js'",
        "    at Module._resolveFilename (node:internal/modules/cjs/loader:1569:15)",
        "  code: 'MODULE_NOT_FOUND'",
      ].join("\n"),
    };
  },
  // exec.mjs is reached through ccusage.mjs and imports this by name.
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// ccusage.mjs resolves ~/.agents-deck/ccusage at import time out of os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows. Both point into a
// temp directory BEFORE the module loads, so nothing here can see — or delete —
// the developer's real managed install on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-broken-npm-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;

// @ts-expect-error — .mjs server module, no types
const { cannotLoadModule, fetchCcusageDaily, primeCcusage } = await import("../../server/ccusage.mjs");

const CCUSAGE_DIR = join(FAKE_HOME, ".agents-deck", "ccusage");
const PKG_DIR = join(CCUSAGE_DIR, "node_modules", "ccusage");
if (!PKG_DIR.startsWith(FAKE_HOME)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${FAKE_HOME}`);

/**
 * A managed install in the state a half-finished `npm install` leaves: a
 * package.json and an entry file resolveEntry is happy with, and nothing behind
 * them that runs.
 *
 * The marker is dated now on purpose. Without it the once-a-day `npm view`
 * check is due, and that spawn would land in the middle of the plan below —
 * this is the same reason ccusage-no-shell.test.ts keeps installs off.
 */
function damagedInstall() {
  mkdirSync(join(PKG_DIR, "src"), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "1.2.3", bin: "./src/cli.js" }));
  writeFileSync(join(PKG_DIR, "src", "cli.js"), "");
  writeFileSync(join(CCUSAGE_DIR, ".last-update-check"), String(Date.now()));
}

// The width is read per call from the real stream, so it is pinned here — a
// narrow terminal would truncate the very substring these assertions look for,
// and the width rule itself is checked against oneLine above.
const prevColumns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
beforeAll(() => {
  Object.defineProperty(process.stderr, "columns", { value: 200, configurable: true, writable: true });
});

afterAll(() => {
  if (prevColumns) Object.defineProperty(process.stderr, "columns", prevColumns);
  else delete (process.stderr as unknown as { columns?: number }).columns;
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => { calls.length = 0; plan.length = 0; });

/** What `work` answered, and every line the module wrote to the terminal while
 *  it ran. console.error is the only way out of ccusage.mjs, so this is the
 *  whole of what a machine in this state puts on screen. */
async function printed<T>(work: () => Promise<T> | T): Promise<{ value: T; lines: string[] }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const value = await work();
    return { value, lines: spy.mock.calls.map(args => args.map(String).join(" ")) };
  } finally {
    spy.mockRestore();
  }
}

describe("what the deck prints when ccusage cannot run", () => {
  it("writes one line per failure, never the child's stack", async () => {
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
    plan.push({ stderr: NPX_STACK, code: 1 });

    const { lines } = await printed(() => fetchCcusageDaily({ since: "20260301" }));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).not.toContain("at Module._resolveFilename");
      expect(line).not.toContain("requireStack");
    }
    const fetchLine = lines.find(l => l.includes("fetch failed"));
    expect(fetchLine).toBeDefined();
    expect(fetchLine).toContain("Cannot find module");
  });

  it("keeps the whole stack for the modal's title, where the evidence belongs", async () => {
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
    plan.push({ stderr: NPX_STACK, code: 1 });

    const { value: res } = await printed(() => fetchCcusageDaily({ since: "20260302" }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("run_failed");
    // Shortening the terminal line must not shorten the evidence: this is what
    // the user hovers, and what they paste into an issue.
    expect(res.error).toContain("at Module._resolveFilename");
    expect(String(res.error).split("\n").length).toBeGreaterThan(5);
    // And the modal reads a real remedy out of it rather than "try again".
    expect(explainCcusageFailure({ reason: res.reason, error: res.error }, "x"))
      .not.toBe(CCUSAGE_REASONS.run_failed);
  });

  it("says one line at boot too, which is where such a machine sees it first", async () => {
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });

    const { lines } = await printed(async () => {
      primeCcusage();
      await new Promise(r => setTimeout(r, 20));
    });

    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/install failed/);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    // npm's own stderr is a stack trace here, and none of it may reach the row
    // the boot report is being written into.
    expect(lines[0]).not.toContain("at Module._resolveFilename");
    expect(lines[0]).toContain("Cannot find module");
  });
});

describe("a managed install that resolves but cannot run", () => {
  it("knows Node's two ways of saying it could not load a file", () => {
    expect(cannotLoadModule("Error: Cannot find module 'x'\n  code: 'MODULE_NOT_FOUND'")).toBe(true);
    expect(cannotLoadModule("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'y'")).toBe(true);
    // A CLI that ran and failed on its own is not a broken install.
    expect(cannotLoadModule("ccusage exited 3")).toBe(false);
    expect(cannotLoadModule("spawn npx ENOENT")).toBe(false);
    expect(cannotLoadModule(undefined)).toBe(false);
  });

  it("is thrown away and rebuilt instead of failing identically forever", async () => {
    // The state a broken npm leaves behind: package.json and an entry file on
    // disk, so resolveEntry answers "installed" and getRunner hands that entry
    // back on every call — while running it fails every time. Nothing re-checked
    // it, and the only fix was deleting ~/.agents-deck/ccusage by hand.
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
    damagedInstall();

    plan.push(
      // `node <entry> …` — the managed install, half written.
      { stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './chunk.js'", code: 1 },
      // The npx fallback the rebuild falls through to, npm having refused.
      { stdout: `{"daily":[],"totals":null}`, code: 0 },
    );

    const { value: res } = await printed(() => fetchCcusageDaily({ since: "20260303" }));

    expect(res.ok).toBe(true);
    // The damaged copy is gone, so the next boot installs a fresh one.
    expect(existsSync(join(PKG_DIR, "package.json"))).toBe(false);
    // It really did try the managed entry first, and really did run again after.
    expect(calls[0].args.some(a => a.endsWith("cli.js"))).toBe(true);
    expect(calls.some(c => c.args.includes("ccusage@latest") && !c.args.includes("install"))).toBe(true);
  });

  it("repairs at most once per process, so a rebuild that fails cannot loop", async () => {
    // Same damage again. The guard has already been spent by the case above, so
    // this one must report the failure rather than reinstalling a second time.
    damagedInstall();

    plan.push({ stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './chunk.js'", code: 1 });

    const { value: res } = await printed(() => fetchCcusageDaily({ since: "20260304" }));

    expect(res.ok).toBe(false);
    expect(existsSync(join(PKG_DIR, "package.json"))).toBe(true);
    // One spawn: the managed entry. No second attempt, no `npm install`.
    expect(calls).toHaveLength(1);
  });
});
