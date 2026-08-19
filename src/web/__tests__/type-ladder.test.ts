// #379: three token-level drifts in styles.css, none of which broke anything
// and all of which cost the panels their hierarchy.
//
//   1. One tier order inverted. `.ap-lane-label` is the reading key for an
//      accounts row — "5h", "7d", the model name — and `.ap-lane-reset` is the
//      footnote under it saying when the window rolls over. The label was
//      painted --text-dim and the footnote --muted, and --text-dim is the WEAKER
//      of the two by construction, so on white the 9px footnote read at 7.87:1
//      against the 10px name's 5.78:1: 36% stronger than the line it belongs to.
//      In dark the two tokens share a value, so the intended step did not exist
//      there at all and 10px against 9px was the only separation left.
//   2. Six rules dimming "this is inactive" at 0.5, 0.55 and 0.45 against eight
//      at 0.6 and a comment on `.ap-manage-btn:disabled` naming 0.6 as the
//      idiom. Two disabled buttons inside one modal — `.uh-reload` at 0.5 and
//      any `.btn` at 0.6 — dimmed by different amounts, which reads as one of
//      them being more broken than the other.
//   3. Eighteen distinct font sizes, eight of them inside the 3.5px band from 9
//      to 12.5 where the step ratio is 1.042 to 1.056. Nobody resolves a 5%
//      difference as rank, so those sizes had stopped encoding one.
//
// Two of the report's own numbers did not survive being measured again, and
// both are pinned below as what they actually are. Its opacity table lists
// `.cat-filter.off` at 0.38 — #368 deleted that declaration outright, so the
// divergence it names is already gone. And its usage-panel census quotes
// "`.qb-label` (11px)" beside `.up-k` (10px) as two spellings of one job:
// `.qb-label` has no font-size at all, only a colour, and renders at 11px by
// inheriting `.qb-meta`. Same conclusion about `.up-k`, one fewer declaration.
//
// The third fix is also narrower than the report asked for, on purpose. It
// wanted a six-step 10/12/14/18/26/34 ladder, which retires 11px (the sheet's
// most-used size, 42 declarations) and 13px as well. Those are 9% and 8% steps
// and they are load-bearing — `.agent-node` is 12px and its `.meta`, `.sub` and
// `.time` are 11px, which is the node's own body-to-secondary hierarchy — so
// collapsing them is a redesign rather than the removal of drift. What collapsed
// is every value within 7% of a neighbour, which is exactly the set that could
// not have been ranking anything.
//
// This suite runs in plain node — no DOM, no jsdom, no layout engine — so like
// quiet-signals.test.ts and panel-rhythm.test.ts it reads styles.css, parses it,
// and computes. The contrast helpers are re-declared here rather than imported
// from contrast-floors.test.ts: importing a *.test.ts registers its suites into
// this file too.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const rawCss = readFileSync(join(web, "styles.css"), "utf8");

/** Comments quote the values they retired — the ladder note names 9.5 and 10.5
 *  while explaining where they went — so every read below is of stripped text.
 *  Blanking comments in place rather than deleting them keeps line numbers and
 *  therefore keeps any "appears nowhere" assertion honest about what it saw. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));

// ── the stylesheet, as rules ────────────────────────────────────────────────

type Rule = { selector: string; body: string; nested: boolean };

/** Every declaration block in the sheet, including the ones inside @media, with
 *  the at-rule ones flagged. A rule inside `@media (prefers-reduced-motion)` is
 *  a different cascade and the ladder still applies to it. */
function rules(src: string): Rule[] {
  const out: Rule[] = [];
  const stack: Array<{ prelude: string; start: number }> = [];
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { stack.push({ prelude: buf.trim(), start: i + 1 }); buf = ""; continue; }
    if (ch === "}") {
      const f = stack.pop();
      if (f) {
        const body = src.slice(f.start, i);
        if (!f.prelude.startsWith("@") && !/[{}]/.test(body)) {
          out.push({
            selector: f.prelude.replace(/\s+/g, " ").trim(),
            body,
            nested: stack.some(s => s.prelude.startsWith("@")),
          });
        }
      }
      buf = "";
      continue;
    }
    buf += ch;
  }
  return out;
}

const RULES = rules(css);

/** The last declaration of `prop` in a body, which is the one that applies. */
function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

/** Every rule naming this exact selector, concatenated in source order. */
function decl(selector: string, prop: string): string | null {
  const bodies = RULES
    .filter(r => r.selector.split(",").some(s => s.replace(/\s+/g, " ").trim() === selector))
    .map(r => r.body);
  return bodies.length ? declIn(bodies.join(";"), prop) : null;
}

