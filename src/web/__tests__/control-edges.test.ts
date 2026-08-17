// #325 fixed five controls. #332 measured the other sixty-five.
//
// The defect it fixed was one control filled from `var(--bg-soft)` and edged
// with `var(--line)`, which on this sheet is a control with neither: --bg-soft
// is 1.04:1 against --panel in dark and byte-identical to it in light, and
// --line is 1.14:1 dark / 1.60:1 light — both under the 3:1 that WCAG 1.4.11
// asks of a boundary that is a control's only identification. #325 mixed two
// replacement values out of `var(--text)` and scoped them to `.ap-account`,
// which was right for the blast radius of that issue and wrong as a resting
// place: twenty-two of the app's seventy rendered controls had the same defect,
// in BOTH themes, and every one of them was reading the same two tokens the
// manage block had just stopped reading.
//
// So the two values are at :root now under names that are not --ap-*, the row's
// private copy is gone, and this file is the sweep. It is deliberately not a
// list of the ratios somebody once measured: it asks the sheet, for every
// control that DECLARES a boundary, on every opaque surface that control can
// land on, in both themes, whether the boundary clears 3:1 — and whether any
// state the control can enter draws that boundary fainter than it rests. A
// hover that lowers a contrast is not a hover.
//
// What it does not do is lift --line. That would redraw every panel edge,
// table rule and card in the app to solve a problem that belongs to controls;
// #325 declined and the last test here holds the line by value.
//
// No DOM — plain node, vitest — so this reads styles.css the way
// manage-block.test.ts, contrast-floors.test.ts and session-hue.test.ts do and
// computes the ratios from the sheet's own token values.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(web, "styles.css"), "utf8");

/** WCAG 1.4.3 for the words, 1.4.11 for a control's own boundary. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  if (s === "transparent" || s === "none") return [0, 0, 0, 0];
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

/** Every top-level rule naming this exact selector, concatenated in source
 *  order — one element's cascade may be written in more than one place. */
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
  if (hex) return hex[0];
  // `border: none` and `border: 0` are the same statement: no boundary.
  if (/\b(transparent|none)\b/.test(value) || /^\s*0\s*$/.test(value)) return "transparent";
  throw new Error(`no colour in "${value}"`);
}

/** A rule's border colour, whichever of the four ways it was written. */
function borderColourIn(body: string): string | null {
  const raw = declIn(body, "border-color")
    ?? declIn(body, "border")
    ?? declIn(body, "border-bottom");
  return raw === null ? null : colourIn(raw);
}

const borderColour = (selector: string) => {
  const c = borderColourIn(bodyOf(selector));
  if (c === null) throw new Error(`${selector} declares no border`);
  return c;
};

// ── tokens and the surfaces a control can land on ───────────────────────────

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

