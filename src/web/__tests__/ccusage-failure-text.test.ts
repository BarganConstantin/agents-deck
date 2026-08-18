// A failed ccusage run printed whatever `err.message` happened to be into the
// usage-history modal — "spawn npx ENOENT", "Command failed with exit code 1",
// or, when the browser could not reach the deck at all, the client's own bare
// "request failed". None of it says that ccusage is an external CLI the deck
// installs and runs, and none of it says what to do; the four ways a run can end
// mean four different remedies and /api/ccusage collapsed all four into one
// string, so there was nothing to map even if the modal had wanted to.
//
// So the route now tags the failure with the reason it knows — it raised three
// of them itself — and the modal answers from the reason map, the same ranking
// switch-failure-text.test.ts pins for claude-swap: the map speaks and the CLI's
// own bytes stay evidence on the title. These pin both halves, and the one case
// that only ever arrives inside those bytes: a machine without npx words it
// differently depending on how the fallback was launched — a plain spawn error,
// cmd.exe's "is not recognized", or, from a deck old enough to have used a
// shell, sh's or dash's own line.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CCUSAGE_REASONS, commandOutput, explainCcusageFailure } from "../admin-failure";

// ccusage.mjs resolves ~/.agents-deck/ccusage out of the home directory at
// import time, and nothing here may touch the real one — so every home-shaped
// variable points into a temp directory BEFORE the module loads, and the
// resolution is checked rather than assumed. AGENTS_DECK_NO_INSTALL=1 is set
// with them: no test in this file may reach the registry, and the runnable cases
// below hand ccusage.mjs a package it can resolve without one.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-failure-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  PATH: process.env.PATH,
  AGENTS_DECK_CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");
process.env.AGENTS_DECK_NO_INSTALL = "1";
// #433 made a ccusage the user provided — at AGENTS_DECK_CCUSAGE, or on PATH —
// a runner in its own right, and under AGENTS_DECK_NO_INSTALL=1 it is the one
// path left. That is exactly what the no_install case below is asserting the
// ABSENCE of, so PATH here has to hold no ccusage; the developer's own PATH
// very well might. The children this file really does spawn are launched by
// absolute path (process.execPath), so emptying it costs them nothing.
process.env.PATH = SANDBOX;
delete process.env.AGENTS_DECK_CCUSAGE;
if (!homedir().startsWith(SANDBOX)) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${SANDBOX}`);
}

// @ts-expect-error — .mjs server module, no types
const { fetchCcusageDaily } = await import("../../server/ccusage.mjs");

const PKG_DIR = join(SANDBOX, ".agents-deck", "ccusage", "node_modules", "ccusage");
if (!PKG_DIR.startsWith(SANDBOX)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${SANDBOX}`);

/** Stand in for the managed install with a script that prints what the test
 *  needs. Real spawn, real exit code — the point is the route's own tagging. */
function fakeCcusage(body: string) {
  mkdirSync(join(PKG_DIR, "src"), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "0.0.0-test", bin: "./src/cli.js" }));
  writeFileSync(join(PKG_DIR, "src", "cli.js"), body);
}

