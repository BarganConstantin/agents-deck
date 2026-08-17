// #381: five regions, one landmark, no <h1>, and five aria-labels the
// accessibility tree was throwing on the floor.
//
// Measured on the shipped bundle, the deck answered a landmark query with one
// entry — HEADER.topbar — for an application that has a toolbar, a canvas and
// three panels. Everything else was a <div>. A screen-reader user could not
// jump to the canvas, could not jump to a panel, and could not tell one panel
// from another once they got there; the only route between them was Tab,
// through roughly a hundred and sixty-six stops.
//
// The heading outline was the same story one level down. There was no <h1> at
// all, so the document's first heading was the usage panel's <h3>Usage</h3> and
// every level under it was a skip. The only <h2> in the app was the detail
// panel's hero title, which appears when an agent is selected and not before.
//
// And the third finding, which is the one worth stating precisely because it
// looks like a non-bug in the source: `aria-label` on an element whose role
// resolves to `generic` — a <div> or a <span> with no role attribute — is
// DROPPED. It is not weakened, not a fallback; the name is discarded and the
// element stays anonymous. `.usage-panel` and `.accounts-panel` had carried one
// since they were written and neither had ever produced a name. #373 saw the
// shape and correctly called it a naming defect rather than a state one, which
// is how it arrived here.
//
// The issue counted two. A sweep of every aria-label in the bundle — the last
// test in the first block below, which is the part of this file that will
// still be doing work in a year — found five: the two panel roots and the
// three copies of the cost bar.
//
// Plain node, no DOM, so this reads the components as text the way
// manage-block.test.ts and toggle-state.test.ts do. Comments are stripped
// before any "appears nowhere" assertion, because this repo's comments quote
// the markup they replaced and a search for a retired shape would otherwise
// find the sentence explaining why it is retired.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { versionNoticeLabel } from "../version-chip";

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

const FILES = components(web);
const source = (name: string) => readFileSync(FILES.find(p => p.endsWith(name))!, "utf8");

/** The same text with its comments gone — the only form an "appears nowhere"
 *  assertion may read. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

const app = source("App.tsx");
const usage = source("UsagePanel.tsx");
const accounts = source("AccountsPanel.tsx");
const sessions = source("SessionList.tsx");
const history = source("UsageHistoryModal.tsx");
const summary = source("SessionSummary.tsx");
const addAccount = source("AddAccountDialog.tsx");

/** Every file in the bundle, as [name, comment-stripped text]. The separator is
 *  normalised because two of the assertions below name a file inside
 *  components/, and join() spells that with a backslash on Windows. */
const BUNDLE: Array<[string, string]> = FILES.map(p =>
  [p.slice(web.length).replace(/\\/g, "/"), code(readFileSync(p, "utf8"))]);

/** Every opening tag in a component, as [tagName, its attributes]. Braced
 *  attribute values are counted out so a `{cond ? "a" : "b"}` inside one does
 *  not end the tag early. */
function openingTags(src: string): Array<[string, string]> {
  return [...src.matchAll(/<([a-zA-Z][\w.]*)((?:[^<>]|\{[^{}]*\})*?)\/?>/g)]
    .map(m => [m[1], m[2]] as [string, string]);
}

/** The HTML elements whose implicit role is `generic`, which is the role that
 *  cannot be named. Not a complete list of such elements — a complete list is
 *  not the point — but every one of them this deck actually renders. */
const GENERIC = new Set([
  "div", "span", "p", "b", "i", "strong", "em", "small", "code", "pre",
  "li", "ul", "ol", "table", "tr", "td", "th", "tbody", "thead",
]);

// ── the regions ─────────────────────────────────────────────────────────────

