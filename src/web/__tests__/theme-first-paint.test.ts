// #331: a light-theme user saw the dark deck on every single load.
//
// The attribute the whole stylesheet keys on was written from a useEffect, and
// effects run after the browser has painted. Worse, the sheet's first rule is
// `:root, :root[data-theme="dark"]`, so the attribute-less frame is not an
// unstyled one the eye forgives as loading — it is the finished dark deck,
// `color-scheme: dark` included, which drags the browser's own scrollbars and
// form controls along with it. Those are chrome, not CSS: they repaint on their
// own schedule and the correction is visible.
//
// The preference was already known synchronously — App reads it in a useState
// initialiser — so only the DOM write was late, and no bundle can make it early
// enough: the entry is a module script, module scripts are deferred, and the
// browser may paint while that chunk is still in flight. The fix is a classic
// inline script in <head>, which is parser-blocking and therefore runs before a
// frame exists.
//
// That script cannot import theme.ts — an import would make it a module and
// defer it again, which is the bug — so the rule is written twice. Rather than
// trust the two copies to stay in step, this suite EXECUTES the inlined text
// against a fake window and compares its answer to resolveTheme() over the same
// inputs, throwing store included. Plain node, no DOM: `new Function` with
// `window` and `document` as parameters shadows the globals the script reaches
// for, so the browser is never involved.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTheme, storedTheme, THEME_KEY, type Theme } from "../theme";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const html = read("../index.html");
const app = read("../App.tsx");
const css = read("../styles.css");

/** The bootstrap's body, and where it sits. A `<script>` with no attributes at
 *  all is the whole point: Vite rewrites only the tags carrying a `src` or a
 *  `type="module"`, and the browser defers only those same two, so "no
 *  attributes" is simultaneously what survives the build and what beats the
 *  paint. */
function bootstrapOf(source: string): { body: string; at: number } {
  const m = /<script>([\s\S]*?)<\/script>/.exec(source);
  if (!m) throw new Error("no attribute-less inline <script> in the document");
  return { body: m[1], at: m.index };
}

type Refusal = "getter" | "getItem" | "missing";

/**
 * Runs the shipped bootstrap over one store and reports the data-theme it
 * wrote, plus the key it asked for.
 *
 * `stored` is the value the tab has; a Refusal instead models a browser that
 * will not hand the store over — the getter itself raising SecurityError under
 * "Block All Cookies" is the real-world case, and the one a try around getItem
 * alone would miss.
 */
function boot(stored: string | null | Refusal): { applied?: string; asked?: string } {
  const out: { applied?: string; asked?: string } = {};
  const refuse = () => { throw new Error("SecurityError: The operation is insecure."); };
  const store = { getItem: (key: string) => { out.asked = key; return stored as string | null; } };

  const window = Object.defineProperty({}, "localStorage",
    stored === "getter" ? { get: refuse }
    : stored === "getItem" ? { value: { getItem: refuse } }
    : stored === "missing" ? { value: undefined }
    : { value: store });

  const document = { documentElement: {
    setAttribute(name: string, value: string) { if (name === "data-theme") out.applied = value; },
  } };

  new Function("window", "document", bootstrapOf(html).body)(window, document);
  return out;
}

describe("resolveTheme", () => {
  it("treats only the exact string light as light", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("falls back to dark for a value nothing wrote or this version cannot read", () => {
    // null is both "never chosen" and "store refused" — readStored collapses
    // the two — and an unknown string is what a future version could leave
    // behind. All three land on the default the sheet already paints.
    for (const value of [null, undefined, "", "LIGHT", "system", "purple"]) {
      expect(resolveTheme(value)).toBe("dark");
    }
  });

  it("gives the deck a theme even when the browser refuses the store", () => {
    // storedTheme goes through readStored, whose guard wraps the localStorage
    // property read itself. Nothing here may throw: App calls this from a
    // useState initialiser and src/web has no error boundary, so a throw
    // escaping it rejects root.render() and leaves a blank deck.
    const glob = globalThis as unknown as Record<string, unknown>;
    glob.window = Object.defineProperty({}, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError: The operation is insecure."); },
    });
    try {
      expect(() => storedTheme()).not.toThrow();
      expect(storedTheme()).toBe("dark");
    } finally { delete glob.window; }
  });
});

