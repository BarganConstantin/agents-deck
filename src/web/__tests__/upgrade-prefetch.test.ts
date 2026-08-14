// The fetch that has to happen BEFORE the deck stops serving.
//
// `npx -y <spec>@latest` both downloads and executes, and the supervisor used
// that one command for the whole upgrade: the worker exited 76, the port was
// given up, and only then did npm find out it was offline, behind a proxy, or
// looking at a version that had not propagated. Every failed update was
// therefore a real outage — the SSE stream dropped, hook events fired into the
// gap lost outright — paid before anyone knew the update had a chance.
//
// So the download is now done on its own, while the old deck still holds the
// port. Which makes the argument vector the load-bearing part: the spec must
// reach npm as something to INSTALL and never as something to RUN, or the
// pre-flight starts a second deck and the cure is worse than the disease.
//
// The behaviour half is driven with real child processes, because "does it
// resolve false instead of throwing" and "is the process actually dead after
// the deadline" cannot be observed any other way. The children are two-line
// node scripts written into a temp directory: no npx runs here, nothing is
// installed, and nothing is downloaded.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs server module, no types
import { npxPrefetch, npxPrefetchArgs } from "../../server/npx.mjs";
// @ts-expect-error — .mjs server module, no types
import { spawnSpec } from "../../server/exec.mjs";

// Nothing under test reads the user's configuration, but these spawn real Node
// processes that inherit this environment — so every home the deck knows about
// points at a sandbox before anything runs, on POSIX and on Windows alike.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-prefetch-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

// Stands in for npx. `fail` writes npm's own failure shape and exits non-zero,
// `hang` never exits at all, `ok` exits 0 the way a completed install does.
const FAKE_NPX = join(SANDBOX, "fake-npx.mjs");
if (!FAKE_NPX.startsWith(SANDBOX)) throw new Error(`refusing to run: ${FAKE_NPX} is outside ${SANDBOX}`);
writeFileSync(FAKE_NPX, [
  `const how = process.argv[2];`,
  `if (how === "fail") {`,
  `  process.stderr.write("npm warn exec The following package will be installed\\n");`,
  `  process.stderr.write("npm error code ETARGET\\n");`,
  `  process.stderr.write("npm error notarget No matching version found for ccdeck@9.9.9.\\n");`,
  `  process.exit(1);`,
  `}`,
  `if (how === "hang") setInterval(() => {}, 1000);`,
  `else process.exit(0);`,
].join("\n"));

/** npxLaunch's answer, pointed at the script above instead of a real npx. */
const fakeLaunch = (how: string) => (args: string[]) =>
  ({ file: process.execPath, args: [FAKE_NPX, how, ...args], opts: {} });

describe("the arguments the pre-flight hands npx", () => {
  it("names the spec as a package to install, never as a command to run", () => {
    const args = npxPrefetchArgs("ccdeck@latest");
    expect(args[args.indexOf("--package") + 1]).toBe("ccdeck@latest");
    // The regression this shape exists to avoid: as a positional, npx unpacks
    // the package AND starts its bin — a whole second deck, racing the running
    // one for the port it is still holding.
    expect(args.filter(a => a === "ccdeck@latest")).toHaveLength(1);
    expect(args.indexOf("ccdeck@latest")).toBeGreaterThan(args.indexOf("--package"));
  });

  it("runs a shell builtin, so a broken PATH cannot fail a fetch that worked", () => {
    // The environment this pre-flight most needs to answer honestly is the one
    // from #184, where npm's own shim could not find npm. A call that needed a
    // program on PATH would report failure there for the wrong reason.
    expect(npxPrefetchArgs("ccdeck@latest")).toContain("--call");
    expect(npxPrefetchArgs("ccdeck@latest").at(-1)).toBe("exit 0");
  });

  it("still answers the install prompt, since nobody is at the terminal", () => {
    expect(npxPrefetchArgs("agents-deck@latest")).toContain("-y");
  });

  it("survives cmd.exe with the call intact when the shim is the fallback", () => {
    // Windows is the platform this repo cannot execute, so the command line is
    // asserted instead. `exit 0` contains a space and must stay one argument.
    const { args } = spawnSpec("npx.cmd", npxPrefetchArgs("ccdeck@latest"), "win32");
    expect(args[3]).toBe('""npx.cmd" "-y" "--package" "ccdeck@latest" "--call" "exit 0""');
  });
});

describe("npxPrefetch against a fetch that cannot work", () => {
  it("answers with the reason instead of throwing, so the deck can stay up", async () => {
    const got = await npxPrefetch("ccdeck@latest", { launch: fakeLaunch("fail") });
    expect(got.ok).toBe(false);
    // npm's warning about what it is about to install is not why this failed.
    expect(got.error).toBe("notarget No matching version found for ccdeck@9.9.9.");
  });

  it("says so plainly when npx could not be started at all", async () => {
    const got = await npxPrefetch("ccdeck@latest", {
      launch: () => ({ file: join(SANDBOX, "no-such-npx"), args: [], opts: {} }),
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/could not run npx/);
  });

  it("gives up on a fetch that hangs, and leaves nothing behind downloading", async () => {
    // A dead proxy accepts the connection and never answers. Without a deadline
    // the click hangs on it until the tab gives up three minutes later.
    let spawned: { pid?: number; killed?: boolean } | null = null;
    const got = await npxPrefetch("ccdeck@latest", {
      launch: fakeLaunch("hang"),
      timeoutMs: 300,
      onChild: (c: any) => { spawned = c; },
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/timed out/);
    // The process is stopped, not merely abandoned: an npm still writing into
    // the cache directory is what the next attempt reads.
    await new Promise(r => setTimeout(r, 200));
    expect(() => process.kill(spawned!.pid!, 0)).toThrow();
  });
});

describe("npxPrefetch against a fetch that works", () => {
  it("reports success, which is the only thing that costs the deck its port", async () => {
    expect(await npxPrefetch("ccdeck@latest", { launch: fakeLaunch("ok") }))
      .toEqual({ ok: true, error: null, hint: null });
  });

  it("keeps npm's output off a terminal a live deck is still drawing on", async () => {
    // The deck is up throughout, redrawing its pulse line over the last row
    // with \r. Anything npm printed would smear across it.
    const seen: any[] = [];
    await npxPrefetch("ccdeck@latest", {
      launch: fakeLaunch("ok"),
      spawnFn: (file: string, args: string[], opts: any) => {
        seen.push(opts);
        return { stdout: null, stderr: null, on: (ev: string, fn: any) => { if (ev === "exit") setImmediate(() => fn(0, null)); } };
      },
    });
    expect(seen[0].stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});
