// #433. The deck's own failure box has told people to "put ccusage on PATH
// yourself" for as long as that sentence has existed, and nothing in the deck
// had ever looked at PATH for ccusage. getRunner knew two runners — the managed
// install under ~/.agents-deck/ccusage, and `npx -y ccusage@latest` — and
// resolveEntry read one directory. So a reader who did exactly what the box
// said, and could prove it with `ccusage --version` in their own shell, got the
// identical box on the next click.
//
// Two ways to close that: look at PATH, or stop promising it. Looking is what
// happened, because there is a documented configuration that has no other
// answer at all. `AGENTS_DECK_NO_INSTALL=1` means "never install or update
// claude-swap / ccusage"; somebody who sets it AND installs ccusage themselves
// has done the only thing that flag can sensibly mean, and the deck answered
// "ccusage is not installed" while it was installed and on their PATH. There
// was no combination of settings that made a self-managed ccusage work. The
// #432 machine — npm and npx both unusable — is the same story with the volume
// up: it cannot create the managed install and cannot run the fallback, so a
// copy the user already has is the only route left.
//
// These pin the four things that has to mean: the order runners are tried in,
// that PATH is genuinely consulted on all three platforms (which on Windows
// means PATHEXT and a full path, never a bare `ccusage.cmd` — see #456), that an
// explicit AGENTS_DECK_CCUSAGE is obeyed and its failures named as its own, and
// that the sentence in the box is now true.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainCcusageFailure } from "../admin-failure";
// @ts-expect-error — .mjs server module, no types
import { pathLookup, shimPath } from "../../server/exec.mjs";

// ── the lookup itself, with every filesystem injected ───────────────────────
//
// Nothing in this block touches the disk of the machine running the suite: a
// Windows layout is a list of strings, which is the only way the Windows answer
// is checkable from macOS or Linux at all.

const NODE_DIR = "C:\\Program Files\\nodejs";
const NODE_EXE = `${NODE_DIR}\\node.exe`;
const APPDATA_NPM = "C:\\Users\\vceban\\AppData\\Roaming\\npm";

/** A disk on which only the listed files exist. */
const disk = (...files: string[]) => (p: string) => files.includes(p);

