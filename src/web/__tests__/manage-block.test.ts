// #325: the account manage block read as a debug form rather than product UI,
// and every part of that was measurable.
//
// The pills were painted `background: var(--bg-soft)` on a `var(--panel)`
// surface — 1.04:1 in dark and byte-identical in light — with a `var(--line)`
// boundary at 1.14:1 / 1.60:1, under the 3:1 that 1.4.11 asks of a control
// nothing else identifies. Nothing else did identify them: their label was
// `var(--muted)`, which in dark is the same hex as the `--text-dim` the static
// labels use, so the block gave the eye no way to sort clickable from
// decorative. The disclosure that opens all of it was 25x16 and `opacity: 0`
// until hover — under 2.5.8's 24x24 floor and, on a touch device, a door with
// no handle.
//
// The panel cannot be rendered here — plain node, no DOM — so this reads the
// stylesheet the way dead-css.test.ts and contrast-floors.test.ts do and
// computes the ratios from the sheet's own token values. The numbers in the
// report become floors rather than a state somebody restored once.
//
// What it does NOT do is collapse --muted and --text-dim, which the report's
// second finding asked for. Their sharing a value in dark is deliberate and
// documented at styles.css:11 — the dark ramp has no readable tier below
// --muted's 4.70:1, so the step down is carried by size and weight. The
// distinction the block was missing is between CONTROLS and labels, and it is
// the controls that moved.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
/** The same file with its comments gone. The comments here quote the copy they
 *  replaced — explaining WHY `rotation order` was wrong needs the old words on
 *  the page — so a search for retired wording has to read the markup only. */
const panelCode = panel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** WCAG 1.4.3 for the words, 1.4.11 for a control's own boundary. */
const BODY = 4.5;
const NON_TEXT = 3;
/** WCAG 2.5.8, in CSS pixels, on both axes. */
const TARGET = 24;

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/** Source-over compositing onto an already-opaque backdrop. */
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

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── the stylesheet, as rules ────────────────────────────────────────────────

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Top-level rules only. A @media body is a different cascade — the reduced-
 *  motion overrides in particular are not the resting appearance of anything. */
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

const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = topLevel(bare);

const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** Every top-level rule that names this exact selector, concatenated in source
 *  order — the manage block declares `.ap-account` twice, once for geometry and
 *  once for the control tokens, and both are the same element's cascade. */
