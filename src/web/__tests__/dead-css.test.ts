// Eight audit findings, all the same shape: a name only one side of the app
// knows about. `var(--fg)` and `var(--mono, …)` were read by rules nothing
// defines (#241, #247); `var(--fg-dim)` was read by a component and defined by
// nobody (#242); --cat-color was declared eight times and read nowhere (#245);
// .tool-chip, .now-running and .up-quota-header outlived the markup that used
// them (#243, #244, #246); .ctx-window-num was markup with no rule (#250).
// None of it failed, which is why all eight survived: an undefined var() is
// invalid at computed-value time and quietly inherits, and a selector that
// matches nothing simply never fires. So the halves are checked against each
// other here — every custom property the stylesheet reads must be written
// somewhere, every one it writes must be read, and the class names these
// issues retired stay retired unless markup comes back with them.
//
// What it does not catch: a rule whose class is composed at runtime — the
// stylesheet is full of `cat-*`, `state-*` and `status-*` selectors reached
// from template literals, and there is no DOM here to say which of them ever
// matched. Only the names on the watchlist are checked that way, so a new
// selector going dead is still a job for the next audit.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(web, "styles.css"), "utf8");

/** Every .tsx that ends up in the bundle. The suite's own files are not markup. */
function components(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : components(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}
const tsx = components(web).map(p => readFileSync(p, "utf8")).join("\n");

/** Quoted and backticked spans only, so a class name mentioned in a comment
 *  about the design does not count as a component rendering it. */
const literals = [...tsx.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)]
  .map(m => m[1] ?? m[2] ?? m[3])
  .join("\n");

/** `--x:` in any declaration — :root, but also the per-category .tool-burst rules. */
const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
/** A whole-string token: either JS writes it as an inline style (--spawn-dx on a
 *  bubble, --rot on a confetti bit) or reads it back through cssVar(). */
const namedInJs = new Set([...tsx.matchAll(/"(--[\w-]+)"/g)].map(m => m[1]));
const readInCss = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]));
const readInTsx = new Set([...tsx.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]));

describe("custom properties have both a writer and a reader", () => {
  it("reads no property from the stylesheet that nothing anywhere writes", () => {
    expect([...readInCss].filter(t => !declared.has(t) && !namedInJs.has(t))).toEqual([]);
  });

  it("holds the components to the same rule for the var() they set inline", () => {
    expect([...readInTsx].filter(t => !declared.has(t) && !namedInJs.has(t))).toEqual([]);
  });

  it("declares no property that neither a rule nor a component ever reads", () => {
    expect([...declared].filter(t => !readInCss.has(t) && !namedInJs.has(t))).toEqual([]);
  });

  it("still sees the properties JS owns, so the writer side is not vacuous", () => {
    // These are declared nowhere in the sheet and only survive the first check
    // because ToolBursts and Confetti set them per element.
    for (const t of ["--spawn-dx", "--spawn-dy", "--dx", "--dy", "--rot", "--s"]) {
      expect(namedInJs.has(t), t).toBe(true);
      expect(declared.has(t), t).toBe(false);
    }
  });
});

/** Retired by #243, #244, #246 and #250. */
const RETIRED = [
  "chips", "tool-chip", "chips-empty", "chips-more",
  "now-running", "now-dot", "now-label", "now-tool", "now-time",
  "up-quota-header", "ctx-window-num",
];
/** Live neighbours of the retired names, several of them near-homographs. */
const LIVE = ["tool-burst", "model-chip", "cat-chip", "ctx-window-pct", "up-quota-section"];

const styled = (name: string) => new RegExp(`\\.${name}(?![\\w-])`).test(css);
const rendered = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(literals);

describe("class names are styled and rendered together, or not at all", () => {
  it("styles nothing the markup dropped", () => {
    expect(RETIRED.filter(n => styled(n) && !rendered(n))).toEqual([]);
  });

  it("renders nothing the stylesheet has no rule for", () => {
    expect(RETIRED.concat(LIVE).filter(n => rendered(n) && !styled(n))).toEqual([]);
  });

  it("finds the live neighbours on both sides, so neither detector is vacuous", () => {
    expect(LIVE.filter(n => styled(n) && rendered(n))).toEqual(LIVE);
  });
});
