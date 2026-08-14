// Three colour tokens were doing jobs they were never bright (or dark) enough
// for, and nothing in the suite noticed because there is no DOM here to sample.
//   #262 --muted-dim is a decorative tint — 2.35:1 on --panel dark, 3.32-3.76:1
//        light — and seventeen rules were setting it as `color:` on 8-13px
//        annotation text: axis dates, the plan badge, quota reset times, the
//        add-account placeholder. Under 4.5:1 in both themes, under 3:1 in dark.
//   #268 the light-theme node rings reused the dark rules' alphas over a white
//        node and composited to 2.26:1 (done) and 3.12:1 (err) against the node
//        interior, below the 3:1 that a non-text boundary needs; and the light
//        done pill's own text sat at 4.39:1, just under AA.
//   #272 .ver-banner painted a 13% --warn wash and then wrote on it in --warn:
//        3.74:1 light over the tinted end. Its .done twin did the same with --ok.
// So the ratios are computed here from the stylesheet's own token values, and a
// palette edit that walks any of them back under its floor fails the build.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const agentNode = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");

/** WCAG 1.4.3 for body text, 1.4.11 for large text and non-text boundaries. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

/** #rgb, #rrggbb and rgba()/rgb() — the only colour forms this stylesheet writes. */
export function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** Source-over compositing, non-premultiplied, onto an already-opaque backdrop. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

export function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x relative-luminance ratio. Both arguments must already be opaque. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The declarations of the first rule whose selector starts a line verbatim —
 *  enough to keep `.agent-node.state-done` and its `:root[data-theme="light"]`
 *  override apart without modelling cascade order. */
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

/** var() one level deep, plus the `color-mix(in srgb, var(--x) N%, transparent)`
 *  form the banners use — which is just var(--x) at N% alpha. */
function resolve(value: string, theme: Theme): Rgba {
  const mix = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)/.exec(value);
  if (mix) {
    const base = resolve(TOK[theme][mix[1]], theme);
    return [base[0], base[1], base[2], +mix[2] / 100];
  }
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return parseColor(v ? TOK[theme][v[1]] : value);
}

/** Every opaque surface small text lands on: the three panel tiers plus both
 *  stops of the node gradient, since a node's top and bottom differ. */
