// #371: four of the six overlays announced `aria-modal="true"` — the claim
// that the rest of the document is inert while the dialog is up — over a
// document where every last control was still one Tab away.
//
// Three of them did not even take focus when they opened. `useModalDismiss`
// has accepted a `focusRef` since #366 and ToolModal, UsageHistoryModal and
// AddAccountDialog named none, so opening the tool modal from a tool bubble
// left the keyboard on the bubble: a screen reader's cursor outside a dialog
// that says nothing outside it exists reads as a page where nothing is left.
//
// And nothing anywhere contained Tab. From the last control in any of the six,
// Tab walked into the canvas, the toolbar and the panels behind the scrim —
// stops that are painted over, cannot be seen, and lead back out of the dialog
// the user is still reading. The issue counted 171 of them; that measurement
// predates #367, which took 105 tool-bubble stops out of the tab order, so the
// number is smaller now and the walk out is exactly as bad.
//
// Escape is deliberately untouched here. #366 gave it to the dismiss queue and
// #367 gave the loose-focus branch the blur that makes the next `j` work, and
// both still hold: a press that arrives while an overlay is open is "dismiss"
// and never reaches the branch that blurs. What the trap changes is that focus
// is now INSIDE the dialog when that press lands, which is what finally makes
// the unmount restore in modal-dismiss.ts do something — it only fires when
// focus fell to <body>, and before this it rarely had.
//
// Plain node, no DOM and no renderer, so the wrap itself is a pure rule in
// modal-dismiss.ts and is checked directly; the parts that need a document are
// pinned by reading the source, the way manage-block.test.ts does.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createDismissStack,
  escapeOutcome,
  isScrollStop,
  isTabbable,
  shouldRestoreFocus,
  trapTab,
  CONFIRM_LAYER,
  TABBABLE_SELECTOR,
} from "../modal-dismiss";

const web = fileURLToPath(new URL("..", import.meta.url));
const dir = `${web}components`;
const read = (f: string) => readFileSync(`${dir}/${f}`, "utf8");
const hook = read("use-modal-dismiss.ts");
const app = readFileSync(`${web}App.tsx`, "utf8");

/** The same source with its comments gone, for the assertions that say a
 *  pattern appears NOWHERE. The prose in this repo quotes the markup and the
 *  keys it is explaining — this file's own hook talks about Escape and about
 *  Ctrl+Tab in sentences — so a search for absence has to read the code only.
 *  The same trick, for the same reason, as manage-block.test.ts's panelCode. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

/** The opening tag of the scrim — the element with the dismiss onClick. */
function backdropTag(src: string): string | null {
  const m = /<div className="[a-z-]*backdrop"[^>]*>/.exec(src);
  return m ? m[0] : null;
}

/** The dialog surface itself. The `=>` alternative is not decoration: the tag
 *  carries `onClick={e => e.stopPropagation()}` and a plain [^>] run stops dead
 *  on the arrow. Same shape as modal-dialog-role.test.ts, which pins the role. */
function dialogTag(src: string): string {
  return (src.match(/<div\s(?:=>|[^>])*role="dialog"(?:=>|[^>])*>/) ?? [""])[0];
}

const MODALS = readdirSync(dir)
  .filter(f => f.endsWith(".tsx"))
  .filter(f => backdropTag(read(f)) !== null);

// ── the wrap, as a rule about a list and an index ───────────────────────────

