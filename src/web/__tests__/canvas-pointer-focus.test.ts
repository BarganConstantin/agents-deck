// #434: the skip link's focus ring, firing for a mouse arrival.
//
// #381 gave <main> `tabIndex={-1}` so the skip link would have somewhere to
// land, and gave `.canvas-wrap:focus-visible` an inset ring so the reader could
// see they had landed. `tabindex="-1"` grants a second thing nobody asked for:
// an element the MOUSE can focus. So a click on empty canvas parked focus on
// the canvas silently — `:focus-visible` does not match a pointer arrival, so
// nothing was drawn — and then the next keystroke made the browser change its
// answer for the element that was ALREADY focused, and a 2px accent rectangle
// the width of the window lit up on a press the user reads as re-layout or a
// theme swap, and stayed until focus moved.
//
// Measured in Chrome, on a standalone page with the same two rules and then in
// the deck itself. Same element throughout, focus never changing:
//
//   click empty <main tabindex="-1">   :focus true   :focus-visible FALSE
//   then press any key at all          :focus true   :focus-visible TRUE
//
// "Any key at all" is the correction this file records against the issue, which
// listed the deck's own single-letter shortcuts. `x` — a key the deck has no
// shortcut for and never claims — lights the ring exactly the same, because the
// flip is the user agent's and happens before any handler of ours runs. So does
// a right-click, which also focuses <main>.
//
// The fix could not be CSS, and that is worth writing down because CSS is where
// a focus ring belongs. `:focus-visible` is the user agent's own judgement and
// Selectors 4 lets it be re-made AFTER focus has landed, so no selector can
// separate the two arrivals: whatever marks the skip link's arrival, the
// pointer's arrival still matches `:focus-visible` one keystroke later and the
// GLOBAL ring rule still applies to it. CSS could only overrule the ring with
// `outline: none`, and #368 pins the sheet to exactly one of those, for the
// reason that issue exists — a rule that quietly removes a focus ring is how
// the search field lost its own. Dropping the ring outright fails #381's
// purpose. What was left was to take away the arrival: a mouse press that would
// land focus on the canvas itself no longer does, so the ring keeps its one
// caller, the programmatic focus it was written for.
//
// Plain node, no DOM and no renderer — a handler that runs on a real mousedown
// cannot be exercised here — so this reads App.tsx and styles.css as text, the
// way manage-block.test.ts and landmark-outline.test.ts do. Comments are
// stripped before any "appears nowhere" assertion, because the prose above the
// code in this repo quotes the shapes it rejected and a search for a rejected
// shape would otherwise find the sentence rejecting it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** The same text with its comments gone — the only form an "appears nowhere"
 *  assertion may read. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

const appCode = code(app);
const bareCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The opening tag of the canvas, attributes and all. */
const mainTag = /<main\b[\s\S]*?\n\s*>/.exec(appCode)?.[0] ?? "";

/** The body of the handler this issue added, without its own comments. */
const handler = /const releasePointerFocus = useCallback\(([\s\S]*?)\n  \}, \[\]\);/.exec(appCode)?.[1] ?? "";

/** The entries of the FOCUS_CANDIDATES list, as written. */
const candidates = [...(/const FOCUS_CANDIDATES = \[([\s\S]*?)\]\.join/.exec(appCode)?.[1] ?? "")
  .matchAll(/"([^"]+)"/g)].map(m => m[1]);

/** The declarations of the first rule whose selector starts a line verbatim. */
function rule(selector: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  return re.exec(bareCss)?.[1] ?? null;
}

function decl(selector: string, prop: string): string | null {
  const body = rule(selector);
  if (body === null) return null;
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "m").exec(body);
  return m ? m[1].trim() : null;
}

// ── the arrival the canvas no longer answers ────────────────────────────────

describe("a mouse press does not put focus on the canvas (#434)", () => {
  it("cancels the focus the browser was about to place there", () => {
    // The default action of a mousedown is what focuses an element, so
    // cancelling it is what stops the canvas being focused at all — and an
    // element that is not focused cannot match `:focus-visible` later, whatever
    // the user agent decides about the keyboard afterwards. That is the point
    // of answering this on the pointer's side rather than the keyboard's.
    expect(handler).toMatch(/e\.preventDefault\(\)/);
  });

  it("only cancels when the canvas ITSELF is what would take the focus", () => {
    // Every real control inside the canvas — the category chips, React Flow's
    // zoom buttons, the agent cards — keeps the click-to-focus every other
    // control on the page has. The gate is the browser's own answer, asked with
    // closest() before the browser gets to it, not a list of our own.
    expect(handler).toMatch(/closest\(FOCUS_CANDIDATES\) !== e\.currentTarget\) return/);
  });

  it("still puts focus down, because that is what clicking empty canvas means", () => {
    // canvas-keys.ts calls a click on empty canvas the only route back to
    // <body> that existed before Escape learned to release one, and the search
    // field and the agent cards are both released that way. Cancelling the
    // default focus alone would leave whoever held focus holding it, so the
    // click would stop meaning what it has always meant.
    expect(handler).toMatch(/document\.activeElement[\s\S]*?\.blur\?\.\(\)/);
  });

  it("takes the capture phase, which React Flow leaves it no choice about", () => {
    // Measured: React Flow's pan handler calls stopImmediatePropagation() on
    // the pane's mousedown, so on a click on empty canvas — the click this
    // whole issue is about — neither <main> nor the React root sees the event
    // in the bubble phase at all. An onMouseDown here would never run.
    expect(mainTag).toMatch(/onMouseDownCapture=\{releasePointerFocus\}/);
    expect(mainTag).not.toMatch(/onMouseDown=\{/);
  });

  it("is the canvas's alone, and not a habit the panels pick up", () => {
    // Everywhere else on this deck, a click SHOULD focus what was clicked.
    // One canvas, one handler; a second copy of this is a control somewhere
    // losing its focus for no reason.
    expect([...appCode.matchAll(/onMouseDownCapture=/g)]).toHaveLength(1);
  });
});

