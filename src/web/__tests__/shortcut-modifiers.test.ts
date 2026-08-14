// Copying a line of tool output used to destroy the event history. Ctrl+C and
// Cmd+C deliver keydown with e.key as the bare "c", the global handler matched
// it, and Clear emptied the server's ring buffer and truncated the file startup
// replays from — with no confirmation and no undo. Ctrl+R had the same shape:
// the browser reloaded, but not before the deck threw away the saved layout.
// These pin the rule that decides which keystrokes are the deck's to answer.
import { describe, it, expect } from "vitest";
import { isBrowserChord } from "../shortcuts";

const key = (mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("isBrowserChord", () => {
  it("leaves the bare letter to the deck", () => {
    expect(isBrowserChord(key())).toBe(false);
  });

  it("yields Ctrl+C and Ctrl+R to the browser on Linux and Windows", () => {
    expect(isBrowserChord(key({ ctrlKey: true }))).toBe(true);
  });

  it("yields Cmd+C and Cmd+R to the browser on macOS", () => {
    expect(isBrowserChord(key({ metaKey: true }))).toBe(true);
  });

  it("yields the Alt menu chords", () => {
    expect(isBrowserChord(key({ altKey: true }))).toBe(true);
  });

  it("keeps Shift, so the uppercase shortcuts still work", () => {
    const shifted = { ...key(), shiftKey: true };
    expect(isBrowserChord(shifted)).toBe(false);
  });

  it("yields a chord that stacks modifiers", () => {
    expect(isBrowserChord(key({ ctrlKey: true, altKey: true }))).toBe(true);
  });
});
