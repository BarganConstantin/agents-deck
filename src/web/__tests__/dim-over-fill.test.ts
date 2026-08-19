// #316: the search dimmed nothing, because an entrance animation was still
// filling over it.
//
// #266 was one bubble's hover lift losing to `bubble-spawn`'s filled transform.
// The mechanism is general and it reached much further than a hover: both spawn
// animations are declared on a base class — `.tool-burst` and
// `.react-flow__node` — so they are attached for the element's whole life, and
// `both` keeps them applying their last keyframe long after they have finished.
// A filling animation outranks every author declaration under it. Both terminal
// keyframes restated `opacity` and `filter`, and `opacity` and `filter` are the
// only two properties `.tool-burst.dim` and `.react-flow__node.rf-spotlit-out`
// have. Both were dead: the class went on, and the board did not change. (A
// third, `.rf-dim`, was the /-search's own and went with the field.) Reduced
// motion swapped the entrance for `fadeIn`, also with `both`, also ending on
// `opacity: 1`, so it was dead there too.
//
// The fix is not a higher-priority declaration — `!important` would beat the
// animation and lose the ability to layer the dim with anything else. It is to
// leave the property out of the last keyframe, which hands it back to the
// cascade: the animation interpolates towards the element's own value and, once
// filling, simply is it, so a class added a second or an hour later lands.
//
// Hence the invariant swept below, which is wider than the two selectors: no
// animation an element can still be running may name a property that a rule on
// that same element needs to win. "Can still be running" is a fill mode that
// includes forwards, or an infinite duration — an infinite animation never
// stops, so for those every keyframe counts, not just the last.
//
// Exempt: `.fading` and `.rf-exiting`. Those animations are the state, not a
// competitor to it — the element is being removed on a wall-clock timer and has
// nothing left to say about the selection.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
/** Comments quote declarations while explaining them; strip before reading. */
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

type Rule = { selector: string; body: string; reduced: boolean };
type Frame = { stops: string[]; body: string };

const rules: Rule[] = [];
const keyframes = new Map<string, Frame[]>();

/** `0%, 100% { … }` blocks, stops kept apart so the terminal one can be found. */
function frames(src: string): Frame[] {
  const out: Frame[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const stops = src.slice(i, open).split(",").map(s => s.trim()).filter(Boolean);
    const [inner, end] = block(src, open);
    out.push({ stops, body: inner });
    i = end + 1;
  }
  return out;
}

/** @keyframes are collected by name; every other at-rule is descended into,
 *  carrying the reduced-motion flag down with it. */
function collect(src: string, reduced: boolean): void {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    const named = /^@keyframes\s+([\w-]+)/.exec(prelude);
    if (named) keyframes.set(named[1], frames(inner));
    else if (prelude.startsWith("@")) collect(inner, reduced || /prefers-reduced-motion\s*:\s*reduce/.test(prelude));
    else if (prelude) rules.push({ selector: prelude, body: inner, reduced });
    i = end + 1;
  }
}
collect(css, false);

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

