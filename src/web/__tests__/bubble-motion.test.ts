// #354: three defects in the motion of the element the deck draws most — a
// live deck was sampled with 79 tool bubbles on screen at once — all three in
// one block of styles.css, and all three invisible to a test that only reads
// durations off the sheet. What each of them needed was a statement about the
// MECHANISM, so the sweeps below are written against mechanisms rather than
// against the seven literal declarations that happened to be wrong.
//
// There is no jsdom here and no layout engine, so nothing rendered can be
// observed. The sheet and ToolBursts.tsx are the evidence. Every parser below
// is re-derived rather than imported from another test file: a test that
// borrowed another one's collector would go green the moment that one was
// loosened. Comments are stripped before anything is read, because the comments
// in this sheet quote the declarations they explain — several of them now quote
// the exact `ease-in` and the exact `460ms` that the assertions here say appear
// nowhere.
//
// 1. THE FLASH FIRED FROM THE WRONG CLOCK.
//    `.tool-burst.status-done` read `bubble-spawn 460ms …, bubble-done-flash
//    520ms 460ms ease-out`, under a comment claiming "spawn THEN flash … so
//    neither interrupts the other". That is true only if the list starts when
//    the bubble does. It does not. `bubble-spawn` is named at the same list
//    index on the base rule and on the status rule, so it survives the class
//    change untouched; `bubble-done-flash` is NEW to the list at that moment,
//    so it starts THEN and measures its delay from the class change — which is
//    the tool finishing, at an arbitrary time. Measured through a real deck at
//    127.0.0.1:4409 on a Bash call: the tool settled at timeline 5356ms, the ✓'s
//    own `mark-pop` started one frame later at 5373 with no delay, and the flash
//    did not paint until 5833. One event, two signals, 460ms apart — 680ms on
//    the sub-bubble, whose delay had been SUMMED with its spawn delay in the
//    belief that the list restarts, which made a sub's glow trail its primary's
//    by 220ms on a tool that finished once.
//    So the rule swept below is the mechanism: an animation that first appears
//    when a class is added begins at the class change, therefore it may not
//    carry a delay.
//
// 2. THE ENTRANCE BOUNCED TWICE.
//    `animation-timing-function` on the shorthand is not the curve of the
//    animation, it is the default curve of every SEGMENT of it. `bubble-spawn`
//    had three keyframes and overrode nothing, so cubic-bezier(0.34, 1.56,
//    0.64, 1) — which peaks at progress 1.0978 — was applied to both segments.
//    `getKeyframes()` on a live bubble returned it attached to offsets 0, 0.55
//    AND 1, and the measured scale path was 0.35 → 1.1948 at 140ms → 1.1201 at
//    250ms → a trough of 0.9883 at 370ms → 1.00: an arrival that ends by
//    shrinking below its own size. The sweep below counts, per animation, how
//    many segments an overshooting curve governs.
//
// 3. THE EXIT WAS THE ONLY `ease-in` IN THE SHEET.
//    Every other timing function here decelerates into rest — all seven
//    distinct cubic-bezier() curves in the sheet put their second control point
//    at x < 1, so the curve flattens as it lands. `ease-in` is
//    cubic-bezier(0.42, 0, 1, 1): its second control point sits ON the endpoint,
//    so it leaves rest at zero speed and arrives at full speed, which is the
//    hang the report describes. Measured pre-fix, 150ms into the 600ms exit the
//    bubble was still at opacity 0.907 while the SVG leader line pointing at it
//    — whose opacity ToolBursts computes in JS as a dead-linear `1 - since /
//    FADE_MS` over the same 600ms — had already given up a quarter of its own.
//    The bubble was outliving its own connector, which is the exact desync
//    .tool-burst-wrap was fixed for in #259.
//    Worth recording because the report proposed it: the fix it suggested,
//    cubic-bezier(0.4, 0, 1, 1), is `ease-in` with x1 nudged by 0.02. Measured
//    side by side in Chrome at 150ms of 600ms it gives 0.9014 against ease-in's
//    0.9065 — it would have changed the declaration and not the defect. The
//    curve is split off from the fade instead, for the reason .confetti-bit
//    already writes out in this sheet: one timing function governs every
//    property in a keyframe set, so movement keeps an ease-out and the fade runs
//    linear on its own clock, which is the connector's clock.
//
// NOT swept here, and left to the issues that own them: #355 (fourteen controls
// with no press feedback), #356 (four live-pulse rates and three modal
// entrances) and #379 (the duration/easing token scale). The literal durations
// asserted below are literals on purpose — when #379 lands they become token
// lookups, and this file should be updated rather than worked around.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const rawCss = readFileSync(join(web, "styles.css"), "utf8");
/** Blanked to spaces rather than cut, so a reported line number still points at
 *  the rule it belongs to. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const lineOf = (at: number) => css.slice(0, at).split("\n").length;

const rawBursts = readFileSync(join(web, "components/ToolBursts.tsx"), "utf8");
/** `[^\r\n]` rather than `.` so a CRLF checkout on Windows strips the same
 *  line comments a LF one does — `.` excludes \r, so `.*$` would fail to reach
 *  the end of a \r-terminated line and quietly strip nothing at all. */