/** Every font-size declaration in the sheet, one row per comma-separated
 *  selector so that a shared rule is counted once per selector it applies to. */
type FontSize = { selector: string; value: string; px: number };
const FONT_SIZES: FontSize[] = RULES.flatMap(r => {
  const v = declIn(r.body, "font-size");
  if (!v) return [];
  return r.selector.split(",").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean)
    .map(selector => ({ selector, value: v, px: parseFloat(v) }));
});

// ── §3, the ladder ──────────────────────────────────────────────────────────

/** The closed set. Eleven steps, declared in styles.css beside the tokens and
 *  asserted here; there is deliberately no --fs-* token behind any of them,
 *  because no two rules in this sheet have to change size together and a token
 *  that says they do would be worse than the literals it replaced. */
const LADDER = [9, 10, 11, 12, 13, 14, 16, 18, 22, 26, 34];

/** The resolution floor the report measured and this issue acts on: a step
 *  smaller than this is not a rank, it is two spellings of one size. */
const RESOLVABLE = 1.07;

describe("the type ladder is a closed set (#379 §3)", () => {
  it("sets every font-size in the sheet to a step on the ladder", () => {
    const off = FONT_SIZES.filter(f => !LADDER.includes(f.px));
    expect(off.map(f => `${f.selector} → ${f.value}`)).toEqual([]);
  });

  it("writes every one of them in px, so the ladder cannot be dodged by a unit", () => {
    // An em or a rem would be a size the ladder cannot see: it resolves against
    // whatever the ancestor happens to be, which is exactly how the session
    // list's caption ended up at the UA sheet's 1.17em before #381.
    for (const f of FONT_SIZES) expect(f.value, f.selector).toMatch(/^\d+px$/);
  });

  it("uses no more than eleven distinct sizes, down from the eighteen counted", () => {
    const distinct = [...new Set(FONT_SIZES.map(f => f.px))].sort((a, b) => a - b);
    expect(distinct).toEqual(LADDER);
    expect(distinct.length).toBeLessThanOrEqual(11);
  });

  it("leaves no two steps closer together than a reader can resolve", () => {
    // Derived rather than restated: whatever the ladder is, no adjacent pair on
    // it may be inside the 7% that #379 measured as unresolvable. This is the
    // invariant the eight sizes in the 9-12.5 band were breaking, and it is what
    // stops a twelfth step being added at 10.5 next year.
    for (let i = 1; i < LADDER.length; i++) {
      const ratio = LADDER[i] / LADDER[i - 1];
      expect(ratio, `${LADDER[i - 1]}px → ${LADDER[i]}px`).toBeGreaterThanOrEqual(RESOLVABLE);
    }
  });

  it("keeps the four half-steps and the sub-floor 8px out of the sheet entirely", () => {
    // Read off the stripped source, because the ladder note in styles.css names
    // all five while explaining where they went — an "appears nowhere" assertion
    // against the raw file would only ever be measuring that comment.
    for (const gone of ["8px", "9.5px", "10.5px", "11.5px", "12.5px"]) {
      expect(css, `${gone} still declared`).not.toMatch(
        new RegExp(`font-size:\\s*${gone.replace(".", "\\.")}`),
      );
    }
    // …and the comment really does still name them, so the strip above is doing
    // work rather than passing on an empty file.
    for (const gone of ["9.5", "10.5", "11.5", "12.5"]) expect(rawCss).toContain(gone);
  });

  it("still finds the rules the collapse moved, so a pass is not vacuous", () => {
    // The four rules the report singled out, at the values they landed on.
    expect(decl(".ap-email", "font-size")).toBe("10px");            // was 10.5
    expect(decl(".detail .row .v", "font-size")).toBe("11px");      // was 11.5
    expect(decl(".session-list .sl-label", "font-size")).toBe("12px"); // was 12.5
    expect(decl(".uh-stat-label", "font-size")).toBe("9px");        // was 9.5
    expect(decl(".uh-bar-label", "font-size")).toBe("9px");         // was 8
    expect(decl(".ctx-modal-title", "font-size")).toBe("14px");     // was 15
    expect(decl(".detail-hero .hero-title", "font-size")).toBe("18px"); // was 17
    expect(FONT_SIZES.length).toBeGreaterThan(150);
  });

  it("keeps the steps that are doing real work", () => {
    // The report wanted 11px and 13px retired too. They are not drift: the
    // node's body-to-secondary hierarchy is exactly this pair of sizes, and a
    // 9% step is above the floor asserted above.
    expect(decl(".agent-node", "font-size")).toBe("12px");
    expect(decl(".agent-node .meta", "font-size")).toBe("11px");
    expect(decl(".agent-node .sub", "font-size")).toBe("11px");
    expect(11 / 10).toBeGreaterThan(RESOLVABLE);
    expect(12 / 11).toBeGreaterThan(RESOLVABLE);
    // And the three big money numbers stay three sizes apart, on three surfaces
    // of very different size.
    expect(decl(".detail-hero .hero-cost-value", "font-size")).toBe("22px");
    expect(decl(".up-total-value", "font-size")).toBe("26px");
    expect(decl(".session-summary .ss-cost", "font-size")).toBe("34px");
  });
});