describe("trapTab", () => {
  it("wraps to the first control when Tab reaches the last one", () => {
    // The whole finding in one line: this used to be the step into the canvas.
    expect(trapTab({ count: 3, index: 2, shiftKey: false })).toEqual({ kind: "focus", index: 0 });
  });

  it("wraps to the last control when Shift+Tab leaves the first", () => {
    expect(trapTab({ count: 3, index: 0, shiftKey: true })).toEqual({ kind: "focus", index: 2 });
  });

  it("leaves the browser to a Tab that was already staying inside", () => {
    // Re-implementing Tab would be a worse Tab: the browser knows about reading
    // order, scroll containers and shadow roots that a selector sweep does not.
    expect(trapTab({ count: 3, index: 1, shiftKey: false })).toEqual({ kind: "allow" });
    expect(trapTab({ count: 3, index: 1, shiftKey: true })).toEqual({ kind: "allow" });
    expect(trapTab({ count: 3, index: 0, shiftKey: false })).toEqual({ kind: "allow" });
    expect(trapTab({ count: 3, index: 2, shiftKey: true })).toEqual({ kind: "allow" });
  });

  it("collects a focus that is not on one of the dialog's controls", () => {
    // Two ways to be here, and one answer for both: a modal that took no focus
    // when it opened, and a click on a paragraph of modal text, which leaves
    // focus on <body> — from where the next Tab starts at the top of the
    // document, i.e. in the toolbar behind the scrim.
    expect(trapTab({ count: 4, index: -1, shiftKey: false })).toEqual({ kind: "focus", index: 0 });
    expect(trapTab({ count: 4, index: -1, shiftKey: true })).toEqual({ kind: "focus", index: 3 });
  });

  it("treats an index past the end as a focus that has left", () => {
    expect(trapTab({ count: 2, index: 7, shiftKey: false })).toEqual({ kind: "focus", index: 0 });
    expect(trapTab({ count: 2, index: 7, shiftKey: true })).toEqual({ kind: "focus", index: 1 });
  });

  it("keeps a one-control dialog on that one control", () => {
    // The tool modal is this: a header, two payload panes and a single ×.
    expect(trapTab({ count: 1, index: 0, shiftKey: false })).toEqual({ kind: "focus", index: 0 });
    expect(trapTab({ count: 1, index: 0, shiftKey: true })).toEqual({ kind: "focus", index: 0 });
  });

  it("holds a Tab that has nowhere to go rather than letting it out", () => {
    // No such dialog exists today — every one of the six has at least its ×.
    // Letting Tab out of that one would be the same bug with a smaller audience.
    expect(trapTab({ count: 0, index: -1, shiftKey: false })).toEqual({ kind: "hold" });
    expect(trapTab({ count: 0, index: -1, shiftKey: true })).toEqual({ kind: "hold" });
  });

  it("reads Shift and no other modifier, which is the same key everywhere", () => {
    // Ctrl+Tab and Cmd+Tab belong to the browser and the OS. The hook turns
    // them away through isBrowserChord — the deck's existing answer to "whose
    // keystroke is this", which already covers Ctrl on Linux/Windows and Cmd on
    // macOS — rather than through a second rule that could drift from it.
    expect(hook).toMatch(/if \(e\.key !== "Tab" \|\| isBrowserChord\(e\)\) return;/);
    expect(hook).toMatch(/import \{ isBrowserChord \} from "\.\.\/shortcuts";/);
    expect(code(hook)).not.toMatch(/ctrlKey|metaKey|altKey/);
  });
});

// ── which controls the wrap counts ──────────────────────────────────────────

describe("isTabbable", () => {
  it("takes an ordinary control", () => {
    expect(isTabbable({ tabIndex: 0, rendered: true })).toBe(true);
    expect(isTabbable({})).toBe(true);
  });

  it("skips a disabled control, because the browser's own Tab skips it", () => {
    // The usage modal's ↻ is disabled for as long as ccusage runs, and the
    // sign-in dialog's Continue until a code is typed. Wrapping onto either
    // would put focus somewhere Tab could never have reached.
    expect(isTabbable({ disabled: true })).toBe(false);
  });

  it("skips anything taken out of the tab order", () => {
    expect(isTabbable({ tabIndex: -1 })).toBe(false);
  });

  it("skips a control that draws nothing", () => {
    // A selector cannot see a `display: none` ancestor, and a wrap onto an
    // invisible control is a wrap that loses the user completely.
    expect(isTabbable({ rendered: false })).toBe(false);
  });

  it("has nothing to say about nothing", () => {
    expect(isTabbable(null)).toBe(false);
    expect(isTabbable(undefined)).toBe(false);
  });

  it("names the controls the deck builds its dialogs out of", () => {
    for (const part of ["a[href]", "button", "input", "select", "textarea", "[tabindex]"]) {
      expect(`${part}: ${TABBABLE_SELECTOR.includes(part)}`).toBe(`${part}: true`);
    }
    // And leaves "can Tab actually land here" to isTabbable, so the two halves
    // of one rule cannot answer differently.
    expect(TABBABLE_SELECTOR).not.toMatch(/disabled/);
  });
});

