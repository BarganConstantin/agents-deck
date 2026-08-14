// What the deck is allowed to print into a given terminal, and what it must not.
//
// The old rule was one line — `process.stdout.isTTY` — and every consequence of
// it was wrong in a way nobody could see from the machine it was written on:
// NO_COLOR ignored (a convention this project has no business ignoring),
// FORCE_COLOR ignored (so a CI log that renders colour got none), COLORTERM
// ignored (so the deck's accent was whatever the user's theme decided cyan is),
// hyperlinks and box-drawing glyphs emitted unconditionally into consoles that
// render neither.
//
// The three that matter most are asserted here because they are the ones that
// cannot be checked by running the deck: a legacy `cmd.exe` on CP437, a CI
// runner, and a terminal with NO_COLOR set are three machines this repo cannot
// execute. Every input is therefore injected — env, isTTY, platform — and both
// answers are pinned.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Nothing here reads a home directory, but nothing here is allowed to start
// either: every home the server modules resolve at import time is pointed at a
// throwaway directory before that import happens.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-term-caps-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
for (const k of ENV_KEYS) process.env[k] = k === "HOME" || k === "USERPROFILE" ? DIR : join(DIR, k);
for (const k of ENV_KEYS) {
  const p = resolve(String(process.env[k]));
  if (p !== resolve(DIR) && !p.startsWith(resolve(DIR) + "/") && !p.startsWith(resolve(DIR) + "\\")) {
    throw new Error(`refusing to run: ${k} resolved to ${p}, outside ${DIR}`);
  }
}
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
  colorProfile, fg, glyphs, link, motionOK, palette, spinnerFrames, supportsHyperlinks, unicodeOK,
} = term as any;

