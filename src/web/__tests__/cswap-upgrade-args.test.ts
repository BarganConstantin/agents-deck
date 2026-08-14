// The background upgrade of claude-swap used to rebuild its command line from
// the installer's `via` label, and knew only "uv" and "pipx". Every other label
// fell through to `<cmd> -m pipx upgrade claude-swap` — including
// "uv (bundled)", the uv the deck fetches for itself, which is by construction
// the ONLY installer on a machine that had no uv, no pipx and no safe python.
// uv exits 2 on `-m`, runDetached captures nothing, and ensureCswap still
// answered "upgrading": a daily check that lies forever. These tests pin the
// command line each installer actually gets.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLED = join("/fake-deck", "tools", "uv", "uv");

// Nothing is executed: `run` answers from a table and `runDetached` only
// records, so a regression shows up as the wrong recorded argv rather than as
// a real upgrade on the machine running the suite.
const { probeOk, detached } = vi.hoisted(() => ({
  probeOk: { is: (_cmd: string) => false },
  detached: [] as { cmd: string; args: string[] }[],
}));

const ok = (stdout: string) => ({ ok: true, code: 0, killed: false, stdout, stderr: "" });
const fail = () => ({ ok: false, code: "ENOENT", killed: false, stdout: "", stderr: "" });

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    // The installed copy, so ensureCswap takes the "already present" path.
    if (/cswap(\.exe)?$/.test(cmd) && args[0] === "--version") return ok("claude-swap 0.25.0");
    // safePythons: make the answer the same on all three platforms — a python
    // exists, so the `python -m pipx` entry is always in the list.
    if (cmd === "xcode-select") return ok("/Library/Developer/CommandLineTools");
    if (cmd === "py" && args[0] === "-0") return ok(" -V:3.12 *");
    if (cmd === "where") return fail();
    return probeOk.is(cmd) ? ok("1.0.0") : fail();
  },
  runDetached: (cmd: string, args: string[]) => { detached.push({ cmd, args }); },
}));

vi.mock("../../server/uv-bootstrap.mjs", () => ({
  existingBootstrappedUv: () => BUNDLED,
  bootstrapUv: async () => ({ ok: false, reason: "test" }),
}));

// PyPI says there is something newer, without touching the network.
vi.stubGlobal("fetch", async () => ({
  ok: true,
  json: async () => ({ info: { version: "9.9.9" } }),
}));

// The update-check marker is written under homedir(), which reads $HOME on
// POSIX and %USERPROFILE% on Windows. Both point at a temp directory BEFORE the
// module under test loads, so no test here can read or write the real one.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-cswap-upgrade-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  CSWAP: process.env.AGENTS_DECK_CSWAP,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_CSWAP;

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE],
    ["AGENTS_DECK_NO_INSTALL", prev.NO_INSTALL], ["AGENTS_DECK_CSWAP", prev.CSWAP]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

/** Run one daily check with exactly one installer available. */
async function upgradeWith(available: (cmd: string) => boolean) {
  detached.length = 0;
  probeOk.is = available;
  // The marker throttles the check to once a day, and the module caches both the
  // resolved binary and the python list — a fresh instance per case.
  rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  const { ensureCswap } = await import("../../server/cswap-install.mjs");
  const state = await ensureCswap();
  return { state, detached: [...detached] };
}

describe("the background claude-swap upgrade", () => {
  it("gives the bundled uv a uv command line, not a pipx one", async () => {
    const { state, detached } = await upgradeWith(cmd => cmd === BUNDLED);

    expect(state).toMatchObject({ state: "upgrading", version: "0.25.0", via: "uv (bundled)" });
    expect(detached).toEqual([{ cmd: BUNDLED, args: ["tool", "upgrade", "claude-swap"] }]);
    // The regression exactly: uv exits 2 on `-m`, and says nothing anyone sees.
    expect(detached[0].args).not.toContain("-m");
  });

  it("still uses the right command line for uv, pipx and python -m pipx", async () => {
    const uv = await upgradeWith(cmd => cmd === "uv");
    expect(uv.state).toMatchObject({ state: "upgrading", via: "uv" });
    expect(uv.detached).toEqual([{ cmd: "uv", args: ["tool", "upgrade", "claude-swap"] }]);

    const pipx = await upgradeWith(cmd => cmd === "pipx");
    expect(pipx.state).toMatchObject({ state: "upgrading", via: "pipx" });
    expect(pipx.detached).toEqual([{ cmd: "pipx", args: ["upgrade", "claude-swap"] }]);

    // `py` on Windows, `python3` elsewhere — whichever safePythons found.
    const py = await upgradeWith(cmd => cmd === "py" || cmd === "python3");
    expect(py.state).toMatchObject({ state: "upgrading" });
    expect(py.state.via).toMatch(/-m pipx$/);
    expect(py.detached).toEqual([
      { cmd: py.state.via.replace(" -m pipx", ""), args: ["-m", "pipx", "upgrade", "claude-swap"] },
    ]);
  });

  it("upgrades nothing when no installer answers", async () => {
    const { state, detached } = await upgradeWith(() => false);

    expect(state).toEqual({ state: "present", version: "0.25.0" });
    expect(detached).toEqual([]);
  });
});