describe("finding a command on PATH", () => {
  it("walks a POSIX PATH with POSIX separators", () => {
    // `:` between entries and `/` inside them. Splitting on the wrong one is not
    // a near miss: a POSIX PATH read with `;` is one enormous directory name
    // that exists nowhere, so every lookup would answer null and the whole
    // feature would look like it had never been written.
    const out = pathLookup("ccusage", "linux", {
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin:/usr/local/bin:/home/v/.local/bin",
      exists: disk("/usr/local/bin/ccusage"),
    });
    expect(out).toBe("/usr/local/bin/ccusage");
  });

  it("honours the order the user put their own PATH in", () => {
    // The one preference the reader actually stated. shimPath overrules it for
    // npm's shims on purpose — npm ships beside node — but for a tool the user
    // installed, taking node's directory first would quietly run the copy they
    // did not choose.
    const out = pathLookup("ccusage", "darwin", {
      execPath: "/usr/local/bin/node",
      pathEnv: "/opt/homebrew/bin:/usr/local/bin",
      exists: disk("/opt/homebrew/bin/ccusage", "/usr/local/bin/ccusage"),
    });
    expect(out).toBe("/opt/homebrew/bin/ccusage");
  });

  it("applies PATHEXT on Windows, where a bare name is not a file at all", () => {
    // PATHEXT is a shell's job and spawn is not a shell, so `ccusage` on
    // Windows is `ccusage.cmd` or `ccusage.exe` and never the bare name. This
    // is the case the issue singles out as the one that breaks if the existing
    // machinery is not reused.
    const out = pathLookup("ccusage", "win32", {
      execPath: NODE_EXE,
      pathEnv: `C:\\Windows\\system32;${APPDATA_NPM}`,
      exists: disk(`${APPDATA_NPM}\\ccusage.cmd`),
    });
    expect(out).toBe(`${APPDATA_NPM}\\ccusage.cmd`);
    // And backslashes even though this assertion is running on POSIX: the path
    // arithmetic is spelled out rather than done through `node:path`, which is
    // the platform running the SUITE.
    expect(out).not.toContain("/");
  });

  it("prefers a real executable to the extensionless spelling", () => {
    // Same order `candidates` gives `run`, so the repo has one rule rather than
    // two: .exe, then .cmd, then .bat, and the bare name last.
    const both = disk(`${APPDATA_NPM}\\ccusage.exe`, `${APPDATA_NPM}\\ccusage.cmd`, `${APPDATA_NPM}\\ccusage`);
    expect(pathLookup("ccusage", "win32", { execPath: "", pathEnv: APPDATA_NPM, exists: both }))
      .toBe(`${APPDATA_NPM}\\ccusage.exe`);
    expect(pathLookup("ccusage", "win32", {
      execPath: "", pathEnv: APPDATA_NPM, exists: disk(`${APPDATA_NPM}\\ccusage.bat`),
    })).toBe(`${APPDATA_NPM}\\ccusage.bat`);
  });

  it("tolerates the shapes a real PATH carries — quotes, trailing separators, blanks", () => {
    expect(pathLookup("ccusage", "win32", {
      execPath: "", pathEnv: `;"${APPDATA_NPM}\\";;C:\\Windows`, exists: disk(`${APPDATA_NPM}\\ccusage.cmd`),
    })).toBe(`${APPDATA_NPM}\\ccusage.cmd`);
    expect(pathLookup("ccusage", "linux", {
      execPath: "", pathEnv: "::/usr/local/bin/:", exists: disk("/usr/local/bin/ccusage"),
    })).toBe("/usr/local/bin/ccusage");
  });

  it("keeps looking past an entry it cannot even stat", () => {
    // A disconnected network drive is a miss, not the end of the search.
    const out = pathLookup("ccusage", "win32", {
      execPath: "",
      pathEnv: `Z:\\gone;${APPDATA_NPM}`,
      exists: (p: string) => {
        if (p.startsWith("Z:")) throw new Error("ENODEV");
        return p === `${APPDATA_NPM}\\ccusage.cmd`;
      },
    });
    expect(out).toBe(`${APPDATA_NPM}\\ccusage.cmd`);
  });

  it("answers null rather than inventing a path", () => {
    expect(pathLookup("ccusage", "linux", { execPath: "", pathEnv: "/usr/bin", exists: () => false })).toBe(null);
    expect(pathLookup("ccusage", "linux", { execPath: "", pathEnv: "", exists: () => true })).toBe(null);
  });

  it("refuses a name that already carries a directory", () => {
    // Re-rooting an explicit path under a PATH entry would be a way to run
    // something else entirely.
    expect(pathLookup("/usr/local/bin/ccusage", "linux", { pathEnv: "/usr/bin", exists: () => true })).toBe(null);
    expect(pathLookup("C:\\tools\\ccusage.cmd", "win32", { pathEnv: "C:\\Windows", exists: () => true })).toBe(null);
    expect(pathLookup("", "linux", { pathEnv: "/usr/bin", exists: () => true })).toBe(null);
  });

  it("leaves shimPath answering exactly what it answered before", () => {
    // shimPath is now this same walk with two answers filled in — Windows, and
    // node's own directory first — and #456 and #457 both ride on it, so the
    // refactor has to be invisible to them.
    const stock = {
      execPath: NODE_EXE,
      pathEnv: `C:\\Windows\\system32;${NODE_DIR};${APPDATA_NPM}`,
      exists: disk(`${NODE_DIR}\\npm.cmd`, `${APPDATA_NPM}\\npm.cmd`),
    };
    expect(shimPath("npm.cmd", stock)).toBe(`${NODE_DIR}\\npm.cmd`);
    // nvm-windows and a PATH-only npm: node has no shim beside it, so PATH is
    // walked in its own order.
    expect(shimPath("npm.cmd", {
      ...stock, execPath: "C:\\nvm4w\\nodejs\\node.exe", exists: disk(`${APPDATA_NPM}\\npm.cmd`),
    })).toBe(`${APPDATA_NPM}\\npm.cmd`);
    expect(shimPath("npm.cmd", { ...stock, exists: () => false })).toBe(null);
    expect(shimPath("C:\\tools\\npm.cmd", stock)).toBe(null);
  });

  it("does not take node's own directory for a tool the user installed", () => {
    // The other half of the same rule, stated from this side: an npm shim
    // beside node is the answer for `npm.cmd` and is nothing to do with a
    // ccusage the reader put somewhere themselves.
    const beside = { execPath: "/opt/node/bin/node", pathEnv: "", exists: disk("/opt/node/bin/ccusage") };
    expect(pathLookup("ccusage", "linux", beside)).toBe(null);
    expect(pathLookup("ccusage", "linux", { ...beside, besideNode: true })).toBe("/opt/node/bin/ccusage");
  });
});

