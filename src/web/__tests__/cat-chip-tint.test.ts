// One category, two visual identities (#383).
//
// A tool's bucket is drawn on two surfaces: the bubble on the canvas
// (`.tool-burst.cat-*`, which sets a `--cat-accent`) and the chip in the detail
// panel's activity strip (`.cat-chip.cat-*`, which tints its border). Both class
// names are composed at runtime — `cat-${c}` in App.tsx and ToolBursts.tsx — so
// `unstyled-class.test.ts` deliberately leaves the whole `cat-` prefix out of its
// sweep ("no DOM here can say what they became"), and nothing else asked whether
// the eight members of the union each had a rule.
//
// Seven did. `.cat-chip.cat-other` did not, while `.tool-burst.cat-other` did, so
// the one bucket EVERY unknown tool lands in — `categoryFor` returns "other" for
// any name with no row — was tinted grey on the bubble and left on the default
// `--line` border on the chip.
//
// So this file does not assert that one selector exists. It reads the list of
// categories off the `ToolCategory` union in tool-taxonomy.ts and holds both
// families to it, which means a ninth member fails here until it is styled rather
// than shipping untinted on whichever surface was forgotten. And it checks the
// chip against the bubble's own accent rather than against a colour written down
// here, so the fix for a gap like this cannot be a colour that matches neither.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { collectBursts, hashHue, mcpChipIdentity } from "../components/ToolBursts";
import type { AgentNodeData, ToolCall } from "../types";

const web = fileURLToPath(new URL("..", import.meta.url));
// Comments stripped: this file asks what the sheet DECLARES, and the rule added
// for "other" is introduced by a comment naming its own selector.
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const taxonomy = readFileSync(join(web, "tool-taxonomy.ts"), "utf8");
const app = readFileSync(join(web, "App.tsx"), "utf8");

/** The categories, from the union itself — never a list maintained here. */
const CATEGORIES: string[] = (() => {
  // `[^;]*` spans newlines of either flavour, so a CRLF checkout reads the same.
  const decl = /export type ToolCategory\s*=([^;]*);/.exec(taxonomy);
  if (!decl) throw new Error("ToolCategory union not found in tool-taxonomy.ts");
  return [...decl[1].matchAll(/"([a-z][a-z0-9-]*)"/g)].map(m => m[1]);
})();

