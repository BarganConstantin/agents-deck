// The shape of what the deck prints, at the widths it actually gets printed at.
//
// `process.stdout.columns` appeared nowhere in bin/deck.js. The old banner was
// 62 columns of figlet art with the wrong product name in it, the status column
// was held by spaces counted into each string by hand, and the pulse line padded
// to a fixed 61 characters — so in an 80-column terminal it looked designed, and
// in a 40-column one the art wrapped into noise and the `\r` repaint only ever
// reached the pulse's second row, leaving the first one on screen forever.
//
// So: 40, 80, 200 and "the terminal will not say", which is every pipe and every
// CI runner. Nothing may exceed the width it was given, and the two details that
// cannot survive being shortened — the URL, and the name of the product — must
// still be there at the narrowest of them.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-term-layout-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
for (const k of ENV_KEYS) process.env[k] = k === "HOME" || k === "USERPROFILE" ? DIR : join(DIR, k);

/** Hard stop if anything we are about to write escapes the sandbox. */
function sandboxed(name: string): string {
  const p = resolve(DIR, name);
  if (!p.startsWith(resolve(DIR) + "/") && !p.startsWith(resolve(DIR) + "\\")) {
    throw new Error(`refusing to touch ${p}: outside ${DIR}`);
  }
  return p;
}
for (const k of ENV_KEYS) sandboxed(k);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k] as string;
  }
  rmSync(DIR, { recursive: true, force: true });
});

// @ts-expect-error — .mjs server module, no types
const term = await import("../../server/term.mjs");
const {
  CURSOR_HIDE, CURSOR_SHOW, fit, labelColumn, palette, pulseText, statusLine, stripAnsi,
  termColumns, visibleWidth, wordmark, WORDMARK_WIDTH,
} = term as any;

const TERM_MJS = fileURLToPath(new URL("../../server/term.mjs", import.meta.url));
const LABELS = [
  "workspace", "Claude hooks", "Codex sessions", "claude-swap", "accounts",
  "ccusage", "update", "server ready", "log",
];
const widest = (lines: string[]) => Math.max(...lines.map((l: string) => visibleWidth(l)));

describe("the ccdeck wordmark", () => {
  it("says ccdeck, which is what the product is called", () => {
    for (const columns of [40, 80, 200]) {
      const { lines } = wordmark({ columns, version: "1.2.3", profile: "truecolor" });
      // Drawn as half-blocks it is not searchable as text, so the shape is the
      // assertion: six letters on one baseline, two of them with ascenders.
      expect(lines.filter((l: string) => l.trim()).length).toBeGreaterThanOrEqual(4);
    }
    expect(wordmark({ columns: 80, version: "1.2.3", profile: "none" }).lines.join("\n")).toContain("ccdeck");
    expect(wordmark({ columns: 30, version: "1.2.3", profile: "truecolor" }).lines.join("\n")).toContain("ccdeck");
    // And the name it stopped being is gone from every variant.
    for (const profile of ["truecolor", "ansi16", "none"]) {
      for (const columns of [30, 40, 80, 200]) {
        const text = wordmark({ columns, version: "1.2.3", profile }).lines.join("\n");
        expect(text).not.toContain("agents-deck");
      }
    }
  });

  it("fits the terminal it is given, at every width and with no width at all", () => {
    for (const columns of [40, 80, 200, termColumns({} as never)]) {
      const { lines } = wordmark({ columns, version: "1.33.124", profile: "truecolor" });
      expect(widest(lines)).toBeLessThan(columns);
    }
  });

  it("drops the art rather than wrapping it when the terminal is too narrow", () => {
    expect(wordmark({ columns: WORDMARK_WIDTH + 1, version: "1.2.3", profile: "truecolor" }).kind).toBe("full");
    expect(wordmark({ columns: WORDMARK_WIDTH - 1, version: "1.2.3", profile: "truecolor" }).kind).toBe("compact");
    // 20 columns is not a terminal anyone works in, and it still must not wrap.
    expect(widest(wordmark({ columns: 20, version: "1.33.124", profile: "truecolor" }).lines)).toBeLessThan(20);
  });

  it("falls back to the plain name where there are no glyphs and no colour", () => {
    // A console without the half-block characters: the art would be a row of
    // question marks, so it is not attempted.
    expect(wordmark({ columns: 200, version: "1.2.3", profile: "truecolor", unicode: false }).kind).toBe("compact");
    // And a pipe gets text with not one escape in it.
    const piped = wordmark({ columns: 80, version: "1.2.3", profile: "none" });
    expect(piped.kind).toBe("plain");
    expect(piped.lines.join("\n")).toBe(stripAnsi(piped.lines.join("\n")));
  });

  it("keeps the version when the tagline no longer fits beside it", () => {
    const narrow = wordmark({ columns: 40, version: "1.33.124", profile: "truecolor" }).lines.join("\n");
    expect(stripAnsi(narrow)).toContain("v1.33.124");
    expect(stripAnsi(narrow)).not.toContain("Claude Code + Codex");
    expect(stripAnsi(wordmark({ columns: 80, version: "1.33.124", profile: "truecolor" }).lines.join("\n")))
      .toContain("Claude Code + Codex");
  });
});