describe("the inline bootstrap in index.html", () => {
  it("runs before the module script that renders the app", () => {
    // The ordering IS the fix. main.tsx cannot host this: `<script
    // type="module">` is deferred, so it executes after the parse and the
    // browser is free to paint the stylesheet's default first.
    const module = html.indexOf('<script type="module"');
    expect(module).toBeGreaterThan(-1);
    expect(bootstrapOf(html).at).toBeLessThan(module);
  });

  it("sits in <head>, where the parser reaches it before any element can paint", () => {
    expect(bootstrapOf(html).at).toBeLessThan(html.indexOf("</head>"));
  });

  it("applies the stored preference on the very first parse", () => {
    expect(boot("light")).toEqual({ applied: "light", asked: THEME_KEY });
    expect(boot("dark").applied).toBe("dark");
  });

  it("asks for the key every other version of the deck wrote", () => {
    // A renamed key throws nothing and logs nothing: it reads as an empty store
    // and silently discards the choice of everyone upgrading into this build.
    expect(boot("light").asked).toBe("agent-dag.theme");
    expect(THEME_KEY).toBe("agent-dag.theme");
  });

  it("still writes a theme when the store throws, rather than stopping the parse", () => {
    // An exception escaping a parser-blocking script in <head> is not a lost
    // preference, it is a document that never gets its attribute — the dark
    // deck for a light user, permanently, on exactly the profiles that were
    // already the fragile ones.
    for (const refusal of ["getter", "getItem", "missing"] as const) {
      expect(() => boot(refusal)).not.toThrow();
      expect(boot(refusal).applied).toBe("dark");
    }
  });

  it("reaches the same answer as resolveTheme for every input, so the two copies cannot drift", () => {
    // The bootstrap is dependency-free by necessity, which makes it a second
    // implementation of one rule. This is the seam that keeps it honest.
    for (const stored of [null, "light", "dark", "", "LIGHT", "system", "purple"]) {
      const expected: Theme = resolveTheme(stored);
      expect(boot(stored).applied).toBe(expected);
    }
    expect(boot("getter").applied).toBe(resolveTheme(null));
  });

  it("adds no flash in the other direction for the default theme", () => {
    // A dark user is the untouched case only because the sheet's no-attribute
    // block and its dark block are the same block. If they are ever split, the
    // bootstrap writing "dark" starts changing the first frame too, and this is
    // the line that says so.
    expect(css).toMatch(/^\uFEFF?:root,\s*:root\[data-theme="dark"\]\s*\{/);
    expect(boot(null).applied).toBe("dark");
  });
});

describe("App", () => {
  it("starts from the same resolution the bootstrap used, not a second rule", () => {
    expect(app).toContain("useState<Theme>(storedTheme)");
    expect(app).not.toContain('readStored("agent-dag.theme")');
  });

  it("keeps the effect that persists the toggle", () => {
    // Redundant on first mount — the bootstrap already wrote that attribute
    // from that value — and deliberately not guarded: see App.tsx. Every later
    // run is the T toggle, which is the only reason it is still here.
    expect(app).toContain("document.documentElement.dataset.theme = theme");
    expect(app).toContain("window.localStorage.setItem(THEME_KEY, theme)");
  });
});

describe("the built output", () => {
  it("carries the bootstrap ahead of the bundle", () => {
    // Vite copies an attribute-less inline script through verbatim and injects
    // its own tags around it, but "verbatim" is a claim about a tool, so it is
    // checked against the real artifact when one is on disk. `npm run build`
    // runs from prepublishOnly, so the publish path always has one.
    const dist = fileURLToPath(new URL("../../../dist/web/index.html", import.meta.url));
    if (!existsSync(dist)) return;
    const built = readFileSync(dist, "utf8");
    expect(bootstrapOf(built).body).toContain(THEME_KEY);
    expect(bootstrapOf(built).at).toBeLessThan(built.indexOf('<script type="module"'));
    expect(bootstrapOf(built).at).toBeLessThan(built.indexOf("</head>"));
  });
});
