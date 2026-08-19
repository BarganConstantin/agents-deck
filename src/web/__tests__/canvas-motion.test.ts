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
// #355: fifteen further controls declared `cursor: pointer` and had no `:active`
// rule of any kind, so a press on the session row, a tool bubble, the context
// donut or the Restart button was indistinguishable from a hover. The
// enumeration below is no longer a snapshot of what happened to exist when it
// was written: the sweep at the end holds it against every `cursor: pointer`
// rule in the sheet, so the next pressable control either joins the convention
// or is written down as an exception.
//
// #356: one job, several answers, twice over. Nine rules run the `pulse`
// keyframes and five of them paint --inflight and mean "this is running right
// now" — they beat at 1.2s, 1.1s and 1.4s across two easings. And three centred
// dialogs over a dimmed backdrop are reached from this canvas through one
// useModalDismiss, of which one arrived on fadeIn + popIn and two were simply
// present on the next frame. Both families are swept at the bottom of this file,
// each derived from something the sheet says about itself rather than from a
// list: the pulses by the colour token they paint, the dialogs by the shape they
// are laid out in.
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

/** A press: the `:active` selector, the scale it shrinks to, and the property
 *  that carries it. `transform` for all but one — the tool bubble's transform is
 *  owned for the element's whole life by the filling bubble-spawn keyframe, the
 *  same conflict that put its hover lift on `translate`, so its press is the
 *  independent `scale` property and composes instead of losing. */
type Press = [selector: string, scale: string, prop: "transform" | "scale"];

/** Every custom-styled control that answers a press, with the scale it uses:
 *  0.94 where the target is an 18–28px icon and three percent would be
 *  sub-pixel, 0.97 where a label makes three percent visible. The sweep at the
 *  bottom holds this list against every `cursor: pointer` rule in the sheet, so
 *  it is the spec for what a pressable control does rather than a record of
 *  which ones had been got to. */
const PRESSES: Press[] = [
  ["button.btn:active:not(:disabled)", "0.97", "transform"],
  // The machine meter and its panel's close button — same convention, joined
  // here rather than exempted, which is what #355 asked of the next control.
  [".topbar .status .sysmeter:active", "0.97", "transform"],
  [".sd-close:active", "0.97", "transform"],
  [".topbar .waiting-stat:active", "0.97", "transform"],
  [".topbar .brand button.v:active", "0.97", "transform"],
  [".ap-manage-btn:active:not(:disabled)", "0.97", "transform"],
  [".ap-more:active", "0.94", "transform"],
  [".ap-fix:active", "0.97", "transform"],
  [".ap-failure-x:active", "0.94", "transform"],
  ["button.ap-auto-state:active:not(:disabled)", "0.97", "transform"],
  [".ap-field select:active:not(:disabled)", "0.97", "transform"],
  [".ap-rotate:active:not(:disabled)", "0.97", "transform"],
  [".aa-tab:active", "0.97", "transform"],
  [".cat-filter:active", "0.97", "transform"],
  [".detail-close:active", "0.94", "transform"],
  [".detail-reopen:active", "0.94", "transform"],
  [".ctx-modal-close:active", "0.94", "transform"],
  [".ctx-donut:active", "0.94", "transform"],
  [".uh-close:active", "0.94", "transform"],
  [".uh-range-btn:active", "0.97", "transform"],
  [".uh-bar-col:active", "0.97", "transform"],
  [".search-clear:active", "0.94", "transform"],
  [".session-list .sl-row:active", "0.97", "transform"],
  ["button.tool.clickable:active", "0.97", "transform"],
  [".selected-ribbon .selected-close:active", "0.94", "transform"],
  // The × is a span inside the ribbon's own button, and `:active` is set on
  // every ancestor of what was pressed — without the guard, clearing the
  // selection would shrink the whole ribbon as if the view were being fitted.
  [".selected-ribbon:active:not(:has(.selected-close:active))", "0.97", "transform"],
  [".ver-banner .ver-cmd:active", "0.97", "transform"],
  [".ver-banner .ver-auto:active", "0.97", "transform"],
  [".ver-banner .ver-act:active:not(:disabled)", "0.97", "transform"],
  [".ver-banner .ver-close:active", "0.94", "transform"],
  [".tool-burst.clickable:active", "0.97", "scale"],
];