describe("the status column", () => {
  it("comes from the longest label, not from spaces counted into each string", () => {
    expect(labelColumn(LABELS)).toBe("Codex sessions".length);
    const width = labelColumn(LABELS);
    const rows = LABELS.map(label => statusLine({ mark: "+", label, detail: "x", labelWidth: width, columns: 80 }));
    // Every detail starts in the same column — which is the whole point, and
    // what silently broke the day a label got one character longer.
    const columnsOf = rows.map(r => r.lastIndexOf("x"));
    expect(new Set(columnsOf).size).toBe(1);
  });

  it("never writes into the last cell of the line, at any width", () => {
    const detail = "/Users/someone/.claude/agent-dag/events.jsonl";
    for (const columns of [40, 60, 80, 200]) {
      const line = statusLine({ mark: "+", label: "log", detail, labelWidth: 14, columns });
      expect(visibleWidth(line)).toBeLessThan(columns);
    }
  });

  it("shortens a path from the front and a sentence from the back", () => {
    // `…/agent-dag/hook.js` still names a file; `…nel enabled)` names nothing.
    expect(fit("/Users/someone/.claude/agent-dag/hook.js", 20)).toBe("…e/agent-dag/hook.js");
    expect(fit("v0.25.0 (accounts panel enabled)", 20)).toBe("v0.25.0 (accounts p…");
    expect(fit("short", 20)).toBe("short");
    // Below the width where an ellipsis plus a few characters would still say
    // something, the detail is dropped rather than reduced to punctuation.
    expect(fit("/a/very/long/path", 3)).toBe("");
    expect(statusLine({ mark: "+", label: "log", detail: "/a/very/long/path", labelWidth: 14, columns: 24 }))
      .toBe("  +  log");
  });

  it("gives the URL its own line rather than an ellipsis, however narrow it gets", () => {
    const url = "http://127.0.0.1:4317";
    const wide = statusLine({ mark: "+", label: "server ready", detail: url, labelWidth: 14, columns: 80, keep: true });
    expect(wide.split("\n")).toHaveLength(1);
    expect(wide).toContain(url);

    // Intact — half an address is not a shorter address — and still inside the
    // terminal, giving up its indent before it gives up a digit of the port.
    for (const columns of [24, 30, 40]) {
      const rows = statusLine({ mark: "+", label: "server ready", detail: url, labelWidth: 14, columns, keep: true }).split("\n");
      expect(rows).toHaveLength(2);
      expect(rows[1]).toContain(url);
      for (const r of rows) expect(visibleWidth(r)).toBeLessThan(columns);
    }
  });

  it("measures the visible text, so a hyperlinked detail is not read as an overflow", () => {
    const url = "http://127.0.0.1:4317";
    const linked = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
    const line = statusLine({ mark: "+", label: "server ready", detail: linked, labelWidth: 14, columns: 80, keep: true });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain(linked); // the escape survived whole
    expect(visibleWidth(line)).toBeLessThan(80);
  });

  it("paints through the caller, so the same layout serves colour and a pipe", () => {
    const p = palette("truecolor");
    const painted = statusLine({
      mark: "+", label: "log", detail: "x", labelWidth: 14, columns: 80,
      paint: { mark: (s: string) => `${p.ok}${s}${p.reset}` },
    });
    expect(stripAnsi(painted)).toBe(statusLine({ mark: "+", label: "log", detail: "x", labelWidth: 14, columns: 80 }));
  });
});