/** Every `<prefix>.cat-<name>` rule body in the sheet, by category. */
function rulesFor(prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  // The name must run straight into the brace, so the compound
  // `.tool-burst.cat-mcp.mcp-hue` (an hsl() override, not the base accent) is
  // not mistaken for the `mcp` rule itself.
  const re = new RegExp(`\\.${prefix}\\.cat-([a-z][a-z0-9-]*)\\s*\\{([^}]*)\\}`, "g");
  for (const m of css.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

const CHIPS = rulesFor("cat-chip");
const BURSTS = rulesFor("tool-burst");

const decl = (body: string | undefined, prop: string): string | null => {
  if (body === undefined) return null;
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;}]*)`).exec(body);
  return m ? m[1].trim() : null;
};

/** The body of one rule, named by its whole compound selector — the two `.mcp-hue`
 *  rules below are not in either family map above, on purpose: they are overrides
 *  of an accent rather than the accent itself. */
function ruleFor(selector: string): string | undefined {
  const re = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return re.exec(css)?.[1];
}

/** "#94a3b8" → [148, 163, 184]. */
const rgb = (hex: string): number[] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/** Whitespace-insensitive, the way the alpha assertion above is: the sheet's
 *  spacing is not what any of this is about. */
const tight = (s: string) => s.replace(/\s+/g, "");

describe("the ToolCategory union, as this test reads it", () => {
  it("comes off the declaration in tool-taxonomy.ts and has every member", () => {
    // Sorted, so the assertion is about membership and not declaration order —
    // the order itself is pinned where it matters, by DETAIL_CAT_EMOJI's keys.
    expect([...CATEGORIES].sort()).toEqual(
      ["agent", "file", "mcp", "other", "plan", "shell", "task", "web"],
    );
  });
});

describe("every category is tinted on both surfaces it is drawn on", () => {
  it("gives the chip family and the bubble family the same members", () => {
    // The defect stated as one line: a category on one list and not the other.
    expect([...CHIPS.keys()].sort()).toEqual([...BURSTS.keys()].sort());
  });

  for (const cat of CATEGORIES) {
    it(`.tool-burst.cat-${cat} declares an accent colour`, () => {
      const accent = decl(BURSTS.get(cat), "--cat-accent");
      // Asked before the match, so a missing RULE says so rather than failing
      // as "toMatch expected a string and got null".
      expect(accent, `no .tool-burst.cat-${cat} rule with a --cat-accent`).toBeTruthy();
      expect(accent).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it(`.cat-chip.cat-${cat} declares a border colour`, () => {
      const border = decl(CHIPS.get(cat), "border-color");
      expect(border, `no .cat-chip.cat-${cat} rule with a border-color`).toBeTruthy();
      expect(border).toMatch(/^rgba\(/);
    });

    it(`the ${cat} chip borrows its bubble's accent rather than a colour of its own`, () => {
      const accent = decl(BURSTS.get(cat), "--cat-accent");
      const border = decl(CHIPS.get(cat), "border-color");
      expect(accent, `no --cat-accent for ${cat}`).toBeTruthy();
      expect(border, `no border-color for .cat-chip.cat-${cat}`).toBeTruthy();
      const [r, g, b] = rgb(accent!);
      // Whitespace-insensitive: the sheet writes these without spaces today,
      // and a reformat should not be a failure.
      expect(tight(border!)).toBe(`rgba(${r},${g},${b},0.40)`);
    });
  }
});

// ── #489: one category, two DEGREES of identity ─────────────────────────────
//
// The round after the gap above, found while closing it. Seven of the eight
// buckets are one colour on both surfaces and that is the whole of their
// identity. `mcp` is not: `.tool-burst.cat-mcp.mcp-hue` hashes an unrecognised
// server's name to a hue, so two such servers on the canvas are two colours,
// while every MCP chip in the detail panel was the same generic teal whichever
// server it counted. Same defect family — one category, two visual identities —
// except that here the surfaces disagree about how MUCH they distinguish.
//
// It is not a mechanical copy of the bubble's rule, because the chip is a COUNT
// ACROSS SERVERS and three servers have no single hue between them. It is the
// one case where the two surfaces describe the same thing: when every MCP call
// an agent made went to ONE server, the chip wears what those bubbles wear. And
// it wears it through `primaryDisplayFor`, the function that dressed the
// bubbles — a second implementation of the mapping is how the two drifted apart
// in the first place, so the assertions below are that the chip's hue IS the
// bubble's hue for the same tool name, not that both match a number written
// down here.

/** The declarations of the two rules that carry the hued case. */
const BURST_HUED = ruleFor(".tool-burst.cat-mcp.mcp-hue");
const CHIP_HUED = ruleFor(".cat-chip.cat-mcp.mcp-hue");

