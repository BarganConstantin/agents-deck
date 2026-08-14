// The "CLAUDE.md files in scope" list got its left-side ellipsis from
// `direction: rtl`, the usual trick for keeping the end of a path readable.
// The usual bug came with it: in an RTL paragraph the leading '/' of a POSIX
// path is a bidi-neutral sitting at the boundary, so the bidi algorithm hands
// it the paragraph's level and reorders it to the far end —
// /Users/constantin/project/CLAUDE.md drew as Users/constantin/project/CLAUDE.md/
// on every mac and Linux box, and correctly on Windows, where the drive letter
// gives the line a strong-LTR first character. The head is cut in TypeScript
// now, so the rendered string is a literal suffix of the real path in every
// engine. These pin the cut, and pin the CSS rule against the trick coming back.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { truncatePathStart } from "../components/ContextModal";

const POSIX = "/Users/constantin/Desktop/agents-deck/src/web/components/CLAUDE.md";
const WINDOWS = "C:\\Users\\constantin\\Desktop\\agents-deck\\src\\web\\CLAUDE.md";

describe("truncatePathStart", () => {
  it("leaves a path that already fits exactly as it was written", () => {
    expect(truncatePathStart("/Users/c/proj/CLAUDE.md")).toBe("/Users/c/proj/CLAUDE.md");
    expect(truncatePathStart("C:\\proj\\CLAUDE.md")).toBe("C:\\proj\\CLAUDE.md");
  });

  it("keeps the leading slash of a POSIX path at the front, never at the end", () => {
    // The regression, stated the way it looked on screen.
    const short = truncatePathStart("/Users/c/CLAUDE.md");
    expect(short.startsWith("/")).toBe(true);
    expect(short.endsWith("/")).toBe(false);
    expect(truncatePathStart(POSIX).endsWith("/")).toBe(false);
  });

  it("drops the head and keeps the tail, because every file here is CLAUDE.md", () => {
    const out = truncatePathStart(POSIX);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("/components/CLAUDE.md")).toBe(true);
    expect(POSIX.endsWith(out.slice(1))).toBe(true);
  });

  it("cuts a Windows path on a backslash, so the drive-letter form works too", () => {
    const out = truncatePathStart(WINDOWS, 30);
    expect(out).toBe("…\\src\\web\\CLAUDE.md");
    expect(WINDOWS.endsWith(out.slice(1))).toBe(true);
  });

  it("never shows half a directory name — the cut lands on a separator", () => {
    const out = truncatePathStart(POSIX, 40);
    expect(out.slice(1).startsWith("/")).toBe(true);
    expect(out).toBe("…/src/web/components/CLAUDE.md");
  });

  it("stays inside the character budget it was given", () => {
    for (const max of [12, 20, 40, 60]) {
      expect(truncatePathStart(POSIX, max).length).toBeLessThanOrEqual(max);
      expect(truncatePathStart(WINDOWS, max).length).toBeLessThanOrEqual(max);
    }
  });

  it("falls back to a hard cut when nothing in the window is a separator", () => {
    const flat = "a".repeat(80);
    expect(truncatePathStart(flat, 20)).toBe("…" + "a".repeat(19));
  });

  it("renders a suffix of the input and nothing else — no character is moved", () => {
    const paths = [POSIX, WINDOWS, "/CLAUDE.md", "/" + "d/".repeat(60) + "CLAUDE.md",
                   "/Users/x/" + "n".repeat(90) + "/CLAUDE.md", "relative/CLAUDE.md"];
    for (const p of paths) {
      const out = truncatePathStart(p);
      const shown = out.startsWith("…") ? out.slice(1) : out;
      expect(p.endsWith(shown)).toBe(true);
      expect(shown.length).toBeGreaterThan(0);
    }
  });
});

describe(".ctx-md-path", () => {
  it("sets no direction, so the paragraph stays LTR and the path stays in order", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
    const rule = /\.ctx-md-path\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toMatch(/(^|[^-])direction\s*:/);
    // The ellipsis stays: it is the backstop for a modal narrower than the budget.
    expect(rule![1]).toMatch(/text-overflow\s*:\s*ellipsis/);
  });
});
