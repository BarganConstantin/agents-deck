// #369: two fixed-width panels could be scrolled sideways. One did it on every
// render, the other needed a name somebody typed.
//
// The usage panel is 280px wide with `overflow-y: auto`, which computes
// `overflow-x` to `auto` as well — a box cannot scroll one axis and let the
// other spill visibly. Inside it, `.cost-bar` declares `width: 100%`, which
// resolves against the panel's 278px content box, and `.usage-panel .cost-bar`
// then adds 14px of margin on each side OUTSIDE that width. Measured live in
// Chrome, in both themes: the panel reported clientWidth 278 and scrollWidth
// 306, the bar ran 1775 → 2053 against a content edge at 2039, and it was the
// only element in the whole app whose own box overflowed on an axis it had not
// been told to clip. The 28px is pure margin, so it is the same 28px at any
// content width — 265px of panel (280 less a classic 15px scrollbar, which is
// what Windows and Linux render) measured 263/291, also 28. After the fix the
// bar measures 250px and lands on 2025 with `.qb-track` and `.up-table`, and
// the panel reports 278/278.
//
// The accounts panel is the same failure with a different cause. `.ap-email`
// carried the full `min-width: 0` + `overflow: hidden` + ellipsis set;
// `.ap-alias`, its sibling in the same flex row and the one string here a
// person types, carried none of it, so `min-width: auto` floored it at the
// width of the name. Measured: the 288px panel began scrolling at a
// SIXTEEN-character unbroken alias — not the ~120px the report estimated, the
// row has more slack than that — and reached 22148px of scrollable width at
// 2000 characters, carrying `⋯` and the active badge out of the panel with it.
//
// The report's proposed CSS stops the scrolling and costs the email instead:
// with the ellipsis set but no cap, the alias took the entire 156.7px text
// budget and `.ap-email` — `flex: 1`, so a zero flex base size and therefore no
// share of the shrinkage — rendered at 0.0px from sixteen characters onward,
// present in the DOM and invisible on screen. The `max-width` is what keeps
// both: the alias freezes at 103.6px, the email keeps 53.1px, and the row is
// flat from 12 characters to 2000.
//
// None of that can be measured here. This suite runs in plain node with no DOM
// and no layout engine, so it reads styles.css the way manage-block.test.ts and
// dead-css.test.ts do and pins the RULES that make the overflow impossible: the
// width arithmetic, done in full, and the containment set on the alias. The
// second half pins the markup those rules depend on, because a rule that
// matches nothing protects nothing — which is how `.sl-dot` spent #373 scoped
// to a panel it was never inside.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const usageSrc = readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");
const accountsSrc = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
const aliasSaveSrc = readFileSync(fileURLToPath(new URL("../alias-save.ts", import.meta.url)), "utf8");
const cswapSrc = readFileSync(fileURLToPath(new URL("../../server/cswap-admin.mjs", import.meta.url)), "utf8");

/** Comments explain the defects these files fix, in the defects' own words —
 *  `width: 100%` and `min-width: auto` are both quoted a few lines above the
 *  declarations that retired them. Everything below reads the stripped text. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const bare = strip(css);
const accounts = strip(accountsSrc);
const usage = strip(usageSrc);

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

/** Top-level rules only, in source order. A @media body is a different cascade
 *  and none of the geometry here is declared inside one. */
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

const RULES = topLevel(bare);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** Every top-level rule naming this exact selector, concatenated in source
 *  order — `.ap-more` is declared twice, once for its box and once for its
 *  transition, and both are the same element's cascade. */
