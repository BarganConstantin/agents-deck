// #380: three panels, three left insets and two right ones; a topbar carrying
// two button heights 1.4px apart; and a reopen tab under the target floor this
// sheet argues for twice elsewhere.
//
// Measured live in Chrome before the change, identical in dark and in light:
//
//   accounts panel, 288px, content box 0 → 287
//     .ap-header h2            left  x=14      .ap-header-right   right x=275
//     .ap-account-head, .ap-lane, .ap-meta, .ap-auto-head         right x=273
//   session list, 240px, content box 0 → 239
//     .sl-header h2            left  x=14      .sl-close          right x=227
//     .sl-row content          left  x=17      .sl-row-body       right x=222
//   usage panel, 280px, content box 278 wide
//     every row                left  +14                          right -14
//
//   .btn            31.4px tall, top y=9.80
//   .btn.icon-btn   30.0px tall, top y=10.49
//   .detail-reopen  22 × 44
//
// So: a 2px step between the accounts header's controls and every row it heads,
// a 3px and a 5px step in the session list, and a 1.4px height step repeated at
// each of the four boundaries between a text button and an icon button in the
// bar. The usage panel was the only one of the three that lined up.
//
// One claim in the report does not survive being measured again. It puts
// `.ctx-donut` at 19.6 × 19.6 and asks for a 24px box around it. The donut's
// CSS box is 26 × 26 — ContextModal's `size = 26` default, which is the only
// size AgentNode ever asks for — and 19.6 is 26 × 0.754, the donut seen through
// the React Flow viewport transform. Every control on that canvas scales with
// the zoom (`.cluster-label` reads 9.3px tall at 0.5×), so a rect() taken from
// a node measures the zoom and not the target. It is left alone, and pinned
// below at the size it actually is.
//
// This suite runs in plain node — no DOM, no layout engine — so none of the
// numbers above can be re-measured here. What it does instead is what
// panel-overflow.test.ts does for #369: it reads styles.css and pins the RULES
// that make the geometry hold. A single token for the inset, a single token for
// the control height, the session row's padding written as what is left over
// after the gutter and the border rather than as a third free number, and the
// one scroll container that keeps a header and its rows in the same content box
// on a platform whose scrollbar takes up room.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const css = read("../styles.css");
const contextSrc = read("../components/ContextModal.tsx");
const agentNodeSrc = read("../components/AgentNode.tsx");

/** Comments quote the numbers they retired — `padding: 12px 12px 10px 14px` is
 *  written out a few lines above the rule that replaced it — so every read
 *  below is of the stripped text. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const bare = strip(css);

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

/** Top-level rules only, in source order. Nothing this file measures is
 *  declared inside a @media body, and a @media body is a different cascade. */
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
 *  order — a caption's size and its margin are declared in two places now, and
 *  both are the same element's cascade. */
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

// ── lengths, through the tokens ─────────────────────────────────────────────

/** Every custom property a rule in this file's scope can see. The geometry
 *  block is a bare `:root`, and the session list's two local numbers are
 *  declared on `.sl-rows` and inherited by the row inside it. */
const TOKENS: Record<string, string> = {};
for (const source of [":root", ".session-list .sl-rows"]) {
  for (const [, name, value] of bodyOf(source).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
    TOKENS[name] = value.trim();
  }
}

/** Split a declaration value on top-level whitespace — `calc(a - b - c)` is one
 *  value however many spaces are inside it. */
function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A length in px, resolving var() and the one `calc(a - b - c)` shape the
 *  sheet uses. NaN for anything that is not a length — `auto`, a keyword. */
function px(value: string | null | undefined): number {
  const v = (value ?? "").trim();
  const calc = /^calc\((.+)\)$/.exec(v);
  if (calc) {
    const terms = calc[1].split(/\s+-\s+/);
    return terms.slice(1).reduce((acc, t) => acc - px(t), px(terms[0]));
  }
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (ref) {
    if (TOKENS[ref[1]] === undefined) throw new Error(`no declaration for ${ref[1]}`);
    return px(TOKENS[ref[1]]);
  }
  const m = /^(-?[\d.]+)(px)?$/.exec(v);
  return m && (m[2] || +m[1] === 0) ? +m[1] : NaN;
}

