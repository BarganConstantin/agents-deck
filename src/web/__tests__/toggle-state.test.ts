// #370: the five icon toggles in the topbar are 30x30 squares that told you
// whether they were on in two channels, both of them hue at nearly the same
// luminance — and four of the five told assistive tech nothing at all.
//
// The visual half, measured against BOTH ends of the topbar gradient rather
// than one of them, because a 30px button centred in a 52px bar is read against
// the whole of it:
//
//   channel                              dark            light
//   --accent-dim fill vs the bare bar    1.91 / 1.89     1.39 / 1.37
//   --accent edge vs the --ctl-edge it   2.65 / 2.74     1.67 / 1.52
//     replaces
//
// Each boundary is fine on its own — 1.4.11 is about a control against its
// surface and --accent clears it at 10.85:1 dark / 5.93:1 light. What none of
// it does is tell the two STATES apart, and in light neither channel reaches
// even 2:1. The report quoted 1.67:1 for the light edge, which is the friendly
// end of the gradient; at the other end it is 1.52:1, and that is the number a
// floor has to be written against.
//
// The semantic half: only the sound button carried aria-pressed. The usage
// panel, accounts panel, session list and usage history reported no state, and
// so did every category filter chip — while their bar claimed role="toolbar",
// an arrow-key contract it does not implement.
//
// The two halves are one fix here. The stylesheet keys the on state off the
// ARIA attribute, so a control cannot look pressed while reporting nothing.
//
// Plain node, no DOM — React cannot be rendered in this suite — so this reads
// styles.css and the markup the way control-edges.test.ts, quiet-signals.test.ts
// and manage-block.test.ts do, and computes every ratio from the sheet's own
// token values. The helpers are re-declared rather than imported from another
// *.test.ts: importing one registers its suites into this file as well.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const cssRaw = readFileSync(join(web, "styles.css"), "utf8");
/** Comments quote the declarations they explain — including the ones this file
 *  asserts are gone — so every read of the sheet goes through the stripped copy. */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

/** A component's markup with its commentary gone, for the same reason: the
 *  comments here argue about `primary` and `role="toolbar"` by name. */
