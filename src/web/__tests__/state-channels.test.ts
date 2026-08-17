// #373: the state of a session and the outcome of a tool call were each drawn
// as one dot in one of three hues, and the dot was hidden from assistive tech.
//
// The visual half. Every hue clears 1.4.11 against the panel it is drawn on —
//
//   state          dark, on --panel / --bg-soft      light, on --panel / --bg-soft
//   active         10.29 / 10.73                     6.98 / 6.98
//   done           12.89 / 13.45                     5.42 / 5.42
//   err             9.54 /  9.95                     6.47 / 6.47
//
// — so nothing here was ever a boundary failure, exactly as in #370. What none
// of it does is separate the three states from EACH OTHER:
//
//   pair                    dark      light
//   active vs done          1.25:1    1.29:1
//   active vs err           1.08:1    1.08:1
//   done vs err             1.35:1    1.19:1
//
// A WCAG ratio is computed from relative luminance and nothing else, so those
// six numbers ARE the greyscale test: at 1.08:1 a running session and a failed
// one are the same grey, and done against err — the red/green pair, the worst
// one to lean on — is 1.35:1 dark and 1.19:1 light. Well under the 3:1 a
// non-text difference needs, in both themes, on every bed.
//
// The semantic half. `SessionList` and `UsagePanel` marked the dot aria-hidden
// and put the state nowhere else, so the row announced "vcrm-core Opus 5 9
// tools $3.66 waiting 19s" and a reader was told everything about the session
// except whether it was alive. `ToolRow`'s dot was not even aria-hidden, but an
// empty <span> has nothing to contribute to a name either: a failed call and a
// finished one both said "Bash 1.2s".
//
// And a third defect the report did not have: every `.sl-dot` rule was scoped
// to `.session-list`, while `UsagePanel` renders that class in a panel that is
// the sidebar's SIBLING. Those dots matched no rule at all and were drawn as
// zero-sized empty spans — not hue-only, nothing at all.
//
// The fix is the deck's own two answers, not new ones. The second channel is
// the mark: ✓ and × are what a tool bubble on the canvas has drawn for done and
// err since ToolBursts existed, and they read the same in greyscale, under
// every colour vision deficiency and with motion turned off — the shape channel
// #370 reached for when it flipped a toggle's polarity rather than tinting it
// harder. The spoken channel is a visually-hidden word in the same utility
// AccountsPanel already uses, sharing one vocabulary with the card's StatePill.
//
// Plain node, no DOM — React cannot be rendered in this suite — so this reads
// styles.css and the markup the way manage-block.test.ts, control-edges.test.ts
// and toggle-state.test.ts do, and computes every ratio from the sheet's own
// token values. The helpers are re-declared rather than imported from another
// *.test.ts: importing one registers its suites into this file as well.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const cssRaw = readFileSync(join(web, "styles.css"), "utf8");
/** Comments quote the declarations they explain — including the ones this file
 *  asserts are gone — so every read of the sheet goes through the stripped copy. */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

/** A component's markup with its commentary gone, for the same reason: the
 *  comments added here argue about `aria-label`, `title` and `ap-vh` by name. */
