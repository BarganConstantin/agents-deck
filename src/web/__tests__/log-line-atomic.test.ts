// Reported: events.jsonl was shredded whenever one event went over 512 KiB.
//
// `fsPromises.appendFile` is not one write(2) — Node's writeFileHandle loops
// over the payload in 512 KiB chunks, awaiting each one — so any line past
// 524288 bytes reached the file as two or more separate appends with the event
// loop free in between. pushEvent fires the append without awaiting it and then
// synchronously kicks off the transcript scanners, each of which pushes its own
// event a moment later, so an ordinary small event landed INSIDE a large tool
// response: the big line was torn into two unparseable halves and the small one
// was swallowed inside one of them. Two decks sharing one events.jsonl — the
// default, and something the single-writer election deliberately allows for
// different sessions — made it cross-process as well, where no amount of
// in-process queueing would have helped.
//
// The damage was invisible: replayLog skipped every line it could not parse and
// said nothing, so after a restart the canvas was missing the largest tool
// responses and whatever event was spliced into them, with no counter anywhere.
//
// These pin every part of the fix: one whole line per write(2), proved both on
// the writer itself and end to end through a running deck's ingest route,
// proved across two processes as well as inside one, the order lines land in,
// and a log that is ALREADY shredded on a user's disk still replaying
// everything around the damage — now with the skip counted and reported rather
// than swallowed.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Every home the server modules resolve is pointed inside a temp directory
// BEFORE either module is imported, because they resolve them at import time.
// $HOME and %USERPROFILE% together cover POSIX and Windows. Nothing in this
// file can reach the developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-446-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-446-config-"));
const FAKE_CODEX = mkdtempSync(join(tmpdir(), "ccdeck-446-codex-"));
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-446-logs-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
process.env.CODEX_HOME = FAKE_CODEX;

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_WRITER = join(HERE, "..", "..", "server", "log-writer.mjs");

const logWriter = await import("../../server/log-writer.mjs");
const { appendLogLine } = logWriter as unknown as {
  appendLogLine: (file: string, line: string) => Promise<void>;
};
const serverModule = await import("../../server/index.mjs");
const { startServer, eventsSince } = serverModule as unknown as {
  startServer: (o: Record<string, unknown>) => Promise<Server>;
  eventsSince: (seq: number) => { seq: number; source: string; payload: Record<string, unknown> }[];
};
const { claudeConfigDir } = (await import("../../server/claude-dir.mjs")) as unknown as {
  claudeConfigDir: () => string;
};

// Belt and braces. If the override were ever ignored this file would be racing
// multi-megabyte writes against the developer's own event log.
if (!String(claudeConfigDir()).startsWith(FAKE_CONFIG)) {
  throw new Error(`refusing to run: resolved ${claudeConfigDir()}, outside ${FAKE_CONFIG}`);
}

/** A JSONL envelope whose serialized length is exactly `bytes` ASCII bytes. */
function envelope(tag: string, bytes: number, seq = 0): string {
  const build = (blob: string) =>
    JSON.stringify({ seq, epoch: 1, receivedAt: 1, source: "hook", payload: { tag, blob } });
  return build("A".repeat(Math.max(0, bytes - build("").length)));
}

const parseAll = (file: string) => {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const ok: { seq: number; payload: { tag: string } }[] = [];
  const bad: string[] = [];
  for (const l of lines) {
    try { ok.push(JSON.parse(l)); } catch { bad.push(l); }
  }
  return { lines, ok, bad };
};

// ── The already-shredded log the deck boots on ──────────────────────────────
// Written by hand into exactly the shape the pre-fix writer produced: an intact
// event, then the head of a torn 1 MiB event with a whole small event swallowed
// inside it, then two intact events that were appended while the big one was
// mid-flight, then the orphaned tail, then a final intact event. The deck goes
// on appending to this same file, which is what a user with a damaged log
// actually has.
const LIVE_LOG = join(SANDBOX, "events.jsonl");
const INTACT_TAGS = ["e1", "e4", "e5", "e9"];
const PRE_EXISTING_BAD_LINES = 2;
{
  const big = envelope("e2", 1024 * 1024);
  const swallowed = envelope("e3", 120);
  const cut = 400_000;
  writeFileSync(
    LIVE_LOG,
    [
      envelope("e1", 200),
      big.slice(0, cut) + swallowed,   // torn head, with a whole small line inside it
      envelope("e4", 200),
      envelope("e5", 200),
      big.slice(cut),                  // orphaned tail
      envelope("e9", 200),
    ].join("\n") + "\n",
    "utf8",
  );
}

