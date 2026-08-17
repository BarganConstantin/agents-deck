// #367: the canvas could not be operated without a mouse, in three ways that
// each hid the next.
//
// The first Tab killed every shortcut. App.tsx's window handler refuses to
// claim a keystroke aimed at a focused control, which is right — a bare "c"
// from a <select> truncates the event log — but every control on this deck is
// a <button> or a role="button", and Escape released focus only when the user
// was TYPING, which a button never is. Tabbing off the end of the document
// wraps to the first control rather than to <body>, so once focus left the
// body all thirteen single-key shortcuts were dead for the rest of the
// session, with no keyboard route back at all.
//
// The cards themselves were inert. React Flow makes every node a tabbable
// role="button" and answers Enter/Space itself — but its handler routes
// through updateNodesAndEdgesSelections, which only writes when the store owns
// the node array (`hasDefaultNodes`). This deck passes `nodes` as a controlled
// prop with no onNodesChange, so that write is skipped, the app's onNodeClick
// is never reached from the keyboard, and Enter on a focused card did nothing
// whatsoever: no selection, no ribbon, no detail panel, not even React Flow's
// own `.selected` class. And because the card wore role="button", the gate
// above killed j/k while it held focus, so the traversal shortcut could not
// rescue it either.
//
// And two thirds of the tab order announced as nothing: every clickable tool
// bubble was a role="button" tabIndex={0} inside the aria-hidden
// .tool-bursts-layer — 105 of a live deck's 166 focusables, each one a stop
// the accessibility tree says does not exist.
//
// Plain node here, no DOM and no renderer, so the decisions were moved into
// canvas-keys.ts and are checked directly; the parts that need a canvas are
// pinned by reading the source, the way manage-block.test.ts does.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  canvasKeyIntent,
  canvasOrder,
  shouldReleaseFocusOnEscape,
  stepTarget,
  type CanvasNode,
} from "../canvas-keys";
import { ownsKeystroke, type FocusTarget } from "../shortcuts";
import { escapeOutcome } from "../modal-dismiss";

const web = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(join(web, "App.tsx"), "utf8");
const bursts = readFileSync(join(web, "components/ToolBursts.tsx"), "utf8");
const css = readFileSync(join(web, "styles.css"), "utf8");

/** The same source with its comments gone, for the assertions that say a
 *  pattern appears NOWHERE. This repo explains every non-obvious decision in
 *  prose above the code, and the prose for these three findings necessarily
 *  quotes the markup it retired — `tabIndex`, `role="button"` — so a search for
 *  retired markup has to read the markup only. The same trick, for the same
 *  reason, as manage-block.test.ts's panelCode. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

/** Shapes a target the way App.tsx reads one off a real KeyboardEvent. */
const el = (tagName: string, over: Partial<FocusTarget> = {}): FocusTarget =>
  ({ tagName, isContentEditable: false, role: null, type: null, ...over });

/** A card, laid out. Only the position matters to traversal. */
const at = (id: string, x: number, y: number): CanvasNode => ({ id, x, y });

// ── Escape gets the keyboard back to the shortcuts ──────────────────────────