// ── the server half, with every spawn faked ─────────────────────────────────

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

const USAGE = `{"daily":[],"totals":null}`;

vi.mock("node:child_process", () => ({
  spawn: (file: string, args: string[] = []) => {
    calls.push({ file, args });
    return fakeChild((runPlan.shift() ?? { stdout: USAGE, code: 0 }) as never);
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
// — the developer's real managed install on any platform. PATH is redirected
// with them and for the same reason, one layer up: this file's whole subject is
// what the deck does with a ccusage it finds on PATH, so the PATH it finds one
// on has to be this file's, never the machine's.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-user-"));
const BIN_DIR = join(FAKE_HOME, "bin");
const ON_PATH = join(BIN_DIR, "ccusage");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PATH: process.env.PATH,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  AGENTS_DECK_CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.PATH = BIN_DIR;
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { fetchCcusageDaily, primeCcusage, userCcusage, userSpec } = await import("../../server/ccusage.mjs");

const CCUSAGE_DIR = join(FAKE_HOME, ".agents-deck", "ccusage");
const PKG_DIR = join(CCUSAGE_DIR, "node_modules", "ccusage");
if (!PKG_DIR.startsWith(FAKE_HOME)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${FAKE_HOME}`);

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

/** A ccusage the user installed, as a file on this file's PATH. Never run — the
 *  spawn is mocked — so its contents are only there to make it a real file. */
function ccusageOnPath() {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(ON_PATH, "#!/bin/sh\nexit 0\n");
  try { chmodSync(ON_PATH, 0o755); } catch { /* Windows has no mode bits */ }
}

/** The deck's own managed install, in the state resolveEntry accepts. The
 *  marker is dated now so the once-a-day `npm view` check is not due and cannot
 *  land a spawn in the middle of a plan. */
function managedInstall() {
  mkdirSync(join(PKG_DIR, "src"), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "1.0.0", bin: "./src/cli.js" }));
  writeFileSync(join(PKG_DIR, "src", "cli.js"), "");
  writeFileSync(join(CCUSAGE_DIR, ".last-update-check"), String(Date.now()));
}

beforeEach(() => {
  calls.length = 0;
  runPlan.length = 0;
  installReply.current = null;
  rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
  rmSync(BIN_DIR, { recursive: true, force: true });
  delete process.env.AGENTS_DECK_NO_INSTALL;
  delete process.env.AGENTS_DECK_CCUSAGE;
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

// `--by-agent` trails every vector below as of #431: the deck asks ccusage not
// to merge Claude Code's spend into Codex's, and appends the flag to the same
// `daily --json --since …` it has always sent. It is spelled out in each
// expectation rather than factored into a constant because these assertions are
// whole-vector comparisons, and what they are for is that the whole vector is
// visible in the file that pins it.
describe("a ccusage the user installed themselves", () => {
  it("is what runs when there is no managed install", async () => {
    ccusageOnPath();

    const res = await fetchCcusageDaily({ since: "20260501" });

    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ file: ON_PATH, args: ["daily", "--json", "--since", "20260501", "--by-agent"] }]);
  });

  it("is used instead of downloading a second copy of the same tool", async () => {
    // Installs are ALLOWED here, and still nothing is fetched. Pulling a
    // package off the registry that is already on the machine is not a thing to
    // do to somebody, and it is what makes the runner order identical with and
    // without AGENTS_DECK_NO_INSTALL=1 — that flag removes a step rather than
    // changing the sequence.
    ccusageOnPath();

    await fetchCcusageDaily({ since: "20260502" });

    expect(calls.some(c => c.args.includes("install"))).toBe(false);
    expect(calls.some(c => c.args.includes("ccusage@latest"))).toBe(false);
  });

  it("makes AGENTS_DECK_NO_INSTALL=1 a configuration that can actually work", async () => {
    // The headline. That flag is documented as "never install or update
    // claude-swap / ccusage", and a user who sets it and installs ccusage
    // themselves has done the only thing it can sensibly mean. Before this, the
    // deck answered "ccusage is not installed" while it was installed and on
    // their PATH, and there was NO combination of settings that made a
    // self-managed ccusage work.
    process.env.AGENTS_DECK_NO_INSTALL = "1";
    ccusageOnPath();

    const res = await fetchCcusageDaily({ since: "20260503" });

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(calls).toEqual([{ file: ON_PATH, args: ["daily", "--json", "--since", "20260503", "--by-agent"] }]);
  });

  it("still refuses under that flag when there is genuinely no ccusage anywhere", async () => {
    // The guard the test above must not have loosened: no install, no npx, and
    // the reason says which variable forbade it.
    process.env.AGENTS_DECK_NO_INSTALL = "1";

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260504" }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_install");
    expect(calls).toEqual([]);
  });

  it("is the last escape route on the #432 machine, and is now taken", async () => {
    // npm and npx both unusable on disk: the managed install cannot be created
    // and the fallback cannot run. A copy the user already has is the only way
    // left to get usage history, and it was the one route the deck refused to
    // look down while recommending it in the failure box.
    installReply.current = {
      error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }),
      status: null, stdout: "", stderr: "",
    };
    ccusageOnPath();

    const res = await fetchCcusageDaily({ since: "20260505" });

    expect(res.ok).toBe(true);
    // Not one npm, not one npx: the broken halves are never even reached.
    expect(calls).toEqual([{ file: ON_PATH, args: ["daily", "--json", "--since", "20260505", "--by-agent"] }]);
  });

  it("does not displace a managed install that is already there", async () => {
    // The deliberate half of the ordering, and the opposite of what the issue
    // proposed. Preferring PATH would silently change which ccusage runs on
    // every machine that has both — an old global copy without `daily --json`
    // would turn a working panel into a broken one, for a change the user never
    // asked for. AGENTS_DECK_CCUSAGE is how somebody says they want their own
    // copy to win, and it says it unambiguously.
    managedInstall();
    ccusageOnPath();

    await fetchCcusageDaily({ since: "20260506" });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].args[0]).toBe(join(PKG_DIR, "src", "cli.js"));
  });

  it("leaves a machine with nothing of its own exactly as it was", async () => {
    // No managed install, no PATH copy, installs allowed: install, then npx.
    // The path that has always been there, unchanged.
    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260507" }));

    expect(res.ok).toBe(true);
    expect(calls.some(c => c.args.includes("install"))).toBe(true);
    expect(calls.some(c => c.args.includes("ccusage@latest"))).toBe(true);
  });
});

describe("AGENTS_DECK_CCUSAGE", () => {
  it("wins over the managed install, which is the point of setting it", async () => {
    managedInstall();
    const mine = join(BIN_DIR, "my-ccusage");
    mkdirSync(BIN_DIR, { recursive: true });
    writeFileSync(mine, "");
    process.env.AGENTS_DECK_CCUSAGE = mine;

    await fetchCcusageDaily({ since: "20260508" });

    expect(calls).toEqual([{ file: mine, args: ["daily", "--json", "--since", "20260508", "--by-agent"] }]);
  });

  it("fails as itself when it names a file that is not there", async () => {
    // A user who pointed the deck somewhere deserves to be told the path was
    // wrong. Falling through would report "npx is not on this deck's PATH" —
    // true, and about a completely different thing than the setting they got
    // wrong — and would also quietly run a ccusage they did not ask for.
    const nowhere = join(FAKE_HOME, "nope", "ccusage");
    process.env.AGENTS_DECK_CCUSAGE = nowhere;
    ccusageOnPath();

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260509" }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_override");
    expect(res.error).toContain(nowhere);
    expect(calls).toEqual([]);
  });

  it("is read per call, so correcting it takes effect on the next click", () => {
    // Never cached, the same rule cswapBin states for AGENTS_DECK_CSWAP:
    // somebody debugging a bad resolution needs the next attempt to use the new
    // value rather than the next restart.
    process.env.AGENTS_DECK_CCUSAGE = "/first/ccusage";
    expect(userCcusage()).toEqual({ file: "/first/ccusage", named: true });
    process.env.AGENTS_DECK_CCUSAGE = "/second/ccusage";
    expect(userCcusage()).toEqual({ file: "/second/ccusage", named: true });
  });

  it("is taken as typed rather than re-rooted under a PATH entry", () => {
    // An absolute path the user gave is the file they meant; looking it up
    // again would be a way to run something else.
    const env = { AGENTS_DECK_CCUSAGE: "C:\\tools\\ccusage.cmd" };
    expect(userCcusage("win32", { pathEnv: APPDATA_NPM, exists: () => true }, env))
      .toEqual({ file: "C:\\tools\\ccusage.cmd", named: true });
  });
});

describe("launching a ccusage the deck did not install", () => {
  it("routes a Windows .cmd shim through cmd.exe by its FULL path", () => {
    // The case #433 singles out as the one that breaks if exec.mjs's machinery
    // is not reused, and it is #456 all over again: a batch file launched by
    // BARE name computes `%~dp0` from the deck's working directory, so the shim
    // goes looking for its payload under whatever folder the deck was started
    // from. Resolving first and quoting second is the same order npm.cmd and
    // npx.cmd already go through.
    const found = pathLookup("ccusage", "win32", {
      execPath: NODE_EXE, pathEnv: APPDATA_NPM, exists: disk(`${APPDATA_NPM}\\ccusage.cmd`),
    });
    const { file, args, opts } = userSpec(found, ["daily", "--json"], "win32");

    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    expect(opts.shell).toBeUndefined();

    const tokens = [...args[3].replace(/^"/, "").replace(/"$/, "").matchAll(/"([^"]*)"/g)].map(m => m[1]);
    expect(tokens[0]).not.toBe("ccusage.cmd");
    expect(tokens[0]).toBe(`${APPDATA_NPM}\\ccusage.cmd`);
    // Every argument in its own quoted token, so a `--since` carrying a space,
    // an `&` or a quote is an argument rather than syntax.
    expect(tokens.slice(1)).toEqual(["daily", "--json"]);
  });

  it("spawns a POSIX path as the plain vector it always was", () => {
    for (const platform of ["linux", "darwin"]) {
      const spec = userSpec("/usr/local/bin/ccusage", ["daily", "--json"], platform);
      expect(spec.file).toBe("/usr/local/bin/ccusage");
      expect(spec.args).toEqual(["daily", "--json"]);
      expect(spec.opts).toEqual({});
    }
  });

  it("gives a .exe on Windows no shell either", () => {
    // Only .cmd and .bat need cmd.exe; an .exe is spawnable directly, and going
    // through a shell for it would be a command line to get wrong for nothing.
    const spec = userSpec(`${APPDATA_NPM}\\ccusage.exe`, ["daily"], "win32");
    expect(spec.file).toBe(`${APPDATA_NPM}\\ccusage.exe`);
    expect(spec.args).toEqual(["daily"]);
    expect(spec.opts).toEqual({});
  });
});

describe("what the deck says when the user's own copy is the one that failed", () => {
  it("names the file, in the reply and then in the box", async () => {
    // "Your ccusage failed" is half an answer on a machine that has a PATH
    // entry, an override and a managed install. A stale global copy shadowing a
    // good one is the likeliest way to be reading this at all.
    ccusageOnPath();
    // Twice, because a failed run is two attempts as of #431: the first carries
    // `--by-agent` and the second drops it, in case that flag was the whole
    // objection. A real copy that cannot take `--json` refuses both of them, so
    // two identical replies is what this machine actually does.
    runPlan.push(
      { stderr: "ccusage: unknown option --json", code: 1 },
      { stderr: "ccusage: unknown option --json", code: 1 },
    );

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260510" }));

    expect(res.ok).toBe(false);
    expect(res.stage).toBe("path");
    expect(res.bin).toBe(ON_PATH);

    const said = explainCcusageFailure(res, "x");
    expect(said).toContain(ON_PATH);
    expect(said).toMatch(/failed to run/);
  });

  it("never deletes it, whatever it failed with", async () => {
    // discardDamagedInstall throws away a managed install that cannot load a
    // module, because the deck put it there and can rebuild it. A file the user
    // installed is not the deck's to remove — and the retry it triggers would
    // re-run the identical spawn anyway.
    ccusageOnPath();
    runPlan.push(
      { stderr: "Error: Cannot find module './lib/index.js'", code: 1 },
      { stderr: "Error: Cannot find module './lib/index.js'", code: 1 },
    );

    const { value: res } = await quietly(() => fetchCcusageDaily({ since: "20260511" }));

    expect(res.ok).toBe(false);
    expect(userCcusage()).toEqual({ file: ON_PATH, named: false });
    // Two spawns, and both of them the user's own file: the flag retry (#431)
    // and nothing else. The rebuild this error triggers on a MANAGED install
    // would have shown up as an `npm install` and a third spawn, which is the
    // thing this test is here to say does not happen to somebody else's file.
    expect(calls).toEqual([
      { file: ON_PATH, args: ["daily", "--json", "--since", "20260511", "--by-agent"] },
      { file: ON_PATH, args: ["daily", "--json", "--since", "20260511"] },
    ]);
  });

  it("still answers a reply with no stage exactly as it always did", () => {
    // An older deck sends none of this, and must cost its reader nothing.
    const plain = { reason: "run_failed", error: "ccusage exited 3" };
    expect(explainCcusageFailure(plain, "x")).toBe("ccusage could not report usage — try again");
  });

  it("falls back to naming PATH when the file did not travel", () => {
    const said = explainCcusageFailure({ reason: "run_failed", stage: "path", error: "boom" }, "x");
    expect(said).toMatch(/on your PATH/);
  });
});

describe("the sentence this issue is about", () => {
  it("still promises PATH, and the promise is now one the deck keeps", async () => {
    // The whole of #433 in one pair of assertions. The box says this; the deck
    // does this. Before, only the first half was true.
    const box = explainCcusageFailure(
      { reason: "run_failed", stage: "npx", error: "spawn npx ENOENT" }, "x");
    expect(box).toContain("put ccusage on PATH yourself");

    ccusageOnPath();
    const res = await fetchCcusageDaily({ since: "20260512" });
    expect(res.ok).toBe(true);
    expect(calls[0].file).toBe(ON_PATH);
  });

  it("tells the no-install reader to install ccusage, which now also works", async () => {
    const said = explainCcusageFailure({ reason: "no_install", error: "installs are off" }, "x");
    expect(said).toMatch(/install ccusage yourself/);
    expect(said).toMatch(/PATH/);

    process.env.AGENTS_DECK_NO_INSTALL = "1";
    ccusageOnPath();
    expect((await fetchCcusageDaily({ since: "20260513" })).ok).toBe(true);
  });

  it("has its own sentence for an override that names nothing", () => {
    const said = explainCcusageFailure({ reason: "bad_override", error: "/nope/ccusage" }, "x");
    expect(said).toContain("AGENTS_DECK_CCUSAGE");
    // And emphatically not the npx one, which is what a fall-through would have
    // produced: true, and about something the reader never asked for.
    expect(said).not.toMatch(/npx/);
  });
});

describe("the boot row", () => {
  it("reports the user's own copy without spawning anything to find a version", () => {
    // Reading a version means RUNNING the thing, and a status row is not worth
    // a spawn at boot. Naming the file is the more useful half anyway.
    ccusageOnPath();
    expect(primeCcusage()).toEqual({ state: "user", bin: ON_PATH });
    expect(calls).toEqual([]);
  });

  it("does not start an install behind a ccusage that is already there", () => {
    // Otherwise getRunner's "PATH before installing" would be true only until
    // the first restart, and would spend a download saying so.
    ccusageOnPath();
    primeCcusage();
    expect(calls.some(c => c.args.includes("install"))).toBe(false);
  });

  it("keeps reporting the managed install first, so an existing deck's boot is unchanged", () => {
    managedInstall();
    ccusageOnPath();
    expect(primeCcusage()).toEqual({ state: "present", version: "1.0.0" });
  });

  it("says nothing about an override that names nothing, and leaves that to the modal", () => {
    // The boot has no useful sentence for it, and getRunner will say it
    // properly — with the path — the first time the modal is opened.
    process.env.AGENTS_DECK_CCUSAGE = join(FAKE_HOME, "nope", "ccusage");
    expect(primeCcusage()).toEqual({ state: "installing" });
  });
});
