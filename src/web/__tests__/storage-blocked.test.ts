// A browser told to block site data does not hand back an empty store: the
// `window.localStorage` GETTER throws a SecurityError, so the property read is
// the failing step and a try that only wraps `getItem` never runs. App restores
// the usage panel and the theme inside useState initialisers, and src/web has
// no error boundary, so a throw escaping one of those rejected root.render()
// and left #root empty — a blank deck under Safari's "Block All Cookies",
// Chrome with site data blocked, or Firefox in strict mode, with nothing on
// screen naming the cause. These pin that an unreadable store reads as "not
// stored" so the caller keeps its default and the deck still mounts.
import { describe, it, expect, afterEach } from "vitest";
import { readStored } from "../storage";

const glob = globalThis as unknown as Record<string, unknown>;

/** Installs a window whose `localStorage` property behaves as `desc` says —
 *  a value the tab can read, or a getter that refuses. */
function browser(desc: PropertyDescriptor): void {
  glob.window = Object.defineProperty({}, "localStorage", { configurable: true, ...desc });
}

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k: string) => (map.has(k) ? map.get(k)! : null) };
}

/** What a blocked profile actually raises on the property read. */
function refuse(): never {
  throw new Error("SecurityError: The operation is insecure.");
}

afterEach(() => { delete glob.window; });

describe("readStored", () => {
  it("hands back what the tab stored", () => {
    browser({ value: store({ "agent-dag.theme": "light" }) });
    expect(readStored("agent-dag.theme")).toBe("light");
  });

  it("reads a key nothing has written as not stored", () => {
    browser({ value: store() });
    expect(readStored("agent-dag.usagePanelOpen")).toBeNull();
  });

  it("survives a localStorage getter that throws, which is what a blocked browser has", () => {
    browser({ get: refuse });
    expect(() => readStored("agent-dag.usagePanelOpen")).not.toThrow();
    expect(readStored("agent-dag.usagePanelOpen")).toBeNull();
  });

  it("survives a store handed over whose getItem then throws", () => {
    browser({ value: { getItem: refuse } });
    expect(readStored("agent-dag.theme")).toBeNull();
  });

  it("survives a store that is missing entirely", () => {
    browser({ value: undefined });
    expect(readStored("agent-dag.theme")).toBeNull();
  });

  it("reads as not stored with no window at all, so importing outside a tab is safe", () => {
    delete glob.window;
    expect(readStored("agent-dag.theme")).toBeNull();
  });

  it("gives the deck its first-run defaults when the store is blocked", () => {
    // The two initialisers that used to throw: the usage panel opens on a fresh
    // profile, and the theme stays dark. Both derive from a null read, so a
    // refused store lands on the same answer as a browser that has never seen
    // the deck — no blank page, just an unremembered preference.
    browser({ get: refuse });
    const stored = readStored("agent-dag.usagePanelOpen");
    expect(stored === null ? true : stored === "1").toBe(true);
    expect((readStored("agent-dag.theme") as "dark" | "light" | null) ?? "dark").toBe("dark");
  });
});
