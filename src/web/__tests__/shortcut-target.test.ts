// The window keydown listener exempted exactly one thing — tagName "INPUT" —
// so every other focusable control on the deck lost its own keys. Space on a
// focused toolbar button ran preventDefault and toggled pause, and a canceled
// Space keydown also suppresses the button's activation, so the keyboard user
// paused the stream instead of pressing the button. The version banner's
// dismiss span and the clickable tool bursts are role="button" with their own
// Space handler, so one press did two unrelated things. And with one of the
// accounts panel's <select>s focused — that panel opens by default — a bare
// "c" reached Clear, which truncates events.jsonl with no confirmation.
// These pin which focused targets get to keep their keystrokes.
import { describe, it, expect } from "vitest";
import { isTypingTarget, ownsKeystroke, type FocusTarget } from "../shortcuts";

/** Shapes a target the way App.tsx reads one off a real KeyboardEvent. */
const el = (tagName: string, over: Partial<FocusTarget> = {}): FocusTarget =>
  ({ tagName, isContentEditable: false, role: null, type: null, ...over });

describe("ownsKeystroke", () => {
  it("leaves the canvas itself to the deck", () => {
    expect(ownsKeystroke(el("DIV"))).toBe(false);
    expect(ownsKeystroke(el("BODY"))).toBe(false);
    expect(ownsKeystroke(el("SVG"))).toBe(false);
  });

  it("treats a keystroke with no element behind it as the deck's", () => {
    // window and document reach the listener as targets with no tagName.
    expect(ownsKeystroke({})).toBe(false);
    expect(ownsKeystroke(null)).toBe(false);
    expect(ownsKeystroke(undefined)).toBe(false);
  });

  it("gives a focused button back its Space, which is the browser's activation key", () => {
    expect(ownsKeystroke(el("BUTTON", { type: "button" }))).toBe(true);
  });

  it("gives a select its letters, so a bare c cannot run Clear from a dropdown", () => {
    expect(ownsKeystroke(el("SELECT"))).toBe(true);
    expect(ownsKeystroke(el("OPTION"))).toBe(true);
  });

  it("still exempts the search input and a textarea", () => {
    expect(ownsKeystroke(el("INPUT", { type: "text" }))).toBe(true);
    expect(ownsKeystroke(el("INPUT"))).toBe(true);
    expect(ownsKeystroke(el("TEXTAREA"))).toBe(true);
  });

  it("exempts an input that answers Space rather than characters", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "range", "file"]) {
      expect(ownsKeystroke(el("INPUT", { type }))).toBe(true);
    }
  });

  it("exempts anything the user is writing into", () => {
    expect(ownsKeystroke(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(ownsKeystroke(el("SPAN", { isContentEditable: true }))).toBe(true);
  });

  it("exempts the dismiss span and the tool bursts, which are spans wearing role=button", () => {
    expect(ownsKeystroke(el("SPAN", { role: "button" }))).toBe(true);
    expect(ownsKeystroke(el("DIV", { role: "button" }))).toBe(true);
  });

  it("exempts the other controls built out of divs — switch, tab, option, menuitem", () => {
    for (const role of ["switch", "tab", "option", "menuitem", "checkbox", "combobox", "textbox", "slider"]) {
      expect(ownsKeystroke(el("DIV", { role }))).toBe(true);
    }
  });

  it("keeps the shortcuts alive under a decorative role", () => {
    // A live region or a plain container is not something you focus and press.
    for (const role of ["status", "alert", "presentation", "img", "toolbar", "tablist", "dialog"]) {
      expect(ownsKeystroke(el("DIV", { role }))).toBe(false);
    }
  });

  it("reads a role out of an ARIA fallback list", () => {
    expect(ownsKeystroke(el("DIV", { role: "  BUTTON  " }))).toBe(true);
    expect(ownsKeystroke(el("DIV", { role: "doc-noteref link" }))).toBe(true);
    expect(ownsKeystroke(el("DIV", { role: "" }))).toBe(false);
  });

  it("matches the tag whichever case it arrives in", () => {
    // Browsers report tagName uppercase; JSX authors the same element lowercase.
    expect(ownsKeystroke(el("button"))).toBe(true);
    expect(ownsKeystroke(el("select"))).toBe(true);
  });
});

describe("isTypingTarget", () => {
  it("says yes to the places characters actually land", () => {
    expect(isTypingTarget(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "search" }))).toBe(true);
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("says no to a control that only looks like an input", () => {
    // Escape blurs a typing target. Blurring a checkbox or a button would cost
    // the keyboard user their place in the tab order for nothing.
    for (const type of ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]) {
      expect(isTypingTarget(el("INPUT", { type }))).toBe(false);
    }
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(el("SELECT"))).toBe(false);
    expect(isTypingTarget(el("SPAN", { role: "button" }))).toBe(false);
  });

  it("ignores the case of the input type", () => {
    expect(isTypingTarget(el("INPUT", { type: "CHECKBOX" }))).toBe(false);
    expect(isTypingTarget(el("input", { type: "Text" }))).toBe(true);
  });

  it("says no when there is no element, so Escape still clears the selection", () => {
    expect(isTypingTarget(el("BODY"))).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