describe("isScrollStop", () => {
  const pane = { overflow: "auto", overflowing: true, hasFocusable: false };

  it("counts a scrollable region the keyboard would otherwise lose", () => {
    // `.modal-body` is `overflow: auto`, and in the tool modal and the session
    // summary it holds no control at all — so Chrome 127+ and Firefox both make
    // it a tab stop, and it is the only keyboard way to scroll the payload the
    // tool modal exists to show. A trap built from a control selector alone
    // would have quietly taken it away.
    expect(isScrollStop(pane)).toBe(true);
    expect(isScrollStop({ ...pane, overflow: "scroll" })).toBe(true);
    const css = readFileSync(`${web}styles.css`, "utf8");
    expect(css).toMatch(/\.modal-body \{[^}]*overflow: auto;/);
  });

  it("ignores a region whose content fits", () => {
    // Nothing to scroll, so neither browser stops on it and neither do we.
    expect(isScrollStop({ ...pane, overflowing: false })).toBe(false);
  });

  it("ignores a scroller that holds a control of its own", () => {
    // Both browsers leave it out, because Tab reaching the control inside it
    // has already reached the region. The sign-in dialog's body is this.
    expect(isScrollStop({ ...pane, hasFocusable: true })).toBe(false);
  });

  it("ignores a box that simply overflows without scrolling", () => {
    expect(isScrollStop({ ...pane, overflow: "hidden" })).toBe(false);
    expect(isScrollStop({ ...pane, overflow: "visible" })).toBe(false);
    expect(isScrollStop({ ...pane, overflow: null })).toBe(false);
  });

  it("has nothing to say about nothing", () => {
    expect(isScrollStop(null)).toBe(false);
    expect(isScrollStop(undefined)).toBe(false);
  });
});

// ── one overlay holds the keyboard, and it is the one on top ────────────────

describe("which overlay holds Tab", () => {
  it("is the same one Escape would close", () => {
    // Not a second ordering: the clear prompt raised over a session summary is
    // the thing painted on top, the thing Escape means, and the thing Tab must
    // stay inside. Two answers here would be two answers to the same question.
    const stack = createDismissStack();
    const summary = () => {};
    const prompt = () => {};
    stack.push(summary);
    stack.push(prompt);
    expect(stack.isTop(prompt)).toBe(true);
    expect(stack.isTop(summary)).toBe(false);
  });

  it("follows the layer, not the arrival order", () => {
    // The Stop hook fires while the user is deciding: the summary mounts last
    // but the prompt is still what is painted on top.
    const stack = createDismissStack();
    const prompt = () => {};
    const summary = () => {};
    stack.push(prompt, CONFIRM_LAYER);
    stack.push(summary);
    expect(stack.isTop(prompt)).toBe(true);
    expect(stack.isTop(summary)).toBe(false);
  });

  it("hands the keyboard back down the pile as each overlay closes", () => {
    const stack = createDismissStack();
    const usage = () => {};
    const tool = () => {};
    stack.push(usage);
    const dropTool = stack.push(tool);
    dropTool();
    expect(stack.isTop(usage)).toBe(true);
  });

  it("says no when there is no overlay, or when it never saw this one", () => {
    const stack = createDismissStack();
    const stranger = () => {};
    expect(stack.isTop(stranger)).toBe(false);
    stack.push(() => {});
    expect(stack.isTop(stranger)).toBe(false);
  });
});

// ── what each of the six overlays does with it ──────────────────────────────