// ── §3b, the sizes that never rendered ──────────────────────────────────────

/** (b, c) of a selector — classes and pseudo-classes against elements. There is
 *  not one id selector in this sheet, so the a column never moves. */
function specificity(selector: string): [number, number] {
  const b = (selector.match(/\.[a-zA-Z0-9_-]+/g) || []).length
    + (selector.match(/:(?!:)[a-z-]+(\([^)]*\))?/g) || []).length
    + (selector.match(/\[[^\]]*\]/g) || []).length;
  const c = (selector.replace(/\.[a-zA-Z0-9_-]+/g, " ").replace(/:{1,2}[a-z-]+(\([^)]*\))?/g, " ")
    .match(/\b[a-z][a-z0-9]*\b/g) || []).length
    + (selector.match(/::[a-z-]+/g) || []).length;
  return [b, c];
}

const higher = (x: [number, number], y: [number, number]) =>
  x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1];

/** Every className the app renders, as a set of class names. */
function renderedClassSets(): string[][] {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); }
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  })(web);
  const sets = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const set = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, " ").split(/\s+/)
        .filter(c => /^[a-zA-Z][\w-]*$/.test(c));
      if (set.length) sets.set([...set].sort().join(" "), set);
    }
  }
  return [...sets.values()];
}

const CLASS_SETS = renderedClassSets();

/** Does this selector's rightmost compound match an element carrying `set`? */
function hitsLastCompound(selector: string, set: string[]): boolean {
  const last = selector.split(/\s+|>|\+|~/).filter(Boolean).pop()!;
  if (/:(?!:)(hover|focus|active|disabled|checked|empty|not|has|first|last|nth|placeholder|within|visible|target)/.test(last)) return false;
  const classes = (last.match(/\.[a-zA-Z0-9_-]+/g) || []).map(c => c.slice(1));
  return classes.length > 0 && classes.every(c => set.includes(c));
}

/** A selector with no combinator — it constrains only the element itself, so it
 *  applies to every element carrying its classes with no ancestor to check. */
const singleCompound = (selector: string) => !/[\s>+~]/.test(selector.trim());

