// #368: five signals drawn quieter than the job they were given, all of them on
// a surface the user reads when something has already gone wrong.
//
//   1. `.cat-filter.off` faded the whole chip to `opacity: 0.38` — 1.72:1 in
//      dark, 1.87:1 on white — and its hover only reached 3.51:1 in dark. Once
//      two categories are hidden, the bar whose entire job is to say what the
//      canvas is not showing could not say which.
//   2. `.qb-pace-marker` is drawn INSIDE the fill whenever the user is in
//      deficit, because deficit means actual > expected. Its --err against the
//      fill is 1.14:1 on --accent, 1.32:1 on --warn and 1.00:1 once the limit
//      is reached and the fill is --err too. The black halo it leaned on is
//      2.12:1 over light's --err.
//   3. `.up-quota-hint code` and `.ver-cmd-hint` inherit a dim foreground
//      budgeted against --panel and then paint --line under it, which spends
//      the whole budget: 4.14:1 / 3.62:1 and 4.14:1, under AA at 10-10.5px.
//      The first is the CLI command that makes the quota section work at all.
//   4. `.tool-spark-bar` idle was --muted-dim at 2.45:1 in dark, and the counts
//      it draws live only in a title — no adjacent number, so 1.4.11's
//      redundancy exception does not reach it.
//   5. `.search input` set `outline: none` at (0,1,1) on a rule that also
//      carries layout, beating the global `:focus-visible` at (0,1,0) on
//      specificity and on source order. `/` focuses that field.
//
// Plain node, no DOM — so this reads styles.css and UsagePanel.tsx the way
// contrast-floors.test.ts, control-edges.test.ts and manage-block.test.ts do
// and computes the ratios from the sheet's own token values. The helpers are
// deliberately re-declared here rather than imported from contrast-floors:
// importing a *.test.ts registers its suites into this file as well.
//
// Three of the numbers the report quoted were measured against --panel where
// the real bed is something else, so the floors below are this file's own
// arithmetic: --muted on the chip bar is 4.80:1 dark / 7.67:1 light (not
// 4.70 / 7.87), and --text on --line is 11.39:1 / 11.86:1 (not 11.34 / 15.5).
// Same conclusions, different beds. The report's suggested `opacity: 0.75`
// floor for the chip is wrong outright and pinned as wrong below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
/** Comments quote declarations while explaining them; strip before reading. */
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const usagePanel = readFileSync(join(web, "components", "UsagePanel.tsx"), "utf8");

/** WCAG 1.4.3 for the words, 1.4.11 for a meter, a boundary or a focus ring. */
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

/** A CSS `opacity` composites the whole element — its words with it — onto the
 *  bed. That is the mechanism behind failures 1 and 4, so it gets a name. */
function faded(fg: Rgba, alpha: number, bed: Rgba): Rgba {
  return over([fg[0], fg[1], fg[2], fg[3] * alpha], bed);
}

/** The declarations of the first rule whose selector starts a line verbatim. */
function rule(selector: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
}

function decl(body: string | null, prop: string): string | null {
  if (body === null) return null;
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "m").exec(body);
  return m ? m[1].trim() : null;
}