function markup(...path: string[]): string {
  return readFileSync(join(web, ...path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}
const app = markup("App.tsx");
const usagePanel = markup("components", "UsagePanel.tsx");
const accountsPanel = markup("components", "AccountsPanel.tsx");
const sessionList = markup("components", "SessionList.tsx");
const historyModal = markup("components", "UsageHistoryModal.tsx");

/** WCAG 1.4.3 for the glyph, 1.4.11 for the difference between two states. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  if (s === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/** Source-over compositing, non-premultiplied, onto an already-opaque backdrop. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x relative-luminance ratio. Both arguments must already be opaque. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── the stylesheet, as rules ────────────────────────────────────────────────
//
// Selector-list aware, because the rule under test is written as two selectors
// on one rule: a `^selector\s*\{` probe would miss both of them.

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Top-level rules only — a @media body is a different cascade. */
function topLevel(src: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (!prelude.startsWith("@")) out.push({ selector: prelude, body: inner });
    i = end + 1;
  }
  return out;
}

const RULES = topLevel(css);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** Every top-level rule naming this exact selector, in source order. */
function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop`, which is the one that wins. */
function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function rootTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of bodyOf(`:root[data-theme="${theme}"]`).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: rootTokens("dark"), light: rootTokens("light") };

/** var() one level deep, plus the `color-mix(in srgb, X N%, transparent)` form
 *  the control tokens use — which is just X at N% alpha. */
function resolve(value: string, theme: Theme): Rgba {
  const v = value.trim();
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const base = resolve(mix[1], theme);
    return [base[0], base[1], base[2], base[3] * (+mix[2] / 100)];
  }
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  return parseColor(ref ? TOK[theme][ref[1]] : v);
}

/** Both ends of the topbar gradient. A 30px button centred in 52px of it is
 *  read against the darker end as much as the lighter one, so a state delta
 *  that only holds at one of them does not hold. */
function barEnds(theme: Theme): Array<[string, Rgba]> {
  const stops = TOK[theme]["--topbar-grad"].match(/var\(--[\w-]+\)|#[0-9a-f]{3,8}/gi) ?? [];
  return stops.map((s, i) => [i === 0 ? "the topbar's light end" : "the topbar's dark end", resolve(s, theme)]);
}

/** The on state, as the sheet writes it: one rule, two selectors. */
const ON = 'button.btn.icon-btn[aria-pressed="true"]';
const ON_EXPANDED = 'button.btn.icon-btn[aria-expanded="true"]';

describe("the contrast maths, against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#7dd3fc"), parseColor("#7dd3fc"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });
});

describe("what the toggle state used to be worth (#370)", () => {
  // Literals, not tokens: this is the shipped v1.33.151 appearance restated as
  // arithmetic, and a baseline that moved with the palette would not be one.
  const darkEnds = [parseColor("#14161b"), parseColor("#0f1116")];
  const lightEnds = [parseColor("#ffffff"), parseColor("#eef1f6")];
  const darkDim: Rgba = [56, 189, 248, 0x50 / 255];
  const lightDim: Rgba = [3, 105, 161, 0.22];

  it("reproduces the fill delta — an --accent-dim wash on the bar it sits in", () => {
    expect(darkEnds.map(b => +contrastRatio(over(darkDim, b), b).toFixed(2))).toEqual([1.91, 1.89]);
    expect(lightEnds.map(b => +contrastRatio(over(lightDim, b), b).toFixed(2))).toEqual([1.39, 1.37]);
  });

  it("reproduces the edge delta, and corrects the light number the report quoted", () => {
    // --ctl-edge is 50% of --text, so it composites differently at each end;
    // --accent is opaque and does not. The report's 1.67:1 is the white end.
    // The bar's other end is #eef1f6 and the same step is 1.52:1 there.
    const darkEdge = darkEnds.map(b => +contrastRatio(parseColor("#7dd3fc"), over([216, 218, 224, 0.5], b)).toFixed(2));
    const lightEdge = lightEnds.map(b => +contrastRatio(parseColor("#0369a1"), over([13, 17, 23, 0.5], b)).toFixed(2));
    expect(darkEdge).toEqual([2.65, 2.74]);
    expect(lightEdge).toEqual([1.67, 1.52]);
  });

  it("agrees that each boundary was fine on its own — the defect is the difference", () => {
    // 1.4.11 asks a control's edge to clear 3:1 against its surface, and both
    // states always did. Nothing here was a boundary failure.
    expect(contrastRatio(parseColor("#0369a1"), parseColor("#ffffff"))).toBeCloseTo(5.93, 2);
    expect(contrastRatio(over([13, 17, 23, 0.5], parseColor("#ffffff")), parseColor("#ffffff"))).toBeCloseTo(3.55, 2);
  });

  it("shows no wash could have fixed it — in dark the two windows never overlap", () => {
    // The obvious cheaper fix is to deepen --accent-dim until the fill clears
    // 3:1 and keep everything else. It does not exist in dark: the alpha is
    // still short of 3:1 at 0.40 (2.75:1) and by 0.50 it has taken --text down
    // to 3.60:1 on top of it, under AA, and only falls from there. Swept at
    // every hundredth so this is a statement about the whole range and not
    // about two samples. Light is the theme where a wash CAN work — 0.70 is
    // 3.27:1 / 3.04:1 with --text still at 5.79:1 — which would have left the
    // same state drawn two different ways in the two themes, the divergence
    // #332 and #368 both refused. Inverting works in both, so it is one rule.
    const darkEnds = [parseColor("#14161b"), parseColor("#0f1116")];
    const text = parseColor("#d8dae0");
    for (let a = 0; a <= 1.0001; a += 0.01) {
      for (const bed of darkEnds) {
        const fill = over([125, 211, 252, a], bed);
        const legible = contrastRatio(text, fill) >= BODY;
        const visible = contrastRatio(fill, bed) >= NON_TEXT;
        expect(legible && visible, `dark --accent at alpha ${a.toFixed(2)}`).toBe(false);
      }
    }
  });
});

describe("the on state, as the sheet draws it now", () => {
  it("is one rule serving both attributes, so no toggle can be styled and mute", () => {
    const rule = RULES.find(r => selectors(r.selector).includes(ON));
    expect(rule, "no rule keyed on aria-pressed").toBeTruthy();
    expect(selectors(rule!.selector)).toContain(ON_EXPANDED);
  });

  it("stopped painting itself in --accent-dim, which is a wash and not a state", () => {
    expect(decl(ON, "background")).toBe("var(--accent)");
    expect(decl(ON, "background")).not.toMatch(/--accent-dim/);
  });

  it("stands 3:1 or better off the bare bar, at both ends, in both themes", () => {
    for (const theme of themes) {
      const fill = resolve(decl(ON, "background")!, theme);
      for (const [name, bed] of barEnds(theme)) {
        expect(contrastRatio(over(fill, bed), bed), `${theme} on-fill vs ${name}`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("reads its glyph at 4.5:1 on that fill — the state is visible AND the icon legible", () => {
    for (const theme of themes) {
      const fill = over(resolve(decl(ON, "background")!, theme), barEnds(theme)[0][1]);
      const glyph = resolve(decl(ON, "color")!, theme);
      expect(contrastRatio(glyph, fill), `${theme} on-glyph`).toBeGreaterThanOrEqual(BODY);
    }
  });

  it("inverts polarity rather than shifting hue — the channel greyscale cannot flatten", () => {
    // Off is a light glyph on a dark bar in dark theme and a dark glyph on a
    // light bar in light theme. On has to be the other way round in BOTH, or
    // the difference is only a colour again. Sign of the luminance step, which
    // is what a monochrome screen, a photocopy and every CVD all still see.
    for (const theme of themes) {
      const bed = barEnds(theme)[0][1];
      const offGlyph = resolve(decl("button.btn", "color")!, theme);
      const onFill = over(resolve(decl(ON, "background")!, theme), bed);
      const onGlyph = resolve(decl(ON, "color")!, theme);
      const offStep = Math.sign(relativeLuminance(offGlyph) - relativeLuminance(bed));
      const onStep = Math.sign(relativeLuminance(onGlyph) - relativeLuminance(onFill));
      expect(offStep, `${theme} off polarity`).not.toBe(0);
      expect(onStep, `${theme} on polarity`).toBe(-offStep);
    }
  });

  it("keeps the pointer's own feedback, since hover now repaints the fill's own colour", () => {
    // button.btn:hover sets border-color and color to --accent, and on this
    // chip --accent is the background. Without a channel of its own a pressed
    // toggle would answer the pointer with nothing at all.
    const hover = bodyOf(`${ON}:hover`);
    expect(declIn(hover, "box-shadow")).toBe("0 0 0 2px var(--accent-dim)");
    expect(selectors(RULES.find(r => selectors(r.selector).includes(`${ON}:hover`))!.selector))
      .toContain(`${ON_EXPANDED}:hover`);
  });

  it("out-specifies the hover it has to survive", () => {
    // (0,3,1) against (0,2,1). If this ever inverts, hovering a pressed toggle
    // repaints the glyph in the fill's own colour and the icon disappears.
    const specificity = (sel: string): number =>
      (sel.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    expect(specificity(ON)).toBeGreaterThan(specificity("button.btn:hover"));
  });

  it("left .primary alone — it means 'the action to take', not 'this is on'", () => {
    expect(decl("button.btn.primary", "background")).toBe("var(--accent-dim)");
    expect(decl("button.btn.primary", "color")).toBe("var(--text)");
  });
});

describe("what each of the five toggles announces", () => {
  /** The attributes of the <button> whose aria-label is exactly this. */
  function button(label: string): string {
    const at = app.indexOf(`aria-label="${label}"`);
    expect(at, `no button labelled ${label}`).toBeGreaterThan(-1);
    const open = app.lastIndexOf("<button", at);
    return app.slice(open, app.indexOf(">", at) + 1);
  }

  it("gives the three panel toggles aria-expanded, bound to the panel's own state", () => {
    // Disclosures: each shows a region that follows the button in the DOM and
    // takes no focus with it. Not aria-pressed — the button is not a setting
    // that stays on, it reports whether the thing it points at is on screen.
    expect(button("Toggle usage panel")).toMatch(/aria-expanded=\{usagePanelOpen\}/);
    expect(button("Toggle accounts panel")).toMatch(/aria-expanded=\{accountsPanelOpen\}/);
    expect(button("Toggle session list")).toMatch(/aria-expanded=\{sessionListOpen\}/);
  });

  it("points each one at a real element, and only while that element exists", () => {
    // The AccountsPanel ⋯ menu's rule, applied to the panels: an IDREF that
    // resolves to nothing is a dangling pointer, and closed is exactly when
    // there is nothing to point at.
    const pairs: Array<[string, string, string]> = [
      ["Toggle usage panel", "usagePanelOpen", "usage-panel"],
      ["Toggle accounts panel", "accountsPanelOpen", "accounts-panel"],
      ["Toggle session list", "sessionListOpen", "session-list"],
    ];
    for (const [label, state, id] of pairs) {
      expect(button(label), label)
        .toMatch(new RegExp(`aria-controls=\\{${state} \\? "${id}" : undefined\\}`));
    }
    expect(usagePanel).toMatch(/id="usage-panel"/);
    expect(accountsPanel).toMatch(/id="accounts-panel"/);
    expect(sessionList).toMatch(/id="session-list"/);
  });

  it("keeps aria-pressed for the sound button, the only one of the five that is a setting", () => {
    // It installs or removes a Stop hook on disk. Nothing appears when it goes
    // on, so there is no region for aria-expanded to be about.
    // The label names the CLI since #394 — the button is drawn only where
    // Claude Code is, and it is the only turn the sound covers.
    const sound = button("Toggle Claude Code finish sound");
    expect(sound).toMatch(/aria-pressed=\{soundOn\}/);
    expect(sound).not.toMatch(/aria-expanded/);
  });

  it("gives the usage-history button aria-haspopup and no state at all", () => {
    // It opens a modal: role="dialog" aria-modal="true" behind a full-screen
    // scrim, with a focus trap. While it is open the button cannot be clicked
    // or tabbed to and aria-modal has taken the topbar out of the tree, so a
    // `true` no reader can reach is worse than no state — it would be the one
    // value announced only when it is not needed.
    const history = button("Open usage history");
    expect(history).toMatch(/aria-haspopup="dialog"/);
    expect(history).not.toMatch(/aria-pressed|aria-expanded/);
    expect(historyModal).toMatch(/role="dialog" aria-modal="true"/);
    expect(historyModal).toMatch(/useModalDismiss/);
    expect(declIn(bodyOf(".uh-backdrop"), "position")).toBe("fixed");
  });

  it("leaves no toggle showing its state as a class the tree cannot see", () => {
    // `primary` was the whole of the visual state on all five. It is the
    // stylesheet's word for a primary ACTION and the add-account dialog still
    // uses it that way; what it must not do is stand in for "pressed".
    expect(app).not.toMatch(/\bprimary\b/);
    expect(markup("components", "AddAccountDialog.tsx")).toMatch(/className="btn primary"/);
  });
});

describe("the category filter chips, handed over from #368", () => {
  it("reports pressed state, and pressed means the category is showing", () => {
    // The chip's own label is the category name — "edit", not "hide edit" — so
    // pressed has to mean the category is on. `off` is the hidden set.
    expect(app).toMatch(/aria-pressed=\{!off\}/);
  });

  it("dropped role=\"toolbar\" rather than promising arrow keys it does not implement", () => {
    // A toolbar is one tab stop for the whole set with arrows between members.
    // Every chip here is its own tab stop. group keeps the naming, which is
    // what the role was really doing.
    expect(app).not.toMatch(/role="toolbar"/);
    expect(app).toMatch(/role="group"\s*\n\s*aria-label="Filter tools by category"/);
  });

  it("carries `off` in a channel that is not colour", () => {
    expect(decl(".cat-filter.off .cat-name", "text-decoration")).toBe("line-through");
    // The emoji's desaturation is a second one, but it is still a colour
    // channel and an emoji is not always a colourful glyph.
    expect(decl(".cat-filter.off .cat-emoji", "filter")).toMatch(/grayscale/);
  });

  it("needed one — the two colour tiers alone are under 3:1 apart in both themes", () => {
    // This is the measurement that makes the strike load-bearing rather than
    // decoration: --text against --muted, which is the whole of what #368 left.
    for (const theme of themes) {
      const on = resolve(decl(".cat-filter", "color")!, theme);
      const off = resolve(decl(".cat-filter.off", "color")!, theme);
      expect(contrastRatio(on, off), `${theme} on vs off label`).toBeLessThan(NON_TEXT);
    }
  });

  it("did not spend the contrast #368 just bought to get it", () => {
    // The strike is geometry; both tiers stay exactly where that issue put them.
    expect(decl(".cat-filter.off", "color")).toBe("var(--muted)");
    expect(decl(".cat-filter.off:hover", "color")).toBe("var(--text)");
    expect(declIn(bodyOf(".cat-filter.off"), "opacity")).toBeNull();
  });
});