describe("no font-size is declared where a shared rule outranks it (#379, #380)", () => {
  /** For each rendered class set, the font-size rules that reach the element and
   *  lose on specificity to a same-element rule declaring something else. */
  function deadOverrides() {
    const dead: string[] = [];
    for (const set of CLASS_SETS) {
      const reaching = FONT_SIZES.filter(f => hitsLastCompound(f.selector, set));
      const sameElement = reaching.filter(f => singleCompound(f.selector));
      if (!sameElement.length) continue;
      const winner = sameElement.reduce((a, b) =>
        higher(specificity(b.selector), specificity(a.selector)) ? b : a);
      const classesOf = (s: string) => (s.match(/\.[a-zA-Z0-9_-]+/g) || []).map(c => c.slice(1));
      for (const f of reaching) {
        if (f === winner) continue;
        if (!higher(specificity(winner.selector), specificity(f.selector))) continue;
        if (f.value === winner.value) continue;
        // `button.btn` losing to `button.btn.icon-btn` is the cascade working:
        // the winner names every class the loser does and one more, which is
        // what a deliberate variant looks like. Drift looks like the opposite —
        // two unrelated class names competing, where whichever happens to carry
        // an element name wins and the author of the other never finds out.
        if (classesOf(f.selector).every(c => classesOf(winner.selector).includes(c))) continue;
        dead.push(`${f.selector} declares ${f.value} but ${winner.selector} renders ${winner.value} on class="${set.join(" ")}"`);
      }
    }
    return [...new Set(dead)];
  }

  it("leaves none of them in the sheet", () => {
    // #380 found five — `.ap-refresh`, `.ap-switch`, `.ap-add`, `.up-close` and
    // `.sl-close` — by naming the selectors it had noticed. Sweeping the same
    // arithmetic over every className the app renders finds two more that carry
    // a font-size, `.uh-reload` (13px under `button.btn.icon-btn`'s 14px) and
    // `.up-refresh-btn` (14px under `button.btn`'s 12px). All seven declarations
    // are deleted rather than promoted: they had never rendered, so making one
    // win for the first time would change the picture, which is a design change
    // wearing a cleanup's clothes.
    expect(deadOverrides()).toEqual([]);
  });

  it("still sees the collision that made them dead, so the sweep is not vacuous", () => {
    // The two shared rules are still there and still outrank a bare class.
    expect(decl("button.btn", "font-size")).toBe("12px");
    expect(decl("button.btn.icon-btn", "font-size")).toBe("14px");
    expect(higher(specificity("button.btn"), specificity(".ap-refresh"))).toBe(true);
    expect(higher(specificity("button.btn.icon-btn"), specificity(".session-list .sl-close"))).toBe(true);
    // And the class sets really were read out of the components.
    expect(CLASS_SETS.some(s => s.includes("btn") && s.includes("icon-btn"))).toBe(true);
    expect(CLASS_SETS.length).toBeGreaterThan(50);
  });

  it("keeps the one per-button override that does out-rank the shared rule", () => {
    // `.detail-hero .hero-action-btn` is (0,2,0) against `button.btn`'s (0,1,1),
    // so its 11px renders. It is not dead and must not be swept up with the
    // seven that were.
    expect(decl(".detail-hero .hero-action-btn", "font-size")).toBe("11px");
    expect(higher(specificity(".detail-hero .hero-action-btn"), specificity("button.btn"))).toBe(true);
  });

  it("removed the seven font sizes without removing the rules around them", () => {
    // Each of these rules still exists and still carries the geometry that was
    // always doing the work; only the never-rendered font-size is gone. Deleting
    // the whole rule would have been #383's sweep, not this one's.
    expect(decl(".ap-refresh", "font-size")).toBeNull();
    expect(decl(".ap-refresh", "padding")).toBe("1px 6px");
    expect(decl(".ap-switch", "font-size")).toBeNull();
    expect(decl(".ap-switch", "flex-shrink")).toBe("0");
    expect(decl(".ap-add", "font-size")).toBeNull();
    // The colour is gone rather than dead. It was pinned here as the surviving
    // declaration when the font-size went, but it never rendered either:
    // `.ap-add` is (0,1,0) against `button.btn { color: var(--text) }` at
    // (0,1,1). The button is bare now and takes `.glyph-btn`'s `--muted`, which
    // is what its two neighbours have always used — so what is pinned is that
    // nothing here re-declares a colour and reopens that fight from the side the
    // class can actually win.
    expect(decl(".ap-add", "color")).toBeNull();
    expect(decl(".ap-add", "margin-right")).toBe("6px");
    expect(decl(".up-close", "font-size")).toBeNull();
    expect(decl(".up-close", "color")).toBe("var(--muted)");
    expect(decl(".session-list .sl-close", "font-size")).toBeNull();
    expect(decl(".session-list .sl-close", "width")).toBe("26px");
    expect(decl(".uh-reload", "font-size")).toBeNull();
    expect(decl(".uh-reload", "padding")).toBe("0");
    expect(decl(".up-refresh-btn", "font-size")).toBeNull();
    expect(decl(".up-refresh-btn", "padding")).toBe("1px 7px");
  });
});

// ── §2, the two dimmings ────────────────────────────────────────────────────

/** Every rule that dims because a control cannot be operated or because what it
 *  shows is out of date — the two idioms #379 separated. A `:disabled` rule is
 *  the attribute spelling; `.ap-account.disabled` and `.v.checking` are the two
 *  class spellings of the same thing. */
const INACTIVE = /:disabled|\.ap-account\.disabled|button\.v\.checking/;

/** …but not the rules that fire only when the control is NOT inactive. The
 *  sheet spells hover-while-enabled as `:hover:not(:disabled)`, which mentions
 *  `:disabled` while meaning its opposite. */
const NOT_INACTIVE = /:not\(:disabled\)|:hover|:focus|:active/;

