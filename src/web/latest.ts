// Pure "last request wins" rule for hooks that re-fetch when their input
// changes. Kept out of the components so it can be unit-tested without React
// or the DOM.

/** A request that has been started and can still ask whether it is current. */
export interface LatestGuard {
  /**
   * Register a new request. Returns the predicate that request must consult
   * before it writes any state: it answers true only while no newer request
   * has been started and the guard has not been cancelled.
   */
  begin(): () => boolean;
  /** Invalidate every in-flight request — used on unmount or input change. */
  cancel(): void;
}

/**
 * Guard against out-of-order responses.
 *
 * /api/ccusage shells out to the ccusage CLI and caches per range, so a cached
 * narrow range answers instantly while an uncached wide one takes seconds:
 * clicking 90d then 7d used to let the late 90d response overwrite the 7d data
 * under an aria-selected 7d tab, and let whichever request finished first clear
 * the shared loading flag. Sequencing the requests means only the newest one
 * may write, so the view can never disagree with the selected range.
 */
export function createLatestGuard(): LatestGuard {
  let seq = 0;
  return {
    begin() {
      const id = ++seq;
      return () => id === seq;
    },
    cancel() {
      seq++;
    },
  };
}