// ── what the browser will hand a click's focus to ───────────────────────────

describe("the list the gate is asked against (#434)", () => {
  it("counts <main> itself, which is the entry the whole rule turns on", () => {
    // <main> is a focus candidate because it carries tabindex="-1" for the skip
    // link — that IS the bug's cause, and listing it here is what lets the gate
    // recognise "the browser is about to focus the canvas". Drop `[tabindex]`
    // and the handler silently never fires.
    expect(candidates).toContain("[tabindex]");
    expect(appCode).toMatch(/<main\n\s+id="canvas"\n\s+tabIndex=\{-1\}/);
  });

  it("lists what the browser focuses on a click, and nothing invented", () => {
    const bare = candidates.map(s => s.replace(/:not\([^)]*\)/g, ""));
    expect(bare).toEqual(["a[href]", "button", "input", "select", "textarea", "summary", "[tabindex]"]);
  });

  it("skips the disabled ones, because the browser skips them and keeps walking", () => {
    // A click on a disabled button lands its focus on the nearest ENABLED
    // ancestor, which on this canvas is <main>. Counting a disabled control as
    // the answer would leave that click lighting the ring — the bug, on the one
    // press nobody would think to re-test.
    for (const tag of ["button", "input", "select", "textarea"]) {
      expect(candidates.find(c => c.startsWith(tag)), tag).toBe(`${tag}:not(:disabled)`);
    }
  });
});

// ── and the ring it was all to protect ──────────────────────────────────────

describe("the ring #381 put there is exactly what it was (#434)", () => {
  it("still draws, because a skip link that lands nowhere visible is the bug", () => {
    // The failure this ring exists to fix is landing somewhere with no sign you
    // landed. Deleting it would have closed this issue and re-opened that one.
    expect(decl(":focus-visible", "outline")).toBe("2px solid var(--accent)");
    expect(decl(".canvas-wrap:focus-visible", "outline-offset")).toBe("-3px");
  });

  it("is still the shared ring, drawn by the global rule and only inset here", () => {
    // .canvas-wrap declares an offset and nothing else: one focus language for
    // the whole deck, and this element's own reason — it runs to the window
    // edge, so the shared outward offset would draw two sides off screen.
    expect(decl(".canvas-wrap:focus-visible", "outline")).toBeNull();
  });

  it("answers none of this in CSS, where the question cannot be asked", () => {
    // The two CSS answers, both rejected on the record. Removing the ring for
    // the unmarked case needs a rule that removes an outline, and the sheet is
    // allowed exactly one of those (#368) — checked here in both spellings, so
    // the `0` that would slip past a search for `none` is pinned too. And
    // `:focus:not(:focus-visible)` cannot help: after the keystroke the canvas
    // genuinely DOES match `:focus-visible`, so there is nothing for it to
    // catch.
    const removers = [...bareCss.matchAll(/^([^{}\n][^{}]*)\{([^}]*)\}/gm)]
      .filter(([, , body]) => /outline\s*:\s*(none|0)\b/.test(body))
      .map(([, selector]) => selector.trim());
    expect(removers).toEqual([]);
    expect(bareCss).not.toMatch(/:focus\s*:not\(\s*:focus-visible\s*\)/);
  });

  it("gated the ring on no marker, because a marker could not have gated it", () => {
    // The shape this issue proposed: a data- attribute the skip link sets, and
    // `.canvas-wrap[data-…]:focus-visible` for the ring. It tells the two
    // arrivals apart and still does not fix this — the ring on a mouse arrival
    // is drawn by the GLOBAL `:focus-visible` rule, which goes on matching
    // .canvas-wrap whatever attribute it is wearing. The marker would have
    // needed the outline-remover above as well.
    expect(bareCss).not.toMatch(/\.canvas-wrap[^{,]*\[[^\]]*\][^{,]*:focus/);
    expect(appCode).not.toMatch(/data-focus/);
  });
});