/** What the press declaration has to read, given the property carrying it. */
const pressed = ([, scale, prop]: Press) => (prop === "transform" ? `scale(${scale})` : scale);

/** The control a press belongs to — the selector without its `:active…` tail. */
const owner = (sel: string) => sel.replace(/:active.*$/, "");

/** Controls that say `cursor: pointer` and deliberately stay out of the
 *  convention. Empty on purpose: an exception has to be written down here, with
 *  a reason, rather than being the silent default it was until #355. */
const EXEMPT: string[] = [];

describe("press feedback is one convention, applied everywhere", () => {
  it("gives every one of these controls something to give back on press", () => {
    const missing = PRESSES.filter(p =>
      !all.some(r => !r.reduced && selectors(r).includes(p[0]) && decl(r.body, p[2]) === pressed(p)));
    expect(missing.map(([sel]) => sel)).toEqual([]);
  });

  it("eases the press on the control itself, so it grows back rather than jumps", () => {
    const unEased = PRESSES.filter(([sel, , prop]) =>
      !all.some(r => !r.reduced && selectors(r).includes(owner(sel)) && transitioned(r.body).includes(prop)));
    expect(unEased.map(([sel]) => sel)).toEqual([]);
  });

  it("puts the press after the hover wherever the two tie on specificity", () => {
    // `.ctx-donut:hover` scales to 1.08 and a press is always a hover as well,
    // so nothing but source order decides which of the two the pointer sees.
    const at = (sel: string) => all.find(r => !r.reduced && selectors(r).includes(sel))?.at ?? -1;
    for (const sel of [".ctx-donut", ".tool-burst.clickable"]) {
      const hover = at(`${sel}:hover`);
      expect(hover, `${sel}:hover`).toBeGreaterThan(-1);
      expect(at(`${sel}:active`), sel).toBeGreaterThan(hover);
    }
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
    const loud = PRESSES.filter(([sel, , prop]) =>
      !(answers.get(sel) ?? []).some(r => decl(r.body, prop) === "none"));
    expect(loud.map(([sel]) => sel)).toEqual([]);
  });

  it("holds the list to every control the sheet itself calls pressable", () => {
    const pressable = new Set<string>();
    for (const rule of all) {
      if (decl(rule.body, "cursor") !== "pointer") continue;
      for (const sel of selectors(rule)) pressable.add(sel);
    }
    // If a rename ever slips the controls out of this sweep, this collapses
    // before the two comparisons below can pass by finding nothing.
    expect(pressable.size).toBeGreaterThan(25);
    const owners = new Set(PRESSES.map(([sel]) => owner(sel)));
    expect([...pressable].filter(s => !owners.has(s) && !EXEMPT.includes(s)).sort()).toEqual([]);
    // And the other way: nothing enumerated has quietly stopped being a control.
    expect([...owners].filter(s => !pressable.has(s)).sort()).toEqual([]);
  });
});

/** Every non-reduced rule that runs the `pulse` keyframes. The name is matched
 *  as a whole token so `--pulse-live` in a value is not mistaken for it. */
const pulsing = all.filter(r => {
  if (r.reduced) return false;
  const value = decl(r.body, "animation");
  return value != null && splitTop(value).some(part => part.split(/\s+/).includes("pulse"));
});

/** The bodies that decide what colour a pulsing rule paints: its own, plus the
 *  rule it is a `::before` of — `.detail … .status-dot.inflight` carries the
 *  `--inflight` its pseudo-element inherits through `currentColor`. */
const paints = (rule: Rule): string =>
  [rule, ...all.filter(r => !r.reduced && r.selector === rule.selector.replace(/::before$/, ""))]
    .map(r => r.body).join(";");