function markup(...path: string[]): string {
  return readFileSync(join(web, ...path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}
const app = markup("App.tsx");
const agentNode = markup("components", "AgentNode.tsx");
const sessionList = markup("components", "SessionList.tsx");
const usagePanel = markup("components", "UsagePanel.tsx");
const toolModal = markup("components", "ToolModal.tsx");
const bursts = markup("components", "ToolBursts.tsx");

/** WCAG 1.4.3 for a glyph read as text, 1.4.11 for a mark read as an icon. */
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

/** WCAG 2.x relative-luminance ratio. Both arguments must already be opaque.
 *  Luminance is all it looks at, which is why it doubles as the greyscale
 *  test: two colours that a monochrome print cannot separate score 1:1 here. */
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

/** Top-level rules only. A @media body is a different cascade — and a mark that
 *  only exists inside one is a mark that some readers never get. */
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

const has = (selector: string) => RULES.some(r => selectors(r.selector).includes(selector));

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

/** var() one level deep, plus the color-mix form the control tokens use. */
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

/** Every opaque bed one of these dots is painted on, read from the rules that
 *  paint them rather than named here: the sidebar and the usage panel and the
 *  detail panel are all --panel, and a hovered or selected session row lays
 *  --bg-soft over it. Both are opaque in both themes. */
function beds(theme: Theme): Array<[string, Rgba]> {
  const named = [
    ["the session list", decl(".session-list", "background")!],
    ["the usage panel", decl(".usage-panel", "background")!],
    ["the detail panel", decl(".detail", "background")!],
    ["a hovered session row", decl(".session-list .sl-row:hover", "background")!],
  ] as const;
  return named.map(([name, value]) => [name, resolve(value, theme)]);
}

/** The two dot families, as the sheet writes them: the base rule, the state
 *  rules, and the ::before that draws the mark. */
const FAMILIES = [
  { name: "the session dot", base: ".sl-dot", states: ["state-active", "state-done", "state-err"],
    hues: { "state-active": "--inflight", "state-done": "--ok", "state-err": "--err" } },
  { name: "the tool dot", base: ".detail .tool .name .status-dot", states: ["inflight", "done", "err"],
    hues: { inflight: "--inflight", done: "--ok", err: "--err" } },
] as const;

/** What a state draws in the mark slot: its own `content` if it declares one,
 *  the family's base `content` if it does not. */
function contentOf(base: string, state: string): string {
  const own = has(`${base}.${state}::before`) ? declIn(bodyOf(`${base}.${state}::before`), "content") : null;
  return (own ?? declIn(bodyOf(`${base}::before`), "content")!).trim();
}

describe("the contrast maths, against the two ends everybody knows", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#86efac"), parseColor("#86efac"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });
});

describe("what the hue was worth as a state (#373)", () => {
  // Literals, not tokens: this is the shipped v1.33.152 palette restated as
  // arithmetic, and a baseline that moved with the palette would not be one.
  const DARK = { active: "#f0abfc", done: "#86efac", err: "#fca5a5", panel: "#14161b", soft: "#0f1116" };
  const LIGHT = { active: "#7e22ce", done: "#157a3a", err: "#b91c1c", panel: "#ffffff", soft: "#ffffff" };
  const r = (a: string, b: string) => +contrastRatio(parseColor(a), parseColor(b)).toFixed(2);

  it("agrees each dot was perfectly visible — no state was ever a 1.4.11 failure", () => {
    expect([r(DARK.active, DARK.panel), r(DARK.done, DARK.panel), r(DARK.err, DARK.panel)])
      .toEqual([10.29, 12.89, 9.54]);
    expect([r(DARK.active, DARK.soft), r(DARK.done, DARK.soft), r(DARK.err, DARK.soft)])
      .toEqual([10.73, 13.45, 9.95]);
    expect([r(LIGHT.active, LIGHT.panel), r(LIGHT.done, LIGHT.panel), r(LIGHT.err, LIGHT.panel)])
      .toEqual([6.98, 5.42, 6.47]);
  });

  it("and that none of them could be told from another — the defect is the difference", () => {
    // A luminance ratio is exactly what survives a greyscale conversion, so
    // these six numbers are the greyscale test rather than a proxy for it.
    expect([r(DARK.active, DARK.done), r(DARK.active, DARK.err), r(DARK.done, DARK.err)])
      .toEqual([1.25, 1.08, 1.35]);
    expect([r(LIGHT.active, LIGHT.done), r(LIGHT.active, LIGHT.err), r(LIGHT.done, LIGHT.err)])
      .toEqual([1.29, 1.08, 1.19]);
    for (const pair of [[DARK.active, DARK.err], [DARK.done, DARK.err], [LIGHT.active, LIGHT.err], [LIGHT.done, LIGHT.err]]) {
      expect(r(pair[0], pair[1]), `${pair[0]} vs ${pair[1]}`).toBeLessThan(NON_TEXT);
    }
  });

  it("shows no re-tune of the palette could have fixed it on its own", () => {
    // The cheap answer is to pull the three hues apart in luminance until they
    // clear 3:1 from each other. Three states need two 3:1 steps between the
    // outer pair, which is a 9:1 spread — and every one of them also has to
    // stay at 3:1 against its own bed. On white the darkest usable colour is
    // black at 21:1, so the brightest of the three would sit at 21/9 = 2.33:1
    // against the paper, under its own floor. The three hues also mean the same
    // three things on the canvas, in the node rings and in the state pills, so
    // the re-tune would not have been local to a dot.
    const spread = NON_TEXT * NON_TEXT;
    const brightest = contrastRatio(parseColor("#000000"), parseColor("#ffffff")) / spread;
    expect(brightest).toBeLessThan(NON_TEXT);
  });
});

describe("every state now draws a mark, and the mark is the canvas's own", () => {
  it("draws ✓ and × for done and err, the two marks a tool bubble already draws", () => {
    // Read out of ToolBursts rather than typed here, so the list and the canvas
    // cannot drift into two vocabularies for one outcome.
    expect(bursts).toMatch(/className="tb-mark done">✓</);
    expect(bursts).toMatch(/className="tb-mark err">×</);
    for (const { base, states } of FAMILIES) {
      expect(contentOf(base, states[1]), `${base} done`).toBe('"✓"');
      expect(contentOf(base, states[2]), `${base} err`).toBe('"×"');
    }
  });

  it("keeps the running state a dot — a shape that is neither mark", () => {
    for (const { base, states } of FAMILIES) {
      expect(contentOf(base, states[0]), `${base} running`).toBe('""');
      expect(declIn(bodyOf(`${base}::before`), "border-radius"), base).toBe("50%");
    }
  });

  it("gives each family three distinct silhouettes, in the resting cascade", () => {
    // topLevel() skips every @-rule, so a `content` that only existed inside a
    // media query would not be found at all — the mark is unconditional or it
    // is not a channel.
    for (const { name, base, states } of FAMILIES) {
      const marks = states.map(s => contentOf(base, s));
      expect(new Set(marks).size, `${name}: ${marks.join(" ")}`).toBe(3);
    }
  });

  it("does not lean on the pulse, which prefers-reduced-motion turns off", () => {
    // The running dot animates, and that animation is the one channel a reader
    // can switch off. It is decoration on top of the shape, so the three states
    // stay three shapes with every animation stripped out.
    for (const { base, states } of FAMILIES) {
      for (const s of states) {
        const own = has(`${base}.${s}::before`) ? bodyOf(`${base}.${s}::before`) : "";
        expect(declIn(own, "content") ?? declIn(bodyOf(`${base}::before`), "content"), `${base}.${s}`)
          .not.toBeNull();
      }
    }
    const reduced = /@media \(prefers-reduced-motion: reduce\)/.test(css);
    expect(reduced, "the sheet still honours reduced motion").toBe(true);
    for (const [, body] of css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)) {
      expect(body, "no state mark is declared behind a motion preference").not.toMatch(/sl-dot|status-dot/);
    }
  });

  it("stopped carrying the state in a background hue", () => {
    // The old shape, and the one this issue is about: three rules whose entire
    // difference was `background: var(--ok)` against `background: var(--err)`.
    for (const { base, states } of FAMILIES) {
      for (const s of states) {
        if (!has(`${base}.${s}`)) continue;
        expect(declIn(bodyOf(`${base}.${s}`), "background"), `${base}.${s}`).toBeNull();
      }
    }
  });
});

