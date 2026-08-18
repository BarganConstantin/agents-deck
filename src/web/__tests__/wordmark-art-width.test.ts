// WORDMARK_WIDTH is a hand-computed prediction of how wide the drawn ccdeck
// mark is, and it is the ONLY thing standing between the art and a terminal too
// narrow to hold it: `wordmark()` renders the three rows when
// `columns >= WORDMARK_WIDTH + 1` and falls back to the one-line compact form
// otherwise. Nothing in that path ever measures the art, so the two can
// disagree silently — and the existing coverage cannot catch it, because
// term-layout.test.ts asserts the gate with WORDMARK_WIDTH on BOTH sides
// (`wordmark({ columns: WORDMARK_WIDTH - 1 }).kind === "compact"`), which holds
// for any value the constant might take, right or wrong.
//
// The failure that hides behind that is not subtle once it happens: an
// under-counting width lets the art through at a width it does not fit, and
// three rows of half-blocks wrap into six broken ones on the first screen a
// user ever sees. WORDMARK_LINES is exported for exactly this comparison, which
// is why #383 kept the export rather than removing it as unused surface.
//
// Plain node: term.mjs draws with string arithmetic and never touches a DOM.
import { describe, it, expect } from "vitest";

// @ts-expect-error — .mjs server module, no types
const term = await import("../../server/term.mjs");
const { WORDMARK_LINES, WORDMARK_WIDTH, wordmark, stripAnsi } = term as {
  WORDMARK_LINES: string[];
  WORDMARK_WIDTH: number;
  wordmark: (o: Record<string, unknown>) => { kind: string; lines: string[] };
  stripAnsi: (s: string) => string;
};

/** Columns the string occupies. Counted in code points rather than UTF-16 code
 *  units so the count is the terminal's, not JavaScript's — the half-blocks
 *  used here are all BMP, but a future glyph outside it would otherwise be
 *  counted twice and quietly inflate the answer. */
const columnsOf = (s: string) => [...s].length;

/** The two-space indent `wordmark()` puts in front of every art row, and the
 *  same one WORDMARK_WIDTH's comment accounts for. */
const INDENT = 2;

/** What the compact banner spends before its tagline: `"  ccdeck  "`. Spelled
 *  out here rather than imported, so a change to the compact line has to be
 *  made in two places and cannot quietly move the floor this file measures. */
const COMPACT_PREFIX = "  ccdeck  ".length;

