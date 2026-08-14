// v1.33.82 taught the deck to report an npx upgrade that failed: the supervisor
// leaves a note, the next worker serves it, and the banner turns into "update
// failed: <npm's error> — run it yourself:" with the button relabelled "Retry
// update". The tab never learned its restart had ended, though. A failed
// `npx -y <spec>@latest` relaunches the OLD copy on the SAME port, so `running`
// never moves and the "landed" check waits for a version that is not coming —
// leaving that Retry button disabled and reading "fetching…" for the whole
// 180s askRestart allows, next to the banner explaining the failure.
//
// These pin the rule that ends such an attempt, and the one subtlety in it: the
// previous note is still on disk while the retry fetches, so "a failure is
// reported" is not the same question as "this attempt failed". Pure module, no
// filesystem and no environment — nothing here can reach a real ~/.claude.
import { describe, it, expect } from "vitest";
import { restartEndedInFailure, upgradeFailureId } from "../restart";

const AT = 1_800_000_000_000;
const failed = (at: number, error: string) => ({ state: "failed", command: "npx -y ccdeck", error, at });

describe("upgradeFailureId", () => {
  it("says nothing about an upgrade that has not failed", () => {
    expect(upgradeFailureId({ state: "idle", error: null, at: 0 })).toBeNull();
    expect(upgradeFailureId({ state: "running", error: null, at: AT })).toBeNull();
    expect(upgradeFailureId({ state: "done", error: null, at: AT })).toBeNull();
    expect(upgradeFailureId(null)).toBeNull();
    expect(upgradeFailureId(undefined)).toBeNull();
  });

  it("tells a retry's failure from the one it was retrying", () => {
    // The whole point: a retry that breaks the same way reports the same
    // command and the same error, and only the supervisor's stamp differs.
    const first = upgradeFailureId(failed(AT, "npm ERR! ETARGET"));
    const second = upgradeFailureId(failed(AT + 42_000, "npm ERR! ETARGET"));
    expect(first).not.toBeNull();
    expect(second).not.toEqual(first);
  });

  it("gives the same failure the same id however often it is polled", () => {
    // /api/version answers with a fresh object every three seconds; the id is
    // what stops each of those from reading as news.
    expect(upgradeFailureId(failed(AT, "boom"))).toEqual(upgradeFailureId(failed(AT, "boom")));
  });

  it("still identifies a note that lost its timestamp", () => {
    // restartFailureNotice zeroes a non-numeric `at`, and an older supervisor
    // wrote none at all. The error text has to carry the identity then.
    expect(upgradeFailureId({ state: "failed", error: "boom", at: null }))
      .not.toEqual(upgradeFailureId({ state: "failed", error: "different", at: null }));
  });

  it("reads the same on every platform, because the note is only text", () => {
    // Windows fails in the npx shim with a MODULE_NOT_FOUND stack, Linux and
    // macOS fail in the registry lookup. Neither the rule nor the id cares.
    const windows = upgradeFailureId(failed(AT, "Cannot find module 'C:\\Users\\J S\\AppData\\npm\\npx-cli.js'"));
    const posix = upgradeFailureId(failed(AT, "npm ERR! code ETARGET"));
    expect(windows).not.toBeNull();
    expect(posix).not.toBeNull();
    expect(windows).not.toEqual(posix);
  });
});

describe("restartEndedInFailure", () => {
  it("ends the first attempt as soon as the failure it caused shows up", () => {
    const reported = upgradeFailureId(failed(AT, "npx exited 1"));
    expect(restartEndedInFailure({ asked: null, reported })).toBe(true);
  });

  it("keeps waiting while nothing has failed", () => {
    // The seconds between the click and the supervisor's verdict, and every
    // restart that is going to succeed.
    expect(restartEndedInFailure({ asked: null, reported: null })).toBe(false);
    expect(restartEndedInFailure({ asked: upgradeFailureId(failed(AT, "boom")), reported: null })).toBe(false);
  });

  it("keeps waiting through a retry, whose banner still shows the old failure", () => {
    // The regression this file exists for, in reverse: while npx fetches, the
    // tab cannot reach a server, so the version it holds is the failed one it
    // was already showing when the retry was clicked. Ending the attempt on
    // that would re-enable the button mid-fetch and offer a third attempt.
    const previous = upgradeFailureId(failed(AT, "npm ERR! ETARGET"));
    expect(restartEndedInFailure({ asked: previous, reported: previous })).toBe(false);
  });

  it("ends the retry when it fails in its own right", () => {
    const previous = upgradeFailureId(failed(AT, "npm ERR! ETARGET"));
    const own = upgradeFailureId(failed(AT + 90_000, "npm ERR! ETARGET"));
    expect(restartEndedInFailure({ asked: previous, reported: own })).toBe(true);
  });

  it("walks the whole failed upgrade the way the tab polls it", () => {
    // Click, server gone, old copy back with the note, and the button has to be
    // usable at that last step rather than three minutes later.
    const asked = null;
    const polls = [
      null,                                        // /api/version unreachable: last known report, no failure
      null,                                        // still fetching
      upgradeFailureId(failed(AT, "npx exited 1")), // supervisor gave up, old copy serving again
    ];
    expect(polls.map(reported => restartEndedInFailure({ asked, reported }))).toEqual([false, false, true]);
  });
});
