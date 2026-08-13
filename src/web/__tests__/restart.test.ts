// The deck can now restart itself when a newer version is sitting on disk.
// Everything about that is recoverable except one thing: hook events fired
// while the server is down are lost permanently — hook/hook.js gives each POST
// a 1s timeout, swallows ECONNREFUSED and never retries — leaving tools stuck
// in flight on the canvas. So the gate that decides "now is a safe moment" is
// the part worth pinning down.
import { describe, it, expect } from "vitest";
import { autoRestartStep, shouldReloadBundle, IDLE_BEFORE_RESTART_MS } from "../restart";

const NOW = 1_800_000_000_000;
const ok = {
  enabled: true,
  kind: "restart" as string | null | undefined,
  canRestart: true,
  busy: false,
  idleSince: null as number | null,
  now: NOW,
};

describe("autoRestartStep", () => {
  it("starts the clock on the first quiet tick rather than restarting at once", () => {
    expect(autoRestartStep(ok)).toEqual({ idleSince: NOW, restart: false });
  });

  it("waits out the full window", () => {
    const started = NOW - IDLE_BEFORE_RESTART_MS + 1;
    expect(autoRestartStep({ ...ok, idleSince: started }).restart).toBe(false);
    expect(autoRestartStep({ ...ok, idleSince: NOW - IDLE_BEFORE_RESTART_MS }).restart).toBe(true);
  });

  it("never restarts while an agent is running", () => {
    // The whole point. A restart here drops the hook events of a live turn.
    const almost = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS };
    expect(autoRestartStep({ ...almost, busy: true }).restart).toBe(false);
  });

  it("makes work reset the clock, not pause it", () => {
    // A single busy tick in the middle of a quiet stretch must buy another full
    // window — otherwise a burst of work is followed instantly by a restart.
    const almost = { ...ok, idleSince: NOW - IDLE_BEFORE_RESTART_MS + 500 };
    const interrupted = autoRestartStep({ ...almost, busy: true });
    expect(interrupted.idleSince).toBeNull();
    const next = autoRestartStep({ ...ok, idleSince: interrupted.idleSince, now: NOW + 1000 });
    expect(next).toEqual({ idleSince: NOW + 1000, restart: false });
  });

  it("does nothing when the user turned it off", () => {
    expect(autoRestartStep({ ...ok, enabled: false, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS }))
      .toEqual({ idleSince: null, restart: false });
  });

  it("never acts on an upgrade notice — that would need an install we do not do", () => {
    const stale = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS };
    expect(autoRestartStep({ ...stale, kind: "upgrade" }).restart).toBe(false);
    expect(autoRestartStep({ ...stale, kind: null }).restart).toBe(false);
    expect(autoRestartStep({ ...stale, kind: undefined }).restart).toBe(false);
  });

  it("obeys the server when it says a restart is impossible", () => {
    // Unsupervised, or --no-persist, where restarting would wipe the canvas.
    const stale = { ...ok, idleSince: NOW - 10 * IDLE_BEFORE_RESTART_MS };
    expect(autoRestartStep({ ...stale, canRestart: false }).restart).toBe(false);
  });

  it("recovers from a clock that jumped backwards", () => {
    // Laptop wake, NTP correction. A negative elapsed must not read as "not yet"
    // for however long the jump was.
    const step = autoRestartStep({ ...ok, idleSince: NOW + 60_000 });
    expect(step).toEqual({ idleSince: NOW, restart: false });
  });
});

describe("shouldReloadBundle", () => {
  // Reported from a real deck: after it restarted itself onto v1.32.0 the tab
  // still showed v1.31.0's banner, without the Restart button that version
  // added — because the page kept executing the bundle it had downloaded. The
  // button "only appeared after a refresh". Nothing else reloads the page, so
  // this does.
  it("reloads when the page's own code is older than the server's", () => {
    expect(shouldReloadBundle({ bundle: "1.31.0", running: "1.32.0", lastTried: null })).toBe(true);
  });

  it("stays put when they match", () => {
    expect(shouldReloadBundle({ bundle: "1.32.0", running: "1.32.0", lastTried: null })).toBe(false);
  });

  it("reloads at most once per server version", () => {
    // `npm version` without a rebuild leaves the bundle permanently behind the
    // package version — every checkout mid-release. Without this guard that is
    // an endless reload loop.
    expect(shouldReloadBundle({ bundle: "1.31.0", running: "1.32.0", lastTried: "1.32.0" })).toBe(false);
    // A later version is a new reason, and gets its own single attempt.
    expect(shouldReloadBundle({ bundle: "1.31.0", running: "1.33.0", lastTried: "1.32.0" })).toBe(true);
  });

  it("does nothing before the server has answered", () => {
    expect(shouldReloadBundle({ bundle: "1.31.0", running: null, lastTried: null })).toBe(false);
    expect(shouldReloadBundle({ bundle: null, running: "1.32.0", lastTried: null })).toBe(false);
  });
});
