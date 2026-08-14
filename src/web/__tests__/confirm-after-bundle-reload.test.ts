// A restart that changes the version is the one case the green "Restarted —
// now running vX" banner exists for, and it was the one case that never showed
// it. Two effects hung off the same move of `running`: one reloaded the stale
// tab into the new bundle, the other consumed the sessionStorage marker and
// raised the banner. React flushes both in a single synchronous pass and
// `location.reload()` only schedules the navigation, so the second still ran —
// deleting, synchronously and into a store that outlives the navigation, the
// very marker meant to carry the confirmation across it. The new bundle came up
// with nothing pending and said nothing.
//
// One decision now, and these pin it: who owns the confirmation when a reload
// is due, and that the reload itself still happens for a tab with nothing
// pending at all. Pure module — no filesystem, no environment, nothing here can
// reach a real ~/.claude.
import { describe, it, expect } from "vitest";
import { restartLandingStep } from "../restart";

const OLD = "1.33.91";
const NEW = "1.33.92";

describe("restartLandingStep", () => {
  it("leaves the marker for the bundle that will be able to show it", () => {
    // The regression. A stale tab hearing the new version must reload and
    // confirm nothing — consuming the marker here throws the confirmation away.
    expect(restartLandingStep({ bundle: OLD, running: NEW, pending: NEW, lastTried: null })).toBe("reload");
  });

  it("confirms once the new bundle is the one asking", () => {
    // The same marker, one navigation later: the reloaded page's own version is
    // the version answering, so it is the page that can honestly claim it.
    expect(restartLandingStep({ bundle: NEW, running: NEW, pending: NEW, lastTried: NEW })).toBe("confirm");
  });

  it("still reloads a stale tab that was not waiting on anything", () => {
    // A restart from a terminal moves `running` with no marker in this tab, and
    // that bundle is just as old. Folding the two decisions into one must not
    // make the reload depend on a pending restart.
    expect(restartLandingStep({ bundle: OLD, running: NEW, pending: null, lastTried: null })).toBe("reload");
  });

  it("confirms a plain restart, which carries no version to wait for", () => {
    // askRestart stores "" when there is no notice to name a target. Falsy, so
    // it must not be mistaken for "still the old process".
    expect(restartLandingStep({ bundle: NEW, running: NEW, pending: "", lastTried: null })).toBe("confirm");
  });

  it("keeps waiting while the old process is still the one answering", () => {
    // The seconds between the click and the new server's first reply, when the
    // tab and the process it is talking to are still the version being replaced.
    expect(restartLandingStep({ bundle: OLD, running: OLD, pending: NEW, lastTried: null })).toBe("wait");
  });

  it("says nothing when no restart is pending and the code matches", () => {
    expect(restartLandingStep({ bundle: NEW, running: NEW, pending: null, lastTried: null })).toBe("wait");
  });

  it("waits until the server has reported a version at all", () => {
    // First paint, and every poll that failed. There is nothing to reload into
    // and nothing to confirm.
    expect(restartLandingStep({ bundle: OLD, running: null, pending: NEW, lastTried: null })).toBe("wait");
    expect(restartLandingStep({ bundle: OLD, running: undefined, pending: "", lastTried: null })).toBe("wait");
  });

  it("confirms from a bundle a reload could not bring up to date", () => {
    // `npm version` without a rebuild — every checkout mid-release — leaves the
    // bundle permanently behind the package version. The reload already
    // happened, none is coming, so this page is the last one that can confirm;
    // deferring again would strand the marker and leave the restart button
    // disabled until askRestart's timeout.
    expect(restartLandingStep({ bundle: OLD, running: NEW, pending: NEW, lastTried: NEW })).toBe("confirm");
  });

  it("compares versions as text, the same on every platform", () => {
    // No semver parsing anywhere in this path: the bundle stamp and the
    // server's version are both strings, and a prerelease suffix or a differing
    // patch digit is a different version by string equality alone. Windows,
    // macOS and Linux all read this identically.
    expect(restartLandingStep({ bundle: "1.33.9", running: "1.33.90", pending: "1.33.90", lastTried: null })).toBe("reload");
    expect(restartLandingStep({ bundle: `${NEW}-rc.1`, running: NEW, pending: NEW, lastTried: null })).toBe("reload");
    expect(restartLandingStep({ bundle: NEW, running: NEW, pending: NEW, lastTried: null })).toBe("confirm");
  });

  it("walks a version-changing restart the way the tab lives it", () => {
    // Click, marker stored, server gone, new server answering — and then the
    // navigation, which throws away everything except sessionStorage. The
    // banner has to be raised exactly once, by the bundle that is running the
    // version it names.
    const store = new Map<string, string>([["pending", NEW]]);
    const seen: string[] = [];
    const tick = (bundle: string) => {
      const step = restartLandingStep({
        bundle,
        running: NEW,
        pending: store.get("pending") ?? null,
        lastTried: store.get("lastTried") ?? null,
      });
      seen.push(step);
      if (step === "reload") store.set("lastTried", NEW);       // then location.reload()
      if (step === "confirm") store.delete("pending");          // then the banner
      return step;
    };

    tick(OLD);                       // the stale tab, on the commit that reloads it
    expect(store.get("pending")).toBe(NEW);
    tick(NEW);                       // the fresh bundle, first version poll
    tick(NEW);                       // and the poll three seconds later
    expect(seen).toEqual(["reload", "confirm", "wait"]);
  });
});
