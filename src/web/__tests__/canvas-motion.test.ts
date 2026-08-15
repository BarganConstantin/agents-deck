// Four motion defects that only the stylesheet can be asked about — there is no
// jsdom here, so nothing rendered can be observed and the rules themselves are
// the evidence.
//
// #259: .tool-burst-wrap eased `top` and not `left`. ToolBursts rewrites both
// from the viewport on every pan and zoom frame, and the SVG leader line to the
// same bubble is redrawn from those coordinates with no easing at all, so the
// pill trailed its own connector down the screen for 220ms of every vertical
// move — and equally for the sibling index shift the easing was added for. Both
// axes are transitioned together or neither is; the connector cannot ease, so
// it is neither.
//
// #260: every reduced-motion block in the sheet covered the accounts panel, the
// success mark or the relayout easing. The canvas — spinning orbits, marching
// dashes, wobbling emoji, a bubble flying out of an agent per tool call — was
// untouched. The sweep below holds the whole canvas to it: any rule there that
// animates, or that eases a property which moves the element, must be answered
// by a rule of the same selector inside a prefers-reduced-motion block, placed
// later so it wins the tie. Coverage is matched on the exact selector because
// a media query adds no specificity: `.tool-burst { animation: none }` does not
// reach `.tool-burst.status-done`.
//
// #266: the hover lift on a clickable bubble was dead. bubble-spawn runs with
// `both` and so keeps filling its 100% transform for the element's whole life,
// and animation declarations outrank author rules while they fill. The lift is
// the independent `translate` property now, which composes with the animated
// transform instead of losing to it.
//
// #267: the press convention this codebase invented — scale(0.97), neutralised
// under reduced motion — was on four controls and missing from nine more.
//
// Deliberately outside the canvas sweep: the topbar, banners and sidebar, whose
// single status dots pulse opacity in a fixed strip rather than across the
// surface the deck is watched on, and .cat-filter-bar, chrome that floats over
// the canvas rather than living in it. Its button's press is checked below with
// the other controls.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
/** Comments quote declarations while explaining them; strip before reading. */
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const bursts = readFileSync(join(web, "components/ToolBursts.tsx"), "utf8");

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

