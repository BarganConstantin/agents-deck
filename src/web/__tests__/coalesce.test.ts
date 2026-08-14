// Live SSE events used to render one full canvas rebuild each: a parallel
// fan-out delivers dozens of events in tens of milliseconds, each in its own
// macrotask, so React never batched them and the tab pegged a core. The
// coalescer collapses a burst into one render per window — without delaying a
// lone event, and without ever dropping the render that shows the last event.
import { describe, it, expect } from "vitest";
import {
  createRenderCoalescer,
  LIVE_COALESCE_MS,
  REPLAY_COALESCE_MS,
  type CoalescerTimers,
} from "../coalesce";

/** A fake clock plus a fake timer queue, so the rule can be driven in plain
 *  node with no DOM, no vitest fake timers and no waiting. */
function harness(start = 1_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const rendersAt: number[] = [];

  const clock: CoalescerTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
  };

  /** Run the clock forward, firing timers due along the way in time order. */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, t] of timers) {
        if (t.at <= target && t.at < dueAt) { dueId = id; dueAt = t.at; }
      }
      if (dueId == null) break;
      const t = timers.get(dueId)!;
      timers.delete(dueId);
      now = Math.max(now, t.at);
      t.fn();
    }
    now = target;
  };

  const coalescer = createRenderCoalescer(() => { rendersAt.push(now); }, clock);
  return {
    coalescer,
    rendersAt,
    advance,
    setNow: (t: number) => { now = t; },
    now: () => now,
    pending: () => timers.size,
  };
}

describe("createRenderCoalescer", () => {
  it("renders a lone live event in the same task, with no delay", () => {
    const h = harness();
    h.coalescer.live();
    expect(h.rendersAt).toEqual([h.now()]);
    expect(h.pending()).toBe(0);
  });

  it("does not delay live events that arrive further apart than the window", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.coalescer.live();
      h.advance(LIVE_COALESCE_MS + 5);
    }
    expect(h.rendersAt.length).toBe(5);
    expect(h.pending()).toBe(0);
  });

  it("collapses a burst inside one window into a single trailing render", () => {
    const h = harness();
    h.coalescer.live();               // leading edge, renders now
    for (let i = 0; i < 30; i++) {
      h.advance(1);
      h.coalescer.live();             // all inside the window
    }
    expect(h.rendersAt.length).toBe(1);
    h.advance(LIVE_COALESCE_MS);
    expect(h.rendersAt.length).toBe(2); // one render for the whole burst
    expect(h.pending()).toBe(0);
  });

  it("holds a sustained storm to roughly one render per window", () => {
    const h = harness();
    // 50 events/sec for two seconds — the fan-out scenario from the report.
    for (let i = 0; i < 100; i++) {
      h.coalescer.live();
      h.advance(20);
    }
    h.advance(LIVE_COALESCE_MS);
    // Unbounded would be 100. One per 40ms window over 2s is ~50.
    expect(h.rendersAt.length).toBeLessThanOrEqual(2_000 / LIVE_COALESCE_MS + 2);
    expect(h.rendersAt.length).toBeGreaterThan(1);
  });

  it("always renders after the last event of a burst, so nothing is left unseen", () => {
    const h = harness();
    for (let i = 0; i < 12; i++) { h.coalescer.live(); h.advance(3); }
    const lastEventAt = h.now();
    h.advance(LIVE_COALESCE_MS * 2);
    expect(h.rendersAt.at(-1)!).toBeGreaterThanOrEqual(lastEventAt);
  });

  it("never lets a live event wait longer than the window", () => {
    const h = harness();
    h.coalescer.live();
    const at = h.now();
    h.advance(1);
    h.coalescer.live();
    h.advance(LIVE_COALESCE_MS);
    expect(h.rendersAt.at(-1)! - at).toBeLessThanOrEqual(LIVE_COALESCE_MS);
  });

  it("debounces replay traffic to one render once the drain settles", () => {
    const h = harness();
    for (let i = 0; i < 40; i++) { h.coalescer.replay(); h.advance(2); }
    expect(h.rendersAt.length).toBe(0);
    h.advance(REPLAY_COALESCE_MS);
    expect(h.rendersAt.length).toBe(1);
  });

  it("does not make a live event wait out a pending replay debounce", () => {
    const h = harness();
    h.coalescer.replay();
    const at = h.now();
    h.advance(5);
    h.coalescer.live();
    h.advance(LIVE_COALESCE_MS);
    expect(h.rendersAt.length).toBe(1);
    expect(h.rendersAt[0]! - at).toBeLessThan(REPLAY_COALESCE_MS);
  });

  it("flush renders at once and drops the scheduled render", () => {
    const h = harness();
    h.coalescer.replay();
    h.coalescer.flush();
    expect(h.rendersAt).toEqual([h.now()]);
    h.advance(REPLAY_COALESCE_MS * 2);
    expect(h.rendersAt.length).toBe(1);
    expect(h.pending()).toBe(0);
  });

  it("cancel drops a scheduled render without running it", () => {
    const h = harness();
    h.coalescer.live();
    h.advance(1);
    h.coalescer.live();
    h.coalescer.cancel();
    h.advance(LIVE_COALESCE_MS * 4);
    expect(h.rendersAt.length).toBe(1);
    expect(h.pending()).toBe(0);
  });

  it("survives a background tab clamping the timer far past the window", () => {
    const h = harness();
    h.coalescer.live();
    h.advance(1);
    for (let i = 0; i < 20; i++) h.coalescer.live();
    h.advance(2_000); // hidden tab: browsers clamp timers, they do not drop them
    expect(h.rendersAt.length).toBe(2);
    expect(h.pending()).toBe(0);
    h.coalescer.live();               // and the deck is responsive again after
    expect(h.rendersAt.length).toBe(3);
  });

  it("keeps the wait bounded when the wall clock jumps backwards", () => {
    const h = harness(10_000);
    h.coalescer.live();
    h.setNow(4_000); // NTP correction / DST step between two events
    h.coalescer.live();
    h.advance(LIVE_COALESCE_MS);
    expect(h.rendersAt.length).toBe(2);
  });
});
