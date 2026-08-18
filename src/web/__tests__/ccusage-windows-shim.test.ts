// #456. ccusage never started on a Windows 10 machine whose npm was demonstrably
// healthy — `npx ccdeck` ran the deck, `npm i -g ccdeck` added twelve packages in
// three seconds, `where npx` printed `C:\Program Files\nodejs\npx.cmd` and
// `npm config get prefix` the stock `%APPDATA%\npm`. The raw child stderr, once
// somebody hovered the modal for it, was two stacks:
//
//     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npm-prefix.js'
//     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npx-cli.js'
//
// `C:\Users\vceban` is neither npm's prefix nor node's directory. It is the
// deck's WORKING DIRECTORY. npm's `.cmd` shims locate every file they need as
// `%~dp0\node_modules\npm\bin\…`, and `%~dp0` is the drive-and-path of `%0` —
// the command token cmd.exe was handed. #362 replaced `shell: true` with
// `cmd.exe /d /s /c ""npm.cmd" "install" …`, and that token carries no
// directory of its own, so the shims computed their own location as the cwd.
//
// One defect, both halves: `npm-prefix.js` is the MANAGED INSTALL failing and
// `npx-cli.js` is the NPX FALLBACK failing right behind it, which is why three
// rounds of diagnosing one half kept half-fitting the other.
//
// These pin the fix — an absolute path to the shim on Windows, byte-identical
// argv on POSIX — and the two diagnostics that would have made one round enough:
// an install that reports honestly, and a failure that names which of ccusage's
// two paths it came from ON SCREEN rather than in a title attribute.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainCcusageFailure } from "../admin-failure";
// @ts-expect-error — .mjs server module, no types
import { shimPath, spawnSpec } from "../../server/exec.mjs";

// The reported machine, as three injectable values. Nothing here touches the
// filesystem of the machine running the suite: `exists` answers for a Windows
// disk that does not exist anywhere.
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const NODE_DIR = "C:\\Program Files\\nodejs";
const APPDATA_NPM = "C:\\Users\\vceban\\AppData\\Roaming\\npm";
const WIN_PATH = `C:\\Windows\\system32;C:\\Windows;${NODE_DIR};${APPDATA_NPM}`;

/** A Windows disk on which only the listed files exist. */
const disk = (...files: string[]) => (p: string) => files.includes(p);

const stockWindows = {
  execPath: NODE_EXE,
  pathEnv: WIN_PATH,
  exists: disk(`${NODE_DIR}\\npm.cmd`, `${NODE_DIR}\\npx.cmd`),
};

/**
 * The single command-line argument cmd.exe is handed, back as the list the shim
 * will actually see. The whole line is itself wrapped in quotes, the way `cmd
 * /c` wants it, so that pair comes off before the per-argument ones are read.
 */
