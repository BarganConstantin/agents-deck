// The accounts panel's auto-switch button composed `ap-auto-state toggle${…}`,
// and no `.toggle` selector has ever existed in the stylesheet — the only two
// hits for the word there are English prose inside comments. Nothing queried it
// from the DOM either, so the token did nothing at all; and being a generic
// single-word name, it is exactly the kind a later rule could claim globally,
// at which point that button would silently pick up styling meant for something
// else. Its sibling switch, .ver-auto, shows the shape that holds: one name for
// the control, one modifier for its state, nothing a stranger would reach for.
//
// dead-css.test.ts could not have caught it. Its class half is a watchlist of
// names earlier issues retired, and "toggle" cannot join that list: the
// detector reads every quoted and backticked span in every .tsx, and this same
// panel says "this toggle takes over when you stop it" in a sentence on screen.
// One word, English in one place and markup in another. So this reads the other
// direction — class names out of the className attributes themselves, where
// prose cannot reach — and asks the stylesheet for a rule for each one.
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

/**
 * The text of every className=, brace-matched.
 *
 * A quoted attribute is itself; a braced one is the whole expression, counted
 * out to its closing brace so a ternary inside it does not cut the run short.
 */
function classAttributes(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className=/g)) {
    const start = m.index + "className=".length;
    if (src[start] === '"') {
      out.push(src.slice(start, src.indexOf('"', start + 1) + 1));
      continue;
    }
    if (src[start] !== "{") continue;
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { out.push(src.slice(start + 1, i)); break; }
    }
  }
  return out;
}

/** Drop every `${…}` run, brace-matched: SessionSummary nests a template
 *  literal inside one of them, and a lazy [^}]* cuts that in half. */
function stripInterpolations(s: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "{") { depth++; i++; continue; }
    if (depth === 0) { out += s[i]; continue; }
    if (s[i] === "{") depth++;
    else if (s[i] === "}") depth--;
  }
  return out;
}

/** What a component hard-codes as a class, per file. Names assembled at
 *  runtime leave a stub behind — `state-${…}` becomes "state-" — and those are
 *  the ones dead-css.test.ts already says nothing here can resolve. */
function classTokens(src: string): string[] {
  const literals = classAttributes(src)
    .map(stripInterpolations)
    .flatMap(a => [...a.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2] ?? m[3]));
  return [...new Set(literals.flatMap(v => v.split(/\s+/)).filter(Boolean))];
}

const files = components(web);
const styled = (name: string) => new RegExp(`\\.${name}(?![\\w-])`).test(css);
const composed = (name: string) => name.endsWith("-");
const tokens = new Map(files.map(f => [f.slice(web.length), classTokens(readFileSync(f, "utf8"))]));

describe("every class the markup hard-codes", () => {
  it("has a rule in the stylesheet behind it", () => {
    const orphans = [...tokens].flatMap(([file, names]) =>
      names.filter(n => !composed(n) && !styled(n)).map(n => `${file}: ${n}`));
    expect(orphans).toEqual([]);
  });

  it("names the auto-switch button after itself and its state, the way .ver-auto does", () => {
    const panel = readFileSync(join(web, "components/AccountsPanel.tsx"), "utf8");
    expect(panel).toContain('`ap-auto-state${auto.enabled ? " live" : ""}`');
    expect(readFileSync(join(web, "App.tsx"), "utf8")).toContain('`ver-auto${autoRestart ? " on" : ""}`');
  });

  it("is read from enough files, and enough of them, for the sweep to mean something", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(tokens.get("components/AccountsPanel.tsx")).toContain("ap-auto-state");
    expect(tokens.get("components/AccountsPanel.tsx")).toContain("ap-refresh");
    expect(tokens.get("App.tsx")).toContain("topbar");
  });

  it("leaves the runtime-composed prefixes out, since no DOM here can say what they became", () => {
    const stubs = [...tokens].flatMap(([, names]) => names.filter(composed));
    expect([...new Set(stubs)].sort()).toEqual(["cat-", "state-", "status-"]);
  });
});