/** The colour stops of a gradient token, in order. */
const stopsOf = (value: string) =>
  value.match(/var\(--[\w-]+\)|#[0-9a-f]{3,8}/gi) ?? [];

/** Every opaque bed a control is ever painted on, by the name the sheet gives
 *  it. The topbar is a gradient, so both of its ends count: a pill centred in
 *  52px of it is read against the darker one as much as the lighter. */
function surfaces(theme: Theme): Record<string, Rgba> {
  const panel = parseColor(TOK[theme]["--panel"]);
  const bg = parseColor(TOK[theme]["--bg"]);
  const top = stopsOf(TOK[theme]["--topbar-grad"]).map(s => resolve(s, theme));
  const bannerTint = resolve(colourIn(decl(".ver-banner", "background")!), theme);
  const activeTint = resolve(colourIn(decl(".ap-account.active", "background")!), theme);
  return {
    "--panel": panel,
    "--bg-soft": parseColor(TOK[theme]["--bg-soft"]),
    "--bg": bg,
    "the topbar's light end": top[0],
    "the topbar's dark end": top[1],
    "the version banner": over(bannerTint, bg),
    "the active account row": over(activeTint, panel),
  };
}

/** The beds small text lands on, which is not the same set: the banner and the
 *  active row are washes a control sits in, and nothing writes a status hue on
 *  either. Both ends of the node gradient count — a node's top and bottom
 *  differ, and the cost line runs across both. */
function textBeds(theme: Theme): Array<[string, Rgba]> {
  const named: Array<[string, Rgba]> = (["--panel", "--bg-soft", "--bg"] as const)
    .map(t => [t, parseColor(TOK[theme][t])]);
  const top = stopsOf(TOK[theme]["--topbar-grad"]).map((s, i): [string, Rgba] =>
    [`the topbar, stop ${i}`, resolve(s, theme)]);
  const node = stopsOf(TOK[theme]["--node-grad"]).map((s, i): [string, Rgba] =>
    [`a node, stop ${i}`, resolve(s, theme)]);
  return [...named, ...top, ...node];
}

const TOPBAR = ["the topbar's light end", "the topbar's dark end"];
const BANNER = ["the version banner", "--bg"];
const ACCOUNTS = ["--panel", "the active account row"];

/** A control, as the sheet writes it: the rule that draws it at rest, the rule
 *  its fill comes from when that is a base class, every rule that redraws its
 *  boundary in some state, and the beds it can sit on. */
interface Control {
  at: string;
  fillFrom?: string;
  states?: string[];
  beds: string[];
}

const CONTROLS: Control[] = [
  // topbar
  { at: ".topbar .brand button.v:not(.stale)", fillFrom: ".topbar .brand button.v",
    states: [".topbar .brand button.v:not(.stale):hover"], beds: TOPBAR },
  { at: ".topbar .brand button.v.stale", states: [".topbar .brand button.v.stale:hover"], beds: TOPBAR },
  { at: ".selected-ribbon", states: [".selected-ribbon:hover"], beds: TOPBAR },
  { at: "button.btn", states: ["button.btn:hover"], beds: [...TOPBAR, "--panel"] },
  { at: "button.btn.primary", fillFrom: "button.btn.primary", beds: [...TOPBAR, "--panel"] },
  // The on state of an icon toggle (#370). Two selectors on one rule, so both
  // have to be named or the exhaustiveness check below reports the other as
  // unswept. Its own state delta — this fill against the bare bar, which is a
  // different question from this edge against this fill — is toggle-state.test.ts'.
  { at: 'button.btn.icon-btn[aria-pressed="true"]', beds: [...TOPBAR, "--panel"] },
  { at: 'button.btn.icon-btn[aria-expanded="true"]', beds: [...TOPBAR, "--panel"] },
  { at: "button.btn.warn", fillFrom: "button.btn", states: ["button.btn.warn:hover"], beds: [...TOPBAR, "--panel"] },
  { at: "button.btn.danger", fillFrom: "button.btn", states: ["button.btn.danger:hover"], beds: ["--panel"] },
  { at: ".search input", states: [".search input:focus"], beds: TOPBAR },
  { at: ".topbar .waiting-stat", states: [".topbar .waiting-stat:hover"], beds: TOPBAR },
  // version banner
  { at: ".ver-banner .ver-cmd", states: [".ver-banner .ver-cmd:hover"], beds: BANNER },
  { at: ".ver-banner .ver-act", states: [".ver-banner .ver-act:hover:not(:disabled)"], beds: BANNER },
  { at: ".ver-banner .ver-auto:hover", fillFrom: ".ver-banner .ver-auto", beds: BANNER },
  // canvas, detail panel, modals
  { at: ".detail-reopen", beds: ["--bg"] },
  { at: ".detail-close:hover", fillFrom: ".detail-close:hover", beds: ["--panel"] },
  { at: ".ctx-modal-close", beds: ["--panel"] },
  { at: ".session-list .sl-row:hover", fillFrom: ".session-list .sl-row:hover",
    states: [".session-list .sl-row.selected"], beds: ["--panel"] },
  // accounts panel
  { at: ".ap-auto-state", states: ["button.ap-auto-state:hover:not(:disabled)", ".ap-auto-state.live"],
    beds: ["--panel"] },
  { at: ".ap-field select", states: [".ap-field select:hover:not(:disabled)"], beds: ACCOUNTS },
  { at: ".ap-more:hover", fillFrom: ".ap-more", states: [".ap-more.on"], beds: ACCOUNTS },
  { at: ".ap-manage-input", states: [".ap-manage-input:hover"], beds: ACCOUNTS },
  { at: ".ap-manage-btn", states: [".ap-manage-btn:hover:not(:disabled)"], beds: ACCOUNTS },
  { at: ".ap-manage-btn.danger", fillFrom: ".ap-manage-btn",
    states: [".ap-manage-btn.danger:hover:not(:disabled)", ".ap-manage-btn.danger.armed"], beds: ACCOUNTS },
  { at: ".ap-share-foot .ap-manage-btn", fillFrom: ".ap-share-foot .ap-manage-btn",
    states: [".ap-share-foot .ap-manage-btn:hover:not(:disabled)"], beds: ACCOUNTS },
  { at: ".ap-fix", states: [".ap-fix:hover"], beds: ["--panel"] },
  // add-account dialog
  { at: ".aa-tab", states: [".aa-tab.on"], beds: ["--panel"] },
  { at: ".aa-link", states: [".aa-link:hover"], beds: ["--panel"] },
  { at: ".aa-field input", beds: ["--panel"] },
];

/** What the control is filled with at rest. `background: none` and a rule that
 *  declares no background at all are both "whatever is behind it". */
function restingFill(c: Control): string {
  return decl(c.fillFrom ?? c.at, "background") ?? "transparent";
}

/** A boundary's ratio against the bed it is drawn on, with the control's own
 *  fill in between — `background-clip` is `border-box` by default, so the
 *  border composites over the fill, not straight onto the surface. */
function edgeRatio(edge: string, fill: string, bed: Rgba, theme: Theme): number {
  const filled = over(resolve(fill, theme), bed);
  return contrastRatio(over(resolve(edge, theme), filled), bed);
}

describe("the contrast maths, against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#14161b"), parseColor("#14161b"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("reproduces the ratios #332 reported, so the floors below have a baseline", () => {
    // Every one of these is a shipped value from v1.33.135, restated as
    // arithmetic. They are literals on purpose: the tokens have moved, and a
    // baseline that moved with them would not be one.
    const white = parseColor("#ffffff");
    const canvas = parseColor("#eef1f6");
    const darkPanel = parseColor("#14161b");
    // `Pause`, `Re-layout`, `Clear`, the three icon buttons: transparent fill,
    // --line edge. 1.00 on the fill in light because --bg-soft IS --panel.
    expect(contrastRatio(parseColor("#c8cdd6"), white)).toBeCloseTo(1.60, 2);
    expect(contrastRatio(parseColor("#c8cdd6"), canvas)).toBeCloseTo(1.41, 2);
    expect(contrastRatio(parseColor("#1f2229"), darkPanel)).toBeCloseTo(1.14, 2);
    // The `$` button — the only filled .btn — and its --accent-dim edge over it.
    const dimFill = over([3, 105, 161, 0.22], canvas);
    expect(contrastRatio(dimFill, canvas)).toBeCloseTo(1.37, 2);
    expect(contrastRatio(over([3, 105, 161, 0.22], dimFill), canvas)).toBeCloseTo(1.79, 2);
    // .detail-reopen: a --panel tab on the canvas, edged with --line.
    expect(contrastRatio(white, canvas)).toBeCloseTo(1.13, 2);
    // --accent-dim, the hover edge on eleven rules, against what it hovered.
    expect(contrastRatio(over([3, 105, 161, 0.22], white), white)).toBeCloseTo(1.39, 2);
    expect(contrastRatio(over([56, 189, 248, 0x50 / 255], darkPanel), darkPanel)).toBeCloseTo(1.91, 2);
    // --ok and --warn on the canvas: under AA by a tenth, fine on a panel.
    expect(contrastRatio(parseColor("#15803d"), canvas)).toBeCloseTo(4.43, 2);
    expect(contrastRatio(parseColor("#b45309"), canvas)).toBeCloseTo(4.44, 2);
    expect(contrastRatio(parseColor("#15803d"), white)).toBeCloseTo(5.02, 2);
    // .pill.live: --ok on its own 10% wash, at the dark end of the topbar.
    expect(contrastRatio(parseColor("#15803d"), over([21, 128, 61, 0.10], canvas))).toBeCloseTo(3.90, 2);
  });
});

