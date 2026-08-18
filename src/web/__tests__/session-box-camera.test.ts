// #353: the tinted session box eased four layout properties that the camera
// rewrote on every frame, so it rubber-banded behind its own nodes.
//
// `.cluster-card` transitions `left`, `top`, `width` and `height` over 320ms,
// and SessionClusters wrote all four as `c.x * zoom + x` and friends — the
// cluster's layout coordinate with the viewport folded into it. React Flow
// carries the real nodes with ONE transform on `.react-flow__viewport`, eased by
// nothing, so a pan moved the nodes instantly and put the box through a third of
// a second of easing to catch up. Measured on a live deck against the target the
// component itself wrote that frame: 94px behind on a twelve-move pan, and on a
// pinch zoom 693px of `left`, 1161px of `top`, 1014px of `width` and 1167px of
// `height` — the box detached from the nodes it is drawn around by 674px. A
// session drag was 76px behind for 31 frames of 71.
//
// The fix is NOT to delete the four. They are the only thing keeping the box
// with its cards when the LAYOUT changes: SessionClusters reads each node's
// final position out of the store the frame the layout changes, while the nodes
// are still easing their own transform over the 320ms `.react-flow__node` gives
// them, so a box with no easing would snap to the new bounding box a third of a
// second AHEAD of the cards inside it. One desync traded for another.
//
// What changed is where the camera lives. `.session-clusters` now carries it as
// a single transform, exactly as `.react-flow__viewport` does, and everything
// underneath is written in layout coordinates. The four eased properties then
// change when — and only when — the layout changes, which is what they were
// written for, and the camera reaches them through a property that eases
// nothing. Post-fix the same measurement reads 0.0px on all four for every
// frame of a pan, a zoom and a session drag.
//
// The second half of the issue is the escape hatch that never fired.
// `.cluster-card.dragging` existed to drop the easing during a drag, and the
// component renders `className="cluster-card"` as a literal string, so the class
// was added by nobody and the rule was dead. Confirmed live: every card reports
// `"cluster-card"` on every frame of a session drag. The answer hangs off
// `.canvas-wrap.dragging-any` instead — the flag App already sets for every
// gesture, and the one the nodes above are already answered by.
//
// There is no jsdom here and no layout engine, so none of the pixel numbers
// above can be re-measured. What this file does instead is pin the two SOURCES
// that produced them: the stylesheet rules, and the geometry the component
// writes into the inline style. Both are read with a parser of this file's own —
// borrowing another suite's collector would go green the moment that one was
// loosened.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (name: string) => readFileSync(join(web, name), "utf8");

const rawCss = read("styles.css");
const rawTsx = read("components/SessionClusters.tsx");

/** Comments in both files quote the declarations they explain — this one quotes
 *  `c.x * zoom + x` and `.cluster-card.dragging` while explaining why neither is
 *  there any more — so every "appears nowhere" assertion below has to read the
 *  code with the prose taken out. Blanked to spaces rather than cut, so a rule's
 *  reported line number still points at the rule. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const lineOf = (at: number) => css.slice(0, at).split("\n").length;

/** Every comment in the component is a full-line `//` or a `/* *\/` block. */
const tsx = rawTsx
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

// ── the stylesheet, as rules ────────────────────────────────────────────────

type Rule = { selector: string; body: string; reduced: boolean; at: number };

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Flat rule list. @keyframes are skipped — their `0%`/`to` are not selectors —
 *  and every other at-rule is descended into, carrying the reduced-motion flag
 *  and an absolute source position down with it. */
function collect(src: string, base: number, reduced: boolean, out: Rule[]): Rule[] {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (prelude.startsWith("@keyframes")) {
      // not a rule
    } else if (prelude.startsWith("@")) {
      collect(inner, base + open + 1, reduced || /prefers-reduced-motion\s*:\s*reduce/.test(prelude), out);
    } else if (prelude) {
      out.push({ selector: prelude, body: inner, reduced, at: base + open });
    }
    i = end + 1;
  }
  return out;
}

