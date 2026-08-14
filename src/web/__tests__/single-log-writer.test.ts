// Reported: with three decks up, every tool_use_id appeared exactly three
// times in ~/.claude/agent-dag/events.jsonl. The hook posts each event to
// every deck whose workspace matches — which is deliberate, they all draw it —
// but all of them default to that one log file, so each deck appended its own
// copy. The file grew and rotated three times as fast, and any deck replaying
// it on boot ingested every tool call three times, which is where the
// duplicated tools and the piled-up bubbles came from.
//
// The rule now has two halves, and both are pinned here: the hook elects one
// writer per log file among the decks it is about to post to, and the server
// honours that election for the event itself and for everything it later
// derives from the same session's transcript.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The home the server thinks it has, and the config dir the override points
// at — both temporary, both set before the server module is imported, so
// nothing here can reach the developer's own ~/.claude. $HOME and %USERPROFILE%
// together cover POSIX and Windows.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-config-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;

// @ts-expect-error — .mjs server module, no types
const { startServer, writesLogFor } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const installer = await import("../../server/installer.mjs");
const { discoveryPath, writeDiscovery, ensureDiscovery } = installer as {
  discoveryPath: () => string;
  writeDiscovery: (o: { port: number; workspace?: string; token?: string; persist?: string | null }) => Promise<string>;
  ensureDiscovery: (o: { port: number; workspace?: string; token?: string; persist?: string | null })
    => Promise<{ file: string; rewritten: boolean }>;
};

// Belt and braces: startServer sweeps the discovery dir it resolves, so if the
// override were ignored this file would be deleting from a real one.
if (!String(claudeConfigDir()).startsWith(FAKE_CONFIG)) {
  throw new Error(`refusing to run: server resolved ${claudeConfigDir()}, outside ${FAKE_CONFIG}`);
}

const LOG = join(FAKE_CONFIG, "agent-dag", "events.jsonl");
const server: Server = await startServer({ port: 0, persist: LOG, codex: false });
const PORT = (server.address() as AddressInfo).port;

// hook.js is CommonJS inside a "type": "module" package, so it is only loadable
// as itself from outside that tree — which is also the only way it ever runs,
// since the installer copies it into the Claude config dir. Requiring the copy
// exports the rules and starts nothing: the runtime is behind require.main.
const HOOK_DIR = mkdtempSync(join(tmpdir(), "ccdeck-hook-"));
const HOOK_COPY = join(HOOK_DIR, "hook.cjs");
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js"), HOOK_COPY);

type Deck = { pid: number; port: number; persist?: string | null };
const { electWriters } = createRequire(import.meta.url)(HOOK_COPY) as {
  electWriters: (decks: Deck[], platform?: string) => Set<Deck>;
};

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(FAKE_CONFIG, { recursive: true, force: true });
  rmSync(HOOK_DIR, { recursive: true, force: true });
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