const declared = (body: string): Set<string> =>
  new Set([...body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map(m => m[1]));

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`).exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** Does this selector style the element itself? A descendant, a sibling or a
 *  ::before is a different box — the parent's animation cannot outrank a
 *  declaration that is not on the same element. `.tool-burst-wrap` is not
 *  `.tool-burst` either, hence the word-character guard. */
function onElement(selector: string, base: string): boolean {
  if (!selector.startsWith(base)) return false;
  const rest = selector.slice(base.length);
  return !/^[\w-]/.test(rest) && !rest.startsWith("::") && !/[\s>+~]/.test(rest);
}

const LEAVING = /\.(fading|rf-exiting)(?![\w-])/;

type Running = { name: string; pins: Set<string>; selector: string; reduced: boolean };

/** Every animation on `base` that outlives its own run, with the properties it
 *  goes on applying once it does. */
function stillApplying(base: string): Running[] {
  const out: Running[] = [];
  for (const rule of rules) {
    const value = decl(rule.body, "animation");
    if (value == null || value === "none") continue;
    const mine = splitTop(rule.selector).filter(s => onElement(s, base) && !LEAVING.test(s));
    if (!mine.length) continue;
    for (const part of splitTop(value)) {
      const tokens = part.split(/\s+/);
      const name = tokens.find(t => keyframes.has(t));
      if (!name) continue;
      const forever = tokens.includes("infinite");
      const fills = tokens.includes("forwards") || tokens.includes("both");
      if (!forever && !fills) continue;
      // An infinite animation is inside its own keyframes at every moment; a
      // filling one is only ever pinned to its last.
      const kept = keyframes.get(name)!.filter(f => forever || f.stops.some(s => s === "100%" || s === "to"));
      const pins = new Set(kept.flatMap(f => [...declared(f.body)]));
      out.push({ name, pins, selector: mine[0], reduced: rule.reduced });
    }
  }
  return out;
}

/** Rules that style the element itself and set something visual on it, which is
 *  what a filling keyframe is in a position to erase. */
function stateRules(base: string): { selector: string; props: Set<string> }[] {
  const out: { selector: string; props: Set<string> }[] = [];
  for (const rule of rules) {
    for (const sel of splitTop(rule.selector)) {
      if (!onElement(sel, base) || LEAVING.test(sel)) continue;
      const props = new Set([...declared(rule.body)].filter(p => p === "opacity" || p === "filter"));
      if (props.size) out.push({ selector: sel, props });
    }
  }
  return out;
}

/** The two elements a search dims. `.rf-spotlit-out` sits on the node as well —
 *  App builds one className string for both. */
const BASES = [".tool-burst", ".react-flow__node"];

const masked = new Set<string>();
for (const base of BASES) {
  const running = stillApplying(base);
  for (const state of stateRules(base)) {
    for (const anim of running) {
      for (const prop of state.props) {
        if (anim.pins.has(prop)) masked.add(`${state.selector} — ${prop} lost to ${anim.name}`);
      }
    }
  }
}

describe("what a selection dims outranks the entrance that was filling over it", () => {
  it("keeps every property the dim rules need out of the keyframes still applying", () => {
    expect([...masked]).toEqual([]);
  });

  it("still finds the two selectors that remain, so a pass means something", () => {
    const swept = BASES.flatMap(b => stateRules(b).map(s => s.selector));
    for (const sel of [".tool-burst.dim", ".react-flow__node.rf-spotlit-out"]) {
      expect(swept, sel).toContain(sel);
    }
    // Both dim with the same pair, and both are what the keyframes used to name.
    for (const sel of swept.filter(s => /\.(dim|rf-spotlit-out)$/.test(s))) {
      const props = stateRules(sel.startsWith(".tool-burst") ? ".tool-burst" : ".react-flow__node")
        .find(s => s.selector === sel)!.props;
      expect([...props].sort(), sel).toEqual(["filter", "opacity"]);
    }
  });

  it("still finds an entrance filling on both of them, which is the hazard itself", () => {
    // If the fill ever goes, this collapses first — and #266's `translate` lift
    // exists only because bubble-spawn keeps filling a transform.
    for (const base of BASES) {
      const filling = stillApplying(base).filter(a => a.pins.has("transform") || a.name === "fadeIn");
      expect(filling.length, base).toBeGreaterThan(0);
    }
    expect(decl(rules.find(r => r.selector === ".tool-burst")!.body, "animation")).toMatch(/\bboth\b/);
  });

  it("dims under reduced motion too, where the entrance collapses to a fade", () => {
    const reduced = BASES.flatMap(b => stillApplying(b)).filter(a => a.reduced);
    expect(reduced.map(a => a.name)).toContain("fadeIn");
    for (const anim of reduced) expect([...anim.pins], `${anim.selector} — ${anim.name}`).not.toContain("opacity");
  });

  it("reads fill modes off the shorthand, which is the only spelling the sheet uses", () => {
    expect(css).not.toMatch(/animation-(name|fill-mode)\s*:/);
    expect(keyframes.size).toBeGreaterThan(15);
  });
});