describe("the mark is as visible as the dot it replaced", () => {
  it("clears 4.5:1 on every bed in both themes — the floor for a glyph, not just an icon", () => {
    // A ✓ is an icon and 1.4.11's 3:1 is the rule that covers it, but it is
    // drawn as a character in a font, so the stricter reading is the honest one
    // and every state clears it anyway.
    for (const theme of themes) {
      for (const { name, base, states, hues } of FAMILIES) {
        for (const s of states) {
          const declared = decl(`${base}.${s}`, "color")!;
          expect(declared, `${base}.${s} colour`).toBe(`var(${hues[s as keyof typeof hues]})`);
          for (const [bedName, bed] of beds(theme)) {
            expect(contrastRatio(resolve(declared, theme), bed), `${theme} ${name} ${s} on ${bedName}`)
              .toBeGreaterThanOrEqual(BODY);
          }
        }
      }
    }
  });

  it("draws the mark and the dot out of one colour, so they cannot drift", () => {
    for (const { base } of FAMILIES) {
      expect(declIn(bodyOf(`${base}::before`), "background"), base).toBe("currentColor");
    }
  });

  it("leaves the unreachable fallback readable rather than decorative", () => {
    // AgentState is a closed union of three, so nothing renders a bare .sl-dot.
    // It is still a state dot, and #262 is explicit that --muted-dim is a tint
    // and not a foreground — 2.35:1 in dark, which is the value this replaced.
    expect(decl(".sl-dot", "color")).toBe("var(--muted)");
    for (const theme of themes) {
      for (const [bedName, bed] of beds(theme)) {
        expect(contrastRatio(resolve("var(--muted)", theme), bed), `${theme} fallback on ${bedName}`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
    expect(contrastRatio(parseColor("#50535b"), parseColor("#14161b"))).toBeCloseTo(2.35, 2);
  });
});

describe("the usage panel's dot reaches a rule at all", () => {
  it("scopes no .sl-dot rule to the sidebar it is not always inside", () => {
    // The second defect, and the one nothing in the suite could have caught:
    // unstyled-class.test.ts asks whether `.sl-dot` is styled ANYWHERE, and it
    // was — under `.session-list`, which the usage panel is a sibling of. Every
    // dot in its `By session` list was a zero-sized empty span.
    const dotRules = RULES.flatMap(r => selectors(r.selector)).filter(s => /\.sl-dot\b/.test(s));
    expect(dotRules.length).toBeGreaterThanOrEqual(6);
    expect(dotRules.filter(s => s.includes(".session-list"))).toEqual([]);
    expect(has(".sl-dot")).toBe(true);
  });

  it("still renders it from both components, which is why the scope had to go", () => {
    expect(sessionList).toMatch(/className=\{`sl-dot state-\$\{r\.state\}`\}/);
    expect(usagePanel).toMatch(/className=\{`sl-dot state-\$\{s\.state\}`\}/);
    // …and the panels are siblings in App, not one inside the other.
    expect(app).toMatch(/\{usagePanelOpen && \(\s*<UsagePanel/);
    expect(app).toMatch(/\{sessionListOpen && \(\s*<SessionList/);
  });
});

describe("what a reader is told, now that the dot is decoration everywhere", () => {
  /** Every dot this app renders, from every component, with its tag. */
  function dots(): Array<{ file: string; tag: string }> {
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : files(path);
      return path.endsWith(".tsx") ? [path] : [];
    });
    return files(web).flatMap(path => {
      const src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return [...src.matchAll(/<span className=(?:"|\{`)(?:sl-dot|status-dot)[^>]*>/g)]
        .map(m => ({ file: path.slice(web.length), tag: m[0] }));
    });
  }

  it("marks every one of them aria-hidden, in every component that draws one", () => {
    // Including the ones that already announced nothing. The stylesheet writes
    // the ✓ and the × with `content:`, and generated content IS spoken by some
    // readers — so a dot left exposed would read its mark and then the word
    // beside it said the same thing again.
    const all = dots();
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all.filter(d => !/aria-hidden/.test(d.tag)).map(d => `${d.file}: ${d.tag}`)).toEqual([]);
  });

  it("puts the word where the dot is, so it is heard in the order it is seen", () => {
    expect(sessionList).toMatch(/<span className=\{`sl-dot state-\$\{r\.state\}`\} aria-hidden \/>\s*<span className="vis-hidden">\{stateLabel\(r\.state\)\}<\/span>/);
    expect(usagePanel).toMatch(/<span className=\{`sl-dot state-\$\{s\.state\}`\} aria-hidden \/>\s*<span className="vis-hidden">\{stateLabel\(s\.state\)\}<\/span>/);
    expect(app).toMatch(/<span className=\{`status-dot \$\{status\}`\} aria-hidden \/>\s*<span className="vis-hidden">\{TOOL_STATUS_LABEL\[status\]\}<\/span>/);
  });

  it("says it in one vocabulary, shared with the word already on the card", () => {
    // A card that reads `live` beside a row that reads `running` is one state
    // with two names. StatePill and both lists go through the same function.
    expect(agentNode).toMatch(/export function stateLabel\(state: AgentNodeData\["state"\]\): string/);
    expect(agentNode).toMatch(/state === "active" \? "live" : state === "done" \? "done" : "err"/);
    expect(agentNode).toMatch(/<span className=\{`state-pill state-\$\{state\}`\}>\{stateLabel\(state\)\}<\/span>/);
    for (const [name, src] of [["SessionList", sessionList], ["UsagePanel", usagePanel]] as const) {
      expect(src, name).toMatch(/import \{[^}]*\bstateLabel\b[^}]*\} from "\.\/AgentNode"/);
      expect(src, `${name} re-states the vocabulary`).not.toMatch(/\? "live"/);
    }
  });

  it("names a tool's outcome in the words the tool modal already prints", () => {
    // Not stateLabel's: a tool call is not a session. `in-flight` is what the
    // modal writes where the duration goes and `error` is what it tags the
    // response with, and both predate this change.
    expect(app).toMatch(/const TOOL_STATUS_LABEL = \{ inflight: "in-flight", done: "done", err: "error" \} as const;/);
    expect(toolModal).toMatch(/return "in-flight…";/);
    expect(toolModal).toMatch(/<span className="err-tag">error<\/span>/);
  });

  it("left the row's name to its contents — no aria-label, and no reliance on title", () => {
    // An aria-label on the row would replace the whole computed name, so the
    // label, model, tool count, cost and clock would have to be rebuilt inside
    // it and kept in step forever. A title is not a substitute either: for an
    // element with contents it is only the fallback the name computation never
    // reaches, and this row already has one pointed at something else.
    // The opening tag, taken as everything from `<button` to the first child
    // rather than to the first `>`: an arrow function in an onClick puts a `>`
    // inside the attribute list.
    const row = /<button\s+type="button"\s+key=\{r\.sessionId\}[\s\S]*?<span/.exec(sessionList)![0];
    expect(row).not.toMatch(/aria-label/);
    expect(row).toMatch(/title=\{`Focus \$\{r\.label\}`\}/);
    const toolRow = /<button className="tool clickable"[^>]*>/.exec(app)![0];
    expect(toolRow).not.toMatch(/aria-label/);
  });
});

describe("the visually-hidden utility, now that four surfaces read it", () => {
  it("hides from the eye and from nothing else", () => {
    // display:none and visibility:hidden take an element out of the
    // accessibility tree too, which would put the state back where it was.
    expect(decl(".vis-hidden", "position")).toBe("absolute");
    expect(decl(".vis-hidden", "clip-path")).toBe("inset(50%)");
    expect(decl(".vis-hidden", "display")).not.toBe("none");
    expect(decl(".vis-hidden", "visibility")).toBeNull();
    expect(parseFloat(decl(".vis-hidden", "width")!)).toBeLessThanOrEqual(1);
    expect(parseFloat(decl(".vis-hidden", "height")!)).toBeLessThanOrEqual(1);
  });

  it("dropped the panel prefix rather than lending three panels a private name", () => {
    expect(css).not.toMatch(/\.ap-vh\b/);
    for (const src of [app, sessionList, usagePanel, markup("components", "AccountsPanel.tsx")]) {
      expect(src).not.toMatch(/ap-vh/);
    }
    expect(markup("components", "AccountsPanel.tsx")).toMatch(/className="vis-hidden"/);
  });
});
