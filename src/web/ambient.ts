// What the deck says from a tab nobody is looking at.
//
// A deck spends almost all of its life in a background tab, and until #338 that
// tab carried exactly nothing: index.html's <title> is static markup and
// `document.title` was never assigned anywhere in src/web/, so the one surface
// that is always on screen read the same whether five sessions were blocked on a
// permission prompt or the machine had been idle since lunch. A dashboard you
// have to focus to read is a dashboard you close.
//
// The tab strip gives about four characters and sixteen pixels, so it gets two
// signals and no more: a count in the title, a state in the icon. Both are
// decided here, as plain strings, because the vitest suite runs in bare node
// with no DOM — nothing in this file touches `document`, and the caller owns
// every write.
import { PRODUCT } from "./brand";

/** Which of the three marks the tab should be wearing. */
export type AmbientIcon = "waiting" | "running" | "idle";

export interface AmbientSignal {
  /** What `document.title` should be — already complete, including the name. */
  title: string;
  icon: AmbientIcon;
}

/**
 * What the tab should say and wear, given what the canvas currently holds.
 *
 * THE COUNT LEADS THE STRING: `(2) ccdeck`, never `ccdeck (2)`. Every browser
 * truncates a tab title from the END, and a tab in a strip of fifteen is a few
 * characters wide — so a count appended to the name is the first thing clipped
 * and the deck is back to saying nothing at exactly the moment it has something
 * to say. `(2) c…` is readable down to almost nothing. This ordering is the
 * whole feature, it looks like a typo to anyone tidying the file, and
 * ambient-signal.test.ts asserts the count is at index 0 rather than merely
 * present so that the tidy fails there instead of in a user's tab strip.
 *
 * Never `(0) ccdeck`. Zero is the resting state and has to look like one: a
 * parenthesised zero is a badge that reports nothing is wrong, which is a badge
 * that gets ignored — and a badge that gets ignored is ignored at `(1)` too.
 *
 * The name comes from PRODUCT rather than a literal because this is a surface a
 * human reads, which is the line brand.ts draws; index.html holds the only copy
 * that cannot be derived (it is parsed before any module runs) and
 * display-name.test.ts pins the two together.
 */
export function ambientSignal({ waiting, running }: { waiting: number; running: number }): AmbientSignal {
  return {
    title: waiting > 0 ? `(${waiting}) ${PRODUCT}` : PRODUCT,
    // Waiting outranks running. The tab strip is an alarm surface, not a status
    // report: one session sitting on a permission prompt while four others work
    // is amber, because the four will finish on their own and the one will not.
    // Running answers the lesser question — "is anything still moving" — and
    // only gets the icon when the answer to the first one is no.
    icon: waiting > 0 ? "waiting" : running > 0 ? "running" : "idle",
  };
}

// The three fills, and the reason they are not read from styles.css.
//
// A tab strip is chrome, not page: the browser gives a page no media query and
// no API for the strip's own colour, so neither the theme the user picked in
// the deck nor `prefers-color-scheme` predicts what this icon is drawn on. One
// mark has to work on a white strip and on a #1f1f1f one at once, which rules
// out both a token that flips with `data-theme` and any value chosen against a
// single background.
//
// So all three clear 3:1 — 1.4.11's floor for a graphic whose own boundary is
// the only thing identifying it — against BOTH extremes:
//
//     waiting  #c97d12   3.27:1 on #ffffff   5.04:1 on #1f1f1f
//     running  #2a90d4   3.48:1 on #ffffff   4.74:1 on #1f1f1f
//     idle     #7e828c   3.85:1 on #ffffff   4.28:1 on #1f1f1f
//
// That double floor is also why they sit within 1.18:1 of each other: the two
// bounds leave a luminance band 1.83:1 wide end to end, so three fills inside
// it cannot be told apart by brightness however they are chosen. What is left
// is hue — and hue is the channel a dichromat viewer does not get. These three
// simulated (Viénot 1999) land within 1.25:1 of each other, and under
// protanopia the amber and the grey come out at 1.01:1. So the colour here is
// the redundant cue and the SILHOUETTE is the signal; see mark() below, which
// is where the states are actually distinguished.
//
// The blue is deliberately between the two theme accents (#7dd3fc dark,
// #0369a1 light) and the grey is the dark theme's --muted: the icon belongs to
// the same palette as the deck without being able to ask which half is on.
const FILL: Record<AmbientIcon, string> = {
  waiting: "#c97d12",
  running: "#2a90d4",
  idle: "#7e828c",
};

