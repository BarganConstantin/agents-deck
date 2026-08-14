// What the supervisor does with a dead worker, and specifically what it does
// with one that died in the same instant the user pressed Ctrl+C.
//
// The deck asks to be restarted by exiting 75 (or 76, "come back through npx").
// The supervisor used to act on that code before checking whether it was still
// supposed to be running at all, so a Ctrl+C landing on a worker that was
// already mid-restart got a fresh deck spawned on top of it: the terminal
// printed `restarted → vX · http://…` after the stop, and the new worker served
// until the signal handler's 2.5s retry timer happened to kill it. The 76
// variant started a full npx registry fetch first.
//
// Ctrl+C is the input here, and it reaches this process on every platform —
// POSIX delivers it to the foreground process group, Windows raises
// CTRL_C_EVENT for the whole console — so `stopping` is a parameter and both
// answers are asserted.
//
// The second half of the file is the other way a worker can end — not with an
// exit code at all, but killed by a signal — and what the supervisor owes its
// caller then.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs server module, no types
import { workerExitAction, signalExitAction, RESTART_CODE, UPGRADE_CODE } from "../../server/supervisor.mjs";

describe("workerExitAction while the deck is running", () => {
  it("brings the worker back from disk on 75", () => {
    expect(workerExitAction(RESTART_CODE, false)).toEqual({ relaunch: "disk" });
  });

  it("goes through npx on 76, which is the only way to newer files", () => {
    expect(workerExitAction(UPGRADE_CODE, false)).toEqual({ relaunch: "npx" });
  });

  it("passes any other verdict of the worker's straight through", () => {
    expect(workerExitAction(0, false)).toEqual({ relaunch: null, code: 0 });
    expect(workerExitAction(1, false)).toEqual({ relaunch: null, code: 1 });
    expect(workerExitAction(74, false)).toEqual({ relaunch: null, code: 74 });
    expect(workerExitAction(77, false)).toEqual({ relaunch: null, code: 77 });
  });

  it("reads a worker killed by a signal — code null — as a plain stop", () => {
    expect(workerExitAction(null, false)).toEqual({ relaunch: null, code: 0 });
    expect(workerExitAction(undefined, false)).toEqual({ relaunch: null, code: 0 });
  });
});

describe("workerExitAction after Ctrl+C", () => {
  it("does not resurrect the deck the user just stopped", () => {
    // The regression. Restart clicked, Ctrl+C in the same instant: the signal
    // handler sets stopping, and the exit event then arrives still carrying 75.
    expect(workerExitAction(RESTART_CODE, true).relaunch).toBeNull();
    // And 76 must not start an npx fetch nobody is waiting for either.
    expect(workerExitAction(UPGRADE_CODE, true).relaunch).toBeNull();
  });

  it("stops cleanly rather than reporting the private protocol code", () => {
    // 75 is EX_TEMPFAIL to anything reading sysexits, and the ccdeck wrapper
    // exits with whatever the supervisor does — a stop the user asked for is
    // not a failure.
    expect(workerExitAction(RESTART_CODE, true)).toEqual({ relaunch: null, code: 0 });
    expect(workerExitAction(UPGRADE_CODE, true)).toEqual({ relaunch: null, code: 0 });
  });

  it("still reports a real failure the worker had on its way out", () => {
    expect(workerExitAction(1, true)).toEqual({ relaunch: null, code: 1 });
    expect(workerExitAction(0, true)).toEqual({ relaunch: null, code: 0 });
  });
});

describe("signalExitAction", () => {
  it("re-raises on POSIX, where dying of the signal is the real status", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(signalExitAction("SIGHUP", platform)).toEqual({ reraise: "SIGHUP", code: 129 });
      expect(signalExitAction("SIGINT", platform)).toEqual({ reraise: "SIGINT", code: 130 });
      expect(signalExitAction("SIGTERM", platform)).toEqual({ reraise: "SIGTERM", code: 143 });
    }
  });

  it("exits with the number on Windows, which has no signal to die of", () => {
    // TerminateProcess is not a signal: nothing there sets the killed-by-signal
    // bit, so 128 + n is the whole of what a caller can be told. Windows is the
    // platform this repo cannot execute, so the branch is asserted instead.
    expect(signalExitAction("SIGHUP", "win32")).toEqual({ reraise: null, code: 129 });
    expect(signalExitAction("SIGTERM", "win32")).toEqual({ reraise: null, code: 143 });
  });

  it("falls back to a plain failure for a name it could not re-raise", () => {
    expect(signalExitAction("SIGNOTASIGNAL", "linux")).toEqual({ reraise: null, code: 1 });
    expect(signalExitAction(undefined, "linux")).toEqual({ reraise: null, code: 1 });
  });
});

// The regression, run for real: signals are POSIX, so this is skipped on
// Windows — where signalExitAction's own branch above is what applies.
describe.skipIf(process.platform === "win32")("dieOfSignal in a process that traps signals", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-signal-"));
  const script = join(dir, "supervisor-like.mjs");
  const supervisor = new URL("../../server/supervisor.mjs", import.meta.url).href;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Exactly the shape of bin/agent-dag.js: the same three traps, and the same
  // handler that exits 0 once there is no child left to stop.
  writeFileSync(script, [
    `import { dieOfSignal } from ${JSON.stringify(supervisor)};`,
    `for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));`,
    `dieOfSignal(process.argv[2]);`,
  ].join("\n"));

  const runAndDie = (signal: string) =>
    new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const child = spawn(process.execPath, [script, signal], { stdio: "ignore" });
      child.on("exit", (code, sig) => resolve({ code, signal: sig }));
    });

  it("dies of the signal instead of being caught by its own handler", async () => {
    // Before the fix, the re-raise walked into the trap above and exited 0 —
    // `kill -HUP` on the deck reported success to the shell. deck.js installs no
    // SIGHUP handler at all, so this is the everyday case, not a corner one.
    expect(await runAndDie("SIGHUP")).toEqual({ code: null, signal: "SIGHUP" });
  });

  it("does the same for the signals the supervisor traps for shutdown", async () => {
    // SIGTERM and SIGINT reach the worker during the seconds before deck.js
    // registers its own handlers, and it dies by signal there too.
    expect(await runAndDie("SIGTERM")).toEqual({ code: null, signal: "SIGTERM" });
    expect(await runAndDie("SIGINT")).toEqual({ code: null, signal: "SIGINT" });
  });

  it("exits 1 rather than 0 for a signal name it cannot re-raise", async () => {
    expect(await runAndDie("SIGNOTASIGNAL")).toEqual({ code: 1, signal: null });
  });
});