function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop`, which is the one that wins. */
function decl(selector: string, prop: string): string | null {
  const all = [...bodyOf(selector).matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

/** The colour in a value that may also carry a width and a style. Parens are
 *  counted rather than matched lazily: `color-mix(in srgb, var(--x) 6%, …)`
 *  nests, and a `[^)]*` stops inside it. */
function colourIn(value: string): string {
  const head = /(color-mix|var|rgba?)\(/i.exec(value);
  if (head) {
    const open = head.index + head[0].length - 1;
    let depth = 0;
    for (let i = open; i < value.length; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")" && --depth === 0) return value.slice(head.index, i + 1);
    }
    throw new Error(`unbalanced parens in "${value}"`);
  }
  const hex = /#[0-9a-f]{3,8}/i.exec(value);
  if (!hex) throw new Error(`no colour in "${value}"`);
  return hex[0];
}

const borderColour = (selector: string) =>
  colourIn(decl(selector, "border-color") ?? decl(selector, "border")!);

// ── tokens, per theme, plus the ones the account row scopes ─────────────────

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function rootTokens(theme: Theme): Record<string, string> {
  const head = `:root[data-theme="${theme}"]`;
  const out: Record<string, string> = {};
  for (const [, name, value] of bodyOf(head).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  // Scoped to .ap-account rather than promoted to :root, so a control lifted
  // here does not redraw every border in the app. Resolving them the same way
  // is the point: inside the row these ARE the values.
  for (const [, name, value] of bodyOf(".ap-account").matchAll(/(--[\w-]+)\s*:\s*([^;]+)(?:;|$)/g)) {
    out[name] = value.trim();
  }
  return out;
}

const TOK: Record<Theme, Record<string, string>> = { dark: rootTokens("dark"), light: rootTokens("light") };

/** var() with an optional fallback, and the `color-mix(in srgb, X N%, transparent)`
 *  form this sheet uses for every tint — which is just X at N% alpha. */
function resolve(value: string, theme: Theme): Rgba {
  const v = value.trim();
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(v);
  if (mix) {
    const base = resolve(mix[1], theme);
    return [base[0], base[1], base[2], base[3] * (+mix[2] / 100)];
  }
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(v);
  if (ref) {
    const defined = TOK[theme][ref[1]];
    if (defined !== undefined) return resolve(defined, theme);
    if (ref[2] === undefined) throw new Error(`undefined token with no fallback: ${v}`);
    return resolve(ref[2], theme);
  }
  return parseColor(v);
}

/** The two opaque surfaces the block is ever painted on: the panel, and the
 *  panel under the 6% accent wash the ACTIVE account's row carries. */
function beds(theme: Theme): Array<[string, Rgba]> {
  const panelBed = parseColor(TOK[theme]["--panel"]);
  const tint = resolve(colourIn(decl(".ap-account.active", "background")!), theme);
  return [["--panel", panelBed], ["the active row", over(tint, panelBed)]];
}

/** A control, as the three things a reader has to be able to tell apart: what
 *  it is filled with, what its boundary is, and what its label is. */
interface Control { name: string; fill: string; edge: string; label: string }

const CONTROLS: Control[] = [
  {
    name: ".ap-manage-btn",
    fill: decl(".ap-manage-btn", "background")!,
    edge: borderColour(".ap-manage-btn"),
    label: decl(".ap-manage-btn", "color")!,
  },
  {
    name: ".ap-manage-btn.danger",
    fill: decl(".ap-manage-btn", "background")!,
    edge: borderColour(".ap-manage-btn.danger"),
    label: decl(".ap-manage-btn.danger", "color")!,
  },
  {
    name: ".ap-manage-input",
    fill: decl(".ap-manage-input", "background")!,
    edge: borderColour(".ap-manage-input"),
    label: decl(".ap-manage-input", "color")!,
  },
  {
    name: ".ap-field select",
    fill: decl(".ap-field select", "background")!,
    edge: borderColour(".ap-field select"),
    label: decl(".ap-field select", "color")!,
  },
  {
    name: ".ap-share-foot .ap-manage-btn",
    fill: decl(".ap-share-foot .ap-manage-btn", "background")!,
    edge: borderColour(".ap-share-foot .ap-manage-btn"),
    label: decl(".ap-share-foot .ap-manage-btn", "color")!,
  },
];

describe("the contrast maths, against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#14161b"), parseColor("#14161b"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("reproduces the ratios #325 reported, so the floors below have a baseline", () => {
    const darkPanel = parseColor("#14161b");
    expect(contrastRatio(parseColor("#0f1116"), darkPanel)).toBeCloseTo(1.04, 2);   // pill fill, dark
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#ffffff"))).toBeCloseTo(1.00, 2); // and light
    expect(contrastRatio(parseColor("#1f2229"), darkPanel)).toBeCloseTo(1.14, 2);   // pill border, dark
    expect(contrastRatio(parseColor("#c8cdd6"), parseColor("#ffffff"))).toBeCloseTo(1.60, 2); // and light
    // `save`, disabled the instant the block opened: the whole button at 0.45,
    // so both the label and the fill under it composite onto the panel.
    const label = over([126, 130, 140, 0.45], darkPanel);
    const fill = over([15, 17, 22, 0.45], darkPanel);
    expect(contrastRatio(label, fill)).toBeCloseTo(1.97, 2);
    // And the boundary the report credited `remove` with: 30% --err is not 3:1,
    // it is 1.96:1 — only its LABEL cleared anything, which is exactly why it
    // out-drew every safe control around it.
    expect(contrastRatio(over([252, 165, 165, 0.30], darkPanel), darkPanel)).toBeCloseTo(1.96, 2);
    expect(contrastRatio(parseColor("#fca5a5"), darkPanel)).toBeCloseTo(9.54, 2);
  });
});

describe("every control in the manage block has a perceivable boundary (1.4.11)", () => {
  it("draws its edge at 3:1 or better on both surfaces, in both themes", () => {
    for (const theme of themes) {
      for (const [bedName, bed] of beds(theme)) {
        for (const c of CONTROLS) {
          const fill = over(resolve(c.fill, theme), bed);
          const edge = over(resolve(c.edge, theme), fill);
          expect(contrastRatio(edge, bed), `${theme} ${c.name} edge on ${bedName}`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("reads every control's own label at 4.5:1 over its own fill", () => {
    for (const theme of themes) {
      for (const [bedName, bed] of beds(theme)) {
        for (const c of CONTROLS) {
          const fill = over(resolve(c.fill, theme), bed);
          expect(contrastRatio(resolve(c.label, theme), fill), `${theme} ${c.name} label on ${bedName}`)
            .toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });

  it("derives the fill from the foreground, not from another surface", () => {
    // --bg-soft is 1.04:1 against --panel in dark and the SAME BYTES in light,
    // so a fill borrowed from it is not a fill. Mixed from --text it exists in
    // both themes by construction, which is the whole point of the change.
    for (const c of CONTROLS) expect(c.fill, c.name).not.toMatch(/var\(--bg-soft\)\s*$/);
    for (const theme of themes) {
      expect(TOK[theme]["--ap-ctl-fill"], theme).toMatch(/var\(--text\)/);
      expect(TOK[theme]["--ap-ctl-edge"], theme).toMatch(/var\(--text\)/);
    }
    // Light theme is where the old value was indistinguishable from the panel.
    expect(TOK.light["--bg-soft"]).toBe(TOK.light["--panel"]);
  });

  it("keeps the lift inside the account row — every reader falls back to the old value", () => {
    // The auto-switch threshold shares `.ap-field select` and sits outside
    // `.ap-account`, so the fallback is what it renders. A token promoted to
    // :root would have redrawn every border in the app instead.
    for (const rule of RULES) {
      for (const [, value] of rule.body.matchAll(/var\(\s*(--ap-ctl-[\w-]+)\s*\)/g)) {
        expect.unreachable(`${rule.selector} reads ${value} with no fallback`);
      }
    }
    expect(bodyOf(".ap-account")).toMatch(/--ap-ctl-fill\s*:/);
    for (const theme of themes) expect(bodyOf(`:root[data-theme="${theme}"]`)).not.toMatch(/--ap-ctl-/);
  });

  it("never lowers a control's boundary on hover, which is what a hover is for", () => {
    for (const theme of themes) {
      for (const [bedName, bed] of beds(theme)) {
        for (const [name, base] of [
          [".ap-manage-btn", ".ap-manage-btn"],
          [".ap-manage-input", ".ap-manage-input"],
        ] as const) {
          const rest = contrastRatio(over(resolve(borderColour(base), theme), bed), bed);
          const hovered = contrastRatio(
            over(resolve(borderColour(`${base}:hover${base === ".ap-manage-btn" ? ":not(:disabled)" : ""}`), theme), bed),
            bed,
          );
          expect(hovered, `${theme} ${name} hover on ${bedName}`).toBeGreaterThanOrEqual(rest);
        }
      }
    }
  });
});

describe("the buttons stopped sharing the labels' colour (#325's first finding)", () => {
  it("writes button labels in --text and static labels in --text-dim", () => {
    expect(decl(".ap-manage-btn", "color")).toBe("var(--text)");
    expect(decl(".ap-manage-label", "color")).toBe("var(--text-dim)");
    expect(decl(".ap-manage-hint", "color")).toBe("var(--text-dim)");
    // --muted was the pills' colour and is --text-dim's own value in dark.
    expect(decl(".ap-manage-btn", "color")).not.toBe("var(--muted)");
  });

  it("puts a real step between them, in both themes", () => {
    for (const theme of themes) {
      const panelBed = parseColor(TOK[theme]["--panel"]);
      const button = contrastRatio(resolve(decl(".ap-manage-btn", "color")!, theme), panelBed);
      const label = contrastRatio(resolve(decl(".ap-manage-label", "color")!, theme), panelBed);
      expect(button / label, `${theme} button vs label`).toBeGreaterThan(2);
    }
  });

  it("did NOT buy that step by sinking the labels below 4.5:1", () => {
    // #325's second finding asked for a third, dimmer dark tier. There is no
    // room for one: --muted is itself 4.70:1 on --panel (styles.css:11), and
    // anything under it is annotation the sheet already has a token for.
    for (const theme of themes) {
      const panelBed = parseColor(TOK[theme]["--panel"]);
      for (const sel of [".ap-manage-label", ".ap-manage-hint", ".ap-manage-hint.ap-manage-swap"]) {
        expect(contrastRatio(resolve(decl(sel, "color")!, theme), panelBed), `${theme} ${sel}`)
          .toBeGreaterThanOrEqual(BODY);
      }
    }
    expect(TOK.dark["--text-dim"]).toBe(TOK.dark["--muted"]);
  });

  it("leaves nothing disabled at rest for `opacity` to render at 2:1", () => {
    // The button's own resting state is the one the block opens in. The dimming
    // stays for the moment a request is out, at the 0.6 the ↻ and the selects
    // already use.
    expect(panel).not.toMatch(/aliasDraft\.trim\(\)\s*===/);
    expect(panel).toMatch(/className="ap-manage-btn" disabled=\{busy != null\}/);
    expect(decl(".ap-manage-btn:disabled", "opacity")).toBe("0.6");
    for (const theme of themes) {
      const bed = parseColor(TOK[theme]["--panel"]);
      const dimmed = over([...resolve(decl(".ap-manage-btn", "color")!, theme).slice(0, 3), 0.6] as Rgba, bed);
      expect(contrastRatio(dimmed, bed), `${theme} busy save`).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });
});

describe("the ⋯ that opens all of it (2.5.8, and touch)", () => {
  it("is at least 24x24 on both axes", () => {
    expect(parseFloat(decl(".ap-more", "min-width")!)).toBeGreaterThanOrEqual(TARGET);
    expect(parseFloat(decl(".ap-more", "min-height")!)).toBeGreaterThanOrEqual(TARGET);
  });

  it("is visible before it is hovered, which is the only state touch has", () => {
    expect(decl(".ap-more", "opacity")).toBeNull();
    expect(bare).not.toMatch(/\.ap-account:hover \.ap-more[^{]*\{[^}]*opacity/);
  });

  it("clears 3:1 at rest on both surfaces and in both themes", () => {
    // Not 0.35, which #325 suggested: --text-dim faded that far composites to
    // 1.63:1, the same defect the pills above it were just lifted out of.
    for (const theme of themes) {
      for (const [bedName, bed] of beds(theme)) {
        const glyph = resolve(decl(".ap-more", "color")!, theme);
        expect(contrastRatio(over(glyph, bed), bed), `${theme} ⋯ on ${bedName}`)
          .toBeGreaterThanOrEqual(NON_TEXT);
        expect(contrastRatio(over([...glyph.slice(0, 3), 0.35] as Rgba, bed), bed))
          .toBeLessThan(NON_TEXT);
      }
    }
  });
});

describe("three settings, one right edge (#325's fourth finding)", () => {
  it("lays the rows out on a grid instead of letting each stop where it runs out", () => {
    // x273 / x162 / x133 at the panel's 288px was three flex rows ending
    // wherever their content did. Label, explanation, control — and the control
    // column is `auto`, so every row ends on the same x whatever is in it.
    expect(decl(".ap-manage-row", "display")).toBe("grid");
    const cols = decl(".ap-manage-row", "grid-template-columns")!.split(/\s+(?![^(]*\))/);
    expect(cols).toHaveLength(3);
    expect(cols[2]).toBe("auto");
  });

  it("separates the irreversible action rather than only colouring it", () => {
    // `remove` sat 6px from `share` with the loudest colour in the block. It
    // now has a row to itself, right-aligned under a rule.
    expect(decl(".ap-manage-foot", "justify-content")).toBe("flex-end");
    expect(decl(".ap-manage-foot", "border-top")).toMatch(/dashed/);
    expect(panel).toMatch(/<div className="ap-manage-foot">/);
  });

  it("keeps the two-step arm and its four-second expiry", () => {
    expect(panel).toMatch(/confirmRemove === a\.num \? "confirm remove" : "remove"/);
    expect(panel).toMatch(/setConfirmRemove\(c => \(c === a\.num \? null : c\)\), 4000\)/);
    expect(bare).toMatch(/ap-disarm 4000ms linear forwards/);
  });

  it("stops shouting the labels — sentence case, like every other label here", () => {
    expect(decl(".ap-manage-label", "text-transform")).toBeNull();
    expect(decl(".ap-manage-label", "letter-spacing")).toBeNull();
  });
});

describe("the input behaves like its four siblings (#325's ninth finding)", () => {
  it("transitions its border, which every other control in the block already did", () => {
    expect(decl(".ap-manage-input", "transition")).toMatch(/border-color 120ms/);
    expect(decl(".ap-manage-input:hover", "border-color")).toBeTruthy();
  });

  it("keeps the block's entrance exactly as it was — it earns it", () => {
    expect(bare).toMatch(/animation: ap-manage-in 180ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both/);
  });
});

describe("the disclosure and the block it opens are related (#325's seventh finding)", () => {
  it("names the group, and points the button at it while it exists", () => {
    expect(panel).toMatch(/id=\{`ap-manage-\$\{a\.num\}`\}/);
    expect(panel).toMatch(/role="group" aria-label=\{`Manage account \$\{a\.num\}`\}/);
    expect(panel).toMatch(/aria-controls=\{menuFor === a\.num \? `ap-manage-\$\{a\.num\}` : undefined\}/);
  });

  it("labels the two fields with the words on screen, not with different ones", () => {
    // 2.5.3: the accessible name has to contain the visible label. `NAME` above
    // a field called "Alias for account 2" failed that outright, and voice
    // control asks for it harder than a screen reader does.
    expect(panel).toMatch(/<label className="ap-manage-label" htmlFor=\{`ap-alias-\$\{a\.num\}`\}>name<\/label>/);
    expect(panel).toMatch(/<label className="ap-manage-label" htmlFor=\{`ap-slot-\$\{a\.num\}`\}>slot<\/label>/);
    expect(panel).not.toMatch(/aria-label=\{`Alias for account/);
    expect(panel).not.toMatch(/aria-label=\{`Slot for account/);
  });

  it("moves the keyboard into the block rather than leaving it above everything", () => {
    expect(panel).toMatch(/autoFocus/);
  });
});

describe("microcopy (#325's eighth finding)", () => {
  it("shows the shape of an answer instead of narrating the empty state", () => {
    expect(panelCode).toMatch(/placeholder="e\.g\. work"/);
    expect(panelCode).not.toMatch(/placeholder="no alias"/);
  });

  it("drops the ellipsis from a button that opens no dialog", () => {
    expect(panelCode).not.toMatch(/share…/);
  });

  it("says what changing the slot DOES, not what the number is", () => {
    expect(panelCode).not.toMatch(/rotation order/);
    expect(panelCode).toMatch(/swaps if the slot is taken/);
  });

  it("does not duplicate the notice #327 already shows after a swap", () => {
    // A <select> commits on change, so there is no moment between "picked" and
    // "happened" for a predictive hint to occupy. The line above is the rule
    // that holds before any pick; this one is the fact after one.
    expect(panelCode).toMatch(/swapped with slot \{swapNote\.displaced\}/);
    expect([...panelCode.matchAll(/swapped with slot/g)]).toHaveLength(1);
  });
});