const RULES = collect(css, 0, false, []);

/** Commas inside cubic-bezier() and color-mix() are not list separators. */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`).exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** Every selector in a list, normalised so two spellings of one match. */
const selectors = (rule: Rule): string[] =>
  splitTop(rule.selector).map(s => s.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim());

/** Property names from a `transition` shorthand — the first token of each part. */
const transitioned = (value: string | null): string[] => {
  if (value == null || value === "none") return [];
  return splitTop(value).map(p => p.split(/\s/)[0]).filter(p => p !== "none");
};

/** Properties whose change moves or resizes the element on the main thread.
 *  `transform` is absent because the whole point of the fix is that the camera
 *  now travels on one, un-eased. */
const TRAVELS = new Set(["top", "left", "right", "bottom", "inset", "width", "height", "margin", "all"]);

const rulesFor = (sel: string, reduced = false) =>
  RULES.filter(r => r.reduced === reduced && selectors(r).includes(sel));
const ruleFor = (sel: string) => {
  const [rule] = rulesFor(sel);
  expect(rule, `styles.css has no resting rule for ${sel}`).toBeTruthy();
  return rule;
};

// ── the component, as the geometry it writes ────────────────────────────────

/** The body of an inline-style object literal, by the const it is bound to.
 *  Scanned by brace depth rather than matched by a regex: two of these three are
 *  cast with `as React.CSSProperties` and one is not, and a pattern that spelled
 *  out both closings would break on the next one written a third way.
 *
 *  Called from inside the tests rather than at module scope, and empty for an
 *  object that is not there, so that a component missing one of the three fails
 *  the assertion that wanted it instead of collapsing the whole file before a
 *  single test has been collected. */
const styleObject = (name: string): string => {
  const open = new RegExp(`const ${name}: React\\.CSSProperties = \\{`).exec(tsx);
  if (!open) return "";
  const from = open.index + open[0].length - 1;
  let depth = 0;
  for (let i = from; i < tsx.length; i++) {
    if (tsx[i] === "{") depth++;
    else if (tsx[i] === "}" && --depth === 0) return tsx.slice(from + 1, i).replace(/\s+/g, " ").trim();
  }
  throw new Error(`unbalanced braces around ${name}`);
};

/** One `key: value,` out of such a literal. Values here never contain a comma
 *  outside brackets, so a depth-aware scan is enough. */
const prop = (object: string, key: string): string | null => {
  const at = new RegExp(`(?:^|[,{])\\s*${key}\\s*:`).exec(object);
  if (!at) return null;
  const rest = object.slice(at.index + at[0].length);
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return rest.slice(0, i).trim();
  }
  return rest.trim();
};

const boxStyle = () => styleObject("boxStyle");
const labelStyle = () => styleObject("labelStyle");
const cameraStyle = () => styleObject("cameraStyle");

// ── the camera ──────────────────────────────────────────────────────────────

describe("the camera is applied once, to the layer, on a property nothing eases", () => {
  it("puts the viewport on .session-clusters as one transform", () => {
    // Same three numbers React Flow builds `.react-flow__viewport`'s transform
    // from. Two cameras built from one pair of numbers cannot drift; two cameras
    // built from different properties drifted by 674px.
    const transform = prop(cameraStyle(), "transform");
    expect(transform, "cameraStyle.transform").toBeTruthy();
    expect(transform).toMatch(/translate\(/);
    expect(transform).toMatch(/\$\{x\}px/);
    expect(transform).toMatch(/\$\{y\}px/);
    expect(transform).toMatch(/scale\(\$\{zoom\}\)/);
  });

  it("hands that transform to the layer element and to nothing else", () => {
    expect(tsx).toMatch(/<div className="session-clusters" style=\{cameraStyle\}>/);
  });

  it("measures the layer from its top-left corner, where the coordinates start", () => {
    // Everything underneath is a layout coordinate measured from the canvas
    // origin, the way React Flow measures node positions. The CSS default of
    // 50% 50% would swing every box away from its own nodes at any zoom but 1.
    expect(decl(ruleFor(".session-clusters").body, "transform-origin")).toBe("0 0");
  });

  it("promotes the one property the camera still writes every frame", () => {
    // The same promotion .tool-burst-wrap got in #259, for the same reason.
    expect(decl(ruleFor(".session-clusters").body, "will-change")).toBe("transform");
  });

  it("never eases that transform, in any block, resting or reduced", () => {
    // A transition here would rebuild the whole defect one level up, and this
    // time it would take the labels down with it.
    for (const rule of RULES.filter(r => selectors(r).includes(".session-clusters")))
      expect(decl(rule.body, "transition"), `styles.css:${lineOf(rule.at)}`).toBeNull();
  });
});

// ── the geometry underneath it ──────────────────────────────────────────────

describe("the four eased properties carry layout coordinates, not screen ones", () => {
  const GEOMETRY: [string, string][] = [["left", "c.x"], ["top", "c.y"], ["width", "c.w"], ["height", "c.h"]];

  it("writes each of the four as the cluster bound and nothing else", () => {
    for (const [css, expr] of GEOMETRY) expect(prop(boxStyle(), css), css).toBe(expr);
  });

  it("keeps the viewport out of all four, which is the whole defect", () => {
    // `c.x * zoom + x` is what this looked like before, on four properties, at
    // 60fps, through 320ms of easing each.
    for (const [css] of GEOMETRY) {
      const value = prop(boxStyle(), css)!;
      expect(value, css).not.toMatch(/\bzoom\b/);
      expect(value.split(/[^\w.]+/), css).not.toContain("x");
      expect(value.split(/[^\w.]+/), css).not.toContain("y");
    }
  });

  it("keeps the label in the same space, so the two cannot disagree", () => {
    // A box in layout space with a label still in screen space would put the
    // session's name somewhere other than the session at every zoom but 1.
    expect(prop(labelStyle(), "left")).toBe("c.x + 16");
    expect(prop(labelStyle(), "top")).toBe("c.y - LABEL_LIFT");
  });

  it("divides the layer's scale back out of the label, which must not zoom", () => {
    // The label is text: at 0.2x it is a smudge, so it has always taken
    // `scale(min(1, zoom))` to shrink with a zoom-out and never grow past its
    // natural size on a zoom-in. Inside a scaled layer that same on-screen size
    // costs a division, and dropping the division is the tempting simplification
    // that would silently make the name zoom with the canvas.
    const transform = prop(labelStyle(), "transform")!;
    expect(transform).toMatch(/Math\.min\(1, zoom\)/);
    expect(transform).toMatch(/Math\.min\(1, zoom\)\s*\/\s*\(?\s*zoom/);
  });
});

// ── the easing that was worth keeping ───────────────────────────────────────

describe("the easing the camera was abusing is still there for its own reason", () => {
  const card = () => ruleFor(".cluster-card");

  it("still eases all four, because a layout move is what they are for", () => {
    // Deleting them would have cured a lag by introducing a lead: the box reads
    // each node's FINAL position the frame the layout changes, while the nodes
    // are still travelling to it.
    const eased = transitioned(decl(card().body, "transition"));
    for (const p of ["left", "top", "width", "height"]) expect(eased, p).toContain(p);
  });

  it("keeps the fade, which is not travel and never was", () => {
    expect(transitioned(decl(card().body, "transition"))).toContain("opacity");
  });

  it("moves on exactly the curve and duration the nodes move on", () => {
    // The box and the cards inside it are one movement or they are two. Both
    // numbers come from .react-flow__node's own base transition; if that one is
    // ever retuned and this one is not, the box starts arriving early or late on
    // every re-layout and nothing else in the suite would notice.
    const nodeTiming = splitTop(decl(ruleFor(".react-flow__node").body, "transition")!)
      .map(part => part.replace(/^\S+\s*/, "").replace(/\s+/g, ""));
    expect(nodeTiming.length, ".react-flow__node transition").toBeGreaterThan(0);
    const boxTiming = splitTop(decl(card().body, "transition")!)
      .filter(part => /^(left|top|width|height)\b/.test(part))
      .map(part => part.replace(/^\S+\s*/, "").replace(/\s+/g, ""));
    expect(boxTiming).toHaveLength(4);
    for (const timing of boxTiming) expect(timing).toBe(nodeTiming[0]);
  });

  it("is still answered under reduced motion, by a later rule of the same selector", () => {
    // #357 wrote that answer and it is not stale: the base rule still eases four
    // layout properties, and a reader who asked for less motion should not watch
    // a box travel because a session gained a node. A media query adds no
    // specificity, so the answer has to come later in the file.
    const base = card();
    expect(transitioned(decl(base.body, "transition")).filter(p => TRAVELS.has(p)).length).toBeGreaterThan(0);
    const answers = rulesFor(".cluster-card", true);
    expect(answers.length, ".cluster-card answered under reduced motion").toBeGreaterThan(0);
    const last = answers[answers.length - 1];
    expect(last.at, "answered after it is declared").toBeGreaterThan(base.at);
    expect(transitioned(decl(last.body, "transition")).filter(p => TRAVELS.has(p))).toEqual([]);
  });
});

// ── the escape hatch that never fired ───────────────────────────────────────

describe("the drag is answered by a class something actually sets", () => {
  it("renders the card's class as a literal, which is what killed the old rule", () => {
    // No conditional, no template literal. This is not a thing to fix here — it
    // is the reason the answer below cannot be a class on the card.
    expect(tsx).toMatch(/<div className="cluster-card" style=\{boxStyle\} aria-hidden \/>/);
    expect(tsx).not.toMatch(/className=\{[^}]*cluster-card/);
  });

  it("has no rule left waiting for a class nobody adds", () => {
    const dead = RULES.filter(r => selectors(r).some(s => /\.cluster-card\.dragging\b/.test(s)));
    expect(dead.map(r => `styles.css:${lineOf(r.at)} ${r.selector}`)).toEqual([]);
  });

  it("drops the travel from the pane flag instead, where the nodes are answered", () => {
    // A gesture that follows the cursor must not ease at all, and React Flow's
    // own `.dragging` only marks the node the pointer grabbed — a session drag
    // moves its members through state. `.canvas-wrap.dragging-any` is the flag
    // App sets for the length of every gesture, which is why the nodes already
    // hang off it.
    const rule = ruleFor(".canvas-wrap.dragging-any .cluster-card");
    const eased = transitioned(decl(rule.body, "transition"));
    expect(eased.filter(p => TRAVELS.has(p))).toEqual([]);
    expect(eased).toContain("opacity");
    // Same flag, same gesture, same sheet — if the nodes ever stop using it this
    // rule is answering a class that no longer exists.
    expect(RULES.some(r => selectors(r).some(s => s.startsWith(".canvas-wrap.dragging-any .react-flow__node")))).toBe(true);
  });
});

describe("sees the sheet it is reading, so a passing run means something", () => {
  it("parsed a whole stylesheet and the component that drives it", () => {
    expect(RULES.length).toBeGreaterThan(200);
    expect(RULES.some(r => r.reduced)).toBe(true);
    expect(tsx).toContain("useViewport");
  });

  it("read the comments out before looking for what is gone", () => {
    // Both files explain the defect by quoting it, and the sheet's quotation
    // sits in prelude position — with comments left in, `collect` would read it
    // as part of the next rule's selector and the dead-rule sweep above would
    // find `.cluster-card.dragging` in a sentence saying it is gone.
    expect(rawCss).toMatch(/\.cluster-card\.dragging/);
    expect(css).not.toMatch(/\.cluster-card\.dragging/);
    // The issue number is only ever written in prose, in either file, so it is
    // the one string that proves a stripper ran without pinning a wording.
    expect(rawTsx).toMatch(/#353/);
    expect(tsx).not.toMatch(/#353/);
    expect(rawCss).toMatch(/#353/);
    expect(css).not.toMatch(/#353/);
  });
});