async function post(payload: Record<string, unknown>, query = "") {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/event${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  await res.json();
}

function logged(): Record<string, any>[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The append is fire-and-forget, so wait for the lines that should be there —
 * then wait a little longer, which is the window a copy that should NOT be
 * there would land in.
 */
async function settle(expected: number) {
  for (let i = 0; i < 200 && logged().length < expected; i++) await tick(5);
  await tick(25);
}

const toolCall = (session: string, id: string) => ({
  hook_event_name: "PreToolUse",
  session_id: session,
  tool_name: "Read",
  tool_use_id: id,
  cwd: FAKE_HOME,
});

describe("a deck told another one owns the log", () => {
  it("draws the event but leaves the one copy on disk to the elected writer", async () => {
    await post(toolCall("sess-mine", "tool-1"));
    await post(toolCall("sess-theirs", "tool-2"), "?persist=0");
    await settle(1);

    const ids = logged().map(e => e.payload.tool_use_id);
    expect(ids).toEqual(["tool-1"]);

    // Both are still on the canvas: the fan-out is the point, only the second
    // copy on disk is dropped.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/events?since=0`);
    const seen = (await res.json()) as { payload: { tool_use_id?: string } }[];
    expect(seen.map(e => e.payload.tool_use_id)).toEqual(["tool-1", "tool-2"]);
  });

  it("also skips the model and usage events it derives from that session", () => {
    // These are read off the transcript by every deck watching the session, so
    // without carrying the election over they duplicate exactly like the hook
    // events did.
    expect(writesLogFor({ hook_event_name: "UsageObserved", session_id: "sess-theirs" })).toBe(false);
    expect(writesLogFor({ hook_event_name: "UsageObserved", session_id: "sess-mine" })).toBe(true);
  });

  it("takes the session back when the deck that owned it is gone", async () => {
    // The election runs per event against the decks that are live right now,
    // so the moment the writer exits the next event arrives unflagged.
    await post(toolCall("sess-theirs", "tool-3"));
    await settle(2);

    expect(logged().map(e => e.payload.tool_use_id)).toEqual(["tool-1", "tool-3"]);
    expect(writesLogFor({ hook_event_name: "UsageObserved", session_id: "sess-theirs" })).toBe(true);
  });

  it("records anything it cannot attribute to a session", () => {
    expect(writesLogFor({ hook_event_name: "__clear", cwd: "" })).toBe(true);
    expect(writesLogFor(null)).toBe(true);
  });
});

describe("electing one writer per events log", () => {
  const deck = (port: number, persist?: string | null): Deck => ({ pid: port * 10, port, persist });
  const ports = (decks: Deck[], writers: Set<Deck>) =>
    decks.filter(d => writers.has(d)).map(d => d.port).sort((a, b) => a - b);

  it("picks exactly one of the decks sharing the default log", () => {
    const decks = [deck(4385, "/home/u/.claude/agent-dag/events.jsonl"),
                   deck(4317, "/home/u/.claude/agent-dag/events.jsonl"),
                   deck(4325, "/home/u/.claude/agent-dag/events.jsonl")];
    // Lowest port, so the same deck keeps the file for as long as it is up.
    expect(ports(decks, electWriters(decks, "linux"))).toEqual([4317]);
  });

  it("hands the log to the next deck once that one is gone", () => {
    const decks = [deck(4385, "/log.jsonl"), deck(4325, "/log.jsonl")];
    expect(ports(decks, electWriters(decks, "linux"))).toEqual([4325]);
  });

  it("still writes when only one deck is running", () => {
    const decks = [deck(4317, "/home/u/.claude/agent-dag/events.jsonl")];
    expect(ports(decks, electWriters(decks, "linux"))).toEqual([4317]);
  });

  it("leaves a deck given its own --history file writing its own file", () => {
    const decks = [deck(4317, "/home/u/.claude/agent-dag/events.jsonl"), deck(4325, "/tmp/mine.jsonl")];
    expect(ports(decks, electWriters(decks, "linux"))).toEqual([4317, 4325]);
  });

  it("never lets a --no-persist deck be the writer for a log it does not have", () => {
    // The lower port here writes nothing at all. Electing it would have meant
    // the event was persisted by nobody.
    const decks = [deck(4317, null), deck(4325, "/home/u/.claude/agent-dag/events.jsonl")];
    expect(ports(decks, electWriters(decks, "linux"))).toEqual([4317, 4325]);
  });

  it("leaves a deck too old to report its log writing, as it did before", () => {
    const decks = [deck(4317), deck(4325)];
    expect(ports(decks, electWriters(decks, "linux"))).toEqual([4317, 4325]);
  });

  it("treats two spellings of one file as one file where the filesystem does", () => {
    const decks = [deck(4317, "C:\\Users\\J\\.claude\\agent-dag\\events.jsonl"),
                   deck(4325, "c:\\users\\j\\.claude\\agent-dag\\events.jsonl")];
    expect(ports(decks, electWriters(decks, "win32"))).toEqual([4317]);
    expect(ports(decks, electWriters(decks, "darwin"))).toEqual([4317]);
    // On Linux those are two different files, and each one needs its writer.
    expect(ports(decks, electWriters(decks, "linux"))).toEqual([4317, 4325]);
  });
});

// The election is only as good as what the decks advertise, and the discovery
// file is re-asserted on a 5s heartbeat — so the log path has to be part of
// both halves. Left out of the record, no hook can group decks by file; left
// out of the comparison, the heartbeat either rewrites the file every tick or
// settles for a record that never grows the field.
describe("the log path in the discovery record", () => {
  const PORT_A = 4326;
  const TOKEN = "b6d1f0c0e2a4";
  const wipe = () => rmSync(discoveryPath(), { force: true });

  afterEach(() => wipe());

  it("is what the deck publishes for the hook to read", async () => {
    await writeDiscovery({ port: PORT_A, workspace: "", token: TOKEN, persist: LOG });
    expect(JSON.parse(readFileSync(discoveryPath(), "utf8"))).toMatchObject({
      pid: process.pid, port: PORT_A, token: TOKEN, persist: LOG,
    });
  });

  it("is null for a deck running --no-persist, which can never be the writer", async () => {
    await writeDiscovery({ port: PORT_A, workspace: "", token: TOKEN, persist: null });
    expect(JSON.parse(readFileSync(discoveryPath(), "utf8")).persist).toBe(null);
  });

  it("leaves the deck's own record alone, so the heartbeat is not a rewrite loop", async () => {
    await writeDiscovery({ port: PORT_A, workspace: "", token: TOKEN, persist: LOG });
    const before = readFileSync(discoveryPath(), "utf8");
    const res = await ensureDiscovery({ port: PORT_A, workspace: "", token: TOKEN, persist: LOG });
    expect(res.rewritten).toBe(false);
    // A rewrite stamps a new startedAt — proof this was a read, not a write.
    expect(readFileSync(discoveryPath(), "utf8")).toBe(before);
  });

  it("replaces a record that names another log, or none at all", async () => {
    for (const stale of [{ persist: "/somewhere/else.jsonl" }, {}]) {
      writeFileSync(discoveryPath(), JSON.stringify({
        pid: process.pid, port: PORT_A, workspace: "", token: TOKEN, ...stale,
      }));
      const res = await ensureDiscovery({ port: PORT_A, workspace: "", token: TOKEN, persist: LOG });
      expect(res.rewritten).toBe(true);
      expect(JSON.parse(readFileSync(discoveryPath(), "utf8")).persist).toBe(LOG);
    }
  });
});
