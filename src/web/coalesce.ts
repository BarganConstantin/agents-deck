// Pure render-scheduling rule for the SSE stream.
//
// Every hook POST is broadcast as its own SSE message, and each message lands
// in its own macrotask, so React 18's automatic batching never merges them: a
// parallel fan-out of eight subagents firing PreToolUse/PostToolUse delivers
// dozens of events inside a few tens of milliseconds, and rendering per event
// means dozens of full snapshotToFlow + groupNodes + ToolBursts passes over
// every agent on the canvas. Dragging stutters and the tab pegs a core.
//
// Coalescing here is about renders only — the reducer still applies every
// envelope, in arrival order, the moment it arrives — so nothing is dropped or
// reordered, the canvas simply stops redrawing intermediate states nobody can
// perceive at 50 events/sec.
//
// Kept out of App.tsx so the scheduling rule can be unit-tested without React,
// a DOM or real timers.

/** The three ambient functions the coalescer needs, injected so tests can
 *  drive it with a fake clock instead of waiting on real ones. */
export interface CoalescerTimers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

/**
 * Live window. Long enough that a tool storm collapses into one render per
 * frame-ish interval, short enough that a burst still looks instant. The first
 * event of a quiet stream never waits at all — see `live()`.
 */
export const LIVE_COALESCE_MS = 40;

/** Replay window. Replay drains a whole ring buffer as fast as the socket
 *  allows, so it wants a plain trailing debounce: one render once it settles. */
export const REPLAY_COALESCE_MS = 120;

export interface RenderCoalescer {
  /** A live event arrived. */
  live(windowMs?: number): void;
  /** A replayed event arrived. */
  replay(windowMs?: number): void;
  /** Render now, dropping any render already scheduled (the replay-end
   *  sentinel, un-pausing, anything that wants the canvas current at once). */
  flush(): void;
  /** Forget any scheduled render without running it (unmount). */
  cancel(): void;
}

/**
 * Collapse bursts of events into renders that stay ahead of the eye.
 *
 * `live()` is leading-edge: when nothing has rendered inside the window the
 * render happens synchronously, in the same task as the event, so a single
 * event arriving alone — the common case on an idle deck — costs exactly the
 * latency it always did. Only a second event inside the window is deferred,
 * and then to the end of that window, where it is joined by every other event
 * of the burst for one render.
 *
 * The scheduling uses setTimeout rather than requestAnimationFrame on purpose:
 * a background tab stops rAF entirely, which would strand the trailing render
 * of a burst until the tab is looked at again. Browsers clamp background
 * timers instead of stopping them, so a hidden deck renders less often and
 * still converges. For the same reason the delay is clamped to the window —
 * a wall-clock adjustment must not be able to park a render in the future.
 */
export function createRenderCoalescer(
  render: () => void,
  timers: CoalescerTimers,
): RenderCoalescer {
  let timer: number | null = null;
  let scheduledFor = 0;
  let lastRenderAt = Number.NEGATIVE_INFINITY;

  const fire = () => {
    timer = null;
    lastRenderAt = timers.now();
    render();
  };

  const clear = () => {
    if (timer != null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleAt = (deadline: number, now: number, windowMs: number) => {
    if (timer != null) {
      // Already firing no later than we would have asked for: ride along.
      if (scheduledFor <= deadline) return;
      clear();
    }
    const delay = Math.min(windowMs, Math.max(0, deadline - now));
    scheduledFor = deadline;
    timer = timers.setTimeout(fire, delay);
  };

  return {
    live(windowMs = LIVE_COALESCE_MS) {
      const now = timers.now();
      const deadline = Math.max(lastRenderAt + windowMs, now);
      if (deadline <= now) {
        // Window is clear — render in this very task, no timer involved.
        clear();
        fire();
        return;
      }
      scheduleAt(deadline, now, windowMs);
    },
    replay(windowMs = REPLAY_COALESCE_MS) {
      // Trailing debounce: each replayed event pushes the render back, so the
      // drain costs one render however many envelopes it carries.
      clear();
      const now = timers.now();
      scheduledFor = now + windowMs;
      timer = timers.setTimeout(fire, windowMs);
    },
    flush() {
      clear();
      fire();
    },
    cancel() {
      clear();
    },
  };
}
