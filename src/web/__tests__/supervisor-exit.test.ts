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
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { workerExitAction, RESTART_CODE, UPGRADE_CODE } from "../../server/supervisor.mjs";

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