describe("the deck's six overlays", () => {
  it("has found all six, so a new one cannot skip this file", () => {
    expect(MODALS.length).toBe(6);
  });

  it("gives every dialog a boundary for the trap to hold Tab inside", () => {
    // The ref comes back from the hook, so a modal cannot hold Tab without
    // saying where the walls are, and cannot get the walls wrong.
    for (const f of MODALS) {
      const src = read(f);
      expect(`${f}: ${/const dialogRef = useModalDismiss[<(]/.test(src)}`).toBe(`${f}: true`);
      expect(`${f}: ${dialogTag(src).includes("ref={dialogRef}")}`).toBe(`${f}: true`);
    }
  });

  it("puts the boundary on the dialog and not on the scrim", () => {
    // The backdrop is a click-to-close gesture that covers the whole viewport.
    // Trapping Tab inside THAT would be trapping it inside the page.
    for (const f of MODALS) {
      expect(`${f}: ${backdropTag(read(f))!.includes("ref=")}`).toBe(`${f}: false`);
    }
  });

  it("now says aria-modal on all six, because all six mean it", () => {
    // It was on four. It is a claim about the rest of the document, so it was
    // wrong on all four and missing on the two that behaved no differently.
    for (const f of MODALS) {
      expect(`${f}: ${dialogTag(read(f)).includes('aria-modal="true"')}`).toBe(`${f}: true`);
    }
  });

  it("takes focus on open, in all six", () => {
    // Either the modal names its own first stop, or the hook takes the dialog's
    // first control. What none of them may do any more is nothing.
    const named = MODALS.filter(f => /useModalDismiss\([^)]*focusRef/s.test(read(f)));
    expect(named.sort()).toEqual([
      "AddAccountDialog.tsx", "ClearConfirm.tsx", "ContextModal.tsx",
      "SessionSummary.tsx", "UsageHistoryModal.tsx",
    ]);
    expect(hook).toMatch(/\(focusRef\?\.current \?\? tabbablesIn\(dialogRef\.current\)\[0\]\)\?\.focus\(\)/);
  });

  it("lands the tool modal's default on its ×, which is its first control", () => {
    // The one modal that names no focusRef, because the hook's own default is
    // already the right answer there — and this is what makes that true.
    const firstButton = (/<button(?:=>|[^>])*>/.exec(code(read("ToolModal.tsx"))) ?? [""])[0];
    expect(firstButton).toContain('aria-label="Close (Esc)"');
  });

  it("greets the usage modal's keyboard with Close and not with a range tab", () => {
    // Its header opens with a four-button range strip. A dialog whose greeting
    // is "7d" reads as a setting to change rather than a thing to read or leave.
    const src = read("UsageHistoryModal.tsx");
    expect(src).toMatch(/const closeRef = useRef<HTMLButtonElement>\(null\);/);
    expect(src).toMatch(/<button ref=\{closeRef\} className="glyph-btn uh-close"/);
  });

  it("focuses the sign-in dialog's primer, the branch it always opens on", () => {
    // The code field and the share field each take focus from an effect of
    // their own; the primer — the branch every open starts on — took none, so
    // the dialog that opens a browser tab did it with focus outside itself.
    const src = read("AddAccountDialog.tsx");
    expect(src).toMatch(/useModalDismiss\(close, \{ focusRef: primerRef \}\)/);
    expect(src).toMatch(/<button type="button" ref=\{primerRef\}[\s\S]*?Open the sign-in page/);
  });
});

// ── the hook is where all of it actually happens ────────────────────────────

