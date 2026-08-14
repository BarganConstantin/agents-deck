// The SSE fan-out wrote to every subscriber with `try { res.write(line) }
// catch {}` and looked no further. A client that stops reading without closing
// its socket — a frozen tab, a suspended machine, a stalled `ssh -L` tunnel —
// never makes write() throw and never fires 'close', and on loopback nothing
// times the connection out, so every event (tool responses reach megabytes)
// piled up in that socket's write buffer for the life of the process.
//
// The policy is to drop the client, not the events: EventSource reconnects
// after the `retry: 1500` the stream opens with and resumes from
// Last-Event-ID, so the ring buffer replays what it missed. This pins that a
// subscriber which stops reading is hung up on, and — just as important — that
// a subscriber which keeps reading is left alone and keeps receiving.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { get, request, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything lives under this temp directory; the real ~/.claude and ~/.codex
// are never read or written. Resolved at module import time, hence before the
// dynamic import below.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-backpressure-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");

let server: Server;
let port = 0;
const sockets: Socket[] = [];
const streams: IncomingMessage[] = [];

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const s of streams) s.destroy();
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

function post(path: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      res => { res.resume(); res.on("end", () => resolve()); },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function health(): Promise<{ clients: number }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/api/health" }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function waitForClients(n: number, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await health()).clients === n) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`${label}: still ${(await health()).clients} client(s), expected ${n}`);
}

/**
 * A subscriber that opens the stream and then never reads a byte. Raw TCP
 * rather than http.get: pausing a parsed response still lets Node drain the
 * socket, and it is the socket standing still that reproduces the report.
 */
function stalledSubscriber(): Socket {
  const sock = connect(port, "127.0.0.1");
  sockets.push(sock);
  sock.on("error", () => {});
  sock.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`);
  sock.pause();
  return sock;
}

/** A subscriber that behaves: it reads everything the server sends. */
async function healthySubscriber(): Promise<{ res: IncomingMessage; bytes: () => number }> {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/events" }, resolve).on("error", reject);
  });
  streams.push(res);
  let bytes = 0;
  res.setEncoding("utf8");
  res.on("data", c => { bytes += c.length; });
  res.on("error", () => {});
  return { res, bytes: () => bytes };
}

// 1MB each, comfortably under the 5MB ingest cap; twenty of them is well past
// the per-client buffer bound.
const BLOB = "x".repeat(1024 * 1024);
function fatEvent(n: number) {
  return { hook_event_name: "PostToolUse", session_id: "sid-fat", cwd: DIR, tool_use_id: `t${n}`, tool_response: BLOB };
}

describe("SSE fan-out backpressure", () => {
  it("hangs up on a subscriber that stops reading, and keeps the one that does", async () => {
    const healthy = await healthySubscriber();
    stalledSubscriber();
    await waitForClients(2, "both subscribers registered");
    const before = healthy.bytes();

    for (let i = 0; i < 20; i++) await post("/api/event", fatEvent(i));

    // The stalled one is dropped; the reader survives and is still fed.
    await waitForClients(1, "stalled subscriber dropped");
    for (let i = 0; i < 200 && healthy.bytes() <= before; i++) await new Promise(r => setTimeout(r, 25));
    expect(healthy.bytes()).toBeGreaterThan(before);

    // And the server is still serving after hanging up on it.
    await post("/api/event", { hook_event_name: "Stop", session_id: "sid-fat", cwd: DIR });
    expect((await health()).clients).toBe(1);
  }, 60_000);
});
