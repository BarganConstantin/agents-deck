// #357: reduced motion stopped at the canvas edge, and two transitions were
// written from JS where no rule in the sheet could ever reach them.
//
// #260 built the canvas half of the contract and canvas-motion.test.ts polices
// it, but that sweep is deliberately fenced to selectors matching its CANVAS
// regex. Outside the fence four panel readouts went on easing a LAYOUT property
// — `.qb-fill` and `.ctx-window-fill` on width, `.qb-pace-marker` on left,
// `.uh-bar` on height — each of them driven by a number that changes on its own
// schedule, so a reader who asked the OS for less motion watched bars slide and
// a marker walk sideways at moments they neither chose nor could predict. The
// tool modal arrived on `popIn`, which lifts it 4px and scales it up.
//
// Worse, `src/web/App.tsx` set `transition: "opacity 500ms ease, stroke-width
// 200ms ease"` on every session edge and `ContextModal.tsx` set `transition:
// "stroke-dasharray 400ms ease"` on the donut arc, both as INLINE styles. An
// inline style outranks every selector, so no `@media (prefers-reduced-motion:
// reduce)` block could answer either one without `!important`: the contract was
// unenforceable there by construction. Both now name a custom property that
// styles.css owns and the media query rewrites.
//
// So this file is the sweep canvas-motion.test.ts stops at, widened to the
// whole sheet and continued into the components:
//
//   1. every rule that eases a layout property is answered under reduced
//      motion by a rule of the same selector, placed later so it wins the tie
//      (a media query adds no specificity);
//   2. every rule whose animation runs keyframes that MOVE the element is
//      answered the same way — derived from the keyframes rather than from a
//      list of selectors, so the `pulse` dots stay out on the merits (pulse
//      animates opacity and nothing else, and a fade is the recommended
//      reduced-motion fallback rather than the thing being escaped) and any
//      dot that ever starts moving is caught rather than grandfathered;
//   3. nothing sets motion from JS without an escape hatch the sheet controls.
//
// There is no jsdom here and React cannot be rendered, so the sources are the
// evidence. Everything below re-derives its own parser rather than importing
// one: a test that borrowed another test's collector would go green whenever
// that one was loosened.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const rawCss = readFileSync(join(web, "styles.css"), "utf8");
/** Comments in this sheet quote the declarations they explain, so they are
 *  blanked before anything is parsed — but blanked to spaces rather than cut,
 *  so a rule's reported line number still points at the rule. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const lineOf = (at: number) => css.slice(0, at).split("\n").length;

type Rule = { selector: string; body: string; reduced: boolean; at: number };

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Flat rule list. @keyframes are collected separately — their `0%`/`to` are
 *  not selectors — and every other at-rule is descended into, carrying the
 *  reduced-motion flag and an absolute source position down with it. */
function collect(src: string, base: number, reduced: boolean, out: Rule[]): Rule[] {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (prelude.startsWith("@keyframes")) {
      // not a rule
    } else if (prelude.startsWith("@")) {
      collect(inner, base + open + 1, reduced || /prefers-reduced-motion\s*:\s*reduce/.test(prelude), out);
    } else if (prelude) {
      out.push({ selector: prelude, body: inner, reduced, at: base + open });
    }
    i = end + 1;
  }
  return out;
}

const all = collect(css, 0, false, []);
const reducedRules = all.filter(r => r.reduced);

