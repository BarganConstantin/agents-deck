// A /-search that matched nothing asked every node and every bubble to drop to
// 22% opacity and desaturate, and said nothing else. No count, no zero-result
// line: a typo and "every session has aged out" produced the same screen, and
// the board read as broken rather than filtered. The number that would have
// said otherwise was already being computed on every keystroke — the match set
// feeding the dimming — and was never rendered. It was the only filter in the
// app with no readout; the tool category chips and the selection ribbon both
// show theirs.
//
// Two rules are pinned here. The count, which has to be counted over the agents
// actually on the canvas or it describes a different board than the one being
// looked at. And the refusal to dim when nothing matched: dimming everything is
// a statement that some things matched, and there is nothing left for the eye
// to land on.
//
// Worth knowing while reading this: the dimming is presently masked anyway. The
// spawn animations on `.react-flow__node` and `.tool-burst` both run with
// `fill: both` and end on `opacity: 1`, and a filling animation outranks author
// declarations — so `.rf-dim` and `.tool-burst.dim` lose the cascade for the
// life of the element (#316, not fixed here). Which makes the count and the
// message the only feedback the search currently gives, rather than a garnish
// on a working dim.
import { describe, it, expect } from "vitest";
import { searchStatus, shouldDimUnmatched } from "../search-status";

describe("an empty search field", () => {
  it("shows no readout at all, because nothing is being filtered", () => {
    const s = searchStatus("", 0, 11);
    expect(s.active).toBe(false);
    expect(s.count).toBeNull();
    expect(s.message).toBeNull();
    expect(s.empty).toBe(false);
  });

  it("dims nothing", () => {
    expect(searchStatus("", 0, 11).dim).toBe(false);
    expect(shouldDimUnmatched("", 0)).toBe(false);
  });
});

describe("a search that keeps something", () => {
  it("says how much of the board survived the filter", () => {
    expect(searchStatus("api", 3, 11).count).toBe("3 of 11");
  });

  it("dims the rest, so the survivors are the ones lit up", () => {
    expect(searchStatus("api", 3, 11).dim).toBe(true);
  });

  it("has no zero-result message to show", () => {
    const s = searchStatus("api", 3, 11);
    expect(s.empty).toBe(false);
    expect(s.message).toBeNull();
  });

  it("still reports a count when everything matches, so the filter never looks inert", () => {
    expect(searchStatus("a", 11, 11).count).toBe("11 of 11");
  });
});

describe("a search that matches nothing", () => {
  it("states it, quoting back the query the user has to correct", () => {
    const s = searchStatus("foo", 0, 11);
    expect(s.empty).toBe(true);
    expect(s.message).toBe("No agents match “foo”");
  });

  it("counts zero out loud rather than leaving the board to imply it", () => {
    expect(searchStatus("foo", 0, 11).count).toBe("0 of 11");
  });

  it("stops dimming, since a board with nothing bright on it is not a filtered board", () => {
    expect(searchStatus("foo", 0, 11).dim).toBe(false);
    expect(shouldDimUnmatched("foo", 0)).toBe(false);
  });

  it("says the same thing on an empty canvas, where there is nothing to dim either way", () => {
    const s = searchStatus("foo", 0, 0);
    expect(s.count).toBe("0 of 0");
    expect(s.dim).toBe(false);
  });

  it("quotes a query with regex punctuation in it verbatim — it is text, not a pattern", () => {
    expect(searchStatus("src/*.ts", 0, 4).message).toBe("No agents match “src/*.ts”");
  });
});