describe("one token per dimming decision, and two decisions (#379 §2)", () => {
  const opacities = RULES.flatMap(r => {
    const v = declIn(r.body, "opacity");
    return v === null ? [] : [{ selector: r.selector, value: v }];
  });

  it("declares both tokens once, at the values the sheet already argued for", () => {
    expect(decl(":root", "--dim-off")).toBe("0.6");
    expect(decl(":root", "--dim-stale")).toBe("0.45");
  });

  it("dims every inactive control through --dim-off and nothing through a literal", () => {
    // The report's headline: two disabled buttons in one modal, 0.5 and 0.6,
    // with nothing different to say. Every one of them reads the token now.
    const inactive = opacities.filter(o =>
      INACTIVE.test(o.selector) && !NOT_INACTIVE.test(o.selector));
    expect(inactive.length).toBeGreaterThanOrEqual(12);
    for (const o of inactive) expect(o.value, o.selector).toBe("var(--dim-off)");
    // No `:disabled` rule anywhere still writes one of the four literals the
    // report found, which is the assertion that would have caught this drift.
    for (const o of opacities) {
      if (!INACTIVE.test(o.selector) || NOT_INACTIVE.test(o.selector)) continue;
      expect(o.value, o.selector).not.toMatch(/^0\.\d+$/);
    }
  });

  it("names the two superseded surfaces apart, so they stay free to differ", () => {
    // `.uh-stale` and `.ap-share.expired` are not "you cannot use this", they
    // are "this is a refresh out of date" — still readable, still true a moment
    // ago. Folding them into --dim-off would make a later decision about
    // disabled controls silently restate itself about stale data.
    expect(decl(".uh-stale", "opacity")).toBe("var(--dim-stale)");
    expect(decl(".ap-share.expired .ap-share-blob", "opacity")).toBe("var(--dim-stale)");
    expect(decl(":root", "--dim-stale")).not.toBe(decl(":root", "--dim-off"));
  });

  it("leaves the report's 0.38 alone, because #368 already deleted it", () => {
    // The opacity table lists `.cat-filter.off { opacity: 0.38 }`. It is not
    // there to fix: #368 dropped the fade entirely and carries "off" on the
    // colour tier, a greyed emoji and #370's strike-through instead.
    expect(decl(".cat-filter.off", "opacity")).toBeNull();
    expect(decl(".cat-filter.off", "color")).toBe("var(--muted)");
    expect(css).not.toMatch(/opacity:\s*0\.38/);
  });

  it("does NOT reach the opacities that only happen to be the same number", () => {
    // `.ap-failure-x` rests at 0.6 and lifts to 1 under the pointer, which is a
    // quiet affordance rather than a dead control; the search dim has its own
    // ladder; the rest is decoration with no state at all. Equal numbers, three
    // different decisions — a token over them would be worse than the literals.
    for (const sel of [".ap-failure-x", ".tool-burst.dim:hover"]) {
      expect(decl(sel, "opacity"), sel).toBe("0.6");
    }
    expect(decl(".ap-dot", "opacity")).toBe("0.55");
    expect(decl(".ap-field::after", "opacity")).toBe("0.5");
    expect(decl(".aa-mark-ring", "opacity")).toBe("0.45");
    expect(decl(".agent-node .accent-stripe", "opacity")).toBe("0.7");
  });

  it("made every control it touched lighter-dimmed than it was, never darker", () => {
    // 1.4.3 and 1.4.11 both exempt a disabled control, so the floor here is not
    // a WCAG one — a dimmed label is meant to be hard to read, that is the
    // message. What has to hold is that consolidating on 0.6 was a one-way
    // move: every literal it replaced was 0.6 or less, so no control anywhere
    // got quieter than it already was. That is the whole safety argument for
    // touching fourteen rules at once, and it is arithmetic, not judgement.
    const OFF = parseFloat(decl(":root", "--dim-off")!);
    for (const replaced of [0.5, 0.55, 0.6]) expect(OFF).toBeGreaterThanOrEqual(replaced);
    // Which means strictly more contrast than the worst of them, on every bed.
    for (const theme of ["dark", "light"] as const) {
      const bed = rgb(TOKENS[theme]["--panel"]);
      const before = contrastRatio(over([...rgb(TOKENS[theme]["--muted"]), 0.5], bed), bed);
      const after = contrastRatio(over([...rgb(TOKENS[theme]["--muted"]), OFF], bed), bed);
      expect(after, `${theme} dimmed --muted on --panel`).toBeGreaterThan(before);
    }
    // And --dim-stale stays the quieter of the two, which is what makes it a
    // separate decision rather than a second opinion about the same one.
    expect(parseFloat(decl(":root", "--dim-stale")!)).toBeLessThan(OFF);
  });
});