function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop` in a body, which is the one that wins. */
function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

/** The left and right of a margin, from the shorthand plus any longhand that
 *  came after it. The sheet uses no logical properties — `margin-inline` and
 *  friends appear zero times — so the physical sides are the whole story. */
function horizontalMargin(body: string): [string, string] {
  const short = declIn(body, "margin");
  const sides = short ? short.split(/\s+/) : null;
  let left: string | null = null;
  let right: string | null = null;
  if (sides) {
    if (sides.length === 1) [left, right] = [sides[0], sides[0]];
    else if (sides.length === 4) [left, right] = [sides[3], sides[1]];
    else [left, right] = [sides[1], sides[1]];
  }
  return [declIn(body, "margin-left") ?? left ?? "0", declIn(body, "margin-right") ?? right ?? "0"];
}

/** A CSS length in px, or NaN for anything else — `auto`, a keyword, a calc.
 *  A bare `0` is a length too, and the panel's own padding is written that way. */
const px = (value: string | null) => {
  const m = /^(-?[\d.]+)(px)?$/.exec((value ?? "").trim());
  return m && (m[2] || +m[1] === 0) ? +m[1] : NaN;
};

/** A CSS percentage as a number, or NaN. */
const pct = (value: string | null) => {
  const m = /^([\d.]+)%$/.exec((value ?? "").trim());
  return m ? +m[1] : NaN;
};

const isZero = (value: string) => value === "0" || value === "0px" || value === "auto";

// ── 1. the usage panel's cost bar ───────────────────────────────────────────

describe("the cost bar inside the usage panel", () => {
  /** The panel's content box, derived the way the browser derives it. */
  const panelWidth = px(decl(".usage-panel", "width"));
  const border = px(/(-?[\d.]+px)/.exec(decl(".usage-panel", "border") ?? "")?.[1] ?? null);
  const padding = decl(".usage-panel", "padding")!.split(/\s+/);
  const padSides = padding.length === 1
    ? [px(padding[0]), px(padding[0])]
    : [px(padding[padding.length === 4 ? 3 : 1]), px(padding[1])];
  const contentWidth = panelWidth - 2 * border - padSides[0] - padSides[1];

  /** What `.cost-bar` inside this panel actually resolves to. Both rules can
   *  match the same element and the scoped one is both later and more specific,
   *  so it wins whichever of the two declares the width. */
  const scoped = bodyOf(".usage-panel .cost-bar");
  const effectiveWidth = declIn(scoped, "width") ?? decl(".cost-bar", "width");
  const [ml, mr] = horizontalMargin(scoped);

  it("is measured against a border-box, which is what makes 280px a 278px panel", () => {
    // Every number below assumes the declared width IS the border box. The
    // sheet says so once, globally, and the arithmetic is wrong without it.
    expect(bodyOf("*")).toMatch(/box-sizing\s*:\s*border-box/);
    expect(contentWidth).toBe(278);
  });

  it("declares a scroll on one axis, which is why an overflow on the other one shows", () => {
    // Not a thing to fix — it is the reason the defect was reachable rather
    // than merely present, and the reason the fix has to be arithmetic and not
    // an `overflow-x: hidden` laid over the top of it.
    expect(decl(".usage-panel", "overflow-y")).toBe("auto");
    expect(decl(".usage-panel", "overflow-x")).toBeNull();
    expect(Number.isNaN(panelWidth)).toBe(false);
  });

  it("keeps its margins inside the panel instead of adding them to a full width", () => {
    expect(isZero(ml)).toBe(false);
    expect(isZero(mr)).toBe(false);
    const margins = px(ml) + px(mr);

    // The used width of the bar's box, for the two forms the width can take.
    // `auto` on a block-level flex container is the space left after margins;
    // a percentage is a share of the content box and knows nothing about them.
    const used = effectiveWidth === "auto"
      ? contentWidth - margins
      : Number.isNaN(pct(effectiveWidth)) ? px(effectiveWidth) : (contentWidth * pct(effectiveWidth)) / 100;
    expect(Number.isNaN(used)).toBe(false);

    const overhang = margins + used - contentWidth;
    expect(overhang).toBeLessThanOrEqual(0);
    // The live numbers, kept as numbers: 28px of overhang before, none after,
    // and a bar that now measures the same 250px as the rows above and below.
    expect(overhang).toBe(0);
    expect(used).toBe(250);
    expect(margins).toBe(28);
  });

  it("lines up with the two rows it sits between, which is what 250px is", () => {
    // `.qb-track` and `.up-table` fill `.up-section`'s 14px padding box and
    // measured 1775 → 2025 all along. The bar overhanging them by 14px was the
    // visible half of this defect before anything scrolled.
    expect(decl(".up-section", "padding")).toBe("0 14px");
    expect(px(ml)).toBe(14);
    expect(px(mr)).toBe(14);
    expect(decl(".up-table", "width")).toBe("100%");
  });

  it("is the panel's own descendant, so the scoped rule is the one that runs", () => {
    // #373 found every `.sl-dot` rule scoped to a panel its element was a
    // sibling of, so the rules matched nothing. The same class of mistake here
    // would put the width back where it was without touching this stylesheet.
    expect(usage).toMatch(/className="usage-panel"/);
    expect(usage).toMatch(/<div className="cost-bar" aria-label="Cost breakdown">/);
    // The last segment is the one an overhanging bar clips, and it is the
    // priciest token class in the panel.
    const segments = [...usage.matchAll(/"cb-(input|output|cache-r|cache-w)"/g)].map(m => m[1]);
    expect(segments).toEqual(["input", "output", "cache-r", "cache-w"]);
    // Segment widths are percentages OF THE BAR, so the bar's right edge is the
    // last segment's right edge — there is no slack inside to absorb an
    // overhang.
    expect(usage).toMatch(/style=\{\{ width: `\$\{pct\}%` \}\}/);
  });
});

// ── 2. the same arithmetic, everywhere it could recur ───────────────────────

describe("a percentage width under a horizontal margin", () => {
  it("never gets one added outside it by a rule further down the sheet", () => {
    // The defect was invisible to a per-rule reading: `.cost-bar` declared the
    // width and `.usage-panel .cost-bar`, three hundred lines away, declared
    // the margin. So this pairs them — every class a bare-class rule gives a
    // percentage width, against every scoped rule that adds a margin to an
    // element carrying that class without also restating the width.
    const percentWidth = new Set<string>();
    for (const rule of RULES) {
      for (const sel of selectors(rule.selector)) {
        const solo = /^\.([\w-]+)$/.exec(sel);
        if (solo && !Number.isNaN(pct(declIn(rule.body, "width")))) percentWidth.add(solo[1]);
      }
    }
    expect([...percentWidth].sort()).toEqual(["cost-bar", "tool-bursts-svg", "uh-bar", "uh-bar-seg", "up-table"]);

    const violations: string[] = [];
    for (const rule of RULES) {
      for (const sel of selectors(rule.selector)) {
        if (/^\.[\w-]+$/.test(sel)) continue;            // the bare rule itself
        const subject = sel.split(/[\s>]+/).filter(Boolean).pop() ?? "";
        const classes = [...subject.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
        if (!classes.some(c => percentWidth.has(c))) continue;
        const [left, right] = horizontalMargin(rule.body);
        if (isZero(left) && isZero(right)) continue;
        const own = declIn(rule.body, "width");
        if (own !== null && Number.isNaN(pct(own))) continue;
        violations.push(`${sel} { margin: ${left} / ${right}; width: ${own ?? "inherited %"} }`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── 3. the account alias ────────────────────────────────────────────────────

describe("the account alias in the accounts panel row", () => {
  it("is contained the way the email span beside it always was", () => {
    // Four properties, and the row needs all four: without `min-width: 0` a
    // flex item is floored at its min-content width, and without `nowrap` an
    // unbroken name has no min-content width worth the name.
    expect(decl(".ap-alias", "min-width")).toBe("0");
    expect(decl(".ap-alias", "overflow")).toBe("hidden");
    expect(decl(".ap-alias", "text-overflow")).toBe("ellipsis");
    expect(decl(".ap-alias", "white-space")).toBe("nowrap");
    // Its sibling, unchanged — a "fix" that took the containment off the email
    // to make room for the alias would move the defect rather than close it.
    expect(decl(".ap-email", "min-width")).toBe("0");
    expect(decl(".ap-email", "overflow")).toBe("hidden");
    expect(decl(".ap-email", "text-overflow")).toBe("ellipsis");
    expect(decl(".ap-email", "white-space")).toBe("nowrap");
  });

  it("is capped below the row, so an absurd name cannot squeeze the email to nothing", () => {
    // `.ap-email` is `flex: 1` — flex base size zero, so the shrink algorithm,
    // which shares shrinkage in proportion to base size, gives it none. An
    // uncapped alias therefore takes the whole text budget and leaves the email
    // rendering at 0.0px. The cap freezes the alias at its maximum and the
    // remaining free space goes to the email, measured at 103.6px / 53.1px.
    expect(decl(".ap-email", "flex")).toBe("1");
    const cap = pct(decl(".ap-alias", "max-width"));
    expect(Number.isNaN(cap)).toBe(false);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(100);
  });

  it("is never pinned unshrinkable, which would undo all of it", () => {
    // `flex-shrink: 0` or `flex: none` on this span puts it back at its
    // min-content width and the cap stops mattering.
    const body = bodyOf(".ap-alias");
    expect(declIn(body, "flex-shrink")).not.toBe("0");
    // `?? ""` because absent is the resting state and the right one: the
    // initial `flex: 0 1 auto` is exactly what this row wants.
    expect(declIn(body, "flex") ?? "").not.toBe("none");
    expect(declIn(body, "flex") ?? "").not.toMatch(/^0\s+0\b/);
    // And the row it sits in is still the flex row the whole analysis assumes.
    expect(decl(".ap-account-head", "display")).toBe("flex");
  });

  it("carries the whole name in a title, because the row may be showing part of it", () => {
    // Truncation without a title is deletion. The email beside it has had one
    // since it was given the same treatment.
    expect(accounts).toMatch(/<span className="ap-alias" title=\{a\.alias\}>\{a\.alias\}<\/span>/);
    expect(accounts).toMatch(/<span className="ap-email" title=\{a\.org \?\? undefined\}>/);
  });

  it("bounds the rename field at the store's own limit, not at a smaller round number", () => {
    // The field had no bound, so the only way to find the limit was to type
    // past it and read a `bad_value` back. This states it where the typing
    // happens — and states the SERVER's number, so the field never refuses a
    // name the store would have taken.
    const server = /\{\s*1\s*,\s*(\d+)\s*\}/.exec(/const ALIAS_OK = (\/.+\/);/.exec(cswapSrc)![1])![1];
    expect(aliasSaveSrc).toMatch(new RegExp(`export const ALIAS_MAX_LENGTH = ${server};`));
    expect(accounts).toMatch(/maxLength=\{ALIAS_MAX_LENGTH\}/);
    expect(accounts).toMatch(/import \{ ALIAS_MAX_LENGTH, aliasSave \} from "\.\.\/alias-save";/);
  });

  it("does not lean on that bound for the panel's width", () => {
    // `cswap alias` writes the same store from a terminal and never passes
    // through this deck, so the field's maximum is a courtesy and the CSS is
    // the guard. Sixty-four W's measured 705px — two and a half times the
    // panel — before the ellipsis went on.
    expect(accounts).toMatch(/className="ap-alias"/);
    expect(decl(".ap-alias", "max-width")).not.toBeNull();
  });
});