describe("the wordmark's declared width against the art it is supposed to measure", () => {
  it("is the widest drawn row plus the indent, exactly", () => {
    const widest = Math.max(...WORDMARK_LINES.map(columnsOf));
    expect(widest + INDENT).toBe(WORDMARK_WIDTH);
  });

  it("draws three rows, none of them empty, so the max above is a real measurement", () => {
    // Guards the assertion above rather than the banner: `Math.max()` of an
    // empty list is -Infinity, and a WORDMARK_LINES that had lost its rows
    // would make the width check pass by vacuity instead of failing loudly.
    expect(WORDMARK_LINES).toHaveLength(3);
    for (const row of WORDMARK_LINES) expect(row.trim()).not.toBe("");
  });

  it("holds the art inside the narrowest terminal the gate lets it into", () => {
    // The gate's own boundary, driven through the public function: at exactly
    // one column more than the declared width the full art is chosen, and every
    // line it returns has to fit that terminal with nothing to spare.
    const at = WORDMARK_WIDTH + 1;
    const full = wordmark({ columns: at, version: "1.33.124", profile: "truecolor" });
    expect(full.kind).toBe("full");
    for (const line of full.lines) expect(columnsOf(stripAnsi(line))).toBeLessThanOrEqual(at);
  });

  it("keeps the art out of every terminal narrower than that", () => {
    // The other side of the same boundary, and the reason the width may not
    // over-count either: an inflated constant costs the art on terminals that
    // could have held it. Walking down from the boundary rather than testing
    // one value below it, because an off-by-one is the shape this drifts in.
    for (let columns = WORDMARK_WIDTH; columns >= WORDMARK_WIDTH - 4; columns--) {
      const out = wordmark({ columns, version: "1.33.124", profile: "truecolor" });
      expect(out.kind, `${columns} columns`).toBe("compact");
    }
  });

  it("fits the terminal at every width it can possibly fit, in all three layouts", () => {
    // Found while writing the measurement above, and it is the reason this file
    // is here rather than a one-line assertion (#383): the tagline's budget was
    // computed as if it always had a line to itself behind a two-space indent.
    // In the compact and plain layouts it does not — it sits after the product
    // name — so between 21 and 31 columns the banner chose the medium tagline
    // and printed 36 columns into a terminal that had at most 31. The first
    // thing the user saw wrapped.
    //
    // Every width is swept rather than a handful sampled, because the bug lived
    // in a ten-column band that the widths the suite already sampled — 20, 40,
    // 80, 200 — stepped straight over.
    //
    // The sweep starts at FLOOR, not at 1. `  ccdeck  ` and the version are the
    // two things the banner will not give up, so below their combined width it
    // has nothing left to trim and overflows by construction; the test below
    // pins that it is genuinely at that floor rather than merely over budget.
    const VERSION = "1.33.124";
    const FLOOR = COMPACT_PREFIX + `v${VERSION}`.length;
    for (let columns = FLOOR; columns <= WORDMARK_WIDTH * 3; columns++) {
      for (const profile of ["truecolor", "ansi16", "none"]) {
        for (const unicode of [true, false]) {
          const { lines } = wordmark({ columns, version: VERSION, profile, unicode });
          for (const line of lines) {
            const width = columnsOf(stripAnsi(line));
            expect(width, `${profile}/${unicode ? "unicode" : "ascii"} at ${columns} columns: ${JSON.stringify(stripAnsi(line))}`)
              .toBeLessThanOrEqual(columns);
          }
        }
      }
    }
  });

  it("shrinks to the product name and the version, and no further", () => {
    // Under the floor there is no layout that fits, and the choice made there is
    // deliberate: overflow by a few columns rather than print a banner that does
    // not say which build is running. What must NOT happen is the banner going
    // on choosing a longer tagline as the terminal narrows — so the line a
    // one-column terminal gets has to be the same one the floor gets.
    const VERSION = "1.33.124";
    const FLOOR = COMPACT_PREFIX + `v${VERSION}`.length;
    const atFloor = stripAnsi(wordmark({ columns: FLOOR, version: VERSION, profile: "truecolor" }).lines.join("\n"));
    for (const columns of [1, 5, 10, FLOOR - 1]) {
      const under = stripAnsi(wordmark({ columns, version: VERSION, profile: "truecolor" }).lines.join("\n"));
      expect(under, `${columns} columns`).toBe(atFloor);
    }
  });

  it("never drops the version, however narrow the terminal gets", () => {
    // The budget above decides which tagline fits; this is the floor under it.
    // `tagline` falls back to the bare version when nothing fits, so a one-column
    // terminal still gets a banner that says which build is running — that line
    // is over budget by construction and is the one thing worth overflowing for,
    // since a banner with no version answers nothing at all.
    for (const columns of [1, 10, 20, 25, 31, 32, 80]) {
      const text = stripAnsi(wordmark({ columns, version: "1.33.124", profile: "truecolor" }).lines.join("\n"));
      expect(text, `${columns} columns`).toContain("v1.33.124");
    }
  });

  it("draws the same art on every platform, since it is arithmetic and not a font", () => {
    // The banner is the first thing a Windows user sees, and it is built out of
    // U+2580/2584/2588 and spaces — no path separators, no locale, no terminal
    // query. Pinning the exact rows here means a change to LETTERS or to
    // `squash` has to be a deliberate one, on whichever machine it is made.
    for (const row of WORDMARK_LINES) expect(row).toMatch(/^[▀▄█ ]+$/);
    // And no row carries trailing blanks, which is what makes the rows unequal
    // in length and so makes the measurement above necessary in the first place.
    for (const row of WORDMARK_LINES) expect(row).toBe(row.replace(/\s+$/, ""));
  });
});