const bursts = rawBursts
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\r\n]*/g, "$1");

// ─── parsing ──────────────────────────────────────────────────────────────

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Commas inside cubic-bezier(), color-mix() and translate() are not list
 *  separators. */
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

/** Split on whitespace, but never inside cubic-bezier(0.34, 1.56, 0.64, 1). */
function tokens(part: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i <= part.length; i++) {
    const c = part[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((i === part.length || /\s/.test(c)) && depth === 0) {
      const tok = part.slice(start, i).trim();
      if (tok) out.push(tok);
      start = i + 1;
    }
  }
  return out;
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`).exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** Property names declared in a block, keyed off `{` as well as `;` because a
 *  keyframe's first declaration follows the brace. */
const declared = (body: string): Set<string> =>
  new Set([...body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:/g)].map(m => m[1]));

type Rule = { selector: string; body: string; reduced: boolean; at: number };
type Frame = { offsets: number[]; body: string };

const rules: Rule[] = [];
const keyframes = new Map<string, Frame[]>();

const offsetOf = (stop: string): number =>
  stop === "from" ? 0 : stop === "to" ? 1 : parseFloat(stop) / 100;

function frames(src: string): Frame[] {
  const out: Frame[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const offsets = src.slice(i, open).split(",").map(s => s.trim()).filter(Boolean).map(offsetOf);
    const [inner, end] = block(src, open);
    out.push({ offsets, body: inner });
    i = end + 1;
  }
  return out;
}

function collect(src: string, base: number, reduced: boolean): void {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    const named = /^@keyframes\s+([\w-]+)/.exec(prelude);
    if (named) keyframes.set(named[1], frames(inner));
    else if (prelude.startsWith("@")) {
      collect(inner, base + open + 1, reduced || /prefers-reduced-motion\s*:\s*reduce/.test(prelude));
    } else if (prelude) {
      rules.push({ selector: prelude, body: inner, reduced, at: base + open });
    }
    i = end + 1;
  }
}
collect(css, 0, false);

const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(|steps\()/;
const TIME = /^-?[\d.]+m?s$/;

type Part = { name: string; duration: string | null; delay: string | null; easing: string; raw: string };

/** One entry of an `animation` shorthand list. Per the shorthand's grammar the
 *  FIRST time is the duration and the SECOND is the delay, whatever else is
 *  interleaved between them. */
function animationParts(value: string | null): Part[] {
  if (value == null || value === "none") return [];
  return splitTop(value).map(part => {
    const toks = tokens(part);
    const times = toks.filter(t => TIME.test(t));
    return {
      name: toks.find(t => keyframes.has(t)) ?? "",
      duration: times[0] ?? null,
      delay: times[1] ?? null,
      easing: toks.find(t => EASING.test(t)) ?? "ease",
      raw: part.replace(/\s+/g, " ").trim(),
    };
  }).filter(p => p.name !== "");
}

const animationsOf = (rule: Rule): Part[] => animationParts(decl(rule.body, "animation"));

const ms = (t: string | null): number => {
  if (t == null) return 0;
  return t.endsWith("ms") ? parseFloat(t) : parseFloat(t) * 1000;
};

/** Every selector in a list, normalised so two spellings of one match. */
const selectors = (rule: Rule): string[] =>
  splitTop(rule.selector).map(s => s.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim());

/** Does an overshooting curve govern this segment? A cubic-bezier whose control
 *  points leave the 0..1 band on the y axis carries the value past its target
 *  and back — that is exactly one bounce per segment it governs. */
function overshoots(easing: string): boolean {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(easing);
  if (!m) return false;
  const [, y1, , y2] = m[1].split(",").map(Number);
  return y1 > 1 || y2 > 1 || y1 < 0 || y2 < 0;
}

/** The keyframe offsets of `name`, in order, each with the easing that governs
 *  the segment STARTING at it — its own `animation-timing-function` if it has
 *  one, otherwise the animation's. The last offset starts no segment. */
function segments(name: string, shorthandEasing: string): { from: number; easing: string }[] {
  const stops: { offset: number; easing: string }[] = [];
  for (const f of keyframes.get(name) ?? []) {
    const own = decl(f.body, "animation-timing-function");
    for (const offset of f.offsets) stops.push({ offset, easing: own ?? shorthandEasing });
  }
  stops.sort((a, b) => a.offset - b.offset);
  return stops.slice(0, -1).map(s => ({ from: s.offset, easing: s.easing }));
}

// ─── the sweeps ───────────────────────────────────────────────────────────

/** The bubble's two base rules — the ones that carry an animation with no
 *  status class on them. Everything else on .tool-burst is a state added later,
 *  and a state's animation list is compared against the base it extends. */
const BASES = [".tool-burst.sub", ".tool-burst"];
const baseAnimations = new Map<string, Set<string>>();
for (const base of BASES) {
  const rule = rules.find(r => !r.reduced && selectors(r).includes(base) && decl(r.body, "animation") != null);
  if (rule) baseAnimations.set(base, new Set(animationsOf(rule).map(p => p.name)));
}

/** A `.tool-burst` rule whose selector carries a class the base does not — the
 *  status classes React swaps in when the tool settles.
 *  `.sub` is not one of them, which is why it is a base and not a state: a
 *  bubble is a sub-bubble from the frame it is mounted, so its own spawn delay
 *  is measured from its birth like any other.
 *  `.fading` is excluded too: React mounts that class on an element it is about
 *  to unmount on a wall-clock timer, and its timing is answered against that
 *  timer further down rather than against a class change. */
type StateRule = { rule: Rule; sel: string; base: string };
const stateRules: StateRule[] = [];
for (const rule of rules) {
  if (rule.reduced || decl(rule.body, "animation") == null) continue;
  for (const sel of selectors(rule)) {
    if (!/^\.tool-burst[.\w-]*$/.test(sel)) continue;
    if (BASES.includes(sel) || /\.fading(?![\w-])/.test(sel)) continue;
    const base = BASES.find(b => sel.startsWith(b) && sel !== b);
    if (base) stateRules.push({ rule, sel, base });
  }
}

/** Animations that only exist once a state class lands, so the browser starts
 *  them at the class change rather than at the element's birth. */
const startedByAClassChange = stateRules.flatMap(({ rule, sel, base }) =>
  animationsOf(rule)
    .filter(p => !(baseAnimations.get(base) ?? new Set()).has(p.name))
    .map(p => ({ sel, part: p, at: rule.at })));

describe("a tool bubble reports the tool, on the tool's clock", () => {
  it("gives no delay to an animation that starts when a class lands", () => {
    // The delay would be measured from the class change, and the class change
    // is the event being reported. Any delay here is pure lateness.
    const late = startedByAClassChange
      .filter(a => ms(a.part.delay) > 0)
      .map(a => `styles.css:${lineOf(a.at)} ${a.sel} — ${a.part.raw} is ${ms(a.part.delay)}ms late`);
    expect(late).toEqual([]);
  });

  it("sees the flash and the shake in that sweep, so a pass means something", () => {
    // If the status rules are ever restructured past the collector above, this
    // collapses before the assertion it protects can quietly stop testing.
    const names = new Set(startedByAClassChange.map(a => a.part.name));
    expect([...names].sort()).toEqual(["bubble-done-flash", "bubble-err-shake"]);
    // Both bubbles, both outcomes: primary done, primary err, sub done, sub err.
    expect(startedByAClassChange.length).toBe(4);
    expect(startedByAClassChange.filter(a => a.sel.includes(".sub")).length).toBe(2);
  });

  it("keeps the spawn out of it, because the spawn survives the class change", () => {
    // Same name at the same list index on the base rule and on the status rule
    // is what makes it one continuous animation, and the sub's spawn delay is
    // measured from the bubble's birth, which is when it legitimately starts.
    for (const { rule, base } of stateRules) {
      const spawn = animationsOf(rule).find(p => p.name === "bubble-spawn");
      expect(spawn, `${base} state rule must restate bubble-spawn`).toBeTruthy();
      const baseSpawn = rules.find(r => !r.reduced && selectors(r).includes(base) && decl(r.body, "animation") != null)!;
      const want = animationsOf(baseSpawn).find(p => p.name === "bubble-spawn")!;
      expect(spawn!.duration, base).toBe(want.duration);
      expect(spawn!.delay, base).toBe(want.delay);
    }
  });

  it("lets the ✓ and the glow report the same instant", () => {
    // `.tb-mark` is a freshly inserted element, so `mark-pop` has always run the
    // moment the tool landed. The glow now has nothing holding it back either,
    // and the sub's is no longer summed to trail the primary's.
    const mark = animationsOf(rules.find(r => selectors(r).includes(".tool-burst .tb-mark"))!)[0];
    expect(mark.name).toBe("mark-pop");
    expect(ms(mark.delay)).toBe(0);
    for (const a of startedByAClassChange) expect(ms(a.part.delay), a.sel).toBe(0);
  });
});

describe("what runs beside a filling animation composes with it", () => {
  // `bubble-spawn` is declared on the base class with `both`, so it goes on
  // applying its 100% keyframe for the bubble's whole life, and a filling
  // animation outranks every author rule under it. Now that the flash and the
  // shake carry no delay to hold them clear of it, they can run at the same
  // time — and a second animation naming a property the first one pins does not
  // compose with it, it replaces it for as long as it runs. A tool finishing
  // inside its own spawn would have snapped.
  const spawn = keyframes.get("bubble-spawn")!;
  const terminal = spawn.filter(f => f.offsets.includes(1));
  const pinned = new Set(terminal.flatMap(f => [...declared(f.body)]));

  it("still fills a transform, which is the hazard being worked around", () => {
    expect([...pinned]).toContain("transform");
    const base = rules.find(r => selectors(r).includes(".tool-burst") && decl(r.body, "animation") != null)!;
    expect(decl(base.body, "animation")).toMatch(/\bboth\b/);
  });

  it("keeps every concurrent animation off the properties the spawn pins", () => {
    const clashes: string[] = [];
    for (const a of startedByAClassChange) {
      const props = new Set((keyframes.get(a.part.name) ?? []).flatMap(f => [...declared(f.body)]));
      for (const prop of pinned) {
        if (props.has(prop)) clashes.push(`${a.sel} — ${a.part.name} names ${prop}, which bubble-spawn fills`);
      }
    }
    expect([...new Set(clashes)]).toEqual([]);
  });

  it("uses the independent properties instead, as the hover lift already does", () => {
    // #266 fixed the hover lift the same way and .tool-burst.clickable is the
    // rule that documents it, so the two now read as one idea.
    const flash = new Set((keyframes.get("bubble-done-flash") ?? []).flatMap(f => [...declared(f.body)]));
    const shake = new Set((keyframes.get("bubble-err-shake") ?? []).flatMap(f => [...declared(f.body)]));
    expect([...flash].sort()).toEqual(["box-shadow", "scale"]);
    expect([...shake]).toEqual(["translate"]);
    const lift = rules.find(r => selectors(r).includes(".tool-burst.clickable:hover"))!;
    expect(decl(lift.body, "translate")).toBeTruthy();
    expect(decl(lift.body, "transform")).toBeNull();
  });
});

describe("an entrance overshoots once", () => {
  /** Every (rule, animation) pair in the sheet, with the segments its curve
   *  governs. A shorthand easing applies to EVERY segment unless a keyframe
   *  overrides it, which is the whole of defect 2. */
  const governed: { sel: string; name: string; bouncing: number; total: number; at: number }[] = [];
  for (const rule of rules) {
    if (rule.reduced) continue;
    for (const part of animationsOf(rule)) {
      const segs = segments(part.name, part.easing);
      const bouncing = segs.filter(s => overshoots(s.easing)).length;
      for (const sel of selectors(rule)) {
        governed.push({ sel, name: part.name, bouncing, total: segs.length, at: rule.at });
      }
    }
  }

  it("never lets an overshooting curve govern more than one segment", () => {
    const doubled = governed
      .filter(g => g.bouncing > 1)
      .map(g => `styles.css:${lineOf(g.at)} ${g.sel} — ${g.name} bounces on ${g.bouncing} of ${g.total} segments`);
    expect([...new Set(doubled)]).toEqual([]);
  });

  it("sweeps the multi-segment entrance it was written for", () => {
    // bubble-spawn is the only animation in the sheet that is both governed by
    // an overshooting curve and built from more than two keyframes, so if this
    // stops holding the sweep above has stopped seeing anything.
    const spawn = governed.filter(g => g.name === "bubble-spawn");
    expect(spawn.length).toBeGreaterThan(0);
    for (const g of spawn) {
      expect(g.total, "bubble-spawn segment count").toBe(2);
      expect(g.bouncing, "bubble-spawn overshooting segments").toBe(1);
    }
    expect(governed.some(g => g.bouncing === 1 && g.total === 1)).toBe(true);
  });

  it("hands the landing segment a curve that cannot overshoot", () => {
    // The 55% keyframe overrides in place rather than the shorthand changing,
    // because the segment that ARRIVES is still meant to overshoot.
    const segs = segments("bubble-spawn", "cubic-bezier(0.34, 1.56, 0.64, 1)");
    expect(segs).toHaveLength(2);
    expect(overshoots(segs[0].easing), "the arriving segment").toBe(true);
    expect(overshoots(segs[1].easing), "the landing segment").toBe(false);
    // And it is the sheet's own ease-out, not a curve invented for this rule.
    const shared = [...css.matchAll(/cubic-bezier\([^)]*\)/g)].filter(m => m[0] === segs[1].easing);
    expect(shared.length).toBeGreaterThan(5);
  });

  it("starts from something rather than from nothing", () => {
    // The sheet states this rule beside .aa-done's own entrance in as many
    // words, and that entrance is checked here so the convention has two
    // holders rather than one.
    const scaleAt = (name: string, offset: number): number => {
      const f = (keyframes.get(name) ?? []).find(k => k.offsets.includes(offset))!;
      const t = decl(f.body, "transform") ?? "";
      return parseFloat(/scale\(([\d.]+)\)/.exec(t)![1]);
    };
    expect(scaleAt("bubble-spawn", 0)).toBeGreaterThanOrEqual(0.9);
    expect(scaleAt("aa-done-in", 0)).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps the most repetitive element in the app inside the short band", () => {
    // 460ms was the longest duration in the deck, on the element it draws most.
    for (const base of BASES) {
      const rule = rules.find(r => !r.reduced && selectors(r).includes(base) && decl(r.body, "animation") != null)!;
      const spawn = animationsOf(rule).find(p => p.name === "bubble-spawn")!;
      expect(ms(spawn.duration), `${base} spawn duration`).toBeGreaterThanOrEqual(150);
      expect(ms(spawn.duration), `${base} spawn duration`).toBeLessThanOrEqual(250);
    }
    // The sub still leaves while the primary is arriving rather than after it,
    // which is what makes the pair read as one gesture.
    const sub = animationsOf(rules.find(r => !r.reduced && selectors(r).includes(".tool-burst.sub"))!)
      .find(p => p.name === "bubble-spawn")!;
    const primary = animationsOf(rules.find(r => !r.reduced && selectors(r).includes(".tool-burst"))!)
      .find(p => p.name === "bubble-spawn")!;
    expect(ms(sub.delay)).toBeGreaterThan(0);
    expect(ms(sub.delay)).toBeLessThan(ms(primary.duration));
  });
});

describe("this sheet decelerates into rest", () => {
  it("uses no ease-in anywhere", () => {
    // `ease-in` leaves rest at zero speed and arrives at full speed, which is
    // the one shape nothing else here has. The negative lookahead is load
    // bearing: `ease-in-out` is a different keyword and the sheet uses it for
    // the symmetric loops, where a curve has no landing to flatten into.
    const found = [...css.matchAll(/\bease-in\b(?!-out)/g)].map(m => `styles.css:${lineOf(m.index!)}`);
    expect(found).toEqual([]);
  });

  it("read a sheet with the comments taken out of it, which is why that holds", () => {
    // The comments here quote the declarations they explain, and the ones added
    // for #354 quote the removed `ease-in` and the removed `460ms` by name. An
    // "appears nowhere" assertion over the raw file would be answered by the
    // comment explaining the removal, so the strip is part of the evidence.
    expect(rawCss).toMatch(/\/\*/);
    expect(css).not.toMatch(/\/\*/);
    // Blanked, not cut: every offset above still points at its own line.
    expect(css.length).toBe(rawCss.length);
    expect(css.split("\n").length).toBe(rawCss.split("\n").length);
  });

  it("flattens every curve as it lands", () => {
    // A cubic-bezier whose second control point sits at x = 1 arrives at full
    // speed — that is what `ease-in` is. Every curve written out in this sheet
    // puts it short of the end instead.
    const arriving: string[] = [];
    for (const m of css.matchAll(/cubic-bezier\(([^)]*)\)/g)) {
      const [, , x2] = m[1].split(",").map(Number);
      if (!(x2 < 1)) arriving.push(`styles.css:${lineOf(m.index!)} ${m[0]}`);
    }
    expect(arriving).toEqual([]);
    expect([...css.matchAll(/cubic-bezier\([^)]*\)/g)].length).toBeGreaterThan(30);
  });
});

describe("a bubble and its leader line leave together", () => {
  const fadingRules = rules.filter(r => !r.reduced && selectors(r).some(s => /^\.tool-burst[.\w-]*\.fading$/.test(s)));

  it("covers both the primary and the sub", () => {
    expect(fadingRules.map(r => r.selector).sort()).toEqual([".tool-burst.fading", ".tool-burst.sub.fading"]);
  });

  it("splits the movement from the fade, so one curve cannot rewrite the other", () => {
    // .confetti-bit makes this argument in full in this sheet: a single timing
    // function governs every property in a keyframe set, so a curve chosen for
    // travel also races the opacity ramp.
    for (const rule of fadingRules) {
      const parts = animationsOf(rule);
      expect(parts.length, rule.selector).toBe(2);
      const named = (n: string) => new Set((keyframes.get(n) ?? []).flatMap(f => [...declared(f.body)]));
      const fade = parts.filter(p => named(p.name).has("opacity"));
      const move = parts.filter(p => !named(p.name).has("opacity"));
      expect(fade.length, `${rule.selector} — exactly one half carries opacity`).toBe(1);
      expect(move.length, rule.selector).toBe(1);
      // The fade runs on the connector's clock, which has no curve at all.
      expect(fade[0].easing, `${rule.selector} — the fade`).toBe("linear");
      expect(overshoots(move[0].easing) || move[0].easing === "linear", rule.selector).toBe(false);
      // Both on the same 600ms, because both ends are removed by one timer.
      for (const p of parts) expect(ms(p.duration), `${rule.selector} — ${p.name}`).toBe(600);
      expect(ms(fade[0].delay)).toBe(0);
      expect(ms(move[0].delay)).toBe(0);
      // And the movement half must not restate opacity, or it would be back to
      // one clock with extra steps.
      expect([...named(move[0].name)]).not.toContain("opacity");
    }
  });

  it("uses the same 600ms the component removes the element on", () => {
    // The duration is a contract with ToolBursts and with the reduced-motion
    // answer; only the curve was ever free to change.
    expect(bursts).toMatch(/const FADE_MS = 600;/);
    // The connector's opacity is a linear ramp over exactly that window, which
    // is why the bubble's fade is linear too.
    expect(bursts).toMatch(/Math\.max\(0, 1 - since \/ FADE_MS\)/);
    expect(bursts).toMatch(/const opacity = b\.fade\b/);
    expect(bursts).toMatch(/className=\{`tool-conn status-\$\{b\.status\}/);
  });

  it("is still answered under reduced motion, with nothing stale left behind", () => {
    // #357's contract. The exit keeps its 600ms there too — a bubble that
    // vanished early would sit invisible while its connector was still drawn.
    const answers = rules.filter(r => r.reduced && selectors(r).some(s => /\.tool-burst[.\w-]*\.fading$/.test(s)));
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      for (const p of animationsOf(a)) expect(ms(p.duration), a.selector).toBe(600);
    }
  });
});

describe("the sheet names no animation it does not define, and defines none it does not name", () => {
  it("resolves every animation name to a keyframe set", () => {
    const missing: string[] = [];
    for (const rule of rules) {
      const value = decl(rule.body, "animation") ?? decl(rule.body, "animation-name");
      if (value == null || value === "none") continue;
      for (const part of splitTop(value)) {
        const toks = tokens(part);
        if (!toks.some(t => keyframes.has(t))) missing.push(`styles.css:${lineOf(rule.at)} ${rule.selector} — ${part.trim()}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("leaves no keyframe set behind that nothing runs", () => {
    // This is the assertion that would have caught a rename half-done: when
    // `bubble-fade` became `bubble-fade-move` + `bubble-fade-out`, an orphaned
    // `@keyframes bubble-fade` would have shown up right here.
    const used = new Set<string>();
    for (const rule of rules) {
      for (const part of animationsOf(rule)) used.add(part.name);
    }
    const orphans = [...keyframes.keys()].filter(n => !used.has(n));
    expect(orphans).toEqual([]);
    expect(keyframes.has("bubble-fade")).toBe(false);
    expect(keyframes.has("bubble-fade-move")).toBe(true);
    expect(keyframes.has("bubble-fade-out")).toBe(true);
  });
});