let warnings: string[] = [];
let server: Server;
let PORT = 0;
beforeAll(async () => {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    // No providers: this boots for the log alone, and the Codex rollout watcher
    // would add events of its own to the buffer being asserted on.
    server = await startServer({ port: 0, persist: LIVE_LOG, workspace: "", codex: false, claude: false });
  } finally {
    console.warn = warn;
  }
  PORT = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX, SANDBOX]) rmSync(dir, { recursive: true, force: true });
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

describe("booting on a log that is already shredded", () => {
  it("replays every whole event around the damage", () => {
    const tags = eventsSince(0).map(e => (e.payload as { tag?: string })?.tag).filter(Boolean);
    for (const tag of INTACT_TAGS) expect(tags).toContain(tag);
  });

  it("does not replay the torn halves or the event swallowed inside them", () => {
    const tags = eventsSince(0).map(e => (e.payload as { tag?: string })?.tag).filter(Boolean);
    // e2 was torn in two and e3 was swallowed inside its head; neither half
    // parses, so both events are simply gone. That loss belongs to the writer
    // that made it — what matters here is that it costs two events and not the
    // whole of the rest of the file.
    expect(tags).not.toContain("e2");
    expect(tags).not.toContain("e3");
  });

  it("counts the unreadable lines and says so instead of skipping them in silence", () => {
    // Before the fix a shredded log replayed "mostly" with nothing logged
    // anywhere, so the user saw a canvas missing its largest tool responses and
    // had no way to tell that from a session that never produced them.
    const said = warnings.filter(w => /skipped \d+ unreadable line/.test(w));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/skipped 2 unreadable line\(s\)/);
    // The size is what separates one truncated tail from megabytes of shredding.
    expect(said[0]).toMatch(/\(\d+KB\)/);
    // One line, always: this prints onto the terminal the deck paints over.
    expect(said[0]).not.toContain("\n");
  });
});

// POST one event to this deck the way the hook does — no Origin header, no
// credential, which is what /api/event is deliberately open to.
function postEvent(payload: unknown): Promise<number> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, path: "/api/event", method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.byteLength) } },
      res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Wait until the log holds every one of these tags as a whole parseable line. */