/**
 * The mark itself — DRAWN, not typed.
 *
 * This was a `<text>◉</text>` inside an SVG data URI, which means the shape was
 * whatever U+25C9 happens to be in the default font of the machine rendering
 * it: a different weight and a different ratio of dot to ring on macOS, Windows
 * and Linux, and a tofu box on any system whose fonts miss the codepoint. That
 * is survivable for a decorative mark. It stops being survivable the moment the
 * icon carries state, because then the three states have to be told apart from
 * one another identically on all three platforms — and a tofu box is the same
 * box in all three colours, at whatever weight the fallback font picked. Two
 * `<circle>`s have no such dependency: the shape is in the document.
 *
 * The gap inside the ring is left unpainted on purpose. Since no value here may
 * assume a background (see above), the safest thing to put in the negative
 * space is the tab strip itself — which is also what keeps the fisheye the deck
 * has always used, rather than trading it for a plain disc.
 *
 * THE THREE STATES DIFFER IN SILHOUETTE, NOT ONLY IN COLOUR, and that is forced
 * rather than decorative. Clearing 3:1 against a white strip caps a fill's
 * relative luminance at 0.300, and clearing it against a #1f1f1f one floors it
 * at 0.141 — so every fill this icon is allowed to use is trapped in a band
 * whose own extremes are 1.83:1 apart, and three of them land within 1.35:1 of
 * each other. Brightness therefore cannot carry the state, which leaves hue;
 * and hue is exactly what a dichromat viewer does not receive. Simulated
 * (Viénot 1999), the three fills collapse to within 1.25:1 of one another, and
 * under protanopia the amber and the grey land at 1.01:1 — an alarm and a
 * resting state rendered as the same mark, for roughly one man in twelve. The
 * shape is the channel that survives all of it:
 *
 *     idle     hollow ring          least ink
 *     running  ring around a dot    the deck's own fisheye
 *     waiting  solid disc           most ink
 *
 * Same outer diameter throughout, so it reads as one mark filling in rather
 * than three unrelated glyphs, and the ink rises monotonically with how much
 * the deck wants you. Colour stays as the redundant cue for everyone who can
 * use it. Do not "simplify" this back to one shape in three colours.
 *
 * At 16px the ring lands 2.5px thick and the dot 5px across with a 2.25px gap,
 * which is the smallest fisheye that still reads as one rather than as a smudge.
 */
function mark(fill: string, icon: AmbientIcon): string {
  const body = icon === "waiting"
    ? `<circle cx="16" cy="16" r="14.5" fill="${fill}"/>`
    : `<circle cx="16" cy="16" r="12" fill="none" stroke="${fill}" stroke-width="5"/>`
      + (icon === "running" ? `<circle cx="16" cy="16" r="5" fill="${fill}"/>` : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;
}

/**
 * The three hrefs, encoded once at module load.
 *
 * `encodeURIComponent` rather than escaping the angle brackets by hand, which
 * is what the old icon did and what a hex fill makes fatal: `#` inside a URI is
 * the FRAGMENT delimiter, so an unencoded `#c97d12` ends the data URI mid-
 * attribute. The browser gets a truncated document, fails to parse it, and
 * silently keeps whichever icon it already had — a state change that goes
 * missing with nothing logged anywhere.
 *
 * Built here rather than per call because there are exactly three of them and
 * they never change: the effect that assigns one is on the SSE path and has no
 * business re-encoding a string it could have had for free.
 *
 * And no animation, ever — not here and not in the caller. A pulsing favicon
 * asks the browser to re-parse and re-rasterise a data URI every frame for the
 * lifetime of the tab, and it is the single most hated pattern in this genre.
 */
export const FAVICON_HREF: Readonly<Record<AmbientIcon, string>> = Object.freeze({
  waiting: `data:image/svg+xml,${encodeURIComponent(mark(FILL.waiting, "waiting"))}`,
  running: `data:image/svg+xml,${encodeURIComponent(mark(FILL.running, "running"))}`,
  idle: `data:image/svg+xml,${encodeURIComponent(mark(FILL.idle, "idle"))}`,
});
