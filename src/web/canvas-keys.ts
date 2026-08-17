// What the keyboard means on the canvas.
//
// Three separate holes made the deck unusable without a mouse, and all three
// were decisions about focus rather than about rendering, so they live here
// where a plain-node test can read them (the same reason shortcuts.ts and
// modal-dismiss.ts exist).
//
// 1. Escape was the only way back to <body> and it did not take it. The
//    window handler in App.tsx refuses to claim a keystroke aimed at a focused
//    control — correctly, or a bare "c" from a <select> would truncate the
//    event log — but every control on this deck is a <button>, so the first
//    Tab killed all thirteen single-key shortcuts for the rest of the session.
//    Escape released focus only when the user was TYPING, which a button never
//    is, and tabbing off the end of the document wraps to the first control
//    rather than to the body. There was no keyboard route back at all; the
//    only fix on offer was a mouse click on empty canvas.
//
// 2. Enter on a focused agent card did nothing whatsoever. React Flow makes
//    every node a tabbable role="button" and answers Enter/Space itself, but
//    its handler routes through the store's updateNodesAndEdgesSelections,
//    which only writes when `hasDefaultNodes` is set — i.e. when React Flow
//    owns the node array. This deck passes `nodes` as a controlled prop with
//    no onNodesChange, so that write is skipped and the app's own
//    onNodeClick — the single door to selectAgent — is never called from the
//    keyboard. The card was announced as a button and was not one.
//
// 3. And while a card held focus the deck's shortcuts were dead for the same
//    reason a button kills them: role="button" is role="button". But a card is
//    not a control the user typed into, it is the canvas itself wearing a role
//    React Flow chose. It owns its activation keys and its arrows; every other
//    key is still the deck's.
//
// Kept as data-in / decision-out functions with no DOM: App.tsx reads the id
// off the focused element and hands it here.

import { isTypingTarget, type FocusTarget } from "./shortcuts";

/** A canvas node reduced to what traversal order depends on. Structural rather
 *  than React Flow's Node so the rule can be tested without the library. */
export interface CanvasNode {
  id: string;
  x: number;
  y: number;
}

/** Reading order: down the column first, then across. The same order the
 *  `nodes` prop already has, which is what the eye expects j to follow. */
export function canvasOrder<T extends CanvasNode>(nodes: readonly T[]): T[] {
  return nodes.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/** The agent j (+1) or k (-1) lands on, or null when there is nothing to land
 *  on. Wraps at both ends, and starts from the top for j / the bottom for k
 *  when nothing is selected yet — so the very first j from an empty selection
 *  selects the first agent rather than doing nothing. */
export function stepTarget(
  nodes: readonly CanvasNode[],
  selectedId: string | null | undefined,
  direction: 1 | -1,
): string | null {
  if (nodes.length === 0) return null;
  const ordered = canvasOrder(nodes);
  const currentIdx = selectedId ? ordered.findIndex(n => n.id === selectedId) : -1;
  const next = currentIdx === -1
    ? (direction === 1 ? 0 : ordered.length - 1)
    : (currentIdx + direction + ordered.length) % ordered.length;
  return ordered[next]?.id ?? null;
}

/** What a keystroke that arrived while an agent card held focus is for.
 *
 *  `nodeId` rides along in every branch because the caller needs it for the
 *  one gate it still has to apply: the deck's "a focused control owns its own
 *  keys" rule must not fire for a card, and "was this a card?" is exactly the
 *  question this function already answered. */
export type CanvasKeyIntent =
  /** Enter or Space on a card — the keyboard's version of a click. */
  | { kind: "activate"; nodeId: string; additive: boolean }
  /** A key the card itself owns; the deck stays out of it. */
  | { kind: "node"; nodeId: string }
  /** Not the canvas's business — the deck's own shortcuts get it. */
  | { kind: "deck"; nodeId: string | null };

/** The modifier flags this rule reads. Shift only: Ctrl/Cmd/Alt chords belong
 *  to the browser and App.tsx has already turned them away by the time a
 *  keystroke reaches here. */
export interface ActivationModifiers {
  key: string;
  shiftKey: boolean;
}

// Arrows are React Flow's own node-move gesture and Delete/Backspace its own
// delete gesture. Neither does anything in this deck today — both route through
// the same controlled-nodes dead end that swallowed Enter — but they are the
// card's keys, not the deck's, and answering them here would be the deck
// claiming keys it has no shortcut for. Escape is settled before this function
// is ever called; it is listed so the table below is the whole story.
const NODE_OWNED_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Delete", "Backspace",
]);

export function canvasKeyIntent(e: ActivationModifiers, nodeId: string | null | undefined): CanvasKeyIntent {
  // Focus is not on a card, so nothing on the canvas has an opinion.
  if (nodeId == null) return { kind: "deck", nodeId: null };
  // Shift extends, exactly as Shift+click already does in onNodeClick — and
  // deliberately not React Flow's own multi-select chord, which is Meta on
  // macOS and Control everywhere else. One modifier that means the same thing
  // on all three platforms beats matching a library convention the rest of
  // this app never adopted.
  if (e.key === "Enter" || e.key === " ") return { kind: "activate", nodeId, additive: e.shiftKey };
  if (NODE_OWNED_KEYS.has(e.key)) return { kind: "node", nodeId };
  return { kind: "deck", nodeId };
}

// A keydown's target is whatever holds focus, so these are the tags that mean
// "nothing is focused": <body> is where focus falls when it has nowhere else to
// be, and window/document reach the listener with no tag at all.
const UNFOCUSED_TAGS = new Set(["", "BODY", "HTML", "#DOCUMENT"]);

/** Whether Escape should hand focus back to the document before it clears the
 *  selection.
 *
 *  Only when there is somewhere to hand it back FROM. Blurring <body> is not a
 *  release, and a typing target is already the "blur" outcome escapeOutcome
 *  returns one branch earlier — this is the branch for everything that is
 *  focused and is not text: the toolbar buttons, the panel rows, the agent
 *  cards. Releasing them is what makes the next `j` work, and it costs a
 *  keyboard user their place in the tab order, which is the trade Escape is
 *  for. */
export function shouldReleaseFocusOnEscape(t: FocusTarget | null | undefined): boolean {
  if (!t) return false;
  if (isTypingTarget(t)) return false;
  return !UNFOCUSED_TAGS.has(String(t.tagName ?? "").toUpperCase());
}
