// Pause is a freeze of the canvas, not a disconnect from the server.
//
// The deck reads its events from one long-lived EventSource. When the pause
// flag lived in React state and the subscription effect listed it as a
// dependency, pressing Space closed that EventSource and opened a new one — and
// a brand-new EventSource carries no Last-Event-ID, so the server replayed its
// whole ring buffer (up to 2000 envelopes) down the fresh connection. The
// handler was paused by then, so every replayed envelope landed in the pause
// queue: the button read "Resume · 2000" after zero new events, memory held
// thousands of envelopes the reducer had already applied, and resuming re-ran
// all of them just for the seq check to throw each one away — then reconnected
// and replayed the lot a second time.
//
// Holding both the flag and the queue in this gate fixes that structurally.
// The gate is a plain mutable object living in a ref, so the SSE handler asks
// it about the current pause state instead of closing over a state variable,
// and the subscription effect no longer has any reason to name `paused` among
// its dependencies. One connection survives any number of pause toggles.
//
// Kept out of App.tsx so the rule can be tested without React or a DOM.

/** Holds events back while the deck is paused, and hands them over in arrival
 *  order — exactly once — when it resumes. */
export interface PauseGate<T> {
  /** Whether the deck is currently paused. */
  readonly paused: boolean;
  /** How many events are waiting. What the Resume button counts. */
  readonly size: number;
  /**
   * Offer an arriving event to the gate. Returns true when the caller should
   * deliver it now, false when the gate has taken it for later.
   */
  accept(event: T): boolean;
  /**
   * Set the pause flag. Returns the events held since the deck was paused, in
   * arrival order, and empties the queue — so a resume delivers each held
   * event once and a second call has nothing left to give.
   */
  setPaused(paused: boolean): T[];
}

export function createPauseGate<T>(): PauseGate<T> {
  let paused = false;
  let queue: T[] = [];

  return {
    get paused() { return paused; },
    get size() { return queue.length; },

    accept(event: T): boolean {
      if (!paused) return true;
      queue.push(event);
      return false;
    },

    setPaused(next: boolean): T[] {
      paused = next;
      // Pausing holds nothing back yet, and re-pausing must not spill the
      // queue: only a real resume drains.
      if (next || queue.length === 0) return [];
      const held = queue;
      queue = [];
      return held;
    },
  };
}