const declOf = (selector: string, prop: string) => decl(rule(selector), prop);

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function tokens(theme: Theme): Record<string, string> {
  const head = theme === "dark" ? ":root,\\s*\\n:root\\[data-theme=\"dark\"\\]" : ":root\\[data-theme=\"light\"\\]";
  const block = new RegExp(`${head}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  if (!block) throw new Error(`no ${theme} token block`);
  const out: Record<string, string> = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const TOK: Record<Theme, Record<string, string>> = { dark: tokens("dark"), light: tokens("light") };

/** var() one level deep, plus the color-mix form the control tokens use. */
function resolve(value: string, theme: Theme): Rgba {
  const mix = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)/.exec(value);
  if (mix) {
    const base = resolve(TOK[theme][mix[1]], theme);
    return [base[0], base[1], base[2], +mix[2] / 100];
  }
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return parseColor(v ? TOK[theme][v[1]] : value);
}

const tok = (name: string, theme: Theme) => parseColor(TOK[theme][name]);

/** Both stops of the node gradient — a sparkline bar sits against the lower one
 *  but the row can be scrolled, so the strict reading takes the worst of the two. */
function nodeStops(theme: Theme): Rgba[] {
  return (TOK[theme]["--node-grad"].match(/var\(--[\w-]+\)|#[0-9a-f]{3,6}/gi) ?? [])
    .map(s => resolve(s, theme));
}

describe("the contrast maths, checked against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#fca5a5"), parseColor("#fca5a5"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("reproduces every ratio #368 reported, from the shipped values", () => {
    // The five defects restated as arithmetic, so the floors below have a
    // baseline that does not move when the tokens do.
    const darkBar = over([20, 22, 27, 0.78], parseColor("#0b0c10"));
    const lightBar = over([255, 255, 255, 0.78], parseColor("#eef1f6"));
    // 1 — the off chip, at rest and on hover, in both themes.
    expect(contrastRatio(faded(parseColor("#7e828c"), 0.38, darkBar), darkBar)).toBeCloseTo(1.72, 2);
    expect(contrastRatio(faded(parseColor("#4a5260"), 0.38, lightBar), lightBar)).toBeCloseTo(1.87, 2);
    expect(contrastRatio(faded(parseColor("#7e828c"), 0.8, darkBar), darkBar)).toBeCloseTo(3.51, 2);
    // 2 — the marker on each fill it can land in. The last one is the no-op.
    expect(contrastRatio(parseColor("#fca5a5"), parseColor("#7dd3fc"))).toBeCloseTo(1.14, 2);
    expect(contrastRatio(parseColor("#fca5a5"), parseColor("#fcd34d"))).toBeCloseTo(1.32, 2);
    expect(contrastRatio(parseColor("#b91c1c"), parseColor("#b91c1c"))).toBeCloseTo(1.00, 2);
    // 3 — a dim foreground re-bedded on --line.
    expect(contrastRatio(parseColor("#7e828c"), parseColor("#1f2229"))).toBeCloseTo(4.14, 2);
    expect(contrastRatio(parseColor("#5f6673"), parseColor("#c8cdd6"))).toBeCloseTo(3.62, 2);
    // 4 — the idle sparkline bar on the node's lower stop.
    expect(contrastRatio(parseColor("#50535b"), parseColor("#0f1116"))).toBeCloseTo(2.45, 2);
    expect(contrastRatio(parseColor("#7c8493"), parseColor("#f2f5fa"))).toBeCloseTo(3.44, 2);
    // 5 — what a keyboard user got instead of a ring: a border step and a glow.
    const lightEdge = over([13, 17, 23, 0.5], parseColor("#ffffff"));
    expect(contrastRatio(lightEdge, parseColor("#0369a1"))).toBeCloseTo(1.67, 2);
    expect(contrastRatio(over([3, 105, 161, 0.22], parseColor("#eef1f6")), parseColor("#eef1f6")))
      .toBeCloseTo(1.37, 2);
  });
});

describe("1. the tool-category chip you switched off (#368.1)", () => {
  /** The bar is translucent over the canvas, which is NOT --panel — the report
   *  quoted --panel's numbers. Its own fill is what the chip actually sits on. */
  function chipBar(theme: Theme): Rgba {
    const raw = theme === "light"
      ? declOf(':root[data-theme="light"] .cat-filter-bar', "background")!
      : declOf(".cat-filter-bar", "background")!;
    return over(resolve(raw, theme), tok("--bg", theme));
  }

  it("carries `off` on the colour tier alone — no opacity anywhere on the chip", () => {
    // This is the regression that matters: any alpha at all puts --muted under
    // AA in dark, because it only clears it by 0.30 at full strength.
    expect(declOf(".cat-filter.off", "opacity"), "resting").toBeNull();
    expect(declOf(".cat-filter.off:hover", "opacity"), "hover").toBeNull();
    // And the now-dead property is gone from the chip's transition list.
    expect(declOf(".cat-filter", "transition")).not.toMatch(/opacity/);
  });

  it("reads the off label at 4.5:1 on the bar's own fill, in both themes", () => {
    // Composites whatever `opacity` the rule declares, because that is the
    // mechanism: the fade applied to the chip applied to its label too.
    for (const theme of themes) {
      const bed = chipBar(theme);
      const fg = resolve(declOf(".cat-filter.off", "color")!, theme);
      const alpha = +(declOf(".cat-filter.off", "opacity") ?? 1);
      expect(contrastRatio(faded(fg, alpha, bed), bed), `${theme} off chip`).toBeGreaterThanOrEqual(BODY);
    }
  });

  it("shows there is no opacity that would have worked — 0.9 is still under AA in dark", () => {
    // The report proposed `opacity: 0.75` as the floor. It is 3.23:1.
    const bed = chipBar("dark");
    const fg = resolve(declOf(".cat-filter.off", "color")!, "dark");
    expect(contrastRatio(faded(fg, 0.75, bed), bed)).toBeLessThan(NON_TEXT + 0.3);
    expect(contrastRatio(faded(fg, 0.9, bed), bed)).toBeLessThan(BODY);
    expect(contrastRatio(fg, bed)).toBeGreaterThanOrEqual(BODY);
  });

  it("never lets the pointer take contrast away — off:hover is louder than off", () => {
    for (const theme of themes) {
      const bed = chipBar(theme);
      const rest = contrastRatio(resolve(declOf(".cat-filter.off", "color")!, theme), bed);
      const hover = contrastRatio(resolve(declOf(".cat-filter.off:hover", "color")!, theme), bed);
      expect(hover, `${theme} off:hover vs off`).toBeGreaterThan(rest);
    }
  });

  it("still reads off as the quieter of the two states, and on as fully lit", () => {
    for (const theme of themes) {
      const bed = chipBar(theme);
      const on = contrastRatio(resolve(declOf(".cat-filter", "color")!, theme), bed);
      const off = contrastRatio(resolve(declOf(".cat-filter.off", "color")!, theme), bed);
      expect(on, `${theme} on chip`).toBeGreaterThanOrEqual(BODY);
      expect(off, `${theme} off is quieter`).toBeLessThan(on);
    }
    // The emoji keeps its own desaturation, the second half of "off".
    expect(declOf(".cat-filter.off .cat-emoji", "filter")).toMatch(/grayscale/);
  });
});

describe("2. the quota pace marker (#368.2)", () => {
  // The fill and the marker are coloured in the component, not the sheet, so
  // the token sets come from there — a new state added to either is caught.
  const FILLS = [...(/const\s+color\s*=\s*([^;]+);/.exec(usagePanel)![1])
    .matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]);
  const MARKERS = [...(/className="qb-pace-marker"[\s\S]*?\/>/.exec(usagePanel)![0])
    .matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]);

  it("still draws both ends from the tokens this test knows about", () => {
    expect(new Set(FILLS)).toEqual(new Set(["--err", "--warn", "--accent"]));
    expect(new Set(MARKERS)).toEqual(new Set(["--err", "--ok"]));
  });

  it("separates with the surface, not with black", () => {
    const shadow = declOf(".qb-pace-marker", "box-shadow")!;
    expect(shadow).toBe("0 0 0 1px var(--panel)");
    expect(shadow, "a black halo is invisible on light's --err fill").not.toMatch(/rgba\(0,\s*0,\s*0/);
  });

  it("reads the ring at 3:1 against every fill the marker can land in, both themes", () => {
    // Deficit means actual > expected, so the marker is always inside the fill.
    // The ring has to be a spread of an opaque colour to be a boundary at all:
    // the old value was a 2px BLUR of a half-alpha black, which has no edge to
    // measure and, once composited, was 2.12:1 over light's --err.
    const shadow = declOf(".qb-pace-marker", "box-shadow")!;
    const spread = /^0 0 0 1px (.+)$/.exec(shadow);
    expect(spread, `${shadow} is not a 1px spread of a single colour`).not.toBeNull();
    for (const theme of themes) {
      const ring = resolve(spread![1], theme);
      expect(ring[3], `${theme} ring alpha`).toBe(1);
      for (const fill of FILLS) {
        expect(contrastRatio(ring, tok(fill, theme)), `${theme} ring on ${fill} fill`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("reads the ring at 3:1 against the marker it wraps, and against the empty track", () => {
    for (const theme of themes) {
      const ring = tok("--panel", theme);
      for (const marker of MARKERS) {
        expect(contrastRatio(ring, tok(marker, theme)), `${theme} ring vs ${marker} marker`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
      // Surplus puts the marker outside the fill, on the bare track, where it
      // has to carry itself — the ring is near-invisible on --line by design.
      const track = resolve(declOf(".qb-track", "background")!, theme);
      expect(contrastRatio(tok("--ok", theme), track), `${theme} --ok marker on the track`)
        .toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it("keeps the track clipping the ring, which is what leaves only the two side edges", () => {
    expect(declOf(".qb-track", "overflow")).toBe("hidden");
  });
});

describe("3. the chips that paint --line under a dim foreground (#368.3)", () => {
  /** Every rule in the sheet that beds its own text on --line. A chip that
   *  lifts the bed has to pay for it; this finds the next one that forgets. */
  const bedded = [...css.matchAll(/^([^{}\n][^{}]*)\{([^}]*background:\s*var\(--line\)[^}]*)\}/gm)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(r => decl(r.body, "color") !== null);

  it("finds the chips that do it, including the two #368 measured", () => {
    const names = bedded.map(r => r.selector);
    expect(names).toContain(".up-quota-hint code");
    expect(names).toContain(".ver-banner .ver-cmd-hint");
    expect(bedded.length).toBeGreaterThanOrEqual(4);
  });

  it("reads every one of them at 4.5:1 on that bed, in both themes", () => {
    for (const theme of themes) {
      const bed = tok("--line", theme);
      for (const { selector, body } of bedded) {
        const fg = resolve(decl(body, "color")!, theme);
        expect(contrastRatio(fg, bed), `${theme} ${selector} on --line`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("leaves the paragraph around them dim — only the lifted bed pays", () => {
    // .up-quota-hint itself is --text-dim on --panel, which is 4.70:1 / 5.78:1
    // and fine. The size and the bed carry "secondary"; the fix is local to the
    // chip, not a lift of the whole hint.
    expect(declOf(".up-quota-hint", "color")).toBe("var(--text-dim)");
    for (const theme of themes) {
      expect(contrastRatio(tok("--text-dim", theme), tok("--panel", theme)), theme)
        .toBeGreaterThanOrEqual(BODY);
    }
  });
});

describe("4. the sparkline that prints its counts nowhere (#368.4)", () => {
  /** Base rule plus the light override, merged the way the cascade merges them. */
  function spark(cls: string, theme: Theme): { fill: Rgba; opacity: number } {
    const base = rule(`.tool-spark-bar${cls}`);
    const light = rule(`:root[data-theme="light"] .tool-spark-bar${cls}`);
    const pick = (p: string) => (theme === "light" ? decl(light, p) ?? decl(base, p) : decl(base, p));
    return { fill: resolve(pick("fill")!, theme), opacity: +(pick("opacity") ?? 1) };
  }

  const ratio = (cls: string, theme: Theme) =>
    Math.min(...nodeStops(theme).map(bed => contrastRatio(faded(spark(cls, theme).fill, spark(cls, theme).opacity, bed), bed)));

  it("draws the idle bar at 3:1 against the node it is painted on, in both themes", () => {
    // No adjacent number anywhere — the counts live in a title — so 1.4.11's
    // redundancy exception does not cover this meter the way it covers .qb-pct.
    for (const theme of themes) {
      expect(ratio("", theme), `${theme} idle spark bar`).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it("keeps the three tiers pointing the right way — idle quietest, latest loudest", () => {
    // This is why light is NOT lifted with dark. --muted there is 7.21:1 and
    // would put "nothing ran" above both active and latest.
    for (const theme of themes) {
      const idle = ratio("", theme);
      const active = ratio(".active", theme);
      const latest = ratio(".latest", theme);
      expect(idle, `${theme} idle < active`).toBeLessThan(active);
      expect(active, `${theme} active < latest`).toBeLessThan(latest);
    }
  });

  it("lifts the dark bar only, and leaves --muted-dim its decorative jobs", () => {
    expect(declOf(".tool-spark-bar", "fill")).toBe("var(--muted)");
    expect(declOf(':root[data-theme="light"] .tool-spark-bar', "fill")).toBe("var(--muted-dim)");
    // The two louder tiers each carry an extra class, so they out-specify the
    // light idle override whatever the source order.
    for (const cls of [".active", ".latest"]) {
      expect(decl(rule(`:root[data-theme="light"] .tool-spark-bar${cls}`), "fill"), cls).not.toBeNull();
    }
  });
});

describe("5. the focus ring the search field never drew (#368.5)", () => {
  it("restores an outline anywhere the sheet removes one", () => {
    // `outline: none` on a rule that also carries layout beat the global
    // :focus-visible on specificity AND source order. One rule does it; if a
    // second ever does, it has to put the ring back too.
    const killers = [...css.matchAll(/^([^{}\n][^{}]*)\{([^}]*outline:\s*none[^}]*)\}/gm)]
      .map(([, selector]) => selector.trim());
    expect(killers).toEqual([".search input"]);
    for (const sel of killers) {
      expect(declOf(`${sel}:focus-visible`, "outline"), sel).not.toBeNull();
    }
  });

  it("draws it in the deck's one focus language, not a second one", () => {
    expect(declOf(".search input:focus-visible", "outline")).toBe("2px solid var(--accent)");
    expect(declOf(".search input:focus-visible", "outline-offset")).toBe("1px");
    // The same declaration the other two text inputs already carried.
    for (const sel of [".ap-manage-input:focus-visible", ".aa-field input:focus-visible"]) {
      expect(declOf(sel, "outline"), sel).toBe("2px solid var(--accent)");
    }
    // And every focus ring in the sheet is that ring — offset may vary, colour
    // and weight may not.
    for (const [, body] of css.matchAll(/:focus-visible[^{}]*\{([^}]*)\}/g)) {
      const outline = decl(body, "outline");
      if (outline && outline !== "none") expect(outline).toBe("2px solid var(--accent)");
    }
  });

  it("reads the ring at 3:1 against the field and the bar it floats on, both themes", () => {
    // 1.4.11 covers a focus indicator. `/` focuses this field, so in light the
    // border tint it used to rely on was 1.67:1 and the glow 1.37:1.
    const beds: Record<Theme, string[]> = {
      dark: ["--panel", "--bg-soft"],   // the topbar gradient's two stops
      light: ["--panel", "--bg"],
    };
    for (const theme of themes) {
      const ring = resolve(declOf(".search input:focus-visible", "outline")!.replace(/^2px solid /, ""), theme);
      for (const bed of [...beds[theme], "--bg-soft"]) {
        expect(contrastRatio(ring, tok(bed, theme)), `${theme} ring on ${bed}`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("keeps `outline: none` for the pointer, so the ring stays a keyboard answer", () => {
    expect(declOf(".search input", "outline")).toBe("none");
  });
});