async function waitForTags(file: string, tags: string[], ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { ok } = parseAll(file);
    const have = new Set(ok.map(e => e.payload?.tag));
    if (tags.every(t => have.has(t))) return;
    if (Date.now() > deadline) throw new Error(`timed out: missing ${tags.filter(t => !have.has(t)).join(", ")}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

describe("a running deck ingesting an oversized event", () => {
  it("writes it and everything racing it as whole lines", async () => {
    // The reproduction from the report, driven through the route that actually
    // carries it: a PostToolUse whose tool_response is a large Read or Bash
    // output, with ordinary small events arriving while it is being written.
    // The big POST resolves once pushEvent has STARTED the append, so the small
    // ones that follow land squarely inside the window the chunking opened.
    const expected: string[] = [];
    for (let round = 0; round < 2; round++) {
      const bigTag = `live-big-${round}`;
      expected.push(bigTag);
      await postEvent(JSON.parse(envelope(bigTag, 4 * 1024 * 1024)).payload);
      const smalls: Promise<number>[] = [];
      for (let i = 0; i < 16; i++) {
        const tag = `live-small-${round}-${i}`;
        expected.push(tag);
        smalls.push(postEvent({ tag, hook_event_name: "PostToolUse" }));
      }
      expect(await Promise.all(smalls)).toEqual(new Array(16).fill(200));
    }

    await waitForTags(LIVE_LOG, expected);

    // And nothing new was torn on the way in. The only unparseable lines left
    // are the two the fixture was seeded with.
    const { bad } = parseAll(LIVE_LOG);
    expect(bad).toHaveLength(PRE_EXISTING_BAD_LINES);
  }, 120_000);
});

describe("appending one whole line to the shared event log", () => {
  it("round-trips an event far larger than Node's 512 KiB append chunk", async () => {
    const file = join(SANDBOX, "oversized.jsonl");
    // Comfortably past 524288, which is where appendFile starts splitting.
    const line = envelope("big", 3 * 1024 * 1024);
    await appendLogLine(file, line + "\n");
    const { lines, ok, bad } = parseAll(file);
    expect(bad).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(line)).toEqual(ok[0]);
  }, 60_000);

  it("keeps every line whole when a huge event and small ones are written in one tick", async () => {
    const file = join(SANDBOX, "interleaved.jsonl");
    const writes = [appendLogLine(file, envelope("s0", 1024 * 1024) + "\n")];
    for (let i = 1; i <= 8; i++) writes.push(appendLogLine(file, envelope(`s${i}`, 120) + "\n"));
    await Promise.all(writes);

    const { ok, bad } = parseAll(file);
    expect(bad).toEqual([]);
    expect(ok).toHaveLength(9);
    // Not one of the small events may have been swallowed inside the big one.
    expect(ok.map(e => e.payload.tag).sort()).toEqual(
      ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"],
    );
  }, 60_000);

  it("keeps lines in the order they were handed over, big ones included", async () => {
    // Ordering is what the per-file promise chain buys on top of atomicity: a
    // replay reads the file top to bottom, so a log whose lines landed in
    // whatever order the threadpool finished in would replay out of order.
    const file = join(SANDBOX, "ordered.jsonl");
    const writes = [];
    for (let i = 0; i < 12; i++) writes.push(appendLogLine(file, envelope(`o${i}`, i % 2 ? 700_000 : 120, i) + "\n"));
    await Promise.all(writes);
    const { ok, bad } = parseAll(file);
    expect(bad).toEqual([]);
    expect(ok.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  }, 60_000);

  it("keeps every line whole when two separate processes append to one log", async () => {
    // The case a promise chain inside one deck cannot reach, and the one the
    // single-writer election deliberately leaves open: two decks are both
    // elected writers for DIFFERENT sessions on the same default events.jsonl,
    // so both hold the file at once. Only one write(2) per line survives this.
    const file = join(SANDBOX, "two-processes.jsonl");
    const child = (tag: string) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SOURCE], {
          stdio: "ignore",
          env: { ...process.env, CCDECK_446_FILE: file, CCDECK_446_TAG: tag },
        });
        p.on("error", reject);
        p.on("exit", code => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
      });
    await Promise.all([child("X"), child("Y")]);

    const { ok, bad } = parseAll(file);
    expect(bad).toEqual([]);
    expect(ok).toHaveLength(6);
    expect(ok.filter(e => e.payload.tag === "X")).toHaveLength(3);
    expect(ok.filter(e => e.payload.tag === "Y")).toHaveLength(3);
  }, 120_000);
});

// The children import the writer itself rather than reimplementing it, so this
// drives the shipped code path and not a copy of it. pathToFileURL keeps the
// specifier legal on Windows, where a bare drive path is not a URL. Everything
// variable travels in the environment, so no path is ever quoted into source.
const CHILD_SOURCE = `
import { appendLogLine } from ${JSON.stringify(pathToFileURL(LOG_WRITER).href)};
const file = process.env.CCDECK_446_FILE;
const tag = process.env.CCDECK_446_TAG;
const jobs = [];
for (let i = 0; i < 3; i++) {
  const line = JSON.stringify({ seq: i, payload: { tag, blob: tag.repeat(2 * 1024 * 1024) } });
  jobs.push(appendLogLine(file, line + "\\n"));
}
await Promise.all(jobs);
`;