describe("every control that draws a boundary draws one that can be seen (1.4.11)", () => {
  it("clears 3:1 at rest, on every surface it can land on, in both themes", () => {
    for (const theme of themes) {
      const beds = surfaces(theme);
      for (const c of CONTROLS) {
        const fill = restingFill(c);
        const edge = borderColour(c.at);
        for (const bedName of c.beds) {
          expect(edgeRatio(edge, fill, beds[bedName], theme), `${theme} ${c.at} on ${bedName}`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("never draws it fainter in a state than at rest — a hover that lowers a contrast is not a hover", () => {
    for (const theme of themes) {
      const beds = surfaces(theme);
      for (const c of CONTROLS) {
        const restFill = restingFill(c);
        const restEdge = borderColour(c.at);
        for (const state of c.states ?? []) {
          const body = bodyOf(state);
          const fill = declIn(body, "background") ?? restFill;
          const edge = borderColourIn(body) ?? restEdge;
          for (const bedName of c.beds) {
            const bed = beds[bedName];
            expect(edgeRatio(edge, fill, bed, theme), `${theme} ${state} on ${bedName}`)
              .toBeGreaterThanOrEqual(edgeRatio(restEdge, restFill, bed, theme) - 1e-9);
          }
        }
      }
    }
  });

  it("leaves nothing in the sheet drawing a boundary on a control the sweep has not seen", () => {
    // The sweep is only worth its runtime if it is exhaustive, and a hand-kept
    // list rots. So: every class the components put on a <button>, <input>,
    // <select> or <a>, plus the three tag names themselves, and every top-level
    // rule that paints a visible border on one of them has to be either swept
    // above or named below with a reason. A new control cannot be added to this
    // app without landing in one of the two lists.
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : files(path);
      return path.endsWith(".tsx") ? [path] : [];
    });
    const tsx = files(web).map(p => readFileSync(p, "utf8")).join("\n");
    const interactive = new Set<string>();
    for (const [, , attrs] of tsx.matchAll(/<(button|input|select|a)\b([^>]*)>/g)) {
      for (const m of attrs.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const c of (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
          if (c && !c.endsWith("-")) interactive.add(c);
        }
      }
    }
    expect(interactive.size).toBeGreaterThan(20);

    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const marks = [...interactive].map(c => new RegExp(`\\.${escape(c)}(?![\\w-])`));
    marks.push(/(?:^|[\s>+~])(?:button|input|select)(?![\w-])/);
    const isControlRule = (selector: string) =>
      selectors(selector).some(s => marks.some(re => re.test(s)));

    /** A border a reader could see: not `none`, not `0`, not transparent. A
     *  value this file cannot resolve counts as visible — an edge nobody here
     *  understands is exactly the one that has to be looked at by hand. */
    const paintsAnEdge = (body: string) => {
      const c = borderColourIn(body);
      if (c === null || c === "transparent") return false;
      try { return resolve(c, "light")[3] > 0; } catch { return true; }
    };

    // Named, with the reason. All three are the same reason 1.4.11 gives:
    // a control identified by its own visible label or glyph does not owe you
    // a boundary, and a line BETWEEN grouped controls is not one of them.
    const EXEMPT = new Set([
      // The stack's frame and the rules between its buttons. Each button is a
      // glyph; the group's outline is a group's outline.
      ".react-flow__controls-button",
      // Rows in the tool list. `border: none` plus a hairline separating one
      // row from the next — the row is identified by the tool's name in it.
      ".detail .tool", "button.tool.clickable", "button.tool.clickable:last-child",
      // A draggable label on the canvas, whose rim is a tint of the session
      // hue and whose floors session-hue.test.ts owns as decoration. It reads
      // its own name at 4.5:1, which is the identification.
      ".cluster-label",
    ]);
    const swept = new Set<string>();
    for (const c of CONTROLS) {
      for (const s of selectors(c.at)) swept.add(s);
      for (const s of c.states ?? []) swept.add(s);
      if (c.fillFrom) swept.add(c.fillFrom);
    }

    const unclassified = RULES
      .filter(r => isControlRule(r.selector) && paintsAnEdge(r.body))
      .flatMap(r => selectors(r.selector))
      .filter(s => !swept.has(s) && !EXEMPT.has(s));
    expect([...new Set(unclassified)]).toEqual([]);
  });
});

describe("the control surface, promoted (#332)", () => {
  it("lives at :root in both themes and is mixed from the foreground", () => {
    // The property that made #325's fix work and the reason it is safe to
    // promote: a value derived from var(--text) exists in both themes by
    // construction. A value borrowed from another surface does not — --bg-soft
    // is the proof, byte-identical to --panel on white.
    for (const theme of themes) {
      expect(TOK[theme]["--ctl-fill"], theme).toMatch(/var\(--text\)/);
      expect(TOK[theme]["--ctl-edge"], theme).toMatch(/var\(--text\)/);
    }
    expect(TOK.light["--bg-soft"]).toBe(TOK.light["--panel"]);
  });

  it("did not buy any of it by lifting --line", () => {
    // The trap #325 named and refused. --line is the app's structural hairline
    // — panel edges, table rules, separators, card outlines, the scrollbar
    // thumb — and lifting it to clear 3:1 would redraw all of them to fix a
    // defect that is the controls'. Pinned by value, in both themes.
    expect(TOK.dark["--line"]).toBe("#1f2229");
    expect(TOK.light["--line"]).toBe("#c8cdd6");
    expect(TOK.dark["--line-soft"]).toBe("#1a1c22");
    expect(TOK.light["--line-soft"]).toBe("#dde1e8");
  });

  it("left no control reading --line for its own edge", () => {
    for (const c of CONTROLS) {
      expect(borderColour(c.at), c.at).not.toBe("var(--line)");
    }
  });

  it("retired the row-scoped copy rather than keeping two names for one idea", () => {
    expect(bare).not.toMatch(/--ap-ctl-/);
    // …and did not simply move the scope down a level: the readers are spread
    // across the topbar, the banner, the canvas, two side panels and a dialog.
    // Twenty-four rules at the time of writing; a floor rather than a count,
    // so deleting a control does not fail this and re-scoping the tokens back
    // to one block does.
    const readers = RULES.filter(r => /var\(--ctl-(fill|edge)\)/.test(r.body));
    expect(readers.length).toBeGreaterThanOrEqual(20);
    expect(readers.filter(r => r.selector.startsWith(".ap-")).length).toBeLessThan(readers.length / 2);
  });

  it("is a fill for controls that write in --text, and the sheet knows which those are", () => {
    // --ctl-fill is mixed FROM the foreground, so it moves the bed toward the
    // words: 7% of --text lifts the dark panel enough that --muted lands at
    // 4.05:1 on it. That is fine under a label written in --text (11.15:1) and
    // wrong under one written in --muted, which is why the four controls below
    // keep the flat --bg-soft wash and take their identification from the edge
    // instead. Not a preference — the arithmetic is in this test.
    for (const theme of themes) {
      for (const [name, bed] of textBeds(theme)) {
        const fill = over(resolve("var(--ctl-fill)", theme), bed);
        expect(contrastRatio(parseColor(TOK[theme]["--text"]), fill), `${theme} --text on the fill over ${name}`)
          .toBeGreaterThanOrEqual(BODY);
      }
    }
    const darkFill = over(resolve("var(--ctl-fill)", "dark"), parseColor(TOK.dark["--panel"]));
    expect(contrastRatio(parseColor(TOK.dark["--muted"]), darkFill)).toBeLessThan(BODY);
    for (const sel of [".selected-ribbon", ".search input", ".aa-field input", ".session-list .sl-row:hover"]) {
      expect(decl(sel, "background"), sel).toBe("var(--bg-soft)");
    }
  });

  it("stopped asking --accent-dim to be a boundary anywhere", () => {
    // 1.91:1 dark, 1.39:1 light. It is a fill and a glow and it is fine at
    // both; as a border-color it was under the resting edge of every control
    // that hovered to it, which made the pointer take contrast away.
    for (const rule of RULES) {
      const raw = declIn(rule.body, "border-color") ?? declIn(rule.body, "border");
      if (raw && /--accent-dim/.test(raw)) expect.unreachable(`${rule.selector} edges in --accent-dim`);
    }
  });
});

describe("the two status hues, on the canvas as well as on the panels", () => {
  it("reads --ok and --warn at 4.5:1 on every opaque surface in the sheet", () => {
    // They were 4.43:1 and 4.44:1 on --bg and 5.02:1 on --panel, so they failed
    // exactly where they are read most: a tool burst's ✓ and a node's cost.
    for (const theme of themes) {
      for (const token of ["--ok", "--warn"]) {
        const fg = parseColor(TOK[theme][token]);
        for (const [name, bed] of textBeds(theme)) {
          expect(contrastRatio(fg, bed), `${theme} ${token} on ${name}`).toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });

  it("reads each status pill's own word at 4.5:1 wherever in the topbar it lands", () => {
    // The pill is centred in 52px of a gradient, so an alpha wash gave its word
    // one ratio at the top of the bar and another at the bottom — 4.39:1 and
    // 3.90:1 for `live`. The light tints are opaque now, which is the same fix
    // #268 applied to the node rings for the same reason.
    for (const theme of themes) {
      const beds = surfaces(theme);
      for (const [state, token] of [["live", "--ok"], ["paused", "--warn"], ["dead", "--err"]] as const) {
        const light = RULES.find(r =>
          selectors(r.selector).includes(`:root[data-theme="light"] .topbar .status .pill.${state}`));
        const fillRaw = (theme === "light" ? declIn(light!.body, "background") : null)
          ?? decl(".topbar .status .pill", "background")!;
        if (theme === "light") expect(fillRaw, state).not.toMatch(/rgba\(/);
        const fg = parseColor(TOK[theme][token]);
        for (const bedName of TOPBAR) {
          const fill = over(resolve(fillRaw, theme), beds[bedName]);
          expect(contrastRatio(fg, fill), `${theme} .pill.${state} on ${bedName}`).toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });
});