const all = collect(css, 0, false, []);

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
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`).exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** Property names from a `transition` shorthand — the first token of each part. */
const transitioned = (body: string): string[] => {
  const value = decl(body, "transition");
  if (value == null || value === "none") return [];
  return splitTop(value).map(p => p.split(/\s/)[0]).filter(p => p !== "none");
};

/** Properties whose change moves the element on screen. Opacity, colour, stroke
 *  and shadow are not here: a fade is the recommended reduced-motion answer,
 *  not the thing being escaped from. */
const MOVES = new Set([
  "transform", "translate", "rotate", "scale", "all",
  "top", "left", "right", "bottom", "inset", "width", "height", "margin",
]);

/** Every selector in a list, normalised so two spellings of one selector match. */
const selectors = (rule: Rule): string[] =>
  splitTop(rule.selector).map(s => s.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim());

const CANVAS = /(^|[\s>+~])(\.canvas-wrap|\.react-flow|\.agent-node|\.state-pill|\.tool-burst|\.tool-conn|\.cluster-|\.session-clusters|\.session-group-handle|\.empty-hero|\.ctx-donut)/;
const onCanvas = (sel: string) => CANVAS.test(sel);

/** Selector → the reduced-motion rules that redeclare it, in source order. */
const answers = new Map<string, Rule[]>();
for (const rule of all.filter(r => r.reduced)) {
  for (const sel of selectors(rule)) {
    if (!answers.has(sel)) answers.set(sel, []);
    answers.get(sel)!.push(rule);
  }
}

/** Canvas rules that put something in motion, one entry per selector. */
const moving: { sel: string; why: string; at: number }[] = [];
for (const rule of all.filter(r => !r.reduced)) {
  const animation = decl(rule.body, "animation") ?? decl(rule.body, "animation-name");
  const travels = transitioned(rule.body).filter(p => MOVES.has(p));
  for (const sel of selectors(rule)) {
    if (!onCanvas(sel)) continue;
    if (animation != null && animation !== "none") moving.push({ sel, why: `animation: ${animation}`, at: rule.at });
    if (travels.length) moving.push({ sel, why: `transition: ${travels.join(", ")}`, at: rule.at });
  }
}

const uncovered = moving.filter(m =>
  !(answers.get(m.sel) ?? []).some(r => r.at > m.at));

describe("reduced motion reaches the canvas, not just the panels", () => {
  it("answers every canvas animation with a rule of the same selector", () => {
    expect(uncovered.filter(m => m.why.startsWith("animation")).map(m => `${m.sel} — ${m.why}`)).toEqual([]);
  });

  it("answers every canvas transition that carries the element somewhere", () => {
    expect(uncovered.filter(m => m.why.startsWith("transition")).map(m => `${m.sel} — ${m.why}`)).toEqual([]);
  });

  it("sees the motion it is sweeping for, so a passing run means something", () => {
    // If a rename ever slips the canvas out of CANVAS, this collapses first.
    expect(moving.length).toBeGreaterThan(20);
    for (const sel of [".tool-burst", ".tool-burst.sub.status-err", ".empty-hero .core",
                       ".react-flow__node", ".tool-conn.status-inflight", ".cluster-card"]) {
      expect(moving.some(m => m.sel === sel), sel).toBe(true);
    }
  });

  it("keeps the canvas legible instead of switching it off wholesale", () => {
    // A tool bubble still has to announce itself, and the exits still have to
    // outlast the 600ms wall-clock timer that removes the element.
    const rm = all.filter(r => r.reduced);
    const entering = rm.find(r => selectors(r).includes(".tool-burst"))!;
    expect(decl(entering.body, "animation")).toMatch(/fadeIn 140ms/);
    const leaving = rm.find(r => selectors(r).includes(".tool-burst.fading"))!;
    expect(decl(leaving.body, "animation")).toMatch(/600ms/);
    // The status colours are what "in flight" and "done" fall back to, so no
    // reduced-motion rule may take the classes that carry them away.
    for (const rule of rm) expect(rule.body).not.toMatch(/(^|;)\s*(background|border-color|color)\s*:/);
  });
});

describe(".tool-burst-wrap and the connector drawn to it", () => {
  const wrap = all.find(r => r.selector === ".tool-burst-wrap")!;

  it("eases both of the axes it is positioned on, or neither of them", () => {
    const eased = transitioned(wrap.body);
    expect(eased.includes("left")).toBe(eased.includes("top"));
  });

  it("eases neither, because the leader line to the bubble cannot ease with it", () => {
    expect(transitioned(wrap.body).filter(p => MOVES.has(p))).toEqual([]);
    const conn = all.find(r => r.selector === ".tool-conn")!;
    expect(transitioned(conn.body).filter(p => MOVES.has(p))).toEqual([]);
  });

  it("promotes only the property still written per frame", () => {
    expect(decl(wrap.body, "will-change")).toBe("transform");
  });

  it("is still positioned by both axes in JS, so the pairing is not theoretical", () => {
    const style = /const wrapStyle[\s\S]*?\};/.exec(bursts)![0];
    expect(style).toMatch(/left:\s*`\$\{px\}px`/);
    expect(style).toMatch(/top:\s*`\$\{py\}px`/);
  });
});

describe("the hover lift on a clickable bubble", () => {
  const hover = all.find(r => r.selector === ".tool-burst.clickable:hover")!;
  const base = all.find(r => r.selector === ".tool-burst.clickable")!;

  it("still has a spawn animation filling a transform, which is why it must", () => {
    // Remove the fill and the whole reason for `translate` goes with it.
    expect(decl(all.find(r => r.selector === ".tool-burst")!.body, "animation")).toMatch(/\bboth\b/);
    expect(/@keyframes bubble-spawn\s*\{[^]*?\n\}/.exec(css)![0]).toMatch(/transform\s*:/);
  });

  it("lifts with a property the keyframes do not own", () => {
    expect(decl(hover.body, "transform")).toBeNull();
    expect(decl(hover.body, "translate")).toBe("0 -1px");
  });

  it("eases the lift and the shadow, so neither of them snaps", () => {
    const eased = transitioned(base.body);
    expect(eased).toContain("translate");
    expect(eased).toContain("box-shadow");
  });
});

/** Every custom-styled control that answers a press, with the scale it uses:
 *  0.94 where the target is 18–28px and three percent would be sub-pixel. */
const PRESSES: [string, string][] = [
  ["button.btn:active:not(:disabled)", "0.97"],
  [".topbar .waiting-stat:active", "0.97"],
  [".ap-manage-btn:active:not(:disabled)", "0.97"],
  [".ap-more:active", "0.94"],
  [".ap-fix:active", "0.97"],
  [".cat-filter:active", "0.97"],
  [".detail-close:active", "0.94"],
  [".ctx-modal-close:active", "0.94"],
  [".uh-close:active", "0.94"],
  [".uh-range-btn:active", "0.97"],
  [".selected-ribbon .selected-close:active", "0.94"],
  [".ver-banner .ver-cmd:active", "0.97"],
  [".ver-banner .ver-auto:active", "0.97"],
  [".ver-banner .ver-close:active", "0.94"],
];

describe("press feedback is one convention, applied everywhere", () => {
  it("gives every one of these controls something to give back on press", () => {
    const missing = PRESSES.filter(([sel, scale]) =>
      !all.some(r => !r.reduced && selectors(r).includes(sel) && decl(r.body, "transform") === `scale(${scale})`));
    expect(missing.map(([sel]) => sel)).toEqual([]);
  });

  it("eases the press on the control itself, so it grows back rather than jumps", () => {
    const unEased = PRESSES.filter(([sel]) => {
      const owner = sel.replace(/:active.*$/, "");
      return !all.some(r => !r.reduced && selectors(r).includes(owner) && transitioned(r.body).includes("transform"));
    });
    expect(unEased.map(([sel]) => sel)).toEqual([]);
  });

  it("hands both close buttons a transition, so their hover stops snapping too", () => {
    // Neither had a transition property at all before the press was added.
    for (const sel of [".ctx-modal-close", ".uh-close"]) {
      const eased = transitioned(all.find(r => r.selector === sel)!.body);
      const hovered = [...all.find(r => r.selector === `${sel}:hover`)!.body.matchAll(/([\w-]+)\s*:/g)].map(m => m[1]);
      expect(hovered.filter(p => !eased.includes(p)), sel).toEqual([]);
    }
  });

  it("neutralises every press under reduced motion", () => {
    const loud = PRESSES.filter(([sel]) =>
      !(answers.get(sel) ?? []).some(r => decl(r.body, "transform") === "none"));
    expect(loud.map(([sel]) => sel)).toEqual([]);
  });
});
