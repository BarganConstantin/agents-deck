// The `Last-Event-ID` catch-up loop wrote the whole ring buffer to the new
// client with bare `res.write` calls, so the one burst guaranteed to be large
// was the one burst MAX_CLIENT_BUFFER_BYTES did not cover: measured against a
// full ring of 2000 modest events, a single client that never read had 39MB of
// frames queued for it — ten times the cap by the cap's own accounting — and
// never fired 'close' to release any of it.
//
// The fix is flow control rather than a blind drop, and the difference matters
// in both directions. A client that reads must still receive every replayed
// event and the replay-end sentinel however far past the cap the ring is: the
// burst is the server's own doing, so hanging up the moment the buffer fills
// would hang up on healthy clients — repeatedly, since EventSource reconnects
// with the same Last-Event-ID and would meet the same oversized replay. A
// client that reads nothing is held at the cap and then hung up on, exactly as
// the live fan-out treats it.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { get, request, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything lives under this temp directory; the real ~/.claude and ~/.codex
// are never read or written. Resolved at module import time, hence before the
// dynamic import below.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-resume-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
// The production budget for a stalled resumer is 30s, which is the right
// number for a real `ssh -L` tunnel and the wrong one to sit through here.
const DRAIN_MS = 500;
process.env.AGENTS_DECK_REPLAY_DRAIN_MS = String(DRAIN_MS);

// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");

let server: Server;
let port = 0;
const sockets: Socket[] = [];
const streams: IncomingMessage[] = [];

// 1MB each, comfortably under the 5MB ingest cap; twenty of them is a ring
// buffer well past the 8MB per-client bound — and far enough past it that what
// a stalled client is allowed to receive (the bound, plus the frame that
// crossed it, plus whatever the two kernels absorb) cannot be mistaken for the
// whole of it.
const BLOB = "x".repeat(1024 * 1024);
const FAT_EVENTS = 20;
const CAP_PLUS_SLACK = 14 * 1024 * 1024;
const primed: number[] = [];

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  for (let i = 0; i < FAT_EVENTS; i++) {
    primed.push(await post({
      hook_event_name: "PostToolUse", session_id: "sid-fat", cwd: DIR,
      tool_use_id: `t${i}`, tool_name: "Read", tool_response: BLOB,
    }));
  }
}, 60_000);

afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const s of streams) s.destroy();
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTS_DECK_REPLAY_DRAIN_MS"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

/** Post one event and return the seq the server assigned it. `agent: false`
 *  keeps no keep-alive socket alive afterwards, which would otherwise show up
 *  in the connection counts below. */
function post(body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1", port, path: "/api/event", method: "POST", agent: false,
        headers: { "Content-Type": "application/json" },
      },
      res => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", c => { out += c; });
        res.on("end", () => { try { resolve(JSON.parse(out).seq); } catch (e) { reject(e); } });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function health(): Promise<{ clients: number }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/api/health", agent: false }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/** Sockets the server currently holds open — the handle side of "did the drop
 *  actually let go of it". */
function connections(): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((err, n) => (err ? reject(err) : resolve(n)));
  });
}

/** Pending Timeout handles in this worker, the timer side of the same
 *  question. Counted as a delta so whatever the runner keeps running is
 *  common to both readings. */
function timers(): number {
  const info = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  return info ? info.call(process).filter(r => r === "Timeout").length : 0;
}

