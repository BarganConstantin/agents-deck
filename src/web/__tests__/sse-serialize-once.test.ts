// Every ingested event used to be serialized twice: once to build the SSE
// frame and once more, from scratch, for the events.jsonl line — two full
// passes over payloads that reach megabytes, back to back on the event loop.
// The frame was also built unconditionally, so a deck running with no browser
// tab open (or replaying its log at boot, which happens before the listener
// even exists) paid for a string nobody would ever read.
//
// These pin the two halves: nothing is serialized when there is neither a
// subscriber nor a persistence file, and when there is, the envelope is
// serialized exactly once no matter how many consumers share it.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every path this test touches lives under here. The server module resolves
// the Claude config dir and CODEX_HOME from the environment at import time, so
// the redirection has to happen before the dynamic import below — the real
// ~/.claude and ~/.codex are never read or written.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-serialize-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");

let server: Server;
let port = 0;

function close(s: Server): Promise<void> {
  return new Promise(done => {
    s.closeAllConnections?.();
    s.close(() => done());
  });
}

afterAll(async () => {
  if (server) await close(server);
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

function post(path: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      res => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", c => { out += c; });
        res.on("end", () => resolve(out));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function getJson(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/**
 * How many times a server *envelope* is serialized while `fn` runs. The
 * envelope is the only object in the process carrying both a numeric `seq` and
 * a `payload`, so the ack body and every unrelated JSON.stringify — including
 * the one this test uses to send the request — are excluded by shape.
 */
async function countEnvelopeStringifies(fn: () => Promise<void>): Promise<number> {
  const real = JSON.stringify;
  let n = 0;
  JSON.stringify = function (value: unknown, ...rest: unknown[]) {
    const v = value as { seq?: unknown; payload?: unknown; epoch?: unknown };
    if (v && typeof v === "object" && typeof v.seq === "number" && "payload" in v && "epoch" in v) n++;
    // @ts-expect-error — pass the arguments through untouched
    return real.call(JSON, value, ...rest);
  } as typeof JSON.stringify;
  try { await fn(); } finally { JSON.stringify = real; }
  return n;
}

/** A payload with no transcript_path, so ingest emits nothing of its own. */
function event(n: number) {
  return { hook_event_name: "UserPromptSubmit", session_id: `sid-${n}`, cwd: DIR, prompt: `p${n}` };
}

async function waitForClients(n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await getJson("/api/health")).clients === n) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`expected ${n} subscriber(s), server still reports ${(await getJson("/api/health")).clients}`);
}

/** An SSE client that actually reads, connected and registered server-side.
 *  The server adds it to its set after the response head is already on the
 *  wire, so "registered" has to be read back from the server, not assumed. */
async function subscribe(): Promise<IncomingMessage> {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/events" }, resolve).on("error", reject);
  });
  res.setEncoding("utf8");
  res.on("data", () => {});
  await waitForClients(1);
  return res;
}

/** Drop a subscriber and wait until the server has noticed. */
async function unsubscribe(res: IncomingMessage): Promise<void> {
  res.destroy();
  await waitForClients(0);
}

// The tests below run in order and hand the module from one server to the
// next: persistence is a property of the running server, so the headless case
// has to be measured before a persisting server is ever started.
describe("SSE envelope serialization", () => {
  it("serializes nothing with no subscriber and no persistence", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
    port = (server.address() as AddressInfo).port;
    const n = await countEnvelopeStringifies(async () => { await post("/api/event", event(0)); });
    expect(n).toBe(0);
    await close(server);
  });

  it("serializes once for the persist line when nobody is subscribed", async () => {
    // Persistence on — the default the deck ships with, and the second
    // consumer that used to pay for a stringify pass of its own.
    server = await startServer({ port: 0, host: "127.0.0.1", persist: join(DIR, "events.jsonl"), codex: false });
    port = (server.address() as AddressInfo).port;
    const n = await countEnvelopeStringifies(async () => { await post("/api/event", event(1)); });
    expect(n).toBe(1);
  });

  it("serializes once for a subscriber and the persist line together", async () => {
    const sub = await subscribe();
    try {
      const n = await countEnvelopeStringifies(async () => { await post("/api/event", event(2)); });
      expect(n).toBe(1);
    } finally {
      await unsubscribe(sub);
    }
  });

  // An event another deck was elected to log (`?persist=0`) skips the log line
  // but is still broadcast, so a subscriber alone is reason enough to serialize
  // it. Getting that backwards would leave watching tabs blind to every session
  // this deck does not happen to own the log for.
  it("still serializes an event it is not logging when someone is watching", async () => {
    const sub = await subscribe();
    try {
      const n = await countEnvelopeStringifies(async () => { await post("/api/event?persist=0", event(3)); });
      expect(n).toBe(1);

      // The log append is fire-and-forget, so read the file only once an event
      // posted after the suppressed one has landed in it.
      await post("/api/event", event(4));
      let log = "";
      for (let i = 0; i < 400 && !log.includes("p4"); i++) {
        log = readFileSync(join(DIR, "events.jsonl"), "utf8");
        if (!log.includes("p4")) await new Promise(r => setTimeout(r, 10));
      }
      expect(log).toContain("p4");
      expect(log).not.toContain("p3");
    } finally {
      await unsubscribe(sub);
    }
  });
});
