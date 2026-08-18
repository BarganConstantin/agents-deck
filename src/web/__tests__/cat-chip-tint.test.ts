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

const web = fileURLToPath(new URL("..", import.meta.url));
// Comments stripped: this file asks what the sheet DECLARES, and the rule added
// for "other" is introduced by a comment naming its own selector.
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const taxonomy = readFileSync(join(web, "tool-taxonomy.ts"), "utf8");

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

/** "#94a3b8" → [148, 163, 184]. */
const rgb = (hex: string): number[] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

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
      expect(border!.replace(/\s+/g, "")).toBe(`rgba(${r},${g},${b},0.40)`);
    });
  }
});