describe("useModalDismiss", () => {
  it("listens on window, because focus is not always inside the dialog", () => {
    // Clicking a paragraph of modal text drops focus on <body>. A listener on
    // the dialog would never see the Tab that then starts from the top of the
    // document, which is the toolbar behind the scrim.
    expect(hook).toMatch(/window\.addEventListener\("keydown", onKey\)/);
    expect(hook).toMatch(/window\.removeEventListener\("keydown", onKey\)/);
  });

  it("asks trapTab rather than spelling the wrap a second time", () => {
    expect(hook).toMatch(/const move = trapTab\(\{\s*\n\s*count: stops\.length,\s*\n\s*index: active \? stops\.indexOf\(active\) : -1,\s*\n\s*shiftKey: e\.shiftKey,\s*\n\s*\}\);/);
    expect(hook).toMatch(/if \(move\.kind === "allow"\) return;\s*\n\s*e\.preventDefault\(\);/);
  });

  it("only cancels a Tab it is actually redirecting", () => {
    // preventDefault sits after the "allow" return, so a Tab moving between two
    // controls of the dialog is still the browser's own Tab, with the browser's
    // own idea of what comes next.
    const allow = hook.indexOf('if (move.kind === "allow") return;');
    expect(allow).toBeGreaterThan(-1);
    expect(hook.indexOf("e.preventDefault()")).toBeGreaterThan(allow);
  });

  it("lets only the top overlay claim a Tab it cannot place", () => {
    // Both overlays on screen are listening. The lower one stays out of it
    // unless focus is genuinely within its own walls, or the summary underneath
    // the clear prompt would pull the keyboard out of the prompt.
    expect(hook).toMatch(/if \(!inside && !modalStack\.isTop\(dismiss\)\) return;/);
    expect(hook).toMatch(/const inside = active != null && dialog\.contains\(active\);/);
  });

  it("reads the dialog's controls fresh on every keystroke", () => {
    // These dialogs change shape while they are up: the sign-in dialog swaps
    // its whole body between five branches and the usage modal disables its ↻
    // for as long as ccusage runs. A list captured on open would wrap onto
    // controls that are gone.
    expect(hook).toMatch(/const stops = stopsFor\(dialog, active\);/);
    expect(hook).toMatch(/function tabbablesIn\(dialog: HTMLElement \| null\): HTMLElement\[\] \{/);
    expect(code(hook)).not.toMatch(/useRef[^\n]*stops|stopsRef/);
  });

  it("counts the scrollable regions in the same sweep, and in the same order", () => {
    // One pass over the subtree rather than one selector per kind: a control
    // and a scroll region have to come back interleaved the way Tab visits
    // them, and only the DOM knows that order.
    expect(hook).toMatch(/dialog\.querySelectorAll<HTMLElement>\("\*"\)/);
    expect(hook).toMatch(/if \(el\.matches\(TABBABLE_SELECTOR\)\)/);
    expect(hook).toMatch(/overflow: getComputedStyle\(el\)\.overflowY/);
  });

  it("keeps a stop the browser offers that the sweep did not name", () => {
    // If focus is already on something inside the dialog, it keeps its place in
    // the order instead of being yanked to the top. The trap closes the exit;
    // it never takes a stop away.
    expect(hook).toMatch(/compareDocumentPosition\(s\) & Node\.DOCUMENT_POSITION_FOLLOWING/);
  });

  it("still hands focus back to whatever opened the dialog", () => {
    // Unchanged from #366 — and only now load-bearing. It fires when focus fell
    // to <body>, which is what happens when React removes a dialog that HELD
    // the focus. Before the trap, focus was usually still out on the opener and
    // there was nothing to restore.
    expect(hook).toMatch(/if \(shouldRestoreFocus\(opener, document\.activeElement\)\) opener!\.focus\(\);/);
    expect(shouldRestoreFocus({ tagName: "DIV", isConnected: true }, { tagName: "BODY", isConnected: true })).toBe(true);
  });

  it("leaves Escape entirely alone", () => {
    // #366 gave Escape to the dismiss queue and App.tsx's one window handler.
    // A second listener here would be the fourth spelling that bug was about.
    expect(code(hook)).not.toMatch(/["']Escape["']/);
  });
});

// ── and none of it disturbs the keys #366 and #367 settled ──────────────────

describe("Escape and Tab do not fight", () => {
  it("still gives an Escape pressed inside a dialog to the dialog", () => {
    // The trap puts focus on a control inside the modal, so the press now
    // arrives from a <button>. escapeOutcome answers "dismiss" for any press
    // while an overlay is open, before typing or focus is even considered, so
    // #367's release-focus branch is not reached and the canvas selection
    // behind the dialog still survives.
    for (const typing of [true, false]) {
      expect(escapeOutcome({ overlayOpen: true, typing })).toBe("dismiss");
    }
    expect(app).toMatch(/const outcome = escapeOutcome\(\{ overlayOpen: modalStack\.depth\(\) > 0, typing: isTypingTarget\(target\) \}\);/);
    expect(app).toMatch(/if \(outcome === "dismiss"\) modalStack\.dismissTop\(\);/);
  });

  it("keeps #367's release for the press that reaches the canvas", () => {
    expect(escapeOutcome({ overlayOpen: false, typing: false })).toBe("clear-selection");
    expect(app).toMatch(/if \(shouldReleaseFocusOnEscape\(target\)\) el\?\.blur\(\);\s*\n\s*clearSelection\(\);/);
  });

  it("leaves Tab to the trap, since the deck itself claims no Tab at all", () => {
    // Both listeners are on window. They cannot fight over this key because
    // App.tsx has no branch for it — Tab is not a shortcut, is not a chord, and
    // is not one of the keys a focused card owns.
    expect(code(app)).not.toMatch(/["']Tab["']/);
  });
});