// ── §1, the inverted hierarchy ──────────────────────────────────────────────

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, c => c + c) : h;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function over(fg: [number, number, number, number], bg: Rgb): Rgb {
  return [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])) as Rgb;
}

function relativeLuminance(c: Rgb): number {
  const [r, g, b] = c.map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The two palette blocks, read out of the sheet rather than transcribed. */
function palette(block: string): Record<string, string> {
  const i = css.indexOf(block);
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const TOKENS = {
  dark: palette(':root[data-theme="dark"]'),
  light: palette(':root[data-theme="light"]'),
};

describe("the accounts lane reads its name before its footnote (#379 §1)", () => {
  it("reproduces the inversion the report measured, so the fix has a baseline", () => {
    // The values the report quoted, recomputed against the bed the lane is
    // actually painted on — `.accounts-panel` is --panel and `.ap-account` adds
    // no background unless it is the active row. Both numbers come out exactly
    // as reported, which is the one census in this issue that did survive.
    const dark = TOKENS.dark;
    const light = TOKENS.light;
    expect(contrastRatio(rgb(dark["--text-dim"]), rgb(dark["--panel"]))).toBeCloseTo(4.70, 2);
    expect(contrastRatio(rgb(dark["--muted"]), rgb(dark["--panel"]))).toBeCloseTo(4.70, 2);
    expect(contrastRatio(rgb(light["--text-dim"]), rgb(light["--panel"]))).toBeCloseTo(5.78, 2);
    expect(contrastRatio(rgb(light["--muted"]), rgb(light["--panel"]))).toBeCloseTo(7.87, 2);
    // --text-dim is the weaker tier in light and the same tier in dark. That
    // ordering is what makes §1 a defect rather than a preference.
    expect(TOKENS.dark["--text-dim"]).toBe(TOKENS.dark["--muted"]);
    expect(contrastRatio(rgb(light["--text-dim"]), rgb(light["--panel"])))
      .toBeLessThan(contrastRatio(rgb(light["--muted"]), rgb(light["--panel"])));
  });

  it("never draws the 9px footnote stronger than the 10px name above it", () => {
    const label = decl(".ap-lane-label", "color")!;
    const reset = decl(".ap-lane-reset", "color")!;
    const token = (v: string) => /var\((--[\w-]+)\)/.exec(v)![1];
    for (const theme of ["dark", "light"] as const) {
      const bed = rgb(TOKENS[theme]["--panel"]);
      const l = contrastRatio(rgb(TOKENS[theme][token(label)]), bed);
      const r = contrastRatio(rgb(TOKENS[theme][token(reset)]), bed);
      expect(l, `${theme}: label ${l.toFixed(2)}:1 vs reset ${r.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(r);
    }
  });

  it("holds on the active row too, which is the one the reader is looking at", () => {
    // `.ap-account.active` tints the whole row with 6% --accent, so the lane's
    // bed there is not --panel. The order has to survive that bed as well.
    const tint = /color-mix\(in srgb, var\(--accent\) (\d+)%/.exec(
      decl(".ap-account.active", "background")!,
    )!;
    const pct = parseInt(tint[1], 10) / 100;
    for (const theme of ["dark", "light"] as const) {
      const bed = over([...rgb(TOKENS[theme]["--accent"]), pct], rgb(TOKENS[theme]["--panel"]));
      const l = contrastRatio(rgb(TOKENS[theme][/var\((--[\w-]+)\)/.exec(decl(".ap-lane-label", "color")!)![1]]), bed);
      const r = contrastRatio(rgb(TOKENS[theme][/var\((--[\w-]+)\)/.exec(decl(".ap-lane-reset", "color")!)![1]]), bed);
      expect(l, `${theme} active row`).toBeGreaterThanOrEqual(r);
    }
  });

  it("raised the label rather than lowering the footnote", () => {
    // The swap had two directions available and only one of them makes nothing
    // on the row quieter than it already was. The label takes the stronger tier.
    expect(decl(".ap-lane-label", "color")).toBe("var(--muted)");
    expect(decl(".ap-lane-reset", "color")).toBe("var(--text-dim)");
    // And the size step under it is untouched: the name is still the larger.
    expect(parseFloat(decl(".ap-lane-label", "font-size")!))
      .toBeGreaterThan(parseFloat(decl(".ap-lane-reset", "font-size")!));
  });
});