describe("the pulse line", () => {
  it("pads both messages to one width, because it is redrawn over itself", () => {
    for (const columns of [40, 80, 200]) {
      const ok = pulseText({ registered: true, columns });
      const bad = pulseText({ registered: false, columns });
      expect(ok.length).toBe(bad.length);
    }
  });

  it("never wraps, which is what used to strand the first row on screen", () => {
    for (const columns of [40, 60, 80, 200, termColumns({} as never)]) {
      for (const registered of [true, false]) {
        // Two spaces of indent, the dot, two more before the text.
        expect(2 + 1 + 2 + pulseText({ registered, columns }).length).toBeLessThan(columns);
      }
    }
  });

  it("keeps saying the thing that matters when it has to get shorter", () => {
    // A deck no hook can find is not listening in any sense the user cares
    // about, so that state keeps its own words at every width.
    expect(pulseText({ registered: false, columns: 80 })).toContain("not registered");
    expect(pulseText({ registered: false, columns: 40 })).toContain("not registered");
    expect(pulseText({ registered: true, columns: 80 })).toContain("Ctrl+C");
  });

  it("uses no glyph the ASCII tier does not have", () => {
    const ascii = pulseText({ registered: false, columns: 80, unicode: false });
    expect(ascii).toBe(ascii.replace(/[^\x20-\x7e]/g, "?"));
  });
});

describe("an unknown terminal width", () => {
  it("is 80, which is what a pipe and a CI runner are already built around", () => {
    expect(termColumns({} as never)).toBe(80);
    expect(termColumns({ columns: 0 } as never)).toBe(80);
    expect(termColumns(undefined as never)).toBe(80);
    expect(termColumns({ columns: 137 } as never)).toBe(137);
  });
});

// ── the cursor ───────────────────────────────────────────────────────────────
//
// bin/deck.js hides the cursor while the reveal, the spinner and the pulse are
// on screen, and puts it back from a `process.on("exit")` handler. That handler
// is the whole guarantee: it is the one hook Node runs on the ordinary exit, on
// process.exit() from a signal handler, AND after an uncaught throw — and a deck
// that dies with the cursor hidden leaves the user's shell with no cursor and
// nothing to do about it but `reset`.
//
// It cannot be asserted against the deck itself: without a TTY the deck never
// hides the cursor at all, and this repo has no pty to lend it. So the wiring is
// reproduced in a child process, with the sequences imported from the same
// module the deck imports them from, and driven down the path most likely to
// skip a `finally` — a throw nobody caught.
describe("restoring the cursor", () => {
  const escape = (s: string) => s.replace(/\x1b/g, "\\e");

  const runChild = (body: string, expectFail: boolean) => {
    const file = sandboxed("cursor-child.mjs");
    writeFileSync(file, `
import { CURSOR_HIDE, CURSOR_SHOW } from ${JSON.stringify(TERM_MJS)};
let hidden = true;
const showCursor = () => { if (hidden) { hidden = false; process.stdout.write(CURSOR_SHOW); } };
process.stdout.write(CURSOR_HIDE);
process.on("exit", showCursor);
${body}
`, "utf8");
    try {
      const out = execFileSync(process.execPath, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      expect(expectFail).toBe(false);
      return out;
    } catch (err: any) {
      expect(expectFail).toBe(true);
      return String(err.stdout ?? "");
    }
  };

  it("is the DECTCEM pair, and nothing else", () => {
    expect(CURSOR_HIDE).toBe("\x1b[?25l");
    expect(CURSOR_SHOW).toBe("\x1b[?25h");
  });

  it("happens on the ordinary exit", () => {
    expect(escape(runChild(`process.exit(0);`, false))).toBe("\\e[?25l\\e[?25h");
  });

  it("happens after an uncaught throw, which is the path a finally would miss", () => {
    expect(escape(runChild(`setTimeout(() => { throw new Error("boom"); }, 1);`, true)))
      .toBe("\\e[?25l\\e[?25h");
  });

  it("happens once, however many ways out of the process are taken", () => {
    expect(escape(runChild(`showCursor(); showCursor(); process.exit(0);`, false)))
      .toBe("\\e[?25l\\e[?25h");
  });
});
