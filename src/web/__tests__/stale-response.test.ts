// The usage-history modal re-fetches /api/ccusage whenever the range preset
// changes, and that endpoint answers a cached range instantly while an uncached
// one runs the ccusage CLI for seconds. Clicking 90d then 7d therefore used to
// resolve in the wrong order: the late 90d response overwrote the 7d data under
// an aria-selected 7d tab, and whichever request finished first cleared the
// shared loading flag. These pin the rule that fixed it.
import { describe, it, expect } from "vitest";
import { createLatestGuard } from "../latest";

describe("createLatestGuard", () => {
  it("lets a lone request write its result", () => {
    const guard = createLatestGuard();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
  });

  it("stops a slow earlier request from overwriting a newer one", () => {
    const guard = createLatestGuard();
    const wideRange = guard.begin();   // 90d — runs the CLI, takes seconds
    const narrowRange = guard.begin(); // 7d — cached, answers immediately

    expect(narrowRange()).toBe(true);
    expect(wideRange()).toBe(false);
  });

  it("keeps the newest request current no matter what order responses land in", () => {
    const guard = createLatestGuard();
    const first = guard.begin();
    const second = guard.begin();
    const third = guard.begin();

    // The first response arriving last must still be ignored, and reading the
    // predicate must not change who is current.
    expect(third()).toBe(true);
    expect(first()).toBe(false);
    expect(second()).toBe(false);
    expect(third()).toBe(true);
  });

  it("invalidates everything in flight when cancelled", () => {
    const guard = createLatestGuard();
    const pending = guard.begin();
    guard.cancel(); // modal closed, or the range switched

    expect(pending()).toBe(false);
  });

  it("still admits a request started after a cancel", () => {
    const guard = createLatestGuard();
    guard.begin();
    guard.cancel();
    const afterCancel = guard.begin();

    expect(afterCancel()).toBe(true);
  });
});