async function waitUntil(pred: () => Promise<boolean> | boolean, label: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A resuming subscriber that never reads a byte, held that way for longer than
 * the drain budget and then allowed to read whatever it was sent. Raw TCP
 * rather than http.get: pausing a parsed response still lets Node drain the
 * socket, and it is the socket standing still that reproduces the report.
 * `Last-Event-ID: 0` asks for the whole ring, which is the resume a tab makes
 * after a suspend.
 *
 * Resolves once the server has hung up — which a paused socket only learns
 * when it reads again, the close arriving behind the bytes already queued for
 * it, so the stall has to be timed rather than watched.
 */
async function droppedStalledResumer(): Promise<number> {
  const sock = connect(port, "127.0.0.1");
  sockets.push(sock);
  let bytes = 0;
  let ended = false;
  sock.on("error", () => {});
  sock.on("end", () => { ended = true; });
  sock.on("close", () => { ended = true; });
  sock.on("data", c => { bytes += c.length; });
  sock.write(
    `GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
    `Accept: text/event-stream\r\nLast-Event-ID: 0\r\n\r\n`,
  );
  sock.pause();
  await new Promise(r => setTimeout(r, DRAIN_MS * 3));
  sock.resume();
  await waitUntil(() => ended, "the stalled resumer to be hung up on");
  return bytes;
}

describe("SSE resume backpressure", () => {
  it("holds a resuming client that stops reading to the cap, then hangs up on it", async () => {
    // What it was sent is a fraction of the ring, not the ring: the loop
    // stopped at the cap and waited instead of queueing the rest. Before the
    // fix this socket was handed all 20MB and was never hung up on at all.
    expect(await droppedStalledResumer()).toBeLessThan(CAP_PLUS_SLACK);

    // And it was never in the fan-out set to begin with, so hanging up on it
    // cost the live stream nothing.
    expect((await health()).clients).toBe(0);
  }, 30_000);

  // The other half of the fix, and the half a blunter one would have broken:
  // the replay burst fills any client's buffer, because nothing has had the
  // chance to drain it yet, so hanging up at the cap here would hang up on a
  // client doing everything right — over and over, since it reconnects with
  // the same Last-Event-ID and meets the same oversized ring.
  it("still delivers the whole replay and the sentinel to a client that reads", async () => {
    const subscribedBefore = (await health()).clients;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: "/events", agent: false, headers: { "Last-Event-ID": "0" } }, resolve)
        .on("error", reject);
    });
    streams.push(res);

    const ids = new Set<number>();
    let sentinel = false;
    let carry = "";
    res.setEncoding("utf8");
    res.on("error", () => {});
    res.on("data", (c: string) => {
      // Frames are split across chunks at arbitrary offsets, so each scan
      // starts with the tail of the last one.
      const s = carry + c;
      for (const m of s.matchAll(/(?:^|\n)id: (\d+)\n/g)) ids.add(Number(m[1]));
      if (s.includes("event: replay-end")) sentinel = true;
      carry = s.slice(-32);
    });

    await waitUntil(() => sentinel, "the replay-end sentinel");
    // Every event in the ring, none skipped by the flow control that carried
    // this client past the cap several times over.
    for (const seq of primed) expect(ids.has(seq)).toBe(true);
    // And it is live: still subscribed, and fed by the fan-out.
    await waitUntil(
      async () => (await health()).clients === subscribedBefore + 1,
      "the reader to be subscribed",
    );
    const live = await post({ hook_event_name: "Stop", session_id: "sid-fat", cwd: DIR });
    await waitUntil(() => ids.has(live), "the live event after the sentinel");
  }, 30_000);

  it("leaves no handle and no timer behind when it drops a resumer", async () => {
    const baseConns = await connections();
    const baseTimers = timers();
    const baseClients = (await health()).clients;

    await droppedStalledResumer();

    // The socket is gone from the server's own books, the drain timer is
    // cleared on the way out, and the ping interval belongs to clients that
    // made it to the fan-out — this one never did. Each is given a moment,
    // because a socket's bookkeeping unwinds after the close it announces; a
    // leaked handle or interval would still be there long after this deadline.
    await waitUntil(async () => (await connections()) <= baseConns, "the dropped socket to be released", 80);
    await waitUntil(() => timers() <= baseTimers, "the drop to leave no timer behind", 80);
    expect((await health()).clients).toBe(baseClients);
  }, 30_000);
});