function surfaces(theme: Theme): Array<[string, Rgba]> {
  const named: Array<[string, Rgba]> = (["--panel", "--bg-soft", "--bg"] as const)
    .map(t => [t, parseColor(TOK[theme][t])]);
  const stops = TOK[theme]["--node-grad"].match(/var\(--[\w-]+\)|#[0-9a-f]{3,6}/gi) ?? [];
  return named.concat(stops.map((s, i) => [`--node-grad stop ${i}`, resolve(s, theme)]));
}

describe("contrast maths", () => {
  it("puts white on black at the 21:1 ceiling and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#0b0c10"), parseColor("#0b0c10"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("does not care which colour is passed first", () => {
    const a = parseColor("#7e828c");
    const b = parseColor("#14161b");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("composites a half-alpha white to the midpoint of white and black", () => {
    const half = over([255, 255, 255, 0.5], parseColor("#000000"));
    expect(half.slice(0, 3)).toEqual([127.5, 127.5, 127.5]);
    expect(over([255, 255, 255, 1], parseColor("#000000"))).toEqual([255, 255, 255, 1]);
    expect(over([255, 255, 255, 0], parseColor("#0b0c10"))).toEqual([11, 12, 16, 1]);
  });

  it("reproduces the ratios the three audits reported, from the shipped values", () => {
    // The defects, restated as arithmetic so the fixes below have a baseline.
    expect(contrastRatio(parseColor("#50535b"), parseColor("#14161b"))).toBeCloseTo(2.35, 2);
    expect(contrastRatio(parseColor("#7c8493"), parseColor("#eef1f6"))).toBeCloseTo(3.32, 2);
    expect(contrastRatio(over([21, 128, 61, 0.55], parseColor("#ffffff")), parseColor("#ffffff"))).toBeCloseTo(2.26, 2);
    expect(contrastRatio(over([185, 28, 28, 0.6], parseColor("#ffffff")), parseColor("#ffffff"))).toBeCloseTo(3.12, 2);
    expect(contrastRatio(parseColor("#b45309"), over([180, 83, 9, 0.13], parseColor("#eef1f6")))).toBeCloseTo(3.74, 2);
  });
});

describe("--text-dim, the token the annotation rules now read from (#262)", () => {
  it("is defined in both themes, because half a token is a light-theme bug", () => {
    for (const theme of themes) expect(TOK[theme]["--text-dim"], theme).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("clears 4.5:1 on every surface it can land on, in both themes", () => {
    for (const theme of themes) {
      const fg = parseColor(TOK[theme]["--text-dim"]);
      for (const [name, bg] of surfaces(theme)) {
        expect(contrastRatio(fg, bg), `${theme} --text-dim on ${name}`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("still reads as dim — never louder than --muted, the tier above it", () => {
    for (const theme of themes) {
      const panel = parseColor(TOK[theme]["--panel"]);
      const dim = contrastRatio(parseColor(TOK[theme]["--text-dim"]), panel);
      const muted = contrastRatio(parseColor(TOK[theme]["--muted"]), panel);
      expect(dim, `${theme} --text-dim vs --muted`).toBeLessThanOrEqual(muted + 1e-9);
    }
  });

  it("leaves --muted-dim alone for the decoration it was always sized for", () => {
    // Scrollbar thumb, a hover hairline, the auto-restart dot, the idle
    // sparkline bar, the session dot. None of them is text.
    expect(css).toMatch(/background: var\(--muted-dim\)/);
    expect(css).toMatch(/fill: var\(--muted-dim\)/);
    for (const theme of themes) {
      expect(contrastRatio(parseColor(TOK[theme]["--muted-dim"]), parseColor(TOK[theme]["--panel"])))
        .toBeLessThan(BODY);
    }
  });

  it("is the only dim tier that text is allowed to use — no rule sets --muted-dim as a colour", () => {
    // `border-color:` keeps it; a bare `color:` is the regression.
    const offenders = [...css.matchAll(/(^|[^-\w])color:\s*var\(--muted-dim\)/g)];
    expect(offenders.map(m => m[0].trim())).toEqual([]);
    // Fifteen, down from the seventeen #262 converted: .chips-empty went with
    // #243 as unreachable, and .ap-manage-label went when the manage block's
    // labels came off the screen — the fields keep hidden <label>s, which carry
    // no colour at all. The floor tracks deletions; a rule switching BACK to
    // --muted-dim is what the assertion above catches.
    expect([...css.matchAll(/color:\s*var\(--text-dim\)/g)].length).toBeGreaterThanOrEqual(15);
  });
});

describe("agent-node state rings (#268)", () => {
  const ringOf = (state: string, theme: Theme) => {
    const base = decl(rule(`.agent-node.state-${state}`), "border-color")!;
    const light = decl(rule(`:root[data-theme="light"] .agent-node.state-${state}`), "border-color");
    return resolve(theme === "light" && light ? light : base, theme);
  };

  it("draws every state's ring at 3:1 or better against the node it outlines", () => {
    for (const theme of themes) {
      const node = surfaces(theme).filter(([n]) => n.startsWith("--node-grad"));
      for (const state of ["active", "done", "err"]) {
        const ring = ringOf(state, theme);
        for (const [name, bg] of node) {
          expect(contrastRatio(over(ring, bg), bg), `${theme} ${state} ring on ${name}`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("holds that 3:1 against the canvas too, since the ring is the node's edge", () => {
    for (const theme of themes) {
      const canvas = parseColor(TOK[theme]["--bg"]);
      for (const state of ["active", "done", "err"]) {
        expect(contrastRatio(over(ringOf(state, theme), canvas), canvas), `${theme} ${state} ring on --bg`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("keeps the light rings opaque — an alpha tuned for #14161b vanishes on white", () => {
    for (const state of ["done", "err"]) {
      const light = decl(rule(`:root[data-theme="light"] .agent-node.state-${state}`), "border-color");
      expect(light, state).not.toMatch(/rgba\(/);
    }
  });

  it("reads every state pill's own label at 4.5:1 over its own wash", () => {
    for (const theme of themes) {
      const node = surfaces(theme).filter(([n]) => n.startsWith("--node-grad"));
      for (const state of ["active", "done", "err"]) {
        const base = rule(`.state-pill.state-${state}`);
        const light = rule(`:root[data-theme="light"] .state-pill.state-${state}`);
        const pick = (p: string) => (theme === "light" ? decl(light, p) ?? decl(base, p) : decl(base, p))!;
        const fg = resolve(pick("color"), theme);
        const wash = resolve(pick("background"), theme);
        for (const [name, bg] of node) {
          expect(contrastRatio(fg, over(wash, bg)), `${theme} ${state} pill text on ${name}`)
            .toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });

  it("never leans on the ring alone — every node spells its state out in words", () => {
    // 1.4.1: running / done / failed are near-isoluminant under red-green CVD
    // (deuteranope ΔE 4.5 light, 4.5 dark between done and err), so the ring is
    // a reinforcement. The words are the channel that actually carries it.
    expect(agentNode).toMatch(/state === "active" \? "live" : state === "done" \? "done" : "err"/);
    expect(agentNode).toMatch(/<StatePill state=\{data\.state\} \/>/);
  });

  it("keeps the three state hues from collapsing into each other", () => {
    for (const theme of themes) {
      const hues = ["--inflight", "--ok", "--err"].map(t => TOK[theme][t]);
      expect(new Set(hues).size, theme).toBe(3);
    }
  });
});

describe("version-drift banner (#272)", () => {
  const banner = rule(".ver-banner")!;

  it("writes its running text in --text, not in the accent it paints behind it", () => {
    expect(decl(banner, "color")).toBe("var(--text)");
    // .done inherits: --ok on a 13% --ok wash is the same trap, 3.75:1 light.
    expect(decl(rule(".ver-banner.done"), "color")).toBeNull();
  });

  it("clears 4.5:1 at both ends of the wash, in both themes and both states", () => {
    const wash = /(color-mix\(in srgb,\s*var\(--[\w-]+\)\s*[\d.]+%,\s*transparent\))/;
    const gradients = [
      decl(banner, "background")!,
      decl(rule(".ver-banner.done"), "background")!,
    ];
    for (const theme of themes) {
      const fg = resolve(decl(banner, "color")!, theme);
      const canvas = parseColor(TOK[theme]["--bg"]);
      for (const g of gradients) {
        const tint = resolve(wash.exec(g)![1], theme);
        expect(contrastRatio(fg, over(tint, canvas)), `${theme} tinted end of ${g.slice(0, 40)}`)
          .toBeGreaterThanOrEqual(BODY);
      }
      expect(contrastRatio(fg, canvas), `${theme} transparent end`).toBeGreaterThanOrEqual(BODY);
    }
  });

  it("leaves the accent where it is decoration — the dot still pulses in --warn", () => {
    expect(decl(rule(".ver-banner .ver-dot"), "background")).toBe("var(--warn)");
    expect(decl(rule(".ver-banner.done .ver-dot"), "background")).toBe("var(--ok)");
  });
});
