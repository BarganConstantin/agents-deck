// The topbar's readout strip draws its dividers with `::before` rules keyed on
// ADJACENT elements, and the row is conditional — three of its four members can
// be absent, and the fourth renders under either of two class names. That
// combination has already failed once. #502 removed the sessions, agents and
// events counters, and `.topbar .status .stat + .sysmeter-wrap::before` became a
// selector nothing could match in any state: the meter's preceding sibling was
// the events counter, and with the counters gone it is the status pill. Deleting
// only the markup would have left the row with its first line in the wrong place
// and two bare boundaries ahead of it. The rule was moved to the element AFTER
// the meter and the shape restored by inspection, with nothing pinning it.
//
// Removing the MCP legend asked the same question a second time within the hour
// — a `.stat` out of the MIDDLE of the run this time, which the rules survive,
// but only because of which side of the `+` each one names. That is exactly the
// kind of reasoning that should not have to be redone from scratch on the next
// removal, so it is a test now.
//
// This walks every row the strip can render, resolves the sheet's own divider
// rules against each one, and counts lines. No DOM: the rules come out of
// styles.css and the row shapes out of App.tsx's markup, the way dead-css and
// session-hue read the same two files.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
// Comments carry braces and selectors of their own, and this file scans rules.
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const app = readFileSync(join(web, "App.tsx"), "utf8");

/** Selector / body for every rule in the sheet. A nested at-rule's wrapper has a
 *  `{` inside its "body" and is skipped; the rules within it are matched on
 *  their own, which is what this needs. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  selectors: m[1].split(",").map(s => s.trim()).filter(Boolean),
  body: m[2],
}));

/** Every `::before` under `.topbar .status` that paints the strip's 1px rule.
 *  Read off the sheet rather than listed here, so a divider that is added,
 *  moved or deleted is answered by this same walk. */
const DIVIDERS = RULES
  .filter(r => /width:\s*1px/.test(r.body) && /background:\s*var\(--line\)/.test(r.body))
  .flatMap(r => r.selectors)
  .filter(s => s.startsWith(".topbar .status") && s.endsWith("::before"));

/** A rendered element, as the class list it carries. */
interface El { name: string; classes: string[] }

/** The strip's members, in the order App.tsx writes them. The pill and the meter
 *  are unconditional — `statusPill` always returns one and SystemMeter returns
 *  its idle skeleton rather than null — and the two readouts are gated on having
 *  a number to show. */
const PILL: El = { name: "pill", classes: ["pill", "live"] };
const METERS: El[] = [
  // Once the server holds two CPU samples the button is wrapped; before that the
  // skeleton renders bare. Both are the strip's second child, under different
  // class names, which is why the divider rule is a two-selector list.
  { name: "meter", classes: ["sysmeter-wrap"] },
  { name: "meter(idle)", classes: ["sysmeter", "idle"] },
];
const TOKENS: El = { name: "tokens", classes: ["stat"] };
const COST: El = { name: "cost", classes: ["stat"] };

/** Every row the strip can render. */
const ROWS: Array<{ label: string; row: El[] }> = METERS.flatMap(meter =>
  [true, false].flatMap(tokens =>
    [true, false].map(cost => {
      const row = [PILL, meter, ...(tokens ? [TOKENS] : []), ...(cost ? [COST] : [])];
      return { label: row.map(e => e.name).join(" | "), row };
    })));

const hasAll = (el: El, compound: string) =>
  [...compound.matchAll(/\.([\w-]+)/g)].every(m => el.classes.includes(m[1]));

/** Which divider rules fire on `row[i]`, cascade-style: the subject is the last
 *  compound in the selector, and a `+` demands the element before it. */
function dividersAt(row: El[], i: number): string[] {
  return DIVIDERS.filter(sel => {
    const parts = sel.slice(".topbar .status".length).replace("::before", "")
      .split("+").map(s => s.trim());
    const subject = parts[parts.length - 1];
    if (!hasAll(row[i], subject)) return false;
    if (parts.length === 1) return true;
    return i > 0 && hasAll(row[i - 1], parts[0]);
  });
}