describe("Escape releases focus (#367, finding 1)", () => {
  it("releases every control that is not text, which is what a button is", () => {
    expect(shouldReleaseFocusOnEscape(el("BUTTON", { type: "button" }))).toBe(true);
    expect(shouldReleaseFocusOnEscape(el("SELECT"))).toBe(true);
    expect(shouldReleaseFocusOnEscape(el("A"))).toBe(true);
    expect(shouldReleaseFocusOnEscape(el("SUMMARY"))).toBe(true);
    expect(shouldReleaseFocusOnEscape(el("SPAN", { role: "button" }))).toBe(true);
    expect(shouldReleaseFocusOnEscape(el("INPUT", { type: "checkbox" }))).toBe(true);
    // The measured case: the Re-layout button, where `j` used to die.
    expect(shouldReleaseFocusOnEscape(el("BUTTON"))).toBe(true);
  });

  it("releases a focused agent card, so the canvas is not a one-way door", () => {
    // React Flow renders the wrapper as a <div>; the card inside it is one too.
    expect(shouldReleaseFocusOnEscape(el("DIV", { role: "button" }))).toBe(true);
  });

  it("leaves the search box alone, because escapeOutcome already blurred it", () => {
    // Two blurs of the same element is only a redundancy, but the precedence is
    // the point: a typing target is escapeOutcome's "blur" branch and never
    // reaches this one, so this rule must not claim to own it.
    for (const t of [el("INPUT", { type: "text" }), el("TEXTAREA"), el("DIV", { isContentEditable: true })]) {
      expect(escapeOutcome({ overlayOpen: false, typing: true })).toBe("blur");
      expect(shouldReleaseFocusOnEscape(t)).toBe(false);
    }
  });

  it("does not blur the floor, which is where focus already is", () => {
    // Escape on an unfocused page is the mouse user's deselect. It cleared the
    // selection before this change and clears exactly the same selection now.
    expect(shouldReleaseFocusOnEscape(el("BODY"))).toBe(false);
    expect(shouldReleaseFocusOnEscape(el("HTML"))).toBe(false);
    expect(shouldReleaseFocusOnEscape({})).toBe(false);
    expect(shouldReleaseFocusOnEscape(null)).toBe(false);
    expect(shouldReleaseFocusOnEscape(undefined)).toBe(false);
    expect(escapeOutcome({ overlayOpen: false, typing: false })).toBe("clear-selection");
  });

  it("never fires while a modal is up — that press belongs to the modal", () => {
    for (const typing of [true, false]) {
      expect(escapeOutcome({ overlayOpen: true, typing })).toBe("dismiss");
    }
  });

  it("is asked in App.tsx's clear-selection branch, and still clears", () => {
    // The release is additive: the selection clears on the same press it always
    // did, so nothing about the mouse's Escape changes.
    expect(app).toMatch(/if \(shouldReleaseFocusOnEscape\(target\)\) el\?\.blur\(\);\s*\n\s*clearSelection\(\);/);
  });
});

// ── a focused card answers Enter, and leaves every other key to the deck ────

