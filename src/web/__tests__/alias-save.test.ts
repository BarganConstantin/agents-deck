// `save` opened disabled. The draft is seeded from the stored alias, so the
// comparison that disabled it was true the instant the manage block appeared,
// and `.ap-manage-btn:disabled { opacity: 0.45 }` rendered the largest control
// in the top row at 1.98:1 — #325's third finding, and the first impression the
// whole feature makes.
//
// The comparison did not go away, it changed jobs: it now decides whether a
// click has to reach the server, not whether the button may be pressed. Which
// exposed the second half — the old comparison trimmed and the POST did not, so
// one trailing space stored an alias that could never again equal its own
// draft, and `save` stayed lit forever.
import { describe, it, expect } from "vitest";
import { aliasSave } from "../alias-save";

describe("aliasSave", () => {
  it("has nothing to send when the draft is the alias already stored", () => {
    // The state the block OPENS in, which is why this can never gate the button.
    expect(aliasSave("work", "work")).toEqual({ commit: false, alias: "work" });
  });

  it("sends a changed alias", () => {
    expect(aliasSave("home", "work")).toEqual({ commit: true, alias: "home" });
  });

  it("treats an empty draft and an account with no alias as the same state", () => {
    // claude-swap stores null for an account that never had one, and the field
    // renders that as "". Sending "" to say "still nothing" is a round trip
    // that changes nothing.
    expect(aliasSave("", null)).toEqual({ commit: false, alias: "" });
    expect(aliasSave("   ", undefined)).toEqual({ commit: false, alias: "" });
  });

  it("clears an alias that exists, because that IS a change", () => {
    expect(aliasSave("", "work")).toEqual({ commit: true, alias: "" });
  });

  it("stores what it compared — the trimmed form, not the raw field", () => {
    // The bug the old split created: `draft.trim() === alias` gated the button
    // while the POST sent `draft`, so "work " went into the store and every
    // later comparison of "work" against "work " disagreed. One spelling.
    expect(aliasSave(" work ", "work")).toEqual({ commit: false, alias: "work" });
    expect(aliasSave(" home ", "work")).toEqual({ commit: true, alias: "home" });
    expect(aliasSave("work", " work ")).toEqual({ commit: false, alias: "work" });
  });

  it("keeps the spaces inside a name, which are somebody's spelling", () => {
    expect(aliasSave("  day job  ", null)).toEqual({ commit: true, alias: "day job" });
  });
});