describe("the MCP chip's per-server tint, in the stylesheet", () => {
  it("exists at all, which is the defect stated as one line", () => {
    expect(BURST_HUED, "the bubble's hued rule is gone — this issue's premise").toBeTruthy();
    expect(CHIP_HUED, "no .cat-chip.cat-mcp.mcp-hue rule").toBeTruthy();
  });

  it("is the bubble's own accent at the alpha every chip border carries", () => {
    // The same claim the seven literals are held to, for the eighth's hued
    // case: derived from the bubble's declaration rather than restated. So a
    // change to the hue, the saturation or the lightness tier on one surface
    // cannot leave the other behind — there is one expression and this asserts
    // the chip's is it.
    const accent = decl(BURST_HUED, "--cat-accent")!;
    const border = decl(CHIP_HUED, "border-color")!;
    // The alpha comes off the generic MCP chip beside it, not out of this file.
    const generic = tight(decl(CHIPS.get("mcp"), "border-color")!);
    const alpha = /,([\d.]+)\)$/.exec(generic)![1];
    expect(alpha).toBe("0.40");
    expect(tight(border)).toBe(`${tight(accent).replace(/\)$/, "")}/${alpha})`);
  });

  it("stays out of the family maps, so the seven-literal sweep still means what it says", () => {
    // `rulesFor` requires the category name to run straight into the brace.
    // Both hued rules are compounds, so neither is mistaken for the base accent
    // it overrides — which is what keeps the loop above asserting `mcp` is
    // rgba(94,234,212,0.40) rather than accidentally reading this rule.
    expect(tight(CHIPS.get("mcp")!)).toContain("rgba(94,234,212,0.40)");
    expect(decl(BURSTS.get("mcp"), "--cat-accent")).toBe("#5eead4");
  });

  it("outranks the generic teal rather than tying with it", () => {
    // Both classes in the selector, for the reason the bubble's rule gives: a
    // bare `.mcp-hue` would tie with `.cat-chip.cat-mcp` on specificity and the
    // winner would be decided by source order, which is not a decision anyone
    // makes on purpose. Asserted as the rule the sheet holds rather than as a
    // string, so a reformat is not a failure.
    expect(ruleFor(".mcp-hue"), "a bare .mcp-hue rule would tie with the generic chip").toBeUndefined();
    expect(ruleFor(".cat-chip.mcp-hue"), "two classes ties, it does not win").toBeUndefined();
    expect(CHIP_HUED, "the three-class compound is the rule that carries it").toBeTruthy();
  });
});

// ── the rule itself, as a pure function ─────────────────────────────────────

const NOW = 1_000_000;

/** An agent whose tool history is exactly these names, and the MCP bubbles the
 *  canvas draws for it. `collectBursts` is the entry point the canvas layer
 *  calls, so the hue compared against below is the one a bubble really gets
 *  rather than one re-derived here. */
function canvas(names: string[]) {
  const tools: ToolCall[] = names.map((name, i) => ({
    id: `t${i}`, name, inputPreview: "", startedAt: NOW - 100,
  }));
  const agent: AgentNodeData = {
    id: "a1", sessionId: "s1", label: "a1", kind: "root", state: "active",
    startedAt: NOW - 1000, tools, prompts: [], toolCount: tools.length, childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  };
  return collectBursts(
    new Map([[agent.id, agent]]),
    new Set([agent.id]),
    new Map([[agent.id, { x: 0, y: 0 }]]),
    new Map(),
    new Map([[agent.id, { width: 260, height: 130 }]]),
    NOW,
  ).filter(b => !b.isSub && b.category === "mcp");
}

