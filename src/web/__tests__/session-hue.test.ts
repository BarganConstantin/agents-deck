// #330: eight colours in this app were built in JS at a lightness hard-coded
// for the dark canvas, and they were the only ones that could not answer to
// data-theme. The hue is a hash of a session id or an MCP server name, so JS
// has to supply it; the lightness is a property of the surface underneath,
// which only the cascade knows. One number decided both, and on white the
// result was the worst reading in the app — `.cluster-label` at 1.21:1 swept
// across all 360 hues, against a 4.5:1 floor.
//
// The fix moves the composition across that boundary: JS emits --session-hue /
// --mcp-hue and styles.css builds the colour from a per-job lightness tier.
// Which means the whole thing is now arithmetic over token values, and this
// file is where it is checked — every hue 0..359, every tier, both themes, no
// DOM, exactly like contrast-floors.test.ts and manage-block.test.ts before it.
//
// Two things it deliberately does NOT do:
//   * lift the dark theme. #330 fixes light and pins dark, so the one dark
//     shortfall it names (the node accent at 3.13:1 on --panel, thin as TEXT
//     even before this change) is recorded below as a pinned number rather
//     than quietly raised. Raising it is a dark-theme edit and a separate call.
//   * hold the two alpha-carrying cluster rims to 1.4.11. They cannot reach it
//     — the ceiling for a 32% wash on white is 2.19:1 — and the test proves
//     that ceiling rather than asserting the exemption.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(web, "styles.css"), "utf8");
const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const COMPONENTS: Record<string, string> = {
  "App.tsx": src("../App.tsx"),
  "SessionClusters.tsx": src("../components/SessionClusters.tsx"),
  "AgentNode.tsx": src("../components/AgentNode.tsx"),
  "ToolBursts.tsx": src("../components/ToolBursts.tsx"),
};

/** Every module under src/web, tests excluded — the same walk
 *  control-edges.test.ts does, for the same reason: a hand-kept list of four
 *  files is a list the fifth file is not on. */
function modulesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : modulesUnder(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

/** WCAG 1.4.3 for the words, 1.4.11 for a graphic that carries meaning. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** CSS Color 4's hsl-to-rgb, which is what the browser runs on these values. */
function hsl(h: number, s: number, l: number, a = 1): Rgba {
  const sat = s / 100, lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const c = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - c * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [255 * f(0), 255 * f(8), 255 * f(4), a];
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

/** CIE76 ΔE, for the one question contrast cannot answer: whether two sessions
 *  whose hues landed near each other are still telling themselves apart. */
function lab(c: Rgba): [number, number, number] {
  const lin = (v: number) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
  const [r, g, b] = [c[0], c[1], c[2]].map(lin);
  const f = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a: Rgba, b: Rgba) => {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

// ── the stylesheet, as rules and tokens ─────────────────────────────────────

const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(s: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return [s.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Top-level rules only — a @media body is a different cascade. */
function topLevel(s: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{", i);
    if (open < 0) break;
    const prelude = s.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(s, open);
    if (!prelude.startsWith("@")) out.push({ selector: prelude, body: inner });
    i = end + 1;
  }
  return out;
}

const RULES = topLevel(bare);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** The balanced contents of every `hsl(…)` in `body`. Parens are counted rather
 *  than matched with `[^)]*`, which stops inside the nested `var(--x, 200)`
 *  every one of these calls opens with. */
function hslCalls(body: string): string[] {
  const out: string[] = [];
  for (const head of [...body.matchAll(/hsl\(/g)]) {
    const open = head.index + head[0].length - 1;
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")" && --depth === 0) { out.push(body.slice(open + 1, i)); break; }
    }
  }
  return out;
}

/** One `hsl(var(--*-hue …) S% L …)` the sheet writes, split into the parts
 *  #330 cares about: which rule it is in, and what it put in the LIGHTNESS
 *  slot. That slot is the whole issue — a literal there is a colour composed
 *  for one canvas, which is the defect, and a `var(--*-l)` is a colour the
 *  cascade can answer for. */
interface HueSite {
  selector: string;
  call: string;
  lightness: string;
}

const HUE_SITES: HueSite[] = RULES.flatMap(rule =>
  hslCalls(rule.body)
    .filter(call => /^\s*var\(\s*--(?:session|mcp)-hue\b/.test(call))
    .map(call => {
      // Drop the leading balanced var(--*-hue, …), then the alpha after `/`,
      // and what is left is `S% L` — two components, lightness last.
      const after = call.slice(call.indexOf(")") + 1).split("/")[0];
      const parts = after.trim().split(/\s+/);
      return { selector: rule.selector, call, lightness: parts[parts.length - 1] };
    }));

function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop` in that rule, which is the one that wins. */
function decl(selector: string, prop: string): string | null {
  const all = [...bodyOf(selector).matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function rootTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  const head = theme === "dark" ? ":root" : ':root[data-theme="light"]';
  for (const [, name, value] of bodyOf(head).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: rootTokens("dark"), light: rootTokens("light") };

function lightnessOf(theme: Theme, token: string): number {
  const raw = TOK[theme][token];
  if (raw === undefined) throw new Error(`${theme} declares no ${token} — #330's tiers are how these colours reach the theme`);
  const pct = /^([\d.]+)%$/.exec(raw);
  if (!pct) throw new Error(`${token} is "${raw}", which is not a lightness`);
  return +pct[1];
}

/** Every opaque surface in a theme, by the name the sheet gives it. The node
 *  gradient's two stops are separate beds: a node's top and bottom differ. */
function surfaces(theme: Theme): Record<string, Rgba> {
  const out: Record<string, Rgba> = {};
  for (const t of ["--panel", "--bg-soft", "--bg"]) out[t] = parseColor(TOK[theme][t]);
  const stops = TOK[theme]["--node-grad"].match(/var\(--[\w-]+\)|#[0-9a-f]{3,6}/gi) ?? [];
  stops.forEach((s, i) => {
    const ref = /^var\((--[\w-]+)\)$/.exec(s);
    out[`--node-grad stop ${i}`] = parseColor(ref ? TOK[theme][ref[1]] : s);
  });
  return out;
}

// ── the eight colours, as the sheet now writes them ─────────────────────────

/** One generated colour: the constant half (saturation, alpha) that says what
 *  the thing IS, and the token that says how bright it has to be to survive
 *  the canvas it lands on. `beds` is every opaque surface it can be read
 *  against — the edges name only the canvas because nodes paint over them. */
interface Site {
  name: string;
  where: string;
  s: number;
  token: string;
  alpha: number;
  role: "text" | "graphic" | "decoration";
  beds: string[];
  /** How JS used to write it, for the before/after in the report. */
  was: number;
}

const SITES: Site[] = [
  { name: "cluster label", where: ".cluster-label", s: 70, token: "--session-label-l", alpha: 1,
    role: "text", beds: ["--bg", "--bg-soft", "--panel"], was: 78 },
  { name: "node accent", where: ".agent-node", s: 70, token: "--session-accent-l", alpha: 1,
    role: "text", beds: ["--panel", "--bg-soft", "--bg", "--node-grad stop 0", "--node-grad stop 1"], was: 60 },
  { name: "live edge", where: ".react-flow__edge.sess-edge.sess-live .react-flow__edge-path", s: 80,
    token: "--session-edge-l", alpha: 1, role: "graphic", beds: ["--bg"], was: 72 },
  { name: "settled edge", where: ".react-flow__edge.sess-edge.sess-idle .react-flow__edge-path", s: 50,
    token: "--session-edge-idle-l", alpha: 1, role: "graphic", beds: ["--bg"], was: 55 },
  // #330's eighth site was the topbar's MCP legend dot, on --panel / --bg-soft /
  // --bg. The legend has been removed from the strip, and with it the only place
  // an --mcp-dot-l hue was ever painted outside the detail panel — so the tier
  // keeps its reader (this stripe, and the MCP category chip that composes the
  // same expression at 0.40) and loses two beds it no longer lands on. Its dark
  // ratio was --panel's, which is the bed the stripe already names, so the
  // number below did not move when the site did.
  { name: "mcp burst stripe", where: ".tool-burst.cat-mcp.mcp-hue", s: 65, token: "--mcp-dot-l", alpha: 1,
    role: "graphic", beds: ["--panel"], was: 65 },
  { name: "cluster label rim", where: ".cluster-label", s: 65, token: "--session-rim-l", alpha: 0.5,
    role: "decoration", beds: ["--bg", "--bg-soft"], was: 55 },
  { name: "cluster card rim", where: ".cluster-card", s: 65, token: "--session-rim-l", alpha: 0.32,
    role: "decoration", beds: ["--bg"], was: 55 },
];

const FLOOR = { text: BODY, graphic: NON_TEXT, decoration: 0 } as const;

/** The worst of all 360 hues on one bed. Every one of these colours is a hash
 *  away from any hue, so the sweep is the only honest measurement. */
function worstHue(s: number, l: number, alpha: number, bed: Rgba): { ratio: number; hue: number } {
  let ratio = Infinity, hue = -1;
  for (let h = 0; h < 360; h++) {
    const r = contrastRatio(over(hsl(h, s, l, alpha), bed), bed);
    if (r < ratio) { ratio = r; hue = h; }
  }
  return { ratio, hue };
}

/** …across every bed the thing can land on. */
function worst(site: Site, l: number, theme: Theme): { ratio: number; hue: number; bed: string } {
  const beds = surfaces(theme);
  let out = { ratio: Infinity, hue: -1, bed: "" };
  for (const name of site.beds) {
    const w = worstHue(site.s, l, site.alpha, beds[name]);
    if (w.ratio < out.ratio) out = { ...w, bed: name };
  }
  return out;
}

// ── the maths, against ends everybody already knows ─────────────────────────

describe("the contrast and colour maths", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#0b0c10"), parseColor("#0b0c10"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("converts hsl the way the spec does, at the corners and at a mid hue", () => {
    expect(hsl(0, 0, 100).slice(0, 3)).toEqual([255, 255, 255]);
    expect(hsl(0, 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
    expect(hsl(0, 100, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(hsl(120, 100, 50).slice(0, 3)).toEqual([0, 255, 0]);
    expect(hsl(240, 100, 50).slice(0, 3)).toEqual([0, 0, 255]);
    // 50% grey has no hue to lose, so every hue lands on the same bytes.
    for (const h of [0, 97, 359]) expect(hsl(h, 0, 50)[0]).toBeCloseTo(127.5, 6);
  });

  it("scores ΔE at zero for a colour against itself and above it for a hue step", () => {
    expect(deltaE(hsl(200, 70, 50), hsl(200, 70, 50))).toBeCloseTo(0, 9);
    expect(deltaE(hsl(200, 70, 50), hsl(230, 70, 50))).toBeGreaterThan(5);
  });

  it("reproduces the readings #330 reported, so the tiers below have a baseline", () => {
    // The audit measured in Chrome on a live deck. These are the same numbers
    // from the same values, which is what makes the sweep trustworthy.
    const white = parseColor("#ffffff");
    const darkPanel = parseColor("#14161b");
    expect(worstHue(70, 78, 1, white).ratio).toBeCloseTo(1.21, 2);   // cluster label
    expect(worstHue(70, 78, 1, darkPanel).ratio).toBeCloseTo(7.52, 2);
    expect(worstHue(70, 60, 1, white).ratio).toBeCloseTo(1.40, 2);   // node accent
    expect(worstHue(70, 60, 1, darkPanel).ratio).toBeCloseTo(3.13, 2);
    expect(worstHue(65, 65, 1, white).ratio).toBeCloseTo(1.40, 2);   // dot / --cat-accent
    expect(worstHue(65, 65, 1, darkPanel).ratio).toBeCloseTo(4.17, 2);
    // And the three rendered samples the report tabulated, exactly.
    expect(contrastRatio(parseColor("#a0d9ee"), white)).toBeCloseTo(1.54, 2);
    expect(contrastRatio(parseColor("#eec6a0"), white)).toBeCloseTo(1.59, 2);
    expect(contrastRatio(parseColor("#52bae0"), parseColor("#eef1f6"))).toBeCloseTo(1.96, 2);
  });
});

// ── the tiers themselves ────────────────────────────────────────────────────

describe("every generated colour clears its floor in light, for every hue", () => {
  it("reads the words at 4.5:1 and draws the graphics at 3:1, worst hue, worst bed", () => {
    for (const site of SITES) {
      if (site.role === "decoration") continue;
      const l = lightnessOf("light", site.token);
      const w = worst(site, l, "light");
      expect(w.ratio, `${site.name} @${l}% worst on ${w.bed} at h=${w.hue}`)
        .toBeGreaterThanOrEqual(FLOOR[site.role]);
    }
  });

  it("holds against --panel and --bg specifically, which is where the audit looked", () => {
    const beds = surfaces("light");
    for (const site of SITES) {
      if (site.role === "decoration") continue;
      const l = lightnessOf("light", site.token);
      for (const bed of ["--panel", "--bg"]) {
        expect(worstHue(site.s, l, site.alpha, beds[bed]).ratio, `${site.name} on light ${bed}`)
          .toBeGreaterThanOrEqual(FLOOR[site.role]);
      }
    }
  });

  it("is the fix and not a rounding — every one of them failed before", () => {
    // The same sweep against the lightness JS used to hard-code. Six of the
    // eight #330 measured sat between 1.05:1 and 1.82:1 on this canvas; none
    // reached its floor, and the two rims could not have. One of the eight, the
    // topbar's MCP legend dot, has since left the app; the rest still answer.
    for (const site of SITES) {
      const w = worst(site, site.was, "light");
      expect(w.ratio, `${site.name} at the old ${site.was}%`).toBeLessThan(NON_TEXT);
    }
  });
});

describe("the dark theme did not move", () => {
  it("keeps the exact lightness every one of these had before #330", () => {
    // The issue fixes light and pins dark. A tier that drifts here redraws the
    // canvas the app is used on, which is a regression however good the number.
    for (const site of SITES) {
      expect(lightnessOf("dark", site.token), `dark ${site.token}`).toBe(site.was);
    }
  });

  it("keeps the ratios that came with them, to the second decimal", () => {
    const l = (t: string) => lightnessOf("dark", t);
    expect(worst(SITES[0], l("--session-label-l"), "dark").ratio).toBeCloseTo(7.52, 2);
    expect(worst(SITES[1], l("--session-accent-l"), "dark").ratio).toBeCloseTo(3.13, 2);
    expect(worst(SITES[2], l("--session-edge-l"), "dark").ratio).toBeCloseTo(5.74, 2);
    expect(worst(SITES[3], l("--session-edge-idle-l"), "dark").ratio).toBeCloseTo(3.18, 2);
    // 4.17 is the reading the retired legend dot carried too — its worst bed
    // was --panel, which is this stripe's only one — so removing that site left
    // the tier's pinned dark number exactly where it was.
    expect(worst(SITES[4], l("--mcp-dot-l"), "dark").ratio).toBeCloseTo(4.17, 2);
    expect(worst(SITES[5], l("--session-rim-l"), "dark").ratio).toBeCloseTo(1.51, 2);
    expect(worst(SITES[6], l("--session-rim-l"), "dark").ratio).toBeCloseTo(1.25, 2);
  });

  it("leaves the one dark shortfall #330 named standing, on the record", () => {
    // hsl(h 70% 60%) is 3.13:1 on --panel and .tokens-meta / .spawn-badge are
    // text, so the node accent was thin in dark before this change and still
    // is. Lifting it means editing the dark theme, which this issue forbids in
    // as many words — so it is pinned rather than skipped, and the day dark is
    // allowed to move, this line is what asks the question again.
    const site = SITES[1];
    const w = worst(site, lightnessOf("dark", site.token), "dark");
    expect(w.ratio).toBeCloseTo(3.13, 2);
    expect(w.ratio).toBeLessThan(BODY);
    expect(w.bed).toBe("--panel");
    // Light, which #330 does own, is where it now clears the floor it never met.
    expect(worst(site, lightnessOf("light", site.token), "light").ratio).toBeGreaterThanOrEqual(BODY);
  });
});

describe("the two rims stay decoration, and the arithmetic says why", () => {
  it("could not reach 1.4.11 at any lightness, because the alpha caps it first", () => {
    // Pure black is as far as a wash can go. At 32% over white that composites
    // to 2.19:1 — a ceiling under the 3:1 floor — so no tier exists to pick.
    const white = parseColor("#ffffff");
    expect(contrastRatio(over([0, 0, 0, 0.32], white), white)).toBeLessThan(NON_TEXT);
    for (const site of SITES.filter(s => s.role === "decoration")) {
      let best = 0;
      for (let l = 0; l <= 100; l += 0.5) best = Math.max(best, worst(site, l, "light").ratio);
      if (site.alpha === 0.32) expect(best, site.name).toBeLessThan(NON_TEXT);
      // The label's rim COULD, at 9% lightness — which is ink, not a hue, and
      // the rim exists to say which session the label belongs to.
      if (site.alpha === 0.5) expect(best, site.name).toBeGreaterThan(NON_TEXT);
    }
  });

  it("carries at least the weight in light that the same rule carries in dark", () => {
    // Not a WCAG floor — parity. A rim that reads on #0b0c10 and vanishes on
    // #eef1f6 is the same defect as the label, one order of magnitude quieter.
    for (const site of SITES.filter(s => s.role === "decoration")) {
      const inDark = worst(site, lightnessOf("dark", site.token), "dark").ratio;
      const inLight = worst(site, lightnessOf("light", site.token), "light").ratio;
      expect(inLight, `${site.name}: ${inLight.toFixed(2)} light vs ${inDark.toFixed(2)} dark`)
        .toBeGreaterThanOrEqual(inDark);
    }
  });

  it("leaves the 4% card wash on one lightness, because a tier would buy nothing", () => {
    // 1.01:1 on either canvas. Splitting it per theme is arithmetic with
    // nothing on the other side, so the sheet writes the number once.
    const wash = /hsl\(var\(--session-hue[^)]*\) 70% 50% \/ 0\.04\)/;
    expect(decl(".cluster-card", "background")).toMatch(wash);
    for (const theme of themes) {
      const bed = surfaces(theme)["--bg"];
      expect(worstHue(70, 50, 0.04, bed).ratio).toBeLessThan(1.02);
    }
  });
});

describe("the hue still tells two sessions apart, which is what it is for", () => {
  it("keeps a full step of colour between hues 30° apart, in both themes", () => {
    // Contrast is against the paper; this is against each other. A tier dark
    // enough to read can still be dark enough to collapse, and that would
    // trade one defect for another.
    for (const site of SITES.filter(s => s.role !== "decoration")) {
      for (const theme of themes) {
        const l = lightnessOf(theme, site.token);
        let min = Infinity;
        for (let h = 0; h < 360; h++) min = Math.min(min, deltaE(hsl(h, site.s, l), hsl((h + 30) % 360, site.s, l)));
        expect(min, `${theme} ${site.name} ΔE at 30°`).toBeGreaterThan(6);
      }
    }
  });

  it("keeps more than half of what dark separates, having paid for the contrast", () => {
    // Some is spent and that is honest: a mid-dark tier has less room to swing
    // than a pale one. Measured ΔE at 30°, dark → light: label 10.75 → 9.26,
    // node accent 15.86 → 9.26, live edge 14.50 → 9.65, settled edge 13.95 →
    // 11.07, dot 14.49 → 10.68. The floor is what stops a future tier from
    // buying its ratio by walking every hue toward the same near-black.
    for (const site of SITES.filter(s => s.role !== "decoration")) {
      const sep = (theme: Theme) => {
        const l = lightnessOf(theme, site.token);
        let min = Infinity;
        for (let h = 0; h < 360; h++) min = Math.min(min, deltaE(hsl(h, site.s, l), hsl((h + 30) % 360, site.s, l)));
        return min;
      };
      expect(sep("light") / sep("dark"), `${site.name}`).toBeGreaterThan(0.5);
    }
  });
});

// ── the boundary itself ─────────────────────────────────────────────────────

describe("the colour is composed on the CSS side of the theme boundary", () => {
  it("leaves no module under src/web building a colour at all", () => {
    // The defect was never a wrong number, it was a number in the wrong file.
    // Nothing under src/web composes hsl() any more; the components emit a hue
    // and the sheet does the rest, which is the only reason data-theme reaches
    // any of these at all.
    //
    // #378: this ran over the four files in COMPONENTS, which is the four that
    // had the defect — the other twelve .tsx and every .ts beside them could
    // compose colours freely. Measured: a template literal building
    // `hsl(200 70% 62%)` inside SessionList.tsx passed every test in the repo.
    // The tree is walked now, the way control-edges.test.ts walks it, so a file
    // that does not exist yet is covered by the same line.
    const files = modulesUnder(web);
    expect(files.length, "the walk found nothing — src/web moved").toBeGreaterThan(12);
    for (const path of files) {
      expect(readFileSync(path, "utf8"), `${path.slice(web.length)} composes a colour`)
        .not.toMatch(/hsl\(/);
    }
    // The four the audit named are still among them, so the walk cannot quietly
    // stop reaching the files this rule was written about.
    for (const name of Object.keys(COMPONENTS)) {
      expect(files.some(p => p.endsWith(name)), `${name} is no longer in the walk`).toBe(true);
    }
  });

  it("hands each site its hue as a custom property and nothing else", () => {
    expect(COMPONENTS["SessionClusters.tsx"]).toMatch(/"--session-hue": hue/);
    expect(COMPONENTS["AgentNode.tsx"]).toMatch(/"--session-hue": hue/);
    expect(COMPONENTS["App.tsx"]).toMatch(/"--session-hue": hue/);
    // App's --mcp-hue was the topbar legend's dot until that row was removed;
    // the MCP category chip hands its hue across the same boundary the same
    // way, so the rule this line states is unchanged and still has a subject.
    expect(COMPONENTS["App.tsx"]).toMatch(/"--mcp-hue": hue/);
    expect(COMPONENTS["ToolBursts.tsx"]).toMatch(/"--mcp-hue": b\.mcpHue/);
  });

  it("builds every one of them from a tier the sheet declares for both themes", () => {
    // The declaration has to name a var() for the lightness: an hsl() with a
    // literal there is the original bug wearing a stylesheet.
    const spec = (value: string) =>
      /hsl\(\s*var\(\s*--(?:session|mcp)-hue[^)]*\)\s+(\d+)%\s+var\(\s*(--[\w-]+)\s*\)\s*(?:\/\s*([\d.]+)\s*)?\)/.exec(value);
    const found = new Map<string, ReturnType<typeof spec>>();
    for (const [prop, site] of [
      ["color", SITES[0]], ["--accent", SITES[1]], ["stroke", SITES[2]], ["stroke", SITES[3]],
      ["--cat-accent", SITES[4]], ["border", SITES[5]], ["border", SITES[6]],
    ] as Array<[string, Site]>) {
      const value = decl(site.where, prop);
      expect(value, `${site.where} { ${prop} }`).toBeTruthy();
      const m = spec(value!);
      expect(m, `${site.name}: ${value}`).toBeTruthy();
      expect(+m![1], `${site.name} saturation`).toBe(site.s);
      expect(m![2], `${site.name} tier`).toBe(site.token);
      expect(m![3] === undefined ? 1 : +m![3], `${site.name} alpha`).toBe(site.alpha);
      found.set(site.name, m);
    }
    // Not "seven were checked" — the loop above ran seven times by
    // construction, so this only ever said that no two SITES share a name. It
    // does catch a SITES that has grown or shrunk without the pairing list
    // following it, which is how the retired legend dot was kept honest.
    // What proves the sheet holds no eighth is the sweep in the next case.
    expect(found.size, "two SITES share a name, so one of them was never checked").toBe(SITES.length);
    for (const theme of themes) {
      for (const site of SITES) expect(() => lightnessOf(theme, site.token), `${theme} ${site.token}`).not.toThrow();
    }
  });

  it("puts a tier in the lightness slot of every hue the SHEET composes, not just the eight named here", () => {
    // #378. `SITES` is hand-written and the check above walks it, so the sheet
    // was only ever asked about colours somebody had already remembered to
    // list. Measured: adding `.sl-waiting-count { border-color: hsl(var(
    // --session-hue, 200) 70% 62%); }` — a hard-coded lightness, which is the
    // literal defect #330 exists to remove — left all 1849 tests green.
    //
    // So the enumeration runs the other way now: every hue-composed colour in
    // the stylesheet has to put a `var(--…-l)` in its lightness slot, and a new
    // one arrives already covered rather than arriving unnoticed.
    //
    // One exemption, named rather than pattern-matched. `.cluster-card`'s 4%
    // background wash is 1.01:1 on either canvas, so a per-theme tier would be
    // arithmetic with nothing on the other side — the case above proves that
    // ceiling rather than asserting the exemption, and this is the only rule
    // the sheet is allowed to write a literal lightness in.
    const EXEMPT = ".cluster-card";
    const TIER = /^var\(\s*--[\w-]+-l\s*\)$/;
    expect(HUE_SITES.length, "the sweep found no hue-composed colours at all — the walk is broken")
      .toBeGreaterThanOrEqual(SITES.length);

    const literals = HUE_SITES.filter(site => !TIER.test(site.lightness));
    for (const site of literals) {
      expect(site.selector, `${site.selector} composes hsl(${site.call}) — the lightness is a literal, so data-theme cannot reach it`)
        .toBe(EXEMPT);
      expect(site.call, `${EXEMPT} is exempt for its 4% wash, not for a second colour`)
        .toMatch(/70%\s+50%\s*\/\s*0\.04\s*$/);
    }
    // Exactly one, so the exemption cannot widen by a rule being added beside
    // it — .cluster-card also carries a compliant border, and "that selector is
    // allowed literals" would have let the border go back to being one.
    expect(literals, "more than one rule writes a literal lightness").toHaveLength(1);

    // …and every tier it names is declared in both themes, which is what makes
    // the cascade able to answer at all.
    for (const site of HUE_SITES) {
      const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(site.lightness)?.[1];
      if (!token) continue;
      for (const theme of themes) {
        expect(() => lightnessOf(theme, token), `${theme} declares no ${token}`).not.toThrow();
      }
    }
  });

  it("gives every hsl() in the sheet a fallback hue, so a missing one is not a dropped rule", () => {
    // A var() with no value makes the whole declaration invalid at computed-
    // value time and the property silently falls back to inherit/initial — a
    // cluster card with no border rather than a visible mistake.
    for (const [, value] of bare.matchAll(/hsl\(\s*var\(\s*(--(?:session|mcp)-hue[^)]*)\)/g)) {
      expect(value, `hsl(var(${value}))`).toMatch(/,\s*\d+\s*$/);
    }
  });

  it("outranks the two rules an inline stroke used to shadow", () => {
    // .react-flow__edge.animated and the light-theme .react-flow__edge-path
    // both set stroke at 0-3-0. The inline style App used to write beat them
    // by being inline; the replacement has to beat them on specificity, which
    // is why both edge classes are in the selector.
    for (const site of [SITES[2], SITES[3]]) {
      expect(site.where.split(".").length - 1, site.where).toBeGreaterThanOrEqual(4);
    }
    expect(COMPONENTS["App.tsx"]).toMatch(/a\.state === "active" \? "sess-live" : "sess-idle"/);
    expect(decl(".react-flow__edge.animated .react-flow__edge-path", "stroke")).toBe("var(--inflight)");
  });
});

describe("hover keeps its direction when the tier flips", () => {
  /** CSS filter shorthands run in sRGB, so brightness is a plain multiply. */
  const brightness = (c: Rgba, k: number): Rgba =>
    [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k), c[3]];

  const amount = (selector: string) => {
    const m = /brightness\(([\d.]+)\)/.exec(decl(selector, "filter") ?? "");
    if (!m) throw new Error(`no brightness on ${selector}`);
    return +m[1];
  };

  it("brightens on the dark canvas and deepens on the light one", () => {
    expect(amount(".cluster-label:hover")).toBeGreaterThan(1);
    expect(amount(".cluster-label.dragging")).toBeGreaterThan(1);
    expect(amount(':root[data-theme="light"] .cluster-label:hover')).toBeLessThan(1);
    expect(amount(':root[data-theme="light"] .cluster-label.dragging')).toBeLessThan(1);
  });

  it("never lets a hovered or dragged label drop under 4.5:1, at any hue", () => {
    // filter applies to the whole pill, so its own background moves with the
    // text. On white, brightness(1.25) cannot lift the paper and only washes
    // out the words: 5.18:1 down to 3.53:1 at the worst hue, which is the
    // regression the light override exists to avoid.
    for (const theme of themes) {
      const l = lightnessOf(theme, "--session-label-l");
      // The pill paints --bg in dark and --bg-soft in light (styles.css).
      const pill = surfaces(theme)[theme === "dark" ? "--bg" : "--bg-soft"];
      for (const state of [":hover", ".dragging"]) {
        const k = amount(theme === "dark" ? `.cluster-label${state}` : `:root[data-theme="light"] .cluster-label${state}`);
        for (let h = 0; h < 360; h++) {
          const ratio = contrastRatio(brightness(hsl(h, 70, l), k), brightness(pill, k));
          expect(ratio, `${theme} label ${state} h=${h}`).toBeGreaterThanOrEqual(BODY);
        }
      }
    }
    // And the number the override was sized against, so it is not a guess.
    const white = parseColor("#ffffff");
    const worstLight = worstHue(70, lightnessOf("light", "--session-label-l"), 1, white);
    expect(worstLight.ratio).toBeCloseTo(5.18, 2);
    expect(contrastRatio(brightness(hsl(worstLight.hue, 70, 26), 1.25), white)).toBeCloseTo(3.53, 2);
  });
});