/** [top, right, bottom, left] of a box shorthand, in px. */
function box(value: string | null): [number, number, number, number] {
  const s = splitTop(value ?? "").map(px);
  if (s.length === 1) return [s[0], s[0], s[0], s[0]];
  if (s.length === 2) return [s[0], s[1], s[0], s[1]];
  if (s.length === 3) return [s[0], s[1], s[2], s[1]];
  return [s[0], s[1], s[2], s[3]];
}

/** The left and right of a rule's `prop` shorthand, plus any longhand after
 *  it. The sheet uses no logical properties, so the physical sides are all. */
function horizontal(selector: string, prop: "padding" | "margin"): [number, number] {
  const body = bodyOf(selector);
  const [, right, , left] = box(declIn(body, prop));
  const l = declIn(body, `${prop}-left`);
  const r = declIn(body, `${prop}-right`);
  return [l ? px(l) : left, r ? px(r) : right];
}

/** (ids, classes+attributes+pseudo-classes, elements+pseudo-elements), which
 *  is what decides a tie between two rules declaring the same property. */
function specificity(sel: string): [number, number, number] {
  const s = sel.replace(/\s*[>+~]\s*/g, " ");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (s.match(/(?:^|[\s(])[a-z][\w-]*|::[\w-]+/g) ?? []).length;
  return [ids, classes, elements];
}

const beats = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

// ── 1. one inset, and every panel edge on it ────────────────────────────────

describe("the distance a panel prints its content at", () => {
  it("is a token rather than a number each rule reaches for on its own", () => {
    // The defect was invisible rule by rule: 12px on a header and 14px on the
    // row under it are both perfectly reasonable numbers, and only reading them
    // together says one of them is wrong.
    expect(TOKENS["--panel-inset"]).toBeDefined();
    expect(px(TOKENS["--panel-inset"])).toBe(14);
  });

  /** Every rule in the sheet that sets a panel's horizontal content edge. The
   *  usage panel's five were already right and are here as the standard the
   *  other two are being held to, not because they changed. */
  const EDGES: Array<[string, "padding" | "margin"]> = [
    [".ap-header", "padding"],
    [".ap-account", "padding"],
    [".ap-empty", "padding"],
    [".ap-auto", "padding"],
    [".ap-failure", "margin"],
    [".session-list .sl-header", "padding"],
    [".up-header", "padding"],
    [".up-total", "padding"],
    [".up-tokens-row", "padding"],
    [".up-section", "padding"],
    [".usage-panel .cost-bar", "margin"],
  ];

  it("is the same distance on both sides of every panel", () => {
    const inset = px(TOKENS["--panel-inset"]);
    for (const [selector, prop] of EDGES) {
      const [left, right] = horizontal(selector, prop);
      expect([selector, left], `${selector} left`).toEqual([selector, inset]);
      expect([selector, right], `${selector} right`).toEqual([selector, inset]);
    }
  });

  it("keeps the two rules that must stay literal in step with the token", () => {
    // panel-overflow.test.ts redoes #369's overflow arithmetic by parsing these
    // two as numbers — `px("var(--panel-inset)")` is NaN there — so they hold
    // their 14 in the source. This is the assertion that stops the pair from
    // drifting apart in either direction.
    expect(decl(".up-section", "padding")).toBe("0 14px");
    expect(horizontal(".usage-panel .cost-bar", "margin")).toEqual([14, 14]);
    expect(px(TOKENS["--panel-inset"])).toBe(14);
  });
});

// ── 2. a header and the rows underneath it ──────────────────────────────────

describe("a panel header against the rows it heads", () => {
  it("starts and ends where they do, in the accounts panel", () => {
    // The header used to write `12px 12px 10px 14px` — three insets in one
    // declaration, and the odd one out was the right, 2px inside every row.
    expect(horizontal(".ap-header", "padding")).toEqual(horizontal(".ap-account", "padding"));
    expect(horizontal(".ap-header", "padding")).toEqual(horizontal(".ap-auto", "padding"));
  });

  it("starts and ends where they do, in the session list", () => {
    // The row reaches its inset through three boxes, so the comparison has to
    // add them up the way the browser does.
    const gutter = px(TOKENS["--sl-card-gutter"]);
    const edge = px(TOKENS["--sl-card-edge"]);
    const [padLeft, padRight] = horizontal(".session-list .sl-row", "padding");
    expect(gutter + edge + padLeft).toEqual(horizontal(".session-list .sl-header", "padding")[0]);
    expect(gutter + edge + padRight).toEqual(horizontal(".session-list .sl-header", "padding")[1]);
  });

  it("measures the row's border, because the row's border is inside its box", () => {
    // `box-sizing: border-box` is what makes the sum above the whole story, and
    // it is declared once for the sheet. Without it the row's padding box would
    // start a further 1px in and every number here would be off by one.
    expect(bodyOf("*")).toMatch(/box-sizing\s*:\s*border-box/);
    expect(decl(".session-list .sl-row", "border-width")).toBe("var(--sl-card-edge)");
    // And it is still a border rather than an outline, which would sit outside
    // the box and drop out of the sum entirely.
    expect(decl(".session-list .sl-row", "border-style")).toBe("solid");
  });

  it("leaves the last term of the row's inset to be worked out, not chosen", () => {
    // The point of the calc: the gutter is a design number, the border is the
    // row's own, and the padding is whatever lands the label on the panel's
    // inset. Written as a third literal it went to 10px and nothing said so.
    const padding = splitTop(decl(".session-list .sl-row", "padding")!);
    expect(padding).toHaveLength(2);
    expect(padding[1]).toMatch(/^calc\(/);
    for (const token of ["--panel-inset", "--sl-card-gutter", "--sl-card-edge"]) {
      expect(padding[1], token).toContain(`var(${token})`);
    }
  });

  it("puts the card round the text rather than the text inside the card", () => {
    // The gutter has to be smaller than the inset — that is what "the card
    // outdents past the column its text sits on" means — and larger than zero,
    // or the selected row's accent border would sit on the panel's own edge.
    const gutter = px(TOKENS["--sl-card-gutter"]);
    expect(gutter).toBeGreaterThan(0);
    expect(gutter).toBeLessThan(px(TOKENS["--panel-inset"]));
  });
});

// ── 3. the scroll container, which is where a scrollbar takes its room ──────

describe("the session list on a platform that draws a real scrollbar", () => {
  it("scrolls as a whole, so its header and its rows share one content box", () => {
    // A classic scrollbar takes its width out of the content box of whichever
    // element scrolls. With the header outside the scroller and the rows inside
    // it, Windows and Linux would have put every row's right inset ~10px deeper
    // than the header's — the sheet asks for `scrollbar-width: thin` — the
    // moment the list overflowed. macOS overlays, so the defect is invisible
    // here and this assertion is the only place it can be caught.
    expect(decl(".session-list", "overflow-y")).toBe("auto");
    expect(decl(".session-list", "overflow")).toBeNull();
    expect(declIn(bodyOf(".session-list .sl-rows"), "overflow-y")).toBeNull();
    expect(declIn(bodyOf(".session-list .sl-rows"), "overflow")).toBeNull();
  });

  it("keeps the header on screen the way the usage panel does", () => {
    // The header holds the counts and the only way to close the sidebar, and
    // the panel scrolling as a whole would otherwise take it away at row two
    // hundred. Its own opaque background is what stops rows showing through.
    expect(decl(".session-list .sl-header", "position")).toBe("sticky");
    expect(decl(".session-list .sl-header", "top")).toBe("0");
    expect(decl(".session-list .sl-header", "background")).toBe("var(--panel)");
    expect(decl(".up-header", "position")).toBe("sticky");
  });

  it("still relies on the row's own containment for its width", () => {
    // `overflow: hidden` clipped a horizontal overflow; `overflow-y` exposes it
    // as a scrollbar, which is the #369 defect. Measured flat at a
    // 2000-character session label, and these four rules are why.
    expect(decl(".session-list .sl-row", "min-width")).toBe("0");
    expect(decl(".session-list .sl-row-body", "min-width")).toBe("0");
    expect(decl(".session-list .sl-label", "overflow")).toBe("hidden");
    expect(decl(".session-list .sl-label", "text-overflow")).toBe("ellipsis");
  });
});

// ── 4. one caption for three panels ─────────────────────────────────────────

describe("the three panel captions", () => {
  const CAPTIONS = [".up-header h2", ".ap-header h2", ".session-list .sl-header h2"];

  it("are one caption, at one size and one weight", () => {
    // 13px/600, 12px/600 and — because this one declared nothing and took the
    // UA sheet's h3 — 15.21px/700. #381 pinned that last value rather than
    // normalising it and said so, leaving the reconciliation here.
    const sizes = CAPTIONS.map(sel => decl(sel, "font-size"));
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBe("13px");
    const weights = CAPTIONS.map(sel => decl(sel, "font-weight"));
    expect(new Set(weights).size).toBe(1);
    expect(weights[0]).toBe("600");
  });

  it("say it once, in a rule all three share", () => {
    // Three rules that happen to agree is not the same fact as one rule; the
    // first drifts the next time one panel is worked on alone.
    const shared = RULES.filter(r => CAPTIONS.every(c => selectors(r.selector).includes(c)));
    expect(shared).toHaveLength(1);
    expect(declIn(shared[0].body, "font-size")).toBe("13px");
  });

  it("none of them depends on what <body> happens to be set at", () => {
    for (const sel of CAPTIONS) expect(decl(sel, "font-size"), sel).toMatch(/px$/);
  });
});

// ── 5. one height for a control ─────────────────────────────────────────────

describe("the height of a button", () => {
  it("is a token, not a consequence of the padding", () => {
    expect(TOKENS["--ctl-h"]).toBeDefined();
    expect(px(TOKENS["--ctl-h"])).toBe(30);
    expect(decl("button.btn", "min-height")).toBe("var(--ctl-h)");
    expect(decl("button.btn.icon-btn", "width")).toBe("var(--ctl-h)");
    expect(decl("button.btn.icon-btn", "height")).toBe("var(--ctl-h)");
  });

  it("is the same for a text button and an icon button, by arithmetic", () => {
    // What the browser does, done here. The text button's box is its line box
    // plus its vertical padding plus its two borders; the icon button's is the
    // token. They came to 31.4 and 30.0, which is the step the topbar drew four
    // times over. The sheet's line-height is unitless, so 17.4px is 17.4px on
    // every platform and the step was the same everywhere.
    const font = px(decl("button.btn", "font-size"));
    const ratio = +/^\s*[\d.]+px\s*\/\s*([\d.]+)/.exec(decl("body", "font")!)![1];
    const [padTop, , padBottom] = box(decl("button.btn", "padding"));
    const border = px(splitTop(decl("button.btn", "border")!)[0]);
    const textHeight = Math.max(px(TOKENS["--ctl-h"]), font * ratio + padTop + padBottom + 2 * border);
    expect(textHeight).toBe(px(TOKENS["--ctl-h"]));
    expect(px(decl("button.btn.icon-btn", "height"))).toBe(px(TOKENS["--ctl-h"]));
  });

  it("has room to spare, so a wider default font cannot reopen the step", () => {
    // The floor leaves 28px inside the borders for a line box that is 17.4px
    // here. That headroom is the reason the vertical padding is zero rather
    // than merely smaller: with padding, a platform whose default metrics run
    // large pushes the text button past the icon button again.
    const border = px(splitTop(decl("button.btn", "border")!)[0]);
    const [padTop, , padBottom] = box(decl("button.btn", "padding"));
    expect(padTop).toBe(0);
    expect(padBottom).toBe(0);
    const room = px(TOKENS["--ctl-h"]) - 2 * border - padTop - padBottom;
    expect(room / px(decl("button.btn", "font-size"))).toBeGreaterThan(2);
  });

  it("centres the label in a box whose height the label no longer sets", () => {
    expect(decl("button.btn", "display")).toBe("inline-flex");
    expect(decl("button.btn", "align-items")).toBe("center");
    // And the icon button no longer repeats them: it is this control with its
    // width pinned to its height, and that is all it has left to say.
    expect(declIn(bodyOf("button.btn.icon-btn"), "display")).toBeNull();
    expect(declIn(bodyOf("button.btn.icon-btn"), "align-items")).toBeNull();
  });

  it("cannot be overridden into a second height by a rule further down", () => {
    // The height has to be unreachable, not merely stated. Any rule that sizes
    // an element carrying `.btn` either uses the token or loses the cascade to
    // `button.btn.icon-btn` — which is how `.session-list .sl-close`'s 26px and
    // `.up-close`'s padding have always been decided, though neither rule says
    // so. A per-button size that actually applied would put a second height
    // back in the sheet.
    const winner = specificity("button.btn.icon-btn");
    const escapes: string[] = [];
    for (const rule of RULES) {
      for (const sel of selectors(rule.selector)) {
        const subject = sel.split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
        const carriesBtn = /\.(btn|icon-btn)\b/.test(subject)
          || /\.(sl-close|up-close|ap-add|ap-refresh|ap-switch|uh-retry|uh-reload|up-refresh-btn|hero-action-btn)\b/.test(subject);
        if (!carriesBtn) continue;
        for (const prop of ["height", "min-height", "max-height"]) {
          const value = declIn(rule.body, prop);
          if (value === null || value === "var(--ctl-h)") continue;
          if (beats(winner, specificity(sel))) continue;   // it can never apply
          escapes.push(`${sel} { ${prop}: ${value} }`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });
});

// ── 6. the floor this sheet sets for itself ─────────────────────────────────

describe("the 24px target floor", () => {
  it("covers the tab that reopens the detail panel", () => {
    // 22 × 44. The sheet writes this floor down twice and argues for it both
    // times — `.ver-close` and `.ap-more` — and this control predates both.
    expect(px(decl(".detail-reopen", "width"))).toBeGreaterThanOrEqual(24);
    expect(px(decl(".detail-reopen", "height"))).toBeGreaterThanOrEqual(24);
  });

  it("already covered the context donut, which the report measured zoomed", () => {
    // The report puts the donut at 19.6 × 19.6. Its box is 26 × 26 — the
    // component's default, and AgentNode is the one caller and passes no size.
    // 19.6 is 26 × 0.754: a rect() taken from a node measures the React Flow
    // viewport transform as well as the element. Pinned at the size it is, so
    // that shrinking the default has to be a decision rather than a slip.
    const fallback = +/size = (\d+)/.exec(contextSrc)![1];
    expect(fallback).toBeGreaterThanOrEqual(24);
    expect(contextSrc).toMatch(/<svg width=\{size\} height=\{size\}/);
    const call = /<ContextDonut[\s\S]*?\/>/.exec(agentNodeSrc)![0];
    expect(call).not.toMatch(/\bsize=/);
    // The box takes its size from the SVG, so nothing in the sheet may shrink
    // it back underneath the component.
    const donut = bodyOf(".ctx-donut");
    expect(declIn(donut, "width")).toBeNull();
    expect(declIn(donut, "height")).toBeNull();
    expect(declIn(donut, "padding")).toBe("0");
  });
});
