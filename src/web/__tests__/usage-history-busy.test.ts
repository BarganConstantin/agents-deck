// The usage-history modal rendered its busy line only while `days.length === 0`,
// which is true exactly once — before the first response lands. After that the ↻
// and the four range presets changed nothing on screen: the reload button was
// never disabled and never swapped its label, and the chart, the totals strip
// and the legend went on showing the PREVIOUS range's numbers underneath the
// newly highlighted tab. The user clicked 7d, read 30d totals as the answer, and
// watched them rewrite themselves seconds later. The out-of-order guard in
// latest.ts had already made the landing correct; what was missing was any rule
// about what may be on screen in the meantime.
//
// These pin that rule: a response is shown only against the range it was asked
// for, and a fresh run over numbers that do answer the selected range marks them
// as not-final rather than passing them off as the result.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { usageView } from "../usage-view";

const answered = (range: number, days: number) => ({ range, ok: true, days });
const failed = (range: number) => ({ range, ok: false, days: 0 });

describe("what the modal may show while ccusage is running", () => {
  it("says it is running when nothing has answered yet", () => {
    expect(usageView({ loading: true, want: 30, answer: null }))
      .toEqual({ phase: "busy", stale: false });
  });

  it("says so on every later run too, not only before the first one landed", () => {
    // The whole of the bug: 30d had answered, so `days.length === 0` was false
    // forever after and the busy branch could never render again.
    expect(usageView({ loading: true, want: 90, answer: answered(30, 30) }))
      .toEqual({ phase: "busy", stale: false });
  });

  it("refuses to answer a 7d click with the 30d numbers before the fetch even starts", () => {
    // React paints the click — the tab is already highlighted — before the
    // effect runs, so there is a render where nothing is loading and the data on
    // screen belongs to the range the user just left.
    expect(usageView({ loading: false, want: 7, answer: answered(30, 30) }).phase).toBe("busy");
  });

  it("does not leave the previous range's failure standing under a range that is loading", () => {
    expect(usageView({ loading: true, want: 30, answer: failed(7) }).phase).toBe("busy");
  });

  it("never calls anything stale while it is busy, because nothing is on screen to dim", () => {
    for (const loading of [true, false]) {
      expect(usageView({ loading, want: 14, answer: answered(90, 5) }).stale).toBe(false);
    }
  });
});

describe("what the modal shows once the selected range has answered", () => {
  it("draws the chart for the range that was asked for", () => {
    expect(usageView({ loading: false, want: 30, answer: answered(30, 21) }))
      .toEqual({ phase: "chart", stale: false });
  });

  it("dims a ↻ over the same range instead of presenting numbers that are about to move", () => {
    expect(usageView({ loading: true, want: 30, answer: answered(30, 21) }))
      .toEqual({ phase: "chart", stale: true });
  });

  it("tells an empty range from one that has not answered yet", () => {
    // "no usage in this range" is a finding, and it may only be reported about
    // the range someone actually asked about.
    expect(usageView({ loading: false, want: 7, answer: answered(7, 0) }).phase).toBe("empty");
    expect(usageView({ loading: false, want: 7, answer: null }).phase).toBe("busy");
  });

  it("keeps the failure on screen while the retry runs, dimmed rather than replaced", () => {
    expect(usageView({ loading: true, want: 30, answer: failed(30) }))
      .toEqual({ phase: "error", stale: true });
    expect(usageView({ loading: false, want: 30, answer: failed(30) }))
      .toEqual({ phase: "error", stale: false });
  });

  it("reads the tag as the preset, not the date, so an open modal survives local midnight", () => {
    // Tagging the response with the `--since` it carried would stop matching the
    // moment presetSince() rolls over, and the modal would sit on "running
    // ccusage…" for a request that already came back.
    expect(usageView({ loading: false, want: 90, answer: answered(90, 90) }).phase).toBe("chart");
  });
});

describe("the modal itself", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../components/UsageHistoryModal.tsx", import.meta.url)),
    "utf8",
  );

  it("leaves the decision to the rule above rather than counting days again", () => {
    expect(src).toContain("usageView(");
    expect(src).not.toMatch(/loading && days\.length/);
  });

  it("disables the controls that re-run ccusage while a run is in flight", () => {
    // The header ↻ and the error block's Try again are the same request; a
    // second click during the first run only queues work the guard discards.
    expect([...src.matchAll(/disabled=\{loading\}/g)]).toHaveLength(2);
  });

  it("swaps the ↻ for a busy label, the way UsagePanel's reload already did", () => {
    expect(src).toMatch(/loading \?[^\n]*"↻"/);
  });
});
