// Escape closed three of the deck's five modals and did nothing in the other
// two. ContextModal and SessionSummary registered no keydown listener at all,
// so the only way out was to Tab to the ×, and SessionSummary is the one that
// opens by itself when a session ends. The three that did listen fought the
// window-level handler in App.tsx, which mapped the same key to
// clearSelection(): one press closed the tool modal and wiped the canvas
// selection behind it. And because nothing stopped propagation, every modal on
// screen answered the same press — the clear prompt raised over a session
// summary took the summary with it.
//
// These pin the queue that replaced all of it: one owner per press, the
// topmost overlay is the one that answers, the prompt that paints above a
// summary keeps its Escape even when the summary arrived later, and an
// unmounted modal stops answering. The last case pins the focus that used to
// fall to <body> instead of back to the .ctx-donut that opened the modal.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createDismissStack,
  escapeOutcome,
  shouldRestoreFocus,
  CONFIRM_LAYER,
} from "../modal-dismiss";

describe("escapeOutcome", () => {
  it("gives one press to exactly one owner", () => {
    // The old handler blurred the field and cleared the canvas selection while
    // the modal on screen was closing itself on the same event.
    const outcomes = [
      escapeOutcome({ overlayOpen: true, typing: true }),
      escapeOutcome({ overlayOpen: true, typing: false }),
      escapeOutcome({ overlayOpen: false, typing: true }),
      escapeOutcome({ overlayOpen: false, typing: false }),
    ];
    expect(outcomes).toEqual(["dismiss", "dismiss", "blur", "clear-selection"]);
  });

  it("never clears the canvas selection behind an open modal", () => {
    for (const typing of [true, false]) {
      expect(escapeOutcome({ overlayOpen: true, typing })).not.toBe("clear-selection");
    }
  });

  it("lets a dialog close from inside its own text field, the way the sign-in dialog always did", () => {
    expect(escapeOutcome({ overlayOpen: true, typing: true })).toBe("dismiss");
  });

  it("still blurs the search box and still clears the selection when nothing is open", () => {
    expect(escapeOutcome({ overlayOpen: false, typing: true })).toBe("blur");
    expect(escapeOutcome({ overlayOpen: false, typing: false })).toBe("clear-selection");
  });
});

describe("the dismiss queue", () => {
  it("tells the caller there was nothing to close, so Escape reaches the canvas", () => {
    const stack = createDismissStack();
    expect(stack.dismissTop()).toBe(false);
    expect(stack.depth()).toBe(0);
  });

  it("closes only the modal on top, not everything on screen", () => {
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("summary"));
    stack.push(() => closed.push("prompt"));
    expect(stack.dismissTop()).toBe(true);
    expect(closed).toEqual(["prompt"]);
  });

  it("keeps Escape on the clear prompt when a session summary pops in underneath it", () => {
    // The Stop hook fires while the user is deciding: the summary mounts last
    // but renders earlier in the tree, so the prompt is still what is painted
    // on top and still what the key means.
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("prompt"), CONFIRM_LAYER);
    stack.push(() => closed.push("summary"));
    stack.dismissTop();
    expect(closed).toEqual(["prompt"]);
  });

  it("hands Escape back down the pile as each modal closes", () => {
    const stack = createDismissStack();
    const closed: string[] = [];
    const dropTool = stack.push(() => closed.push("tool"));
    const dropUsage = stack.push(() => closed.push("usage"));
    stack.dismissTop();
    dropUsage();
    stack.dismissTop();
    dropTool();
    expect(closed).toEqual(["usage", "tool"]);
    expect(stack.dismissTop()).toBe(false);
  });

  it("unregisters the modal that unmounted, not whichever one is last in line", () => {
    // Modals do not close in the order they opened: a tool modal opened over
    // the usage history closes first, and dropping the tail instead would have
    // left the tool modal holding the key it no longer has a dialog for.
    const stack = createDismissStack();
    const closed: string[] = [];
    const dropUsage = stack.push(() => closed.push("usage"));
    stack.push(() => closed.push("tool"));
    dropUsage();
    expect(stack.depth()).toBe(1);
    stack.dismissTop();
    expect(closed).toEqual(["tool"]);
  });

  it("survives the same modal unmounting twice, which is what a double cleanup is", () => {
    const stack = createDismissStack();
    const drop = stack.push(() => {});
    drop();
    drop();
    expect(stack.depth()).toBe(0);
    expect(stack.dismissTop()).toBe(false);
  });

  it("keeps two stacks apart, so a test can never leak state into the app's", () => {
    const a = createDismissStack();
    const b = createDismissStack();
    a.push(() => {});
    expect(b.depth()).toBe(0);
  });
});

describe("shouldRestoreFocus", () => {
  const donut = { tagName: "BUTTON", isConnected: true };
  const body = { tagName: "BODY", isConnected: true };

  it("puts focus back on the opener when the closing modal dropped it on <body>", () => {
    expect(shouldRestoreFocus(donut, body)).toBe(true);
    expect(shouldRestoreFocus(donut, null)).toBe(true);
  });

  it("leaves focus alone once it has moved somewhere real", () => {
    expect(shouldRestoreFocus(donut, { tagName: "INPUT", isConnected: true })).toBe(false);
  });

  it("does not chase an opener that left the page while the modal was up", () => {
    // Agent nodes are rebuilt on every snapshot tick; the button that opened
    // the modal may be a detached node by the time it closes.
    expect(shouldRestoreFocus({ tagName: "BUTTON", isConnected: false }, body)).toBe(false);
    expect(shouldRestoreFocus(null, body)).toBe(false);
  });

  it("treats <body> as no opener at all, because focusing it restores nothing", () => {
    // Safari does not focus a button on click, so the summary that opened
    // itself and the modal opened by a mouse both record <body> here.
    expect(shouldRestoreFocus(body, body)).toBe(false);
    expect(shouldRestoreFocus({ tagName: "body", isConnected: true }, null)).toBe(false);
  });
});

describe("the modals themselves", () => {
  const dir = fileURLToPath(new URL("../components", import.meta.url));
  const sources = readdirSync(dir)
    .filter(f => f.endsWith(".tsx"))
    .map(f => [f, readFileSync(`${dir}/${f}`, "utf8")] as const);

  it("leaves no component hand-rolling its own Escape listener", () => {
    // A fourth spelling of the same effect is how two modals ended up with
    // none. Every modal goes through useModalDismiss, so the queue sees all of
    // them and App.tsx stays the only place that reads the key.
    for (const [name, src] of sources) {
      expect(`${name}: ${/["']Escape["']/.test(src)}`).toBe(`${name}: false`);
    }
  });

  it("wires every backdrop in the app to the shared hook", () => {
    const withBackdrop = sources.filter(([, src]) => /className="[a-z-]*backdrop"/.test(src));
    expect(withBackdrop.map(([name]) => name).sort()).toEqual([
      "AddAccountDialog.tsx", "ClearConfirm.tsx", "ContextModal.tsx",
      "SessionSummary.tsx", "ToolModal.tsx", "UsageHistoryModal.tsx",
    ]);
    for (const [name, src] of withBackdrop) {
      expect(`${name}: ${src.includes("useModalDismiss(")}`).toBe(`${name}: true`);
    }
  });
});