afterAll(() => {
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

// Results are cached for two minutes per range, so every case asks for its own.
describe("what /api/ccusage says went wrong", () => {
  it("names the opt-out that forbade the install rather than the exception it threw", async () => {
    rmSync(join(SANDBOX, ".agents-deck"), { recursive: true, force: true });
    const res = await fetchCcusageDaily({ since: "20260201" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_install");
    expect(res.error).toContain("AGENTS_DECK_NO_INSTALL");
  });

  it("calls output that is not usage data its own failure, not a failed run", async () => {
    fakeCcusage(`console.log("ccusage: no Claude data directory here");`);
    const res = await fetchCcusageDaily({ since: "20260202" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_output");
  });

  it("says the same for output that looks like JSON and is not", async () => {
    fakeCcusage(`console.log("{ daily: [] }");`);
    const res = await fetchCcusageDaily({ since: "20260203" });

    expect(res.reason).toBe("bad_output");
  });

  it("calls a CLI that exited on its own a failed run", async () => {
    fakeCcusage(`console.error("ccusage: unknown option --since"); process.exit(1);`);
    const res = await fetchCcusageDaily({ since: "20260204" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("run_failed");
    expect(res.error).toContain("unknown option");
  });

  it("tags nothing when the run worked, so a reason always means a failure", async () => {
    fakeCcusage(`console.log(JSON.stringify({ daily: [{ period: "2026-02-05", totalCost: 1 }], totals: {} }));`);
    const res = await fetchCcusageDaily({ since: "20260205" });

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.days).toHaveLength(1);
  });

  it("has a sentence in the modal for every reason it can send", async () => {
    for (const reason of ["no_install", "bad_output", "run_failed", "timeout"]) {
      expect(CCUSAGE_REASONS[reason], reason).toBeTruthy();
    }
  });
});

describe("what the modal shows for a failed run", () => {
  const RAW_NO_INSTALL = "ccusage is not installed, and installs are off (AGENTS_DECK_NO_INSTALL=1)";

  it("explains the opt-out and how to undo it, not the sentence the server threw", () => {
    const said = explainCcusageFailure({ reason: "no_install", error: RAW_NO_INSTALL }, "x");
    expect(said).toBe(CCUSAGE_REASONS.no_install);
    expect(said).toMatch(/AGENTS_DECK_NO_INSTALL/);
    expect(said).toMatch(/unset/);
  });

  it("blames the deadline for a timeout and points at the narrower ranges on screen", () => {
    const said = explainCcusageFailure({ reason: "timeout", error: "ccusage timed out" }, "x");
    expect(said).toBe(CCUSAGE_REASONS.timeout);
    expect(said).toMatch(/narrower range/);
  });

  it("does not print the CLI's last line as the whole account of a failed run", () => {
    const raw = "Command failed with exit code 1";
    const said = explainCcusageFailure({ reason: "run_failed", error: raw }, "x");
    expect(said).toBe(CCUSAGE_REASONS.run_failed);
    expect(said).not.toContain(raw);
  });

  it("ends every reason it knows in something the reader can do", () => {
    // The alternation is the list of remedies actually in use, not a style
    // rule — a new reason belongs on it only once its sentence really does end
    // in an action the reader can take.
    for (const [reason, sentence] of Object.entries(CCUSAGE_REASONS)) {
      expect(`${reason}: ${/try again|unset|narrower|reopen/.test(sentence)}`).toBe(`${reason}: true`);
    }
  });

  it("says the deck did not answer when the browser never got a response at all", () => {
    // The client writes this one itself: there is no server reply to carry a
    // reason, and "request failed" said less than the raw errors did.
    expect(explainCcusageFailure({ reason: "unreachable" }, "x")).toBe(CCUSAGE_REASONS.unreachable);
  });

  it("names a reason a newer server sends that this build has no sentence for", () => {
    expect(explainCcusageFailure({ reason: "quota_exceeded", error: "…" }, "x")).toBe("quota_exceeded");
  });

  it("falls back when the reply carried neither a reason nor anything else", () => {
    expect(explainCcusageFailure(null, "ccusage did not report usage")).toBe("ccusage did not report usage");
    expect(explainCcusageFailure({}, "ccusage did not report usage")).toBe("ccusage did not report usage");
  });

  it("hands the CLI's own line back for the title, where a traceback is a hover away", () => {
    expect(commandOutput({ reason: "run_failed", error: "  ccusage exited 3  " })).toBe("ccusage exited 3");
    expect(commandOutput({ reason: "unreachable" })).toBe("");
  });
});

describe("the missing-npx fallback, which every platform words differently", () => {
  // Whatever launched the fallback is what reports the absence, and the reason
  // is only ever run_failed. Every line below is the same machine. The first
  // three are what a deck that still used `shell: true` produced, and they stay
  // here because a browser can be newer than the deck it is talking to; the last
  // two are what the shell-free spawn produces now — a spawn error off Windows,
  // and cmd.exe's own verdict on the .cmd shim on it.
  const SHELLS = [
    ["dash, Debian's /bin/sh", "/bin/sh: 1: npx: not found"],
    ["bash", "sh: npx: command not found"],
    ["zsh", "zsh: command not found: npx"],
    ["cmd.exe", "'npx.cmd' is not recognized as an internal or external command,\r\noperable program or batch file."],
    ["a direct spawn, off Windows", "spawn npx ENOENT"],
  ] as const;

  it("says npx is missing and what to install, on every platform's wording", () => {
    for (const [shell, output] of SHELLS) {
      const said = explainCcusageFailure({ reason: "run_failed", error: output }, "x");
      expect(said, shell).toMatch(/npx/);
      expect(said, shell).toMatch(/PATH/);
      expect(said, shell).not.toBe(CCUSAGE_REASONS.run_failed);
    }
  });

  it("keeps that remedy out of the way of failures that merely mention a missing file", () => {
    // ccusage's own "not found" is about the logs it reads, and telling that
    // user to install npx would be advice for a machine that already has it.
    expect(explainCcusageFailure({ reason: "run_failed", error: "Error: not found: ~/.claude/projects" }, "x"))
      .toBe(CCUSAGE_REASONS.run_failed);
  });
});

describe("the modal itself", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../components/UsageHistoryModal.tsx", import.meta.url)),
    "utf8",
  );

  it("no longer renders the server's raw string as the explanation", () => {
    expect(src).not.toMatch(/ccusage failed:/);
    expect(src).toContain("explainCcusageFailure(");
  });

  it("keeps the raw line as evidence on the title, the way the accounts panel does", () => {
    expect(src).toMatch(/title=\{commandOutput\(/);
  });

  it("puts a retry where the failure is, since nothing said the header ↻ was the fix", () => {
    expect(src).toMatch(/uh-retry/);
  });
});