/** "This is running right now" is the --inflight token, so membership in the
 *  live family is read off the token rather than off a list of selectors. A dot
 *  that paints itself in flight joins the family whether or not anyone adds it
 *  here, and then has to keep its tempo. */
const live = pulsing.filter(r => /--inflight/.test(paints(r)));
const otherPulses = pulsing.filter(r => !live.includes(r));

/** The five rules that say a tool or a session is in flight. `.state-pill` and
 *  `.sl-dot` are the same `agent.state` rendered on the node and in the sidebar;
 *  the other three are the same tool `inflight` rendered on the bubble, in the
 *  detail panel and in the modal title. For one active session most of them are
 *  on screen at once, which is why they share a beat. */
const LIVE_PULSE = [
  ".state-pill.state-active::before",
  ".sl-dot.state-active::before",
  ".tool-burst .tb-spin",
  ".detail .tool .name .status-dot.inflight::before",
  ".modal-title .status-dot.inflight",
];

/** The pulses that are NOT that signal, each with the question it answers. They
 *  keep their own rates on purpose: collapsing them would say the version you
 *  are running, the health of the event stream and a tool in flight are one
 *  fact. A new pulse fails this suite until it is either in the family above or
 *  written down here with a reason. */
const OTHER_PULSES: [selector: string, meaning: string][] = [
  [".topbar .brand button.v .v-dot", "--warn: a newer ccdeck is published"],
  [".ver-banner .ver-dot", "--warn: you are running a stale version"],
  [".topbar .status .pill.live::before", "--ok: the event stream is connected"],
  [".conn-banner .conn-dot", "--err: the event stream is down"],
];

/** The two live pulses that live on the canvas, and so are switched off by the
 *  canvas block like everything else there. The other three are single dots in
 *  panels and keep pulsing — see the note at the foot of the sheet, and
 *  state-channels.test.ts, which forbids a state mark from depending on it. */
const LIVE_ON_CANVAS = [".state-pill.state-active::before", ".tool-burst .tb-spin"];

describe("one tempo for one meaning: the live pulse", () => {
  it("sweeps the pulses the sheet actually has, so a pass means something", () => {
    expect(pulsing.map(r => r.selector).sort())
      .toEqual([...LIVE_PULSE, ...OTHER_PULSES.map(([sel]) => sel)].sort());
  });

  it("puts every --inflight pulse in the live family and nothing else", () => {
    // Derived from the token, compared against the enumeration: a new dot that
    // paints --inflight fails here until it is written down, and one that stops
    // painting it fails here until it is taken out.
    expect(live.map(r => r.selector).sort()).toEqual([...LIVE_PULSE].sort());
    expect(otherPulses.map(r => r.selector).sort()).toEqual(OTHER_PULSES.map(([sel]) => sel).sort());
  });

  it("beats all five of them on one token, with no duration written twice", () => {
    for (const rule of live) {
      expect(decl(rule.body, "animation"), rule.selector).toBe("pulse var(--pulse-live) infinite");
    }
  });

  it("declares that token once, at :root, outside any theme", () => {
    const declared = all.filter(r => !r.reduced && decl(r.body, "--pulse-live") != null);
    expect(declared.map(r => r.selector)).toEqual([":root"]);
    // Symmetric keyframes take the symmetric curve; the default `ease` is
    // front-loaded and made the breathe lopsided.
    expect(decl(declared[0].body, "--pulse-live")).toBe("1.2s ease-in-out");
  });

  it("leaves the four that answer a different question alone", () => {
    // Two --warn, one --ok, one --err. None of them may quietly adopt the live
    // token: that would say a stale version and a running tool are one fact.
    for (const [sel, meaning] of OTHER_PULSES) {
      const rule = pulsing.find(r => r.selector === sel)!;
      const value = decl(rule.body, "animation")!;
      expect(value, `${sel} — ${meaning}`).not.toContain("--pulse-live");
      expect(value, `${sel} — ${meaning}`).toMatch(/^pulse \d/);
    }
  });

  it("earns its reduced-motion exemption on the keyframes, not on a promise", () => {
    // The panel dots keep pulsing under reduced motion because `pulse` changes
    // opacity and nothing else, and a fade is the recommended answer rather than
    // the thing being escaped. The moment it moves anything, that stops holding.
    const body = /@keyframes pulse\s*\{([\s\S]*?)\n\}/.exec(css)![1];
    expect([...body.matchAll(/([\w-]+)\s*:/g)].map(m => m[1])).toEqual(["opacity", "opacity"]);
    // And nothing half-neutralises it by rewriting the tempo behind the query.
    expect(all.filter(r => r.reduced && decl(r.body, "--pulse-live") != null)).toEqual([]);
  });

  it("keeps the canvas half switched off and the panel half pulsing", () => {
    // The split is deliberate and predates this: a dozen bubbles pulsing across
    // the surface the deck is watched on is not one dot in a fixed strip.
    for (const sel of LIVE_ON_CANVAS) {
      expect((answers.get(sel) ?? []).some(r => decl(r.body, "animation") === "none"), sel).toBe(true);
    }
    for (const sel of LIVE_PULSE.filter(s => !LIVE_ON_CANVAS.includes(s))) {
      expect(answers.get(sel) ?? [], sel).toEqual([]);
    }
  });
});