describe("the divider run in the topbar's readout strip", () => {
  it("is drawn by rules the sheet still has, so the walk is not vacuous", () => {
    // Two: one for each SystemMeter branch, plus the `.stat + .stat` that closes
    // the run. Three selectors over two rules.
    expect(DIVIDERS.length, "no divider rule under .topbar .status").toBeGreaterThanOrEqual(2);
    expect(DIVIDERS).toContain(".topbar .status .stat + .stat::before");
  });

  it("leaves the element that leads the row with nothing drawn to its left", () => {
    // Two separate claims, and both were live defects in #502's neighbourhood:
    // the pill leads the strip and takes no line, and the run that follows it
    // opens on its first readout rather than hanging a line off the pill.
    for (const { label, row } of ROWS) {
      expect(dividersAt(row, 0), `${label}: the pill drew a line`).toEqual([]);
      expect(dividersAt(row, 1), `${label}: a line hangs off the pill`).toEqual([]);
    }
  });

  it("draws exactly one line at every boundary after that, in every row", () => {
    for (const { label, row } of ROWS) {
      for (let i = 2; i < row.length; i++) {
        expect(dividersAt(row, i), `${label}: boundary before ${row[i].name}`).toHaveLength(1);
      }
    }
  });

  it("closes the gap behind the meter whichever readout comes first", () => {
    // The case #502 named as inherited rather than introduced: before it, the
    // rule sat in FRONT of the meter and nothing drew behind it. It is checked
    // per row because `tokens` is conditional — with no tokens to show, `cost`
    // is the element that has to pick the line up.
    for (const { label, row } of ROWS.filter(r => r.row.length > 2)) {
      expect(dividersAt(row, 2), `${label}: nothing behind the meter`).toHaveLength(1);
    }
  });

  it("puts two lines in the row the deck actually shows, and no more", () => {
    const full = [PILL, METERS[0], TOKENS, COST];
    expect(full.flatMap((_, i) => dividersAt(full, i))).toHaveLength(2);
  });

  it("is a model of the row App.tsx really writes, in that order", () => {
    // The geometry above is worth nothing if the strip stopped matching it. The
    // pill, the meter and the two readouts, in the order the sheet's adjacency
    // rules assume — and nothing between them that this file has not been told
    // about.
    const strip = app.slice(
      app.indexOf(`<span className="status">`),
      app.indexOf(`<div className="vis-hidden"`),
    );
    expect(strip, "the .status strip is gone from App.tsx").toBeTruthy();
    const order = ["`pill ${pill.tone}`", "<SystemMeter", `<span className="lbl">tokens</span>`, "cost"]
      .map(needle => strip.indexOf(needle));
    expect(order.every(at => at > -1), `the strip lost one of ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Exactly four elements are direct children of the strip: three `.stat`-less
    // spans plus the meter. A fifth arriving without a line in this file is the
    // failure this case exists for.
    expect(strip.match(/className="stat"/g) ?? []).toHaveLength(2);
    expect(strip).not.toContain("mcp-legend");
  });

  it("draws the same run in light, where only the token beneath it moves", () => {
    // The divider's one themed value is `var(--line)`, which both themes
    // declare — so the counting above is theme-independent by construction
    // rather than by running it twice. What could break that is a
    // data-theme-scoped rule reaching one of these elements. None does: the only
    // themed rules in the strip are the three status-pill dots.
    const owners = RULES.filter(r => /(?:^|;)\s*--line\s*:/.test(r.body)).flatMap(r => r.selectors);
    expect(owners.some(s => s === ':root[data-theme="dark"]' || s === ":root"), "dark --line").toBe(true);
    expect(owners.some(s => s === ':root[data-theme="light"]'), "light --line").toBe(true);
    const themed = RULES.flatMap(r => r.selectors)
      .filter(s => s.includes("data-theme") && /\.(stat|sysmeter|sysmeter-wrap)\b/.test(s));
    expect(themed, "a theme block reaches into the divider run").toEqual([]);
  });
});