const ITERM = { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app", COLORTERM: "truecolor" };

describe("the colour profile", () => {
  it("prints no colour at all when NO_COLOR is set, whatever its value", () => {
    // no-color.org: present and not an empty string means no colour. "0" and
    // "false" are values, not denials — half the CLIs that get this wrong read
    // them as one.
    for (const value of ["1", "0", "false", "yes", " "]) {
      expect(colorProfile({ env: { ...ITERM, NO_COLOR: value }, isTTY: true })).toBe("none");
    }
    // An empty string is the documented way to NOT set it.
    expect(colorProfile({ env: { ...ITERM, NO_COLOR: "" }, isTTY: true })).toBe("truecolor");
  });

  it("lets NO_COLOR win over FORCE_COLOR, since one is a denial and the other a request", () => {
    expect(colorProfile({ env: { NO_COLOR: "1", FORCE_COLOR: "3" }, isTTY: true })).toBe("none");
  });

  it("honours FORCE_COLOR's levels even with nothing on the other end", () => {
    // The piped-into-a-pager case: not a TTY, and colour is still wanted.
    expect(colorProfile({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe("none");
    expect(colorProfile({ env: { FORCE_COLOR: "1" }, isTTY: false })).toBe("ansi16");
    expect(colorProfile({ env: { FORCE_COLOR: "2" }, isTTY: false })).toBe("ansi256");
    expect(colorProfile({ env: { FORCE_COLOR: "3" }, isTTY: false })).toBe("truecolor");
    expect(colorProfile({ env: { FORCE_COLOR: "" }, isTTY: false })).toBe("ansi16");
  });

  it("prints nothing into a pipe, a file or a dumb terminal", () => {
    expect(colorProfile({ env: ITERM, isTTY: false })).toBe("none");
    expect(colorProfile({ env: { TERM: "dumb" }, isTTY: true })).toBe("none");
  });

  it("asks for truecolor wherever the terminal says it has it", () => {
    expect(colorProfile({ env: { COLORTERM: "truecolor" }, isTTY: true })).toBe("truecolor");
    expect(colorProfile({ env: { COLORTERM: "24bit" }, isTTY: true })).toBe("truecolor");
    expect(colorProfile({ env: { TERM: "xterm-kitty" }, isTTY: true })).toBe("truecolor");
    expect(colorProfile({ env: { TERM_PROGRAM: "vscode" }, isTTY: true })).toBe("truecolor");
    // Windows Terminal, which never sets COLORTERM and does truecolor anyway.
    expect(colorProfile({ env: { WT_SESSION: "abc" }, isTTY: true, platform: "win32" })).toBe("truecolor");
  });

  it("degrades rather than giving up: 256 where it is offered, 16 where nothing is", () => {
    expect(colorProfile({ env: { TERM: "screen-256color" }, isTTY: true })).toBe("ansi256");
    expect(colorProfile({ env: { TERM: "xterm" }, isTTY: true })).toBe("ansi16");
    // Legacy conhost advertises nothing at all, and libuv still translates SGR
    // into console calls for it — so 16 is the floor on Windows, never "none".
    expect(colorProfile({ env: {}, isTTY: true, platform: "win32" })).toBe("ansi16");
  });
});

describe("one colour, expressed as far as the profile reaches", () => {
  const ACCENT = [125, 211, 252];

  it("degrades truecolor → 256 → 16 → nothing without changing call sites", () => {
    expect(fg(ACCENT, "truecolor", "\x1b[96m")).toBe("\x1b[38;2;125;211;252m");
    expect(fg(ACCENT, "ansi256", "\x1b[96m")).toBe("\x1b[38;5;117m");
    expect(fg(ACCENT, "ansi16", "\x1b[96m")).toBe("\x1b[96m");
    expect(fg(ACCENT, "none", "\x1b[96m")).toBe("");
  });

  it("hands out empty strings under 'none', so the same template needs no branch", () => {
    const p = palette("none");
    for (const v of Object.values(p)) expect(v).toBe("");
  });

  it("keeps the semantic names the same at every tier", () => {
    const names = Object.keys(palette("truecolor")).sort();
    for (const profile of ["ansi256", "ansi16", "none"]) {
      expect(Object.keys(palette(profile)).sort()).toEqual(names);
    }
  });
});

describe("OSC 8 hyperlinks", () => {
  it("wraps the text only where the terminal is known to understand the escape", () => {
    const url = "http://127.0.0.1:4317";
    const on = supportsHyperlinks({ env: { TERM_PROGRAM: "iTerm.app" }, profile: "truecolor" });
    expect(link(url, url, on)).toBe(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
  });

  it("says no for everything it has not been told about", () => {
    // Legacy Windows console: no WT_SESSION, no TERM_PROGRAM, nothing.
    expect(supportsHyperlinks({ env: {}, profile: "ansi16" })).toBe(false);
    // Apple's Terminal.app, which renders the escape as nothing useful.
    expect(supportsHyperlinks({ env: { TERM_PROGRAM: "Apple_Terminal" }, profile: "truecolor" })).toBe(false);
    // tmux below 3.4 mangles it, which is worse than plain text.
    expect(supportsHyperlinks({ env: { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/x,1,0" }, profile: "truecolor" })).toBe(false);
  });

  it("goes quiet with NO_COLOR, because a link round a path is decoration too", () => {
    expect(supportsHyperlinks({ env: { TERM_PROGRAM: "iTerm.app" }, profile: "none" })).toBe(false);
  });

  it("leaves the text alone rather than emitting a half-open escape", () => {
    const url = "http://127.0.0.1:4317";
    expect(link(url, url, false)).toBe(url);
    // A control character in the URL would close the sequence early, and the
    // rest of the line would be whatever the terminal made of the remainder.
    expect(link("x", "http://x/\x07evil", true)).toBe("x");
  });
});

describe("glyph tiers", () => {
  it("has an ASCII answer for every glyph it can print", () => {
    const uni = glyphs(true);
    const ascii = glyphs(false);
    expect(Object.keys(ascii).sort()).toEqual(Object.keys(uni).sort());
    // Nothing in the fallback tier may need a font: CP437 on a code page that
    // is not UTF-8 is the whole reason this tier exists.
    for (const [name, value] of Object.entries(ascii)) {
      expect(`${name}: ${value}`).toBe(`${name}: ${String(value).replace(/[^\x20-\x7e]/g, "?")}`);
    }
    expect(spinnerFrames(false).join("")).toMatch(/^[|/\-\\]+$/);
    expect(spinnerFrames(true).length).toBeGreaterThan(0);
  });

  it("trusts the Linux virtual console with none of them, and a normal xterm with all", () => {
    expect(unicodeOK({ env: { TERM: "linux" }, platform: "linux" })).toBe(false);
    expect(unicodeOK({ env: { TERM: "xterm-256color" }, platform: "darwin" })).toBe(true);
  });

  it("asks Windows to prove it, because the default console cannot", () => {
    expect(unicodeOK({ env: {}, platform: "win32" })).toBe(false);
    expect(unicodeOK({ env: { WT_SESSION: "abc" }, platform: "win32" })).toBe(true);
    expect(unicodeOK({ env: { TERM_PROGRAM: "vscode" }, platform: "win32" })).toBe(true);
  });
});

describe("motion, which is the terminal's prefers-reduced-motion", () => {
  it("moves only on a real terminal that took the colour", () => {
    expect(motionOK({ env: { TERM: "xterm-256color" }, isTTY: true, profile: "truecolor" })).toBe(true);
  });

  it("holds still in a pipe, under CI, and with NO_COLOR — the three log files", () => {
    expect(motionOK({ env: {}, isTTY: false, profile: "truecolor" })).toBe(false);
    expect(motionOK({ env: { CI: "true" }, isTTY: true, profile: "truecolor" })).toBe(false);
    expect(motionOK({ env: { CI: "1" }, isTTY: true, profile: "truecolor" })).toBe(false);
    expect(motionOK({ env: { NO_COLOR: "1" }, isTTY: true, profile: "none" })).toBe(false);
    // `CI=0` is a machine saying it is not one.
    expect(motionOK({ env: { CI: "0" }, isTTY: true, profile: "truecolor" })).toBe(true);
  });
});
