// ToolModal put role="dialog" aria-modal="true" on its click-to-close
// backdrop, so the dialog a screen reader drew included the dismiss scrim, and
// the surface inside it — the actual dialog — carried no role. Neither element
// carried a name either, so the whole thing announced as an unnamed "dialog"
// while the four siblings around it all named themselves. There is no DOM to
// render into here, so this reads the source the way ctx-path-bidi.test.ts
// reads styles.css: the shape is what the bug was, and the shape is what is
// pinned.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../components", import.meta.url));
const read = (f: string) => readFileSync(`${dir}/${f}`, "utf8");

/** The opening tag of the scrim — the element with the dismiss onClick. */
function backdropTag(src: string): string | null {
  const m = /<div className="[a-z-]*backdrop"[^>]*>/.exec(src);
  return m ? m[0] : null;
}

/** Every element in the file that claims to be a dialog. The `=>` alternative
 *  is not decoration: the surface these modals put the role on is the one
 *  carrying `onClick={e => e.stopPropagation()}`, and a plain [^>] run stops
 *  dead on the arrow. */
function dialogTags(src: string): string[] {
  return src.match(/<div\s(?:=>|[^>])*role="dialog"(?:=>|[^>])*>/g) ?? [];
}

const MODALS = readdirSync(dir)
  .filter(f => f.endsWith(".tsx"))
  .filter(f => backdropTag(read(f)) !== null);

describe("the deck's modals", () => {
  it("has found all six of them, so a new one cannot skip this file", () => {
    expect(MODALS.length).toBe(6);
  });

  it("never calls the dismiss scrim a dialog", () => {
    for (const f of MODALS) {
      const tag = backdropTag(read(f))!;
      expect(`${f}: ${/role="(?!presentation)/.test(tag)}`).toBe(`${f}: false`);
      expect(`${f}: ${tag.includes("aria-modal")}`).toBe(`${f}: false`);
    }
  });

  it("marks the scrim as presentational, since it is a gesture and not content", () => {
    for (const f of MODALS) {
      expect(`${f}: ${backdropTag(read(f))!.includes('role="presentation"')}`).toBe(`${f}: true`);
    }
  });

  it("puts the dialog role on the surface inside the scrim, exactly once", () => {
    for (const f of MODALS) {
      expect(`${f}: ${dialogTags(read(f)).length}`).toBe(`${f}: 1`);
    }
  });

  it("gives every dialog a name, so none of them announces as just 'dialog'", () => {
    for (const f of MODALS) {
      const tag = dialogTags(read(f))[0];
      expect(`${f}: ${/aria-label(ledby)?="/.test(tag)}`).toBe(`${f}: true`);
    }
  });
});

describe("ToolModal", () => {
  const src = read("ToolModal.tsx");

  it("names itself after the tool, the one thing that tells two of these apart", () => {
    expect(dialogTags(src)[0]).toContain('aria-labelledby="tool-modal-title"');
    // The id has to be on something that renders, or the name resolves to
    // nothing and the dialog is unnamed again in a way no attribute shows.
    expect(src).toMatch(/<span id="tool-modal-title" className="modal-tool-name">\{tool\.name\}<\/span>/);
  });

  it("still closes on a backdrop click, which is what the scrim is for", () => {
    expect(backdropTag(src)).toContain("onClick={onClose}");
  });
});