function cmdTokens(line: string) {
  const inner = line.replace(/^"/, "").replace(/"$/, "");
  return [...inner.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

describe("resolving a Windows command shim to a full path", () => {
  it("prefers the directory node itself lives in, where npm ships", () => {
    // Node and npm are installed together, so this is both the likeliest answer
    // and the one that needs no PATH at all — the same preference
    // npxCliCandidates in npx.mjs states for npm's CLI scripts.
    expect(shimPath("npm.cmd", stockWindows)).toBe(`${NODE_DIR}\\npm.cmd`);
    expect(shimPath("npx.cmd", stockWindows)).toBe(`${NODE_DIR}\\npx.cmd`);
  });

  it("walks PATH in its own order when node has no shim beside it", () => {
    // nvm-windows and a PATH-only npm both land here.
    const out = shimPath("npm.cmd", {
      execPath: "C:\\nvm4w\\nodejs\\node.exe",
      pathEnv: WIN_PATH,
      exists: disk(`${APPDATA_NPM}\\npm.cmd`),
    });
    expect(out).toBe(`${APPDATA_NPM}\\npm.cmd`);
  });

  it("tolerates the shapes a real PATH carries — quotes, trailing separators, blanks", () => {
    const out = shimPath("npx.cmd", {
      execPath: "",
      pathEnv: `;"${NODE_DIR}\\";;C:\\Windows`,
      exists: disk(`${NODE_DIR}\\npx.cmd`),
    });
    expect(out).toBe(`${NODE_DIR}\\npx.cmd`);
  });

  it("keeps looking past an entry it cannot even stat", () => {
    // A disconnected network drive on PATH is a miss, not the end of the search.
    const out = shimPath("npm.cmd", {
      execPath: NODE_EXE,
      pathEnv: `Z:\\gone;${APPDATA_NPM}`,
      exists: (p: string) => {
        if (p.startsWith("Z:")) throw new Error("ENODEV");
        return p === `${APPDATA_NPM}\\npm.cmd`;
      },
    });
    expect(out).toBe(`${APPDATA_NPM}\\npm.cmd`);
  });

  it("gives up rather than inventing one, so the caller keeps today's behaviour", () => {
    expect(shimPath("npm.cmd", { execPath: NODE_EXE, pathEnv: WIN_PATH, exists: () => false })).toBe(null);
  });

  it("leaves a name that already has a directory alone", () => {
    // Re-rooting an explicit path would be a way to run something else entirely.
    expect(shimPath("C:\\tools\\npm.cmd", stockWindows)).toBe(null);
    expect(shimPath("", stockWindows)).toBe(null);
  });

  it("still produces backslashes when the suite is running on POSIX", () => {
    // `node:path` here is the platform running the tests, so the arithmetic is
    // spelled out by hand — the same rule npxCliCandidates follows.
    expect(shimPath("npm.cmd", stockWindows)).not.toContain("/");
  });
});

describe("the cmd.exe line the ccusage install and fallback produce", () => {
  // Imported inside the describe so the module's home-directory resolution below
  // is already redirected — see the environment block further down.
  let installSpec: (s?: string, p?: string, d?: unknown) => { file: string; args: string[]; opts: Record<string, unknown> };
  let fallbackSpec: (a?: string[], p?: string, d?: unknown) => { file: string; args: string[]; opts: Record<string, unknown> };

  beforeEach(async () => {
    // @ts-expect-error — .mjs server module, no types
    ({ installSpec, fallbackSpec } = await import("../../server/ccusage.mjs"));
  });

  it("names npm.cmd by its full path, never bare — the whole of #456", () => {
    const { file, args, opts } = installSpec("latest", "win32", stockWindows);

    // #362's guarantees, unchanged: cmd.exe, verbatim arguments, no shell.
    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    expect(opts.shell).toBeUndefined();

    const tokens = cmdTokens(args[3]);
    // The regression, in one line. A bare `npm.cmd` leaves `%0` with no
    // directory, and `%~dp0` — which is where npm.cmd looks for npm-prefix.js —
    // then comes out as the deck's working directory.
    expect(tokens[0]).not.toBe("npm.cmd");
    expect(tokens[0]).toBe(`${NODE_DIR}\\npm.cmd`);
    // And the path has a space in it, so the per-argument quoting is still what
    // holds it together.
    expect(tokens[0]).toContain(" ");
    expect(args[3]).toContain(`"${NODE_DIR}\\npm.cmd"`);
  });

  it("names npx.cmd by its full path too, which is the other half of the same stack", () => {
    const { args } = fallbackSpec(["daily", "--json"], "win32", stockWindows);
    const tokens = cmdTokens(args[3]);
    expect(tokens[0]).not.toBe("npx.cmd");
    expect(tokens[0]).toBe(`${NODE_DIR}\\npx.cmd`);
    expect(tokens.slice(1, 3)).toEqual(["-y", "ccusage@latest"]);
  });

  it("keeps every argument in its own quoted token, prefix included", () => {
    const { args } = installSpec("latest", "win32", stockWindows);
    const tokens = cmdTokens(args[3]);
    expect(tokens.slice(1, 4)).toEqual(["install", "ccusage@latest", "--prefix"]);
    // Nothing the deck puts on this line carries a `%`: cmd.exe expands `%VAR%`
    // inside quotes too and a command line has no escape for it, so the audit
    // that there is nothing to escape is the guarantee.
    for (const token of tokens.slice(0, 4)) expect(token).not.toContain("%");
    expect(tokens.slice(-5)).toEqual(["--no-save", "--no-audit", "--no-fund", "--loglevel", "error"]);
    // The prefix is the one token that carries a path, and it is one token.
    expect(tokens[4]).toContain(".agents-deck");
  });

  it("falls back to the bare name when no shim can be found, exactly as before", () => {
    const blind = { execPath: NODE_EXE, pathEnv: WIN_PATH, exists: () => false };
    expect(cmdTokens(installSpec("latest", "win32", blind).args[3])[0]).toBe("npm.cmd");
    expect(cmdTokens(fallbackSpec([], "win32", blind).args[3])[0]).toBe("npx.cmd");
  });

  it("leaves POSIX byte-identical: a bare name, no cmd.exe, no lookup at all", () => {
    for (const platform of ["linux", "darwin"]) {
      const install = installSpec("latest", platform, stockWindows);
      expect(install.file).toBe("npm");
      expect(install.args[0]).toBe("install");
      expect(install.opts).toEqual({});

      const fallback = fallbackSpec(["daily"], platform, stockWindows);
      expect(fallback.file).toBe("npx");
      expect(fallback.args).toEqual(["-y", "ccusage@latest", "daily"]);
      expect(fallback.opts).toEqual({});
    }
  });

  it("routes the resolved path through the same quoting spawnSpec always used", () => {
    // No second Windows rule: an absolute .cmd is still a .cmd, so isBatch is
    // true and viaCmd quotes it the way it quotes everything else.
    const direct = spawnSpec(`${NODE_DIR}\\npm.cmd`, ["install"], "win32");
    expect(cmdTokens(direct.args[3])).toEqual([`${NODE_DIR}\\npm.cmd`, "install"]);
  });
});

// ── the server half, with every spawn faked ─────────────────────────────────
//
// Nothing real runs and nothing is installed: spawnSync is the `npm install`
// and answers from a plan, spawn is the ccusage run and does the same.

const { calls, installReply, runPlan, fakeChild } = vi.hoisted(() => {
  type Sub = (v?: unknown) => void;
  type Reply = { stdout?: string; stderr?: string; code: number };
  return {
    calls: [] as { file: string; args: string[] }[],
    installReply: { current: null as null | Record<string, unknown> },
    runPlan: [] as Reply[],
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
    return fakeChild((runPlan.shift() ?? { stdout: `{"daily":[],"totals":null}`, code: 0 }) as never);
  },
  spawnSync: (file: string, args: string[] = []) => {
    calls.push({ file, args });
    return installReply.current ?? { status: 1, stdout: "", stderr: "test: no npm here" };
  },
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// ccusage.mjs resolves ~/.agents-deck/ccusage at import time out of os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows. Both point into a
// temp directory BEFORE the module loads, so nothing here can see — or write to
// — the developer's real managed install on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-shim-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  PATH: process.env.PATH,
  AGENTS_DECK_CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;
// #433 put a third runner in front of the npx fallback — a ccusage the user
// provided, at AGENTS_DECK_CCUSAGE or on PATH. The server half below is about
// the managed install failing and npx failing behind it, and neither can be
// reached on a machine that has its own ccusage, so this file supplies a PATH
// that has none. Note that the shimPath cases above are unaffected either way:
// they inject their whole Windows disk.
process.env.PATH = FAKE_HOME;
delete process.env.AGENTS_DECK_CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { fetchCcusageDaily } = await import("../../server/ccusage.mjs");

const CCUSAGE_DIR = join(FAKE_HOME, ".agents-deck", "ccusage");
const PKG_DIR = join(CCUSAGE_DIR, "node_modules", "ccusage");
if (!PKG_DIR.startsWith(FAKE_HOME)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${FAKE_HOME}`);

// The width is read per call from the real stream, and note() truncates to it —
// a narrow terminal would cut the substrings these assertions look for.
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
  runPlan.length = 0;
  installReply.current = null;
  rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
});

/** Run `work` with console.error captured, since that is the module's only way
 *  out to the terminal. */
async function quietly<T>(work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return { value: await work(), lines: spy.mock.calls.map(a => a.map(String).join(" ")) };
  } finally {
    spy.mockRestore();
  }
}

// Every failing run below is planned TWICE, because a failed run has been two
// attempts since #431: the deck asks ccusage for the per-agent split with
// `--by-agent` and, when the CLI refuses, drops the flag and asks again in case
// that was the whole objection. The machines in this file refuse both — a
// broken shim does not care which flags it was handed — so two identical
// replies is what they actually produce. Planning one would let the mock's
// default success answer the second attempt and turn each of these failures
// into a pass, which is the quiet way a diagnosis test stops testing anything.
describe("what an install failure is allowed to lose", () => {
  it("reports the spawn error rather than the word null", async () => {
    // spawnSync puts a failure to LAUNCH in `error` and leaves `status` null.
    // The old text read the null: every ENOENT, EINVAL and expired deadline
    // reached the terminal as "npm install ccusage failed: null".
    installReply.current = {
      error: Object.assign(new Error("spawn cmd.exe ENOENT"), { code: "ENOENT" }),
      status: null, stdout: "", stderr: "",
    };
    runPlan.push({ stderr: "npx also failed", code: 1 }, { stderr: "npx also failed", code: 1 });

    const { value: res, lines } = await quietly(() => fetchCcusageDaily({ since: "20260401" }));

    expect(res.ok).toBe(false);
    expect(res.install).toContain("spawn cmd.exe ENOENT");
    expect(res.install).not.toContain("null");
    expect(lines.some(l => l.includes("install failed"))).toBe(true);
  });

  it("keeps what npm wrote to stdout, which is not always the empty half", async () => {
    installReply.current = { status: 1, stdout: "npm ERR! code E404", stderr: "" };
    runPlan.push({ stderr: "npx also failed", code: 1 }, { stderr: "npx also failed", code: 1 });

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260402" }));
    expect(res.install).toContain("E404");
  });

  it("refuses to call a zero exit a success when nothing runnable came of it", async () => {
    // The shape #432 found once already, and the one that produced no
    // diagnostics at all: npm exits 0, resolveEntry answers null, getRunner
    // falls through to npx, and nothing anywhere records that an install
    // happened. An exit code is npm's opinion, not a fact about the disk.
    installReply.current = { status: 0, stdout: "added 2 packages", stderr: "" };
    runPlan.push({ stderr: "npx also failed", code: 1 }, { stderr: "npx also failed", code: 1 });

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260403" }));

    expect(res.ok).toBe(false);
    expect(res.install).toContain("exited 0");
    // And it names the level of the tree that is missing, which is the answer to
    // "what did `npm install --prefix` actually create on this machine" — the
    // question three rounds of screenshots could not settle.
    expect(res.install).toMatch(/is not there/);
  });

  it("names the level that IS there when only the package is unusable", async () => {
    installReply.current = { status: 0, stdout: "", stderr: "" };
    runPlan.push({ stderr: "npx also failed", code: 1 }, { stderr: "npx also failed", code: 1 });
    mkdirSync(PKG_DIR, { recursive: true });
    writeFileSync(join(PKG_DIR, "package.json"), "{ not json");

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260404" }));
    expect(res.install).toContain("bin entry");
  });
});

describe("which of ccusage's two paths failed", () => {
  it("says so in the reply, not only in whatever the last child printed", async () => {
    installReply.current = { status: 1, stdout: "", stderr: "npm went wrong" };
    runPlan.push({ stderr: "npx went wrong too", code: 1 }, { stderr: "npx went wrong too", code: 1 });

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260405" }));

    expect(res.stage).toBe("npx");
    expect(res.install).toContain("npm went wrong");
    expect(res.error).toContain("npx went wrong too");
  });

  it("calls a managed install's own failure by its own name", async () => {
    mkdirSync(join(PKG_DIR, "src"), { recursive: true });
    writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "1.0.0", bin: "./src/cli.js" }));
    writeFileSync(join(PKG_DIR, "src", "cli.js"), "");
    writeFileSync(join(CCUSAGE_DIR, ".last-update-check"), String(Date.now()));
    runPlan.push({ stderr: "ccusage exited 3", code: 1 }, { stderr: "ccusage exited 3", code: 1 });

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260406" }));

    expect(res.stage).toBe("managed");
    expect(res.install).toBeUndefined();
  });

  it("says which path it was in the terminal too, where the operator is reading", async () => {
    installReply.current = { status: 1, stdout: "", stderr: "npm went wrong" };
    runPlan.push({ stderr: "npx went wrong too", code: 1 }, { stderr: "npx went wrong too", code: 1 });

    const { lines } = await quietly(() => fetchCcusageDaily({ since: "20260407" }));
    expect(lines.some(l => /fetch failed \(npx fallback\)/.test(l))).toBe(true);
    // Still one line each, which is the rule #432 set for anything written while
    // the deck is repainting its own rows.
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/);
  });
});

describe("what the modal shows once it knows which path failed", () => {
  const both = {
    reason: "run_failed",
    stage: "npx",
    install: "npm install ccusage exited 0 but left nothing runnable under C:\\Users\\v\\.agents-deck\\ccusage: node_modules under it is not there",
    error: "'npx.cmd' is not recognized as an internal or external command,\r\noperable program or batch file.",
  };

  it("names both paths on screen, in the order they failed", () => {
    const said = explainCcusageFailure(both, "x");
    expect(said).toMatch(/managed install/i);
    expect(said).toMatch(/npx/);
    expect(said.indexOf("managed install")).toBeLessThan(said.indexOf("fell back to npx"));
    // And the modal is where it says so — not a title attribute, which is where
    // this fact lived for three rounds of debugging.
    expect(said.indexOf("failed first")).toBeGreaterThan(-1);
  });

  it("puts the install's own words in the visible text, not in a title attribute", () => {
    // The reason this took three rounds: the raw child output only ever reached
    // `title`, and the install's half of it was not even there.
    expect(explainCcusageFailure(both, "x")).toContain("node_modules under it is not there");
  });

  it("keeps the ranked remedy whole rather than replacing it", () => {
    // The npx text here is "not recognized", whose remedy is the PATH one. The
    // stage clause is added to it, never instead of it.
    expect(explainCcusageFailure(both, "x")).toMatch(/PATH/);
  });

  it("names the managed install when that is the path that ran", () => {
    const said = explainCcusageFailure(
      { reason: "run_failed", stage: "managed", error: "ccusage exited 3" }, "x");
    expect(said).toMatch(/installed for itself/);
    expect(said).toMatch(/try again/);
  });

  it("says there is no managed copy when the install left no words behind", () => {
    const said = explainCcusageFailure({ reason: "run_failed", stage: "npx", error: "spawn npx ENOENT" }, "x");
    expect(said).toMatch(/no managed copy of ccusage/);
    expect(said).toMatch(/PATH/);
  });

  it("answers a reply with no stage exactly as it always did", () => {
    // An older deck, and every hand-built object in the older tests. A missing
    // answer must cost the reader nothing.
    const plain = { reason: "run_failed", error: "ccusage exited 3" };
    expect(explainCcusageFailure(plain, "x")).toBe("ccusage could not report usage — try again");
    // And a stage a future deck invents that this build has no wording for.
    expect(explainCcusageFailure({ ...plain, stage: "wasm" }, "x"))
      .toBe(explainCcusageFailure(plain, "x"));
  });

  it("cuts a runaway install line rather than filling the box with it", () => {
    const said = explainCcusageFailure(
      { reason: "run_failed", stage: "npx", install: "x".repeat(4000), error: "boom" }, "x");
    expect(said).toContain("…");
    expect(said.length).toBeLessThan(900);
  });
});
