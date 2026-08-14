// The version banner's dismiss control was a <span role="button" tabIndex={0}>
// with a hand-written Enter/Space onKeyDown, sitting among five real buttons in
// the same block. Its Space branch existed to undo the window handler's
// preventDefault — the deck's pause shortcut — which is a workaround the
// element itself makes unnecessary: ownsKeystroke() leaves a focused <button>
// alone, so Space activates the button and nothing else. The box was 18x18 CSS
// px against the 24x24 floor of WCAG 2.2 SC 2.5.8, and margin-left: 2px puts it
// inside the neighbouring .ver-cmd, so the exception for undersized targets —
// which needs 24px of clear space around them — did not rescue it either.
//
// Neither a component nor a stylesheet can be rendered here, so this reads both
// sources, the way ctx-path-bidi.test.ts reads styles.css.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ownsKeystroke } from "../shortcuts";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** The `.ver-close` element as it is written in the banner. */
const control = /<(\w+)([^>]*)className="ver-close"([^>]*)>/.exec(app);

/** The declarations of the one rule that styles it. */
const rule = /\.ver-banner \.ver-close \{([^}]*)\}/.exec(css);

function px(prop: string): number {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(rule![1]);
  return m ? Number(m[1]) : NaN;
}

describe("the version banner's dismiss control", () => {
  it("is a real button, like the five controls beside it", () => {
    expect(control).not.toBeNull();
    expect(control![1]).toBe("button");
    expect(control![0]).toContain('type="button"');
  });

  it("re-implements none of what the element already does", () => {
    const attrs = control![2] + control![3];
    expect(attrs).not.toContain("onKeyDown");
    expect(attrs).not.toContain("tabIndex");
    expect(attrs).not.toContain('role="button"');
  });

  it("keeps the name a screen reader reads out, since the glyph is only an x", () => {
    expect(control![0]).toContain('aria-label="Dismiss"');
  });

  it("hands Space to the button rather than to the deck's pause shortcut", () => {
    // The workaround the deleted onKeyDown was: with a <button> focused the
    // window handler stands down of its own accord, so Space presses it.
    expect(ownsKeystroke({ tagName: "BUTTON" })).toBe(true);
    // And it did so for the span too — which is precisely why the hand-rolled
    // handler was needed to get the activation back after preventDefault.
    expect(ownsKeystroke({ tagName: "SPAN", role: "button" })).toBe(true);
  });

  it("gives the pointer a target that clears the 24px floor of SC 2.5.8", () => {
    expect(rule).not.toBeNull();
    expect(px("width")).toBeGreaterThanOrEqual(24);
    expect(px("height")).toBeGreaterThanOrEqual(24);
  });

  it("keeps the x at the size it was drawn, so only the hit area grew", () => {
    expect(px("font-size")).toBe(14);
  });

  it("strips the chrome the element brings and the span did not", () => {
    // A bare <button> arrives with a border, a grey background and the UA's
    // 13px system font — inside a banner that is none of those things.
    expect(rule![1]).toMatch(/(^|[;\s])border\s*:\s*0/);
    expect(rule![1]).toMatch(/background\s*:\s*none/);
    expect(rule![1]).toMatch(/font\s*:\s*inherit/);
  });
});