/** Commas inside cubic-bezier() and color-mix() are not list separators. */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`).exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
};

/** Property names from a `transition` shorthand — the first token of each part.
 *  A value that is a single `var()` reference names no property here; the
 *  custom property it points at is checked on its own further down. */
const transitioned = (value: string | null): string[] => {
  if (value == null || value === "none") return [];
  return splitTop(value).map(p => p.split(/\s/)[0]).filter(p => p !== "none" && !p.startsWith("var("));
};

/** Properties that lay the element out: changing one moves it, or resizes it,
 *  and does it on the main thread. `transform` is NOT here — the press
 *  convention scales a control on :active and is neutralised by taking the
 *  transform away rather than the transition, which canvas-motion.test.ts
 *  already holds every control to. */
const LAYOUT = new Set([
  "top", "left", "right", "bottom", "inset", "width", "height", "margin", "all",
]);

/** Properties that can change without the element going anywhere, so a
 *  transition may keep them under reduced motion. Stroke GEOMETRY is absent on
 *  purpose: `stroke-width` and `stroke-dasharray` redraw the shape. */
const STILL = new Set([
  "opacity", "color", "background", "background-color", "border-color",
  "box-shadow", "filter", "fill", "stroke", "outline-color",
]);

/** Every selector in a list, normalised so two spellings of one selector match. */
const selectors = (rule: Rule): string[] =>
  splitTop(rule.selector).map(s => s.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim());

/** Keyframe name → whether running it carries the element somewhere. A
 *  declaration inside a keyframe follows `{` as often as `;`, so both count as
 *  its left boundary. */
const MOVED_BY_KEYFRAME = /(?:^|[;{])\s*(transform|translate|rotate|scale|top|left|right|bottom|inset|width|height|margin)\s*:/;
const keyframes = new Map<string, boolean>();
for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
  const [body] = block(css, m.index! + m[0].length - 1);
  keyframes.set(m[1], MOVED_BY_KEYFRAME.test(body));
}

/** Selector → the reduced-motion rules that redeclare it, in source order. */
const answers = new Map<string, Rule[]>();
for (const rule of reducedRules) {
  for (const sel of selectors(rule)) {
    if (!answers.has(sel)) answers.set(sel, []);
    answers.get(sel)!.push(rule);
  }
}
const answeredAfter = (sel: string, at: number) => (answers.get(sel) ?? []).some(r => r.at > at);

/** The one animation in the app that is switched off in JS instead of in the
 *  sheet, and the file that has to keep doing it for the exclusion to hold. */
const CONFETTI = ".confetti-bit";
const confetti = readFileSync(join(web, "components/Confetti.tsx"), "utf8");

type Moving = { sel: string; why: string; at: number };
const easesLayout: Moving[] = [];
const animatesMovement: Moving[] = [];
for (const rule of all) {
  if (rule.reduced) continue;
  const animation = decl(rule.body, "animation") ?? decl(rule.body, "animation-name");
  const names = animation && animation !== "none"
    ? splitTop(animation).map(part => part.split(/\s+/).find(tok => keyframes.has(tok))).filter(Boolean) as string[]
    : [];
  const travels = transitioned(decl(rule.body, "transition")).filter(p => LAYOUT.has(p));
  for (const sel of selectors(rule)) {
    if (travels.length) easesLayout.push({ sel, why: `transition: ${travels.join(", ")}`, at: rule.at });
    if (names.some(n => keyframes.get(n))) animatesMovement.push({ sel, why: `animation: ${names.join(", ")}`, at: rule.at });
  }
}

const describeUncovered = (m: Moving) => `styles.css:${lineOf(m.at)} ${m.sel} — ${m.why}`;

describe("reduced motion reaches the whole deck, not only the canvas", () => {
  it("answers every rule that eases a layout property", () => {
    const uncovered = easesLayout.filter(m => !answeredAfter(m.sel, m.at));
    expect(uncovered.map(describeUncovered)).toEqual([]);
  });

  it("answers every rule whose keyframes carry the element somewhere", () => {
    // Confetti is the documented exception and it is answered in JS, which the
    // assertion below keeps honest.
    const uncovered = animatesMovement
      .filter(m => m.sel !== CONFETTI)
      .filter(m => !answeredAfter(m.sel, m.at));
    expect(uncovered.map(describeUncovered)).toEqual([]);
  });

  it("earns the confetti exclusion by checking the gate that replaces it", () => {
    // A burst is pure celebration, so it is removed rather than slowed — but
    // only because the component refuses to render it. If that ever goes, the
    // exclusion above has to go with it.
    expect(animatesMovement.some(m => m.sel === CONFETTI), CONFETTI).toBe(true);
    expect(confetti).toMatch(/matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
    expect(confetti).toMatch(/if\s*\(reduced\)\s*return/);
  });

  it("leaves a pulse alone, because opacity is the fallback and not the fault", () => {
    // The seven live dots are the reason this sweep reads keyframes rather than
    // selectors: `pulse` changes opacity and nothing else, so it never enters
    // either list and no exclusion has to be written down for it. If a dot is
    // ever given travel, it appears in the sweep above on its own.
    expect(keyframes.get("pulse")).toBe(false);
    expect(keyframes.get("fadeIn")).toBe(false);
    const pulsing = all.filter(r => !r.reduced && /\bpulse\b/.test(decl(r.body, "animation") ?? ""));
    expect(pulsing.length).toBeGreaterThanOrEqual(7);
  });

  it("sees the motion it sweeps for, so a passing run means something", () => {
    // If a rename ever slips the sheet past these regexes, this collapses first.
    expect(keyframes.size).toBeGreaterThan(15);
    expect([...keyframes.values()].filter(Boolean).length).toBeGreaterThan(10);
    expect(easesLayout.length).toBeGreaterThanOrEqual(6);
    expect(animatesMovement.length).toBeGreaterThan(20);
    // The five #357 found, by name: four layout eases and one modal entrance.
    for (const sel of [".ctx-window-fill", ".qb-fill", ".qb-pace-marker", ".uh-bar"]) {
      expect(easesLayout.some(m => m.sel === sel), sel).toBe(true);
    }
    expect(animatesMovement.some(m => m.sel === ".modal"), ".modal").toBe(true);
  });

  it("keeps the modal an entrance rather than deleting it", () => {
    // A dialog that is simply present on the next frame reads as a rendering
    // fault; the canvas block already collapses entrances to a 140ms fade and
    // the modal joins that convention, matched to its own backdrop.
    const answer = (answers.get(".modal") ?? []).at(-1)!;
    expect(decl(answer.body, "animation")).toMatch(/fadeIn 140ms/);
    expect(decl(all.find(r => r.selector === ".modal-backdrop")!.body, "animation")).toMatch(/fadeIn 140ms/);
  });

  it("stops the four readouts dead rather than easing them more slowly", () => {
    // Half the travel is still travel arriving unannounced. The number is the
    // information; the journey to it is not.
    for (const sel of [".ctx-window-fill", ".qb-fill", ".qb-pace-marker", ".uh-bar"]) {
      const answer = (answers.get(sel) ?? []).at(-1)!;
      expect(decl(answer.body, "transition"), sel).toBe("none");
    }
  });
});

/** Every component source, comments removed. Full-line `//` only, which is how
 *  every comment in these two files is written — the point is that the comments
 *  quote the literal transition strings they replaced, so a search for "no
 *  literal transition survives" would find its own explanation and pass. */
function componentSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const full = join(dir, entry.name);
      const shown = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(full, `${shown}/`);
      else if (entry.name.endsWith(".tsx")) {
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
        out.push({ path: shown, code });
      }
    }
  };
  walk(web, "");
  return out;
}