/** A centred dialog over a dimmed backdrop, by the shape it is laid out in
 *  rather than by its name — fixed to the viewport, filling it, centring its one
 *  child on both axes. A fourth dialog written this way joins the sweep on its
 *  own and has to answer for its entrance. */
const isBackdrop = (rule: Rule) =>
  decl(rule.body, "position") === "fixed" && decl(rule.body, "inset") === "0" &&
  decl(rule.body, "align-items") === "center" && decl(rule.body, "justify-content") === "center";

const backdrops = all.filter(r => !r.reduced && isBackdrop(r));

/** backdrop → the panel it centres. All three are reached from this canvas
 *  through one useModalDismiss and dismissed by one Escape key, so they are one
 *  interaction and get one arrival. */
const DIALOGS: [backdrop: string, panel: string][] = [
  [".modal-backdrop", ".modal"],
  [".ctx-modal-backdrop", ".ctx-modal"],
  [".uh-backdrop", ".uh-modal"],
];

describe("one entrance for one interaction: the modal", () => {
  it("finds every centred dialog in the sheet, not only the ones listed", () => {
    expect(backdrops.map(r => r.selector).sort()).toEqual(DIALOGS.map(([b]) => b).sort());
  });

  it("dims behind all three of them the same way", () => {
    for (const [backdrop] of DIALOGS) {
      const rule = all.find(r => !r.reduced && r.selector === backdrop)!;
      expect(decl(rule.body, "animation"), backdrop).toBe("fadeIn 140ms ease-out");
    }
  });

  it("brings all three panels in the same way, over that dim", () => {
    // popIn's transform-origin stays centre: a modal is the documented exception
    // to origin-awareness, and nothing in this UI is anchored to its trigger.
    for (const [, panel] of DIALOGS) {
      const rule = all.find(r => !r.reduced && r.selector === panel)!;
      expect(decl(rule.body, "animation"), panel).toBe("popIn 180ms cubic-bezier(0.22,1,0.36,1)");
    }
    expect(/@keyframes popIn\b[^}]*\}/.exec(css)![0]).toMatch(/transform\s*:/);
  });

  it("collapses all three to the backdrop's own fade under reduced motion", () => {
    // popIn lifts 4px and scales, over whatever the reader was looking at, so
    // each panel is answered — by its own selector, since a media query adds no
    // specificity and one dialog's rule does not reach another's.
    for (const [, panel] of DIALOGS) {
      const answer = (answers.get(panel) ?? []).at(-1);
      expect(answer, panel).toBeDefined();
      expect(decl(answer!.body, "animation"), panel).toBe("fadeIn 140ms ease-out");
      expect(answer!.at, panel).toBeGreaterThan(all.find(r => !r.reduced && r.selector === panel)!.at);
    }
  });
});