describe("which server an MCP chip is counting", () => {
  it("is nobody when the agent made no MCP calls at all", () => {
    expect(mcpChipIdentity([])).toBeNull();
    expect(mcpChipIdentity(["Bash", "Read", "Task"])).toBeNull();
  });

  it("is the server itself when every MCP call went to one, hue and words together", () => {
    const one = mcpChipIdentity(["mcp__sentry-prod__issues", "mcp__sentry-prod__events"])!;
    expect(one).toBeTruthy();
    expect(one.label).toBe("sentry-prod");
    expect(one.hue).toBe(hashHue("sentry-prod"));
    // Non-MCP calls in between are not this chip's business — it counts the mcp
    // bucket, and the rest of the strip counts the rest.
    expect(mcpChipIdentity(["Bash", "mcp__sentry-prod__issues", "Read"])!.label).toBe("sentry-prod");
  });

  it("is nobody when the count spans two servers, because a count is not an identity", () => {
    expect(mcpChipIdentity(["mcp__sentry-prod__issues", "mcp__linear__list"])).toBeNull();
    // Two servers the deck DOES know, whose bubbles are both plain teal: still
    // no single server for the chip to name, so it stays the generic chip.
    expect(mcpChipIdentity(["mcp__github__pr", "mcp__gitlab__mr"])).toBeNull();
    // And two spellings of one known server abstain rather than guess. Their
    // bubbles agree (the lookup lower-cases), the segments do not, and falling
    // back to the category's own colour is never the wrong answer.
    expect(mcpChipIdentity(["mcp__github__pr", "mcp__GitHub__issue"])).toBeNull();
  });

  it("names a server the deck has a row for, and leaves it the base accent", () => {
    // `hue` undefined is the answer, not a gap: `.tool-burst.cat-mcp.mcp-hue`
    // is never on a branded bubble either, so both surfaces are teal here and
    // the chip has said the true thing — one server, drawn by its 🐙 rather
    // than by a colour.
    const known = mcpChipIdentity(["mcp__github__create_pr"])!;
    expect(known.label).toBe("GitHub");
    expect(known.hue).toBeUndefined();
  });

  it("hands an `mcp__` with no server back as nobody, rather than as a bare colour", () => {
    // #474's territory: the segment is outside data. A nameless server would
    // leave the chip with a hue and nothing to write beside it, which is the
    // one arrangement the words exist to prevent.
    expect(mcpChipIdentity(["mcp__"])).toBeNull();
  });

  it("gives a server spelling an Object.prototype member its own hue like any other", () => {
    // The same names #474 swept, arriving as a server segment. `knownMcpServer`
    // answers with hasOwn, so these are unknown servers and the chip hues them
    // — under their own literal name, which is what the bubble draws too.
    for (const name of ["constructor", "tostring", "valueof", "hasownproperty"]) {
      const one = mcpChipIdentity([`mcp__${name}__probe`])!;
      expect(one.label, name).toBe(name);
      expect(one.hue, name).toBe(hashHue(name));
    }
  });
});