const sources = componentSources();

describe("nothing sets motion from JS without an escape hatch the sheet owns", () => {
  it("reads enough components for the sweep to be worth anything", () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.some(s => s.path === "App.tsx")).toBe(true);
    expect(sources.some(s => s.path === "components/ContextModal.tsx")).toBe(true);
  });

  it("writes every inline transition as a custom property, never as a literal", () => {
    // An inline style outranks every selector, so a literal here is a value the
    // cascade cannot answer — the whole of #357's second half.
    const literals: string[] = [];
    for (const { path, code } of sources) {
      for (const m of code.matchAll(/transition\s*:\s*([^,}\n]+)/g)) {
        const value = m[1].trim().replace(/^["'`]|["'`]$/g, "");
        if (!/^var\(--[\w-]+\)$/.test(value)) literals.push(`${path}: ${value}`);
      }
    }
    expect(literals).toEqual([]);
  });

  it("declares each of those properties in the sheet and rewrites it under reduced motion", () => {
    const referenced = new Set<string>();
    for (const { code } of sources) {
      for (const m of code.matchAll(/transition\s*:\s*["'`]var\((--[\w-]+)\)["'`]/g)) referenced.add(m[1]);
    }
    // Both halves of #357's inline problem are still here to be solved.
    expect(referenced.size).toBeGreaterThanOrEqual(2);
    for (const name of referenced) {
      const base = all.filter(r => !r.reduced && selectors(r).includes(":root") && decl(r.body, name) != null);
      expect(base.length, `${name} declared at :root`).toBeGreaterThan(0);
      const answer = reducedRules.filter(r => selectors(r).includes(":root") && decl(r.body, name) != null);
      expect(answer.length, `${name} answered under reduced motion`).toBeGreaterThan(0);
      // Later in the file, because a media query adds no specificity.
      expect(answer.at(-1)!.at, `${name} answered after it is declared`).toBeGreaterThan(base.at(-1)!.at);
      // And the answer has to actually change something.
      const still = decl(answer.at(-1)!.body, name)!;
      expect(still, name).not.toBe(decl(base.at(-1)!.body, name)!);
      // Whatever survives may fade or recolour; it may not move or redraw.
      expect(transitioned(still).filter(p => !STILL.has(p)), `${name} under reduced motion`).toEqual([]);
    }
  });

  it("keeps the edge's fade and drops only the stroke it was travelling on", () => {
    // Dropping the whole string — what a useReducedMotion() hook could have
    // done — would have taken the fade with it, and a fade is the recommended
    // answer to reduced motion rather than a casualty of it.
    const root = all.filter(r => !r.reduced && selectors(r).includes(":root"));
    const full = decl(root.find(r => decl(r.body, "--edge-transition") != null)!.body, "--edge-transition")!;
    expect(transitioned(full)).toEqual(["opacity", "stroke-width"]);
    const reduced = decl(reducedRules.find(r => decl(r.body, "--edge-transition") != null)!.body, "--edge-transition")!;
    expect(transitioned(reduced)).toEqual(["opacity"]);
    const arc = decl(reducedRules.find(r => decl(r.body, "--ctx-arc-transition") != null)!.body, "--ctx-arc-transition")!;
    expect(arc).toBe("none");
  });

  it("sets no inline animation anywhere except behind a matchMedia gate", () => {
    // Confetti writes animationDelay and animationDuration per particle. That
    // is allowed only for as long as the component reads the preference itself.
    for (const { path, code } of sources) {
      if (!/\banimation[A-Za-z]*\s*:/.test(code)) continue;
      expect(code, path).toMatch(/prefers-reduced-motion: reduce/);
    }
  });
});