describe("the deck's five regions are five landmarks (#381)", () => {
  it("puts the canvas in the one <main> a document is allowed", () => {
    expect(code(app)).toMatch(/<main\n\s+id="canvas"\n\s+tabIndex=\{-1\}\n\s+className=\{`canvas-wrap/);
    const mains = BUNDLE.flatMap(([name, src]) =>
      [...src.matchAll(/<main[\s>]/g)].map(() => name));
    expect(mains).toEqual(["App.tsx"]);
    // The shape it replaced, gone rather than merely outnumbered.
    expect(code(app)).not.toMatch(/<div\s*\n?\s*className=\{`canvas-wrap/);
  });

  it("keeps the topbar the banner it already was", () => {
    // A <header> that is not inside an article or a section IS the banner
    // landmark, with no role attribute needed. This one is a direct child of
    // .app, which is a plain grid <div>, so it always has been.
    expect(code(app)).toMatch(/<header className="topbar">/);
  });

  it("makes every panel an <aside>, and every <aside> carry its own name", () => {
    // complementary is what all four of these are: content beside the canvas
    // that can be closed without changing what the canvas shows. The name is
    // what makes the rotor's four entries tellable apart — "complementary,
    // complementary, complementary" is a list nobody can navigate.
    const named: Array<[string, string, string]> = [
      ["UsagePanel.tsx", "usage-panel", "Usage"],
      ["AccountsPanel.tsx", "accounts-panel", "Claude accounts"],
      ["SessionList.tsx", "session-list", "Sessions"],
    ];
    for (const [file, cls, label] of named) {
      expect(code(source(file)), file)
        .toMatch(new RegExp(`<aside className="${cls}" id="${cls}" aria-label="${label}">`));
    }
    // The detail panel was already an <aside> and was the unnamed one.
    expect(code(app)).toMatch(/<aside className="detail" aria-label="Detail">/);
  });

  it("has no <div> left wearing one of those class names", () => {
    // The exact two shapes the issue measured, which is the assertion that
    // fails if somebody re-opens one of these files and reaches for a <div>.
    expect(code(usage)).not.toMatch(/<div className="usage-panel"/);
    expect(code(accounts)).not.toMatch(/<div className="accounts-panel"/);
  });

  it("invents no landmark for a region the deck does not have", () => {
    // The failure mode on the other side of this issue: a rotor padded out
    // with regions nobody would ever navigate to is no more usable than an
    // empty one. There is no navigation on this deck — the session list moves
    // the camera, it does not move the user between documents — and the filter
    // box is a single input the rotor already lists by its own aria-label.
    for (const [name, src] of BUNDLE) {
      expect(src, name).not.toMatch(/<nav[\s>]/);
      expect(src, name).not.toMatch(/role="(navigation|search|banner|main|complementary|contentinfo)"/);
    }
  });

  it("leaves no aria-label on an element whose role is generic", () => {
    // The sweep, and the general form of the issue's third finding. A name on
    // a roleless <div> or <span> is not a weak name, it is no name: the
    // accessibility tree drops it. Five of these shipped — the two panel roots
    // and the three copies of the cost bar — and every one of them read, in
    // source, exactly like a labelled element.
    const offenders: string[] = [];
    for (const [name, src] of BUNDLE) {
      for (const [tag, attrs] of openingTags(src)) {
        if (!/\baria-label(?:ledby)?=/.test(attrs)) continue;
        if (!GENERIC.has(tag)) continue;
        if (/\brole=/.test(attrs)) continue;
        offenders.push(`${name}: <${tag} ${attrs.trim().split(/\s+/)[0]}>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gave the cost bar the role that makes its label exist", () => {
    // Three copies of one component, in three files — that duplication is
    // #374's to remove, and until it does, all three carry the fix.
    for (const [file, src] of [["App.tsx", app], ["UsagePanel.tsx", usage], ["SessionSummary.tsx", summary]] as const) {
      expect(code(src), file).toMatch(/className="cost-bar[^"]*" role="img" aria-label="Cost breakdown"/);
    }
  });
});

// ── the outline ─────────────────────────────────────────────────────────────

describe("the heading outline starts at level 1 and skips nothing (#381)", () => {
  it("has exactly one <h1>, and it is the wordmark already on the page", () => {
    const h1s = BUNDLE.flatMap(([name, src]) => [...src.matchAll(/<h1[\s>]/g)].map(() => name));
    expect(h1s).toEqual(["App.tsx"]);
    expect(code(app)).toMatch(/<h1>\{PRODUCT\}<\/h1>/);
  });

  it("did not hide it, because the name it carries is already visible", () => {
    // A .vis-hidden <h1> was the other option and would have made a screen
    // reader say "ccdeck" twice — once as the heading, once as the wordmark two
    // pixels to its right. The class exists (#373) and is deliberately not used
    // here; marking up the text that is already on screen is what 1.3.1 asks.
    expect(code(app)).toMatch(/<h1>/);
    expect(code(app)).not.toMatch(/<h1 className="vis-hidden"/);
    expect(code(app)).not.toMatch(/<h1[^>]*aria-hidden/);
  });

  it("keeps the <h1> out of the version chip's accessible name", () => {
    // The chip is a sibling of the heading and not a child of it. Inside, its
    // whole sentence about npm would become part of the heading's name — the
    // rotor's entry for this page would be a paragraph.
    const brand = code(app).slice(code(app).indexOf('<div className="brand">'));
    expect(brand).toContain("<h1>");
    expect(brand.indexOf("<h1>")).toBeLessThan(brand.indexOf("{notice ?"));
    expect(brand).not.toMatch(/<h1>[\s\S]*?<button[\s\S]*?<\/h1>/);
  });

  it("heads every persistent region with an <h2>", () => {
    expect(code(usage)).toMatch(/<h2>Usage<\/h2>/);
    expect(code(accounts)).toMatch(/<h2>Accounts<\/h2>/);
    expect(code(sessions)).toMatch(/<h2>Sessions <span className="sl-count">/);
    // The detail panel, in both of its states: the agent's name when one is
    // selected, and the panel's own word when none is.
    expect(code(app)).toMatch(/<h2 className="hero-title"/);
    expect(code(app)).toMatch(/<h2>Detail<\/h2>/);
  });

  it("steps the usage panel's sections from h4 to h3, under that h2", () => {
    expect([...code(usage).matchAll(/<h3 className="up-section-title">/g)]).toHaveLength(4);
    expect(code(usage)).not.toMatch(/<h4/);
  });

  it("leaves <h4> only inside the dialogs, which are their own naming context", () => {
    // aria-modal="true" prunes everything outside the dialog from the tree, and
    // all six of these dialogs name themselves with aria-label or
    // aria-labelledby rather than with a heading — so their internal levels are
    // a separate question from the page's outline, and re-levelling them is not
    // this issue's change. Pinned so the scope-out is a decision on the record
    // rather than something that was missed.
    const withH4 = BUNDLE.filter(([, src]) => /<h4[\s>]/.test(src)).map(([name]) => name).sort();
    expect(withH4).toEqual([
      "components/AddAccountDialog.tsx",
      "components/SessionSummary.tsx",
      "components/ToolModal.tsx",
    ]);
  });
});

describe("promoting the headings changed no pixels (#381)", () => {
  /** The last declaration of `prop` in the rule for `selector`. */
  function decl(selector: string, prop: string): string | null {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(m => m[1].split(",").some(s => s.replace(/\s+/g, " ").trim() === selector));
    if (!rules.length) return null;
    const body = rules.map(m => m[2]).join(";");
    const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
    return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
  }

  it("keeps the two panel captions that already declared a size", () => {
    // An <h2> arrives from the UA sheet at 1.5em where an <h3> arrives at
    // 1.17em, so a caption with no font-size of its own would have grown by a
    // third. These two never depended on the default.
    expect(decl(".up-header h2", "font-size")).toBe("13px");
    expect(decl(".ap-header h2", "font-size")).toBe("12px");
    expect(decl(".up-header h3", "font-size")).toBeNull();
    expect(decl(".ap-header h3", "font-size")).toBeNull();
  });

  it("pins the one that did depend on it to the size it was rendering at", () => {
    // 1.17em is the UA sheet's h3, written down. Not rounded to a px value:
    // the three panel headers already disagree with each other by a few pixels
    // and reconciling them is #380's change, not this one's.
    expect(decl(".session-list .sl-header h2", "font-size")).toBe("1.17em");
    expect(decl(".session-list .sl-header h3", "margin")).toBeNull();
  });

  it("styles the detail panel's h2 without catching the agent's name in it", () => {
    // `.detail-hero .hero-title` is an <h2> too, and it is a title rather than
    // a caption. A bare `.detail h2` would set it in 11px uppercase grey.
    expect(decl(".detail > h2", "font-size")).toBe("11px");
    expect(decl(".detail > h2", "text-transform")).toBe("uppercase");
    expect(decl(".detail-hero .hero-title", "font-size")).toBe("17px");
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/(^|[,\s])\.detail h2\b/);
  });

  it("holds the wordmark at 14px against the UA sheet's 2em", () => {
    expect(decl(".topbar .brand h1", "font")).toBe("inherit");
    expect(decl(".topbar .brand h1", "margin")).toBe("0");
    expect(decl(".topbar .brand", "font-size")).toBe("14px");
  });
});

// ── the skip link ───────────────────────────────────────────────────────────

describe("the route past a hundred and sixty-six tab stops (#381)", () => {
  function decl(selector: string, prop: string): string | null {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(m => m[1].split(",").some(s => s.replace(/\s+/g, " ").trim() === selector));
    if (!rules.length) return null;
    const body = rules.map(m => m[2]).join(";");
    const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
    return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
  }

  it("is the first thing in the document and points at the canvas", () => {
    const bare = code(app);
    const start = bare.indexOf('<div className="app">');
    const link = bare.indexOf('<a className="skip-link" href="#canvas">', start);
    const topbar = bare.indexOf('<header className="topbar">', start);
    expect(link).toBeGreaterThan(start);
    expect(link).toBeLessThan(topbar);
    // The href and the id are the same word, and the element that carries the
    // id is the element the link means to reach.
    expect(bare).toMatch(/<main\n\s+id="canvas"/);
  });

  it("gives that target a negative tabIndex, because a fragment must be focusable to be focused", () => {
    // Without it the browser scrolls to the element and leaves focus where it
    // was, which for a skip link is the whole failure.
    expect(code(app)).toMatch(/<main\n\s+id="canvas"\n\s+tabIndex=\{-1\}/);
  });

  it("is out of flow, or it would take the topbar's grid cell", () => {
    // .app auto-places its children. An in-flow first child claims row 1
    // column 1 and pushes the 52px bar into row 2.
    expect(decl(".skip-link", "position")).toBe("fixed");
    expect(decl(".app", "display")).toBe("grid");
  });

  it("hides without leaving the tab order, and comes back on focus", () => {
    // display:none and visibility:hidden both remove an element from the tab
    // order and the accessibility tree — a skip link nothing can focus is the
    // one thing it must never be. And it is not .vis-hidden either: that class
    // is a 1px clipped box, and this has to become readable.
    expect(decl(".skip-link", "display")).toBeNull();
    expect(decl(".skip-link", "visibility")).toBeNull();
    expect(decl(".skip-link", "transform")).toMatch(/translateY/);
    expect(decl(".skip-link:focus", "transform")).toBe("none");
    expect(code(app)).not.toMatch(/className="skip-link vis-hidden"/);
  });

  it("shows the reader where they landed", () => {
    // A programmatic focus target with no ring is a jump to nowhere. Inset,
    // because .canvas-wrap runs to the window edge and the shared outward
    // offset would draw two of its sides off screen.
    expect(decl(":focus-visible", "outline")).toMatch(/2px solid var\(--accent\)/);
    expect(decl(".canvas-wrap:focus-visible", "outline-offset")).toBe("-3px");
  });
});

// ── the names that were only ever tooltips ──────────────────────────────────

describe("no control is named by its title attribute alone (#381)", () => {
  /** Every string a button body can render, or null when the body is not
   *  purely text — an <svg> child is a different question and `aria-hidden`
   *  answers it. */
  function rendered(body: string): string[] | null {
    if (!body.includes("{")) return [body.trim()];
    const literals = [...body.matchAll(/"([^"]*)"/g)].map(m => m[1].trim());
    const syntax = body.replace(/"[^"]*"/g, "").replace(/[?:{}\s]/g, "");
    // Anything left is an identifier being rendered, whose length nothing here
    // can know.
    if (/[A-Za-z0-9_]/.test(syntax)) return null;
    return literals;
  }

  it("leaves no glyph-only button whose only name is a tooltip", () => {
    // `title` is a valid last-resort name source, so 4.1.2 was technically
    // met — and a touch user never sees a tooltip, and a screen reader can be
    // configured never to read one. Two of the app's sixty-odd icon buttons
    // were in this state: the usage panel's ↻ and the accounts panel's +.
    const offenders: string[] = [];
    for (const [name, src] of BUNDLE) {
      for (const m of src.matchAll(/<button\b((?:[^<>]|\{[^{}]*\})*?)>([^<>]*)<\/button>/g)) {
        const [, attrs, body] = m;
        const texts = rendered(body);
        if (texts === null || texts.length === 0) continue;
        if (texts.some(t => t.length > 2)) continue;
        if (/\baria-label(?:ledby)?=/.test(attrs)) continue;
        offenders.push(`${name}: ${body.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names the ↻ with the same sentence its tooltip shows", () => {
    // One string for both, which keeps 2.5.3 satisfied by construction: the
    // words a voice-control user says are the words on screen. It is per
    // provider, so it never promises a section the panel is not rendering.
    expect(code(usage)).toMatch(/aria-label=\{refreshLabel\}\n\s+title=\{refreshLabel\}/);
    expect(code(usage)).toMatch(/providers\.claude && providers\.codex\s*\n?\s*\? "Refresh Claude \+ Codex quota"/);
  });

  it("names the + and keeps its longer tooltip as the hint", () => {
    expect(code(accounts)).toMatch(/aria-label="Add an account"/);
    expect(code(accounts)).toMatch(/title="Sign in to another Claude account/);
  });
});

// ── the chip that had news and said less than the one that did not ──────────

describe("the version chip's drift branch says what drifted (#381)", () => {
  it("named itself with its own text, which was the healthy chip's text", () => {
    // The regression this guards: the notice branch renders `v{notice.from}`
    // and an aria-hidden dot, so with no aria-label its accessible name was
    // the version string — byte for byte what the healthy chip announces. The
    // branch carrying the news was the quieter of the two.
    expect(code(app)).toMatch(/aria-label=\{versionNoticeLabel\(\{ \.\.\.notice, open: noticeOpen \}\)\}/);
  });

  it("says which way the drift goes, in both kinds", () => {
    expect(versionNoticeLabel({ kind: "upgrade", from: "1.35.2", to: "1.36.0", open: false }))
      .toBe("Version v1.35.2, v1.36.0 is available on npm — show the notice");
    expect(versionNoticeLabel({ kind: "restart", from: "1.35.2", to: "1.36.0", open: false }))
      .toBe("Version v1.35.2, v1.36.0 is installed and waiting for a restart — show the notice");
  });

  it("describes the next click rather than the current state", () => {
    const open = versionNoticeLabel({ kind: "upgrade", from: "1.0.0", to: "1.1.0", open: true });
    expect(open).toMatch(/hide the notice$/);
    expect(open).not.toMatch(/show the notice/);
  });

  it("carries the visible text inside the accessible name (2.5.3)", () => {
    // The chip reads `v1.35.2` on screen; a name that did not contain that
    // string would leave a voice-control user with nothing to say.
    for (const open of [true, false]) {
      expect(versionNoticeLabel({ kind: "upgrade", from: "1.35.2", to: "1.36.0", open }))
        .toContain("v1.35.2");
    }
  });
});

// ── the chart that hid its own buttons ──────────────────────────────────────

describe("the usage-history chart stopped hiding the days inside it (#381)", () => {
  it("is a group, not an image", () => {
    // role="img" makes the whole subtree presentational — and does nothing at
    // all to the tab order, so what it produced was up to ninety focusable
    // buttons that announced nothing when they took focus. Same shape as the
    // tool-bubble finding in #367: reachable and silent.
    expect(code(history)).toMatch(/<div className="uh-chart" role="group" aria-label="Daily cost by model">/);
    expect(code(history)).not.toMatch(/role="img"/);
  });

  it("names each day with the figure its tooltip already carried", () => {
    expect(code(history)).toMatch(/const dayLabel = `\$\{d\.period\}, \$\{fmtCost\(d\.totalCost\)\}`/);
    expect(code(history)).toMatch(/aria-label=\{dayLabel\}/);
    expect(code(history)).toMatch(/aria-pressed=\{isSel\}/);
  });

  it("stopped promising a tab widget's keyboard on the range strip", () => {
    // role="tab" means one tab stop for the set, arrows between the members,
    // and a tabpanel each. The strip has none of the three. A radiogroup —
    // which is what the issue proposed — carries exactly the same unmet
    // contract, so the swap is to group + aria-pressed, which is the shape the
    // canvas category chips already use.
    expect(code(history)).toMatch(/<div className="uh-range" role="group" aria-label="Range">/);
    expect(code(history)).not.toMatch(/role="tab(list)?"/);
    expect(code(history)).not.toMatch(/aria-selected/);
  });

  it("leaves the one real tab set alone, and says so", () => {
    // AddAccountDialog's two tabs do swap two panels, which is a genuine tab
    // widget with a genuine keyboard model missing — arrow keys, aria-controls,
    // a tabpanel each. That is a change to make deliberately and not as the
    // tail of a landmarks issue. Pinned so the scope-out stays a decision.
    expect(code(addAccount)).toMatch(/role="tablist"/);
    const tabbed = BUNDLE.filter(([, src]) => /role="tab"/.test(src)).map(([name]) => name);
    expect(tabbed).toEqual(["components/AddAccountDialog.tsx"]);
  });
});