describe("what a keystroke means on a focused card (#367, finding 2)", () => {
  const NODE = "agent-7";

  it("makes Enter and Space the click the card never answered", () => {
    expect(canvasKeyIntent({ key: "Enter", shiftKey: false }, NODE))
      .toEqual({ kind: "activate", nodeId: NODE, additive: false });
    expect(canvasKeyIntent({ key: " ", shiftKey: false }, NODE))
      .toEqual({ kind: "activate", nodeId: NODE, additive: false });
  });

  it("extends the selection on Shift, the way Shift+click already does", () => {
    // Shift, and deliberately not React Flow's own multi-select chord, which is
    // Meta on macOS and Control everywhere else — one modifier that means the
    // same thing on Linux, macOS and Windows.
    expect(canvasKeyIntent({ key: "Enter", shiftKey: true }, NODE))
      .toEqual({ kind: "activate", nodeId: NODE, additive: true });
    expect(app).toMatch(/selectAgent\(intent\.nodeId, intent\.additive\)/);
    expect(app).toMatch(/onNodeClick=\{\(e, n\) => \{[\s\S]*?selectAgent\(n\.id, e\.shiftKey\)/);
  });

  it("leaves the card the keys the card owns", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Backspace", "Escape"]) {
      expect(canvasKeyIntent({ key, shiftKey: false }, NODE)).toEqual({ kind: "node", nodeId: NODE });
    }
  });

  it("hands every other key straight back to the deck's shortcuts", () => {
    // The compounding half of the bug: with a card focused, ownsKeystroke() is
    // true for all of these, so the only two routes to another agent — j/k and
    // the session list, which is closed by default — were both shut.
    for (const key of ["j", "k", "/", "c", "r", "f", "l", "u", "a", "h", "t"]) {
      expect(canvasKeyIntent({ key, shiftKey: false }, NODE)).toEqual({ kind: "deck", nodeId: NODE });
      expect(ownsKeystroke(el("DIV", { role: "button" }))).toBe(true);   // …and this is why they were shut
    }
  });

  it("says nothing at all about a keystroke that did not come from a card", () => {
    for (const key of ["Enter", " ", "ArrowUp", "j"]) {
      expect(canvasKeyIntent({ key, shiftKey: false }, null)).toEqual({ kind: "deck", nodeId: null });
      expect(canvasKeyIntent({ key, shiftKey: false }, undefined)).toEqual({ kind: "deck", nodeId: null });
    }
  });

  it("exempts a card from the focused-control gate, and nothing else", () => {
    // The gate stays exactly as it was for the toolbar buttons and the panel
    // <select>s — a bare "c" from a dropdown must still not reach Clear.
    expect(app).toMatch(/if \(intent\.nodeId == null && ownsKeystroke\(target\)\) return;/);
  });

  it("asks the browser's chords first, so Cmd+Enter on a card stays the browser's", () => {
    // Cmd on macOS, Ctrl on Linux and Windows — isBrowserChord covers both, and
    // it has to be consulted before the card branch or the card would answer
    // half the OS's chords.
    const chord = app.indexOf("if (isBrowserChord(e)) return;");
    const card = app.indexOf("const intent = canvasKeyIntent(e,");
    const gate = app.indexOf("if (intent.nodeId == null && ownsKeystroke(target)) return;");
    expect(chord).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(chord);
    expect(gate).toBeGreaterThan(card);
  });

  it("takes Space away from pause only while a card is focused", () => {
    // Space is `activate` on a card and reaches togglePause everywhere else,
    // which is the same trade a focused <button> already makes.
    expect(canvasKeyIntent({ key: " ", shiftKey: false }, null)).toEqual({ kind: "deck", nodeId: null });
    expect(app).toMatch(/if \(e\.key === " "\) \{ e\.preventDefault\(\); togglePause\(\); \}/);
  });

  it("reads the id off the wrapper React Flow focuses, not off the card inside it", () => {
    // The reason this cannot live in AgentNode.tsx at all: the focusable
    // element is React Flow's .react-flow__node wrapper, and a keydown on it
    // bubbles UP — an onKeyDown on the card AgentNode renders inside would
    // never fire. And matching an ancestor instead would have answered the
    // context donut's Enter, since the donut is a real <button> in the card.
    expect(app).toMatch(/const RF_NODE_CLASS = "react-flow__node";/);
    expect(app).toMatch(/el\.classList\?\.contains\?\.\(RF_NODE_CLASS\)/);
    expect(app).not.toMatch(/closest\(["'`]\.react-flow__node/);
    expect(readFileSync(join(web, "components/AgentNode.tsx"), "utf8")).not.toMatch(/onKeyDown/);
  });

  it("refuses an id that is not an agent on the canvas", () => {
    // The invisible per-session drag handles are .react-flow__node wrappers too.
    expect(app).toMatch(/nodesRef\.current\.some\(n => n\.id === focusedId\)/);
  });
});

// ── j and k, and the focus that follows them ────────────────────────────────

describe("traversal order", () => {
  it("reads down the column first, then across", () => {
    const nodes = [at("c", 0, 200), at("a", 0, 0), at("b", 300, 0)];
    expect(canvasOrder(nodes).map(n => n.id)).toEqual(["a", "b", "c"]);
  });

  it("starts at the top for j and at the bottom for k when nothing is selected", () => {
    const nodes = [at("a", 0, 0), at("b", 0, 100), at("c", 0, 200)];
    expect(stepTarget(nodes, null, 1)).toBe("a");
    expect(stepTarget(nodes, null, -1)).toBe("c");
    expect(stepTarget(nodes, undefined, 1)).toBe("a");
  });

  it("wraps at both ends", () => {
    const nodes = [at("a", 0, 0), at("b", 0, 100), at("c", 0, 200)];
    expect(stepTarget(nodes, "c", 1)).toBe("a");
    expect(stepTarget(nodes, "a", -1)).toBe("c");
  });

  it("steps one at a time, in order", () => {
    const nodes = [at("a", 0, 0), at("b", 0, 100), at("c", 0, 200)];
    expect(stepTarget(nodes, "a", 1)).toBe("b");
    expect(stepTarget(nodes, "b", 1)).toBe("c");
    expect(stepTarget(nodes, "c", -1)).toBe("b");
  });

  it("starts over when the selected agent has left the canvas", () => {
    const nodes = [at("a", 0, 0), at("b", 0, 100)];
    expect(stepTarget(nodes, "gone", 1)).toBe("a");
    expect(stepTarget(nodes, "gone", -1)).toBe("b");
  });

  it("has nothing to say about an empty canvas", () => {
    expect(stepTarget([], null, 1)).toBeNull();
    expect(stepTarget([], "a", -1)).toBeNull();
  });

  it("does not disturb the array it was handed", () => {
    const nodes = [at("c", 0, 200), at("a", 0, 0)];
    canvasOrder(nodes);
    stepTarget(nodes, null, 1);
    expect(nodes.map(n => n.id)).toEqual(["c", "a"]);
  });

  it("is the order App.tsx traverses in", () => {
    expect(app).toMatch(/stepTarget\(\s*\n\s*current\.map\(n => \(\{ id: n\.id, x: n\.position\.x, y: n\.position\.y \}\)\),/);
  });

  it("moves the keyboard with the selection, but only when it was already on a card", () => {
    // j from <body> stays a pure shortcut: focus stays off, so every other
    // single-key shortcut — space included — keeps working. j from a card is
    // navigation, and the focus has to come along or the next Enter would
    // re-select the card the user just stepped off.
    expect(app).toMatch(/const follow = isCanvasNodeElement\(document\.activeElement\);/);
    expect(app).toMatch(/if \(follow\) focusCanvasNode\(target\.id\);/);
    // preventScroll: the canvas is a transformed plane in a fixed box, and the
    // browser's own scroll-into-view would shove the whole layer behind the
    // panels. fitView is what brings the node on screen.
    expect(app).toMatch(/\.focus\(\{ preventScroll: true \}\)/);
  });
});

// ── the 105 focusables that announced as nothing ────────────────────────────

describe("the tool bubbles are decoration, and now say so (#367, finding 3)", () => {
  it("keeps the layer hidden from the accessibility tree", () => {
    expect(bursts).toMatch(/className="tool-bursts-layer" aria-hidden/);
  });

  it("puts no focus stop anywhere inside it", () => {
    const markup = code(bursts);
    expect(markup).not.toMatch(/tabIndex/);
    expect(markup).not.toMatch(/role=/);
    expect(markup).not.toMatch(/onKeyDown/);
    // The label was the sharpest part of the finding: carefully written, and
    // read by nothing, because aria-hidden had already removed the element it
    // was on. A label on a hidden node is worse than no label — it reads as
    // coverage that is not there.
    expect(markup).not.toMatch(/aria-label/);
  });

  it("leaves the mouse exactly where it was", () => {
    expect(bursts).toMatch(/onClick=\{clickable \? \(\) => onOpenTool!\(b\.toolId\) : undefined\}/);
    expect(bursts).toMatch(/\$\{clickable \? " clickable" : ""\}/);
    expect(css).toMatch(/\.tool-burst\.clickable:hover \{/);
  });

  it("drops the focus ring a bubble can no longer receive", () => {
    expect(css).not.toMatch(/\.tool-burst\.clickable:focus-visible/);
  });

  it("still reaches the same modal from the detail panel, with a real button", () => {
    // This is what makes decoration the right answer rather than the other one:
    // the tools are already a keyboard-reachable, ordered, announced list.
    expect(app).toMatch(/<button className="tool clickable"/);
    expect(app).toMatch(/<ToolRow key=\{t\.id\}[^>]*onClick=\{\(\) => onOpenTool\(t\.id\)\}/);
  });
});

describe("nothing else in the deck invents a focus stop", () => {
  /** Every .tsx that ends up in the bundle. The suite's own files are not markup. */
  function components(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "__tests__" ? [] : components(path);
      return path.endsWith(".tsx") ? [path] : [];
    });
  }

  it("sets tabIndex nowhere, so every focus stop is a real control", () => {
    // The deck's focusables are <button>, <input>, <select> and the wrappers
    // React Flow builds for the canvas — all of which the browser and the
    // library put in the tab order themselves, in the right place, announced.
    // The one hand-rolled tabIndex in the app was the burst bubble, inside
    // aria-hidden. If a later feature needs a roving tabindex on the canvas
    // this line is the thing to revisit deliberately, which is the point of it.
    const offenders = components(web)
      .filter(p => /tabIndex/.test(code(readFileSync(p, "utf8"))))
      .map(p => p.slice(web.length));
    expect(offenders).toEqual([]);
  });

  it("has no role=\"button\" left that a keyboard cannot operate", () => {
    // The ribbon's × was one: a role="button" labelled "Deselect", nested
    // inside the ribbon's own <button> — where a button may not go — and with
    // no tabIndex, so no keyboard could ever reach it. Escape carries the same
    // verb from anywhere, so the × is decoration with a click on it.
    expect(code(app)).not.toMatch(/role="button"/);
    expect(app).toMatch(/aria-hidden\s*\n\s*className="selected-close"/);
  });
});

describe("the shortcut list tells the truth about the keyboard", () => {
  it("names the two keys that reach and open a card", () => {
    expect(app).toMatch(/<kbd>tab<\/kbd><span>reach the cards<\/span>/);
    expect(app).toMatch(/<kbd>enter<\/kbd><span>select the focused card<\/span>/);
  });

  it("says what Escape now also does", () => {
    expect(app).toMatch(/<kbd>Esc<\/kbd><span>deselect, release focus<\/span>/);
  });
});