describe("the chip's hue IS the bubble's hue, drawn from the same call", () => {
  it("matches every bubble the canvas drew, for a server the deck does not know", () => {
    const names = ["mcp__supabase-local__query", "mcp__supabase-local__list_tables"];
    const bursts = canvas(names);
    expect(bursts).toHaveLength(2);
    const chip = mcpChipIdentity(names)!;
    for (const b of bursts) {
      expect(b.mcpHue, b.toolName).toBe(chip.hue);
      expect(b.name, b.toolName).toBe(chip.label);
    }
  });

  it("matches them for a server it does know, where that means no hue on either", () => {
    const names = ["mcp__linear__list_issues", "mcp__linear__create_issue"];
    const bursts = canvas(names);
    const chip = mcpChipIdentity(names)!;
    expect(bursts).toHaveLength(2);
    for (const b of bursts) {
      expect(b.mcpHue, b.toolName).toBeUndefined();
      expect(b.name, b.toolName).toBe(chip.label);
    }
    expect(chip.hue).toBeUndefined();
  });

  it("abstains exactly when the bubbles it counts stop agreeing with each other", () => {
    const names = ["mcp__supabase-local__query", "mcp__weather-mcp__forecast"];
    const hues = new Set(canvas(names).map(b => b.mcpHue));
    expect(hues.size, "the fixture no longer draws two differently hued bubbles").toBe(2);
    expect(mcpChipIdentity(names)).toBeNull();
  });

  it("is one hash and not two — the legend reads it from the same function", () => {
    // The topbar's MCP legend spelled the djb2 out a second time under a
    // comment claiming it was the same one. It is a call now, so a dot, a
    // bubble and a chip cannot disagree about what colour a server is.
    expect(app).toMatch(/hue: hashHue\(server\)/);
    expect(app).not.toMatch(/h = \(\(h << 5\) \+ h\)/);
    expect(app).toMatch(/import ToolBursts, \{ hashHue, mcpChipIdentity \} from "\.\/components\/ToolBursts";/);
    // …and it is still the hash it was, so nothing on screen moved: the values
    // the retired copy produced, restated here the way #374 restates every
    // helper it merged.
    const djb2 = (s: string) => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
      return Math.abs(h) % 360;
    };
    for (const s of ["", "github", "sentry-prod", "supabase-local", "constructor", "a".repeat(64)]) {
      expect(hashHue(s), s).toBe(djb2(s));
      expect(hashHue(s), s).toBeLessThan(360);
      expect(hashHue(s), s).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── the markup: colour is never the only carrier ────────────────────────────

describe("the words beside the tint", () => {
  it("draws the server's name whenever there is one, hue or no hue", () => {
    // 1.4.1. If the hue were the only difference between two MCP chips, a
    // dichromat reader would be looking at two identical chips — so the name is
    // rendered on there being a SERVER (`one`), while only the class and the
    // custom property are gated on there being a hue. A branded server has no
    // hue and is still named.
    expect(app).toMatch(/\{one && <span className="cat-server">\{one\.label\}<\/span>\}/);
    expect(app).toMatch(/cat-chip cat-\$\{c\}\$\{hue != null \? " mcp-hue" : ""\}/);
    expect(app).toMatch(/style=\{hue != null \? \{ "--mcp-hue": hue \} as React\.CSSProperties : undefined\}/);
  });

  it("says the same thing in the tooltip, which is where the count already lived", () => {
    expect(app).toMatch(/title=\{one \? `\$\{calls\}, all to \$\{one\.label\}` : calls\}/);
  });

  it("gives that name a rule, and one that cannot carry a uuid out of the panel", () => {
    // The segment is outside data and is routinely a uuid for an ad-hoc server.
    // A length rather than a percentage — #369's sweep rejects percentage widths
    // on bare classes, and an ellipsis that moves with the strip's contents is
    // not one anybody can predict.
    const rule = ruleFor(".cat-chip .cat-server");
    expect(rule, "no .cat-chip .cat-server rule").toBeTruthy();
    expect(decl(rule, "max-width")).toMatch(/^\d+px$/);
    expect(decl(rule, "overflow")).toBe("hidden");
    expect(decl(rule, "text-overflow")).toBe("ellipsis");
    expect(decl(rule, "white-space")).toBe("nowrap");
    // No font-size of its own: it reads at the chip's 11px, which keeps it off
    // the type ladder entirely.
    expect(decl(rule, "font-size")).toBeNull();
  });
});

// ── what the tint is worth, in both themes ──────────────────────────────────
//
// The colour arithmetic, which is also the argument for why the name beside it
// is not decoration. Every chip border in this block is a 40% wash, and a 40%
// wash has a ceiling: pure black over the light chip is 2.85:1 and pure white
// over the dark one is 3.82:1, so no border here reaches 1.4.11's 3:1 in both
// themes at any colour whatsoever. That is true of the seven literals too —
// this is the family's existing weight, not something the hue spends.
//
// What the hue COULD have spent is the separation it exists for, and the sweep
// below is the one that settles the tier: in dark there is no lightness at all
// at which this edge both clears the weakest literal chip border and keeps two
// servers 30° apart telling themselves apart. So the tint stays at the tier its
// bubble uses, it is reinforcement, and the words carry the distinction.
//
// The maths is re-declared here rather than imported from contrast-floors or
// session-hue: importing a *.test.ts registers its suites into this file too.

type Rgba = [number, number, number, number];

const parseColor = (input: string): Rgba => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
};

/** CSS Color 4's hsl-to-rgb, which is what the browser runs on these values. */
function hslColor(h: number, s: number, l: number, a = 1): Rgba {
  const sat = s / 100, lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const c = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - c * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [255 * f(0), 255 * f(8), 255 * f(4), a];
}

const over = (fg: Rgba, bg: Rgba): Rgba =>
  [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;

function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIE76 ΔE — the question contrast cannot answer: are two servers' tints still
 *  different colours, or have they collapsed toward the same near-paper wash? */
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

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

function tokens(theme: Theme): Record<string, string> {
  const head = theme === "dark" ? ':root,\\s*:root\\[data-theme="dark"\\]' : ':root\\[data-theme="light"\\]';
  const block = new RegExp(`${head}\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no ${theme} token block in styles.css`);
  const out: Record<string, string> = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: tokens("dark"), light: tokens("light") };

/** The lightness tier the chip's hued border reads, per theme. */
function tierOf(theme: Theme): number {
  const token = /var\(\s*(--[\w-]+)\s*\)/.exec(decl(CHIP_HUED, "border-color")!)![1];
  const pct = /^([\d.]+)%$/.exec(TOK[theme][token]);
  if (!pct) throw new Error(`${theme} declares no lightness for ${token}`);
  return +pct[1];
}

/** The chip paints its own background under its border, so that is the bed. */
const CHIP_BED = (theme: Theme) => parseColor(TOK[theme][/^var\((--[\w-]+)\)$/.exec(decl(ruleFor(".cat-chip"), "background")!)![1]]);

/** The alpha the whole family carries, taken off the generic MCP chip. */
const CHIP_ALPHA = +/,([\d.]+)\)$/.exec(tight(decl(CHIPS.get("mcp"), "border-color")!))![1];

/** Worst and best of all 360 hues against one bed — the hue is a hash away from
 *  any of them, so a sweep is the only honest measurement. */
function sweep(l: number, bed: Rgba) {
  let worst = Infinity, worstHue = -1, best = 0, bestHue = -1, separation = Infinity;
  for (let h = 0; h < 360; h++) {
    const edge = over(hslColor(h, 65, l, CHIP_ALPHA), bed);
    const r = contrastRatio(edge, bed);
    if (r < worst) { worst = r; worstHue = h; }
    if (r > best) { best = r; bestHue = h; }
    separation = Math.min(separation, deltaE(edge, over(hslColor((h + 30) % 360, 65, l, CHIP_ALPHA), bed)));
  }
  return { worst, worstHue, best, bestHue, separation };
}

/** Every literal chip border, composited on its own chip. */
const literalEdges = (theme: Theme) => CATEGORIES.map(cat => {
  const [r, g, b] = rgb(decl(BURSTS.get(cat), "--cat-accent")!);
  const bed = CHIP_BED(theme);
  return { cat, ratio: contrastRatio(over([r, g, b, CHIP_ALPHA], bed), bed) };
});

describe("the per-server tint, measured on both canvases", () => {
  it("takes its saturation and its tier from the bubble, so there is one colour to measure", () => {
    expect(CHIP_ALPHA).toBe(0.4);
    expect(decl(CHIP_HUED, "border-color")).toMatch(/hsl\(var\(--mcp-hue, 170\) 65% var\(--mcp-dot-l\) \/ 0\.40\)/);
    expect(tierOf("dark")).toBe(65);
    expect(tierOf("light")).toBe(32);
  });

  it("reads on the white canvas better than any chip border already there", () => {
    // #330 gave this tier its light value (32%) by sweeping every hue against
    // the strictest surface it lands on; the eight literals are dark-theme
    // pastels used unchanged on white, and they all but disappear there. The
    // hued edge at its WORST hue still beats the strongest of them.
    const light = sweep(tierOf("light"), CHIP_BED("light"));
    expect(light.worst).toBeCloseTo(1.60, 2);
    expect(light.best).toBeCloseTo(2.38, 2);
    const strongestLiteral = Math.max(...literalEdges("light").map(e => e.ratio));
    expect(strongestLiteral).toBeCloseTo(1.40, 2);
    expect(light.worst).toBeGreaterThan(strongestLiteral);
  });

  it("sits inside the family's own band on the dark one, and dips below it at cold hues", () => {
    // Pinned rather than asserted as a floor, because it is a real cost and the
    // case below is the proof that it cannot be bought off. The literals span
    // 2.16:1 (other) to 3.04:1 (task) here; the hue spans 1.67:1 at h=240 to
    // 3.05:1 at h=60, so the coldest servers draw a fainter edge than the
    // faintest category does.
    const dark = sweep(tierOf("dark"), CHIP_BED("dark"));
    expect(dark.worst).toBeCloseTo(1.67, 2);
    expect(dark.worstHue).toBe(240);
    expect(dark.best).toBeCloseTo(3.05, 2);
    const band = literalEdges("dark").map(e => e.ratio);
    expect(Math.min(...band)).toBeCloseTo(2.16, 2);
    expect(Math.max(...band)).toBeCloseTo(3.04, 2);
    expect(dark.best).toBeGreaterThan(Math.max(...band));
  });

  it("cannot buy that back at any lightness without collapsing the hue itself", () => {
    // The whole of the design decision, as arithmetic. Sweeping every lightness
    // in dark: none of them both clears the weakest literal border (2.16:1) and
    // keeps a 30° hue step at the ΔE > 6 session-hue.test.ts holds its own tiers
    // to. The best a readable-enough tier can do is 1.89:1, at L=70.5%, and by
    // 80% — where the ratio finally clears the band — two servers 30° apart are
    // 4.3 ΔE from each other, which is a colour that has stopped identifying
    // anything. A per-server hue that cannot tell servers apart is not a
    // quieter version of this feature, it is the absence of it.
    const bed = CHIP_BED("dark");
    let bothAt: number | null = null;
    let bestReadable = 0;
    for (let l = 0; l <= 100; l += 0.5) {
      const s = sweep(l, bed);
      if (s.separation > 6) bestReadable = Math.max(bestReadable, s.worst);
      if (s.worst >= 2.16 && s.separation > 6) bothAt ??= l;
    }
    expect(bothAt, "a lightness now satisfies both — the tier should be revisited").toBeNull();
    expect(bestReadable).toBeLessThan(2.16);
    expect(bestReadable).toBeCloseTo(1.89, 2);
    expect(sweep(80, bed).separation).toBeLessThan(6);
  });

  it("keeps two servers 30° apart looking like two servers, in both themes", () => {
    // Contrast is against the paper; this is against each other, and it is the
    // property the chip is hued FOR. Same floor session-hue.test.ts sets for
    // every generated colour in the app.
    for (const theme of THEMES) {
      expect(sweep(tierOf(theme), CHIP_BED(theme)).separation, theme).toBeGreaterThan(6);
    }
  });

  it("reads the server's name at 4.5:1, which is the channel that carries it", () => {
    // The tint is reinforcement; these words are the distinction. So they get
    // the body-text floor, on the chip's own background, in both themes —
    // 4.91:1 dark and 7.87:1 light as shipped.
    const colour = decl(ruleFor(".cat-chip .cat-server"), "color")!;
    const token = /^var\((--[\w-]+)\)$/.exec(colour)![1];
    for (const theme of THEMES) {
      const ratio = contrastRatio(parseColor(TOK[theme][token]), CHIP_BED(theme));
      expect(ratio, `${theme} ${token} on the chip`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(parseColor(TOK.dark[token]), CHIP_BED("dark"))).toBeCloseTo(4.91, 2);
    expect(contrastRatio(parseColor(TOK.light[token]), CHIP_BED("light"))).toBeCloseTo(7.87, 2);
  });

  it("agrees with the ends everybody already knows, so the sweep is trustworthy", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
    expect(hslColor(0, 100, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(deltaE(hslColor(200, 65, 50), hslColor(200, 65, 50))).toBeCloseTo(0, 9);
    // And the ceiling that puts every 40% border in this block out of 1.4.11's
    // reach whatever colour it is — the reason none of them is asserted to 3:1.
    expect(contrastRatio(over([0, 0, 0, CHIP_ALPHA], CHIP_BED("light")), CHIP_BED("light"))).toBeLessThan(3);
    expect(contrastRatio(over([255, 255, 255, CHIP_ALPHA], CHIP_BED("dark")), CHIP_BED("dark"))).toBeLessThan(4);
  });
});
