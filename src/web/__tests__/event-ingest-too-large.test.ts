// POST /api/event past its 5 MB cap answered with nothing at all.
//
// handleEventIngest called `req.destroy()` inside its `data` handler and then
// returned. Destroying an IncomingMessage destroys the socket under it, so the
// poster did not hang — it got a connection reset, which is worse in the way
// that matters: it is exactly what a deck that crashed, or that was never there,
// looks like. There is no status code anywhere in that exchange to tell the two
// apart. `end` never fires on a destroyed request either, so the handler had no
// second chance to say anything.
//
// readBody (64 KB, everywhere else) gets this right by rejecting into a caller
// that replies. This route now answers 413 first and drops the socket only once
// the reply has flushed, since destroying a socket discards whatever is still
// queued on it.
//
// hook/hook.js is the only client that posts here. It reads the response and
// then calls its finish callback, and it holds a 1-second timeout over the
// whole thing — so it survived the reset and survives the 413; what it gains is
// a status code that says which of the two happened.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-event-too-large-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer } = await import("../../server/index.mjs");

let server: Server;
let port: number;

beforeAll(async () => {
  // persist: null so nothing under test writes an event log.
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
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

/**
 * POST a body of `bytes` and report what came back — a status, or the socket
 * error that arrived instead.
 *
 * Written the long way on purpose. The server answers and hangs up while the
 * body is still being written, so the write side fails with EPIPE/ECONNRESET
 * and a naive `req.on("error", reject)` would report the refusal it is meant to
 * be measuring as a test failure. A response, if one arrives, is the answer;
 * the error only speaks when nothing else does.
 */
function postBytes(bytes: number, path = "/api/event"): Promise<{ status: number | null; body: string; err: string | null }> {
  return new Promise((done) => {
    let answered = false;
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } }, res => {
      answered = true;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => done({ status: res.statusCode ?? null, body, err: null }));
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (!answered) done({ status: null, body: "", err: e.code ?? e.message });
    });
    // A megabyte at a time, so the cap is crossed mid-upload rather than in one
    // write the server never gets to interrupt — which is the shape a real
    // oversized post has.
    const chunk = "x".repeat(1 << 20);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        sent += chunk.length;
        if (!req.write(chunk, () => {})) return req.once("drain", pump);
      }
      req.end();
    };
    // The body is never valid JSON; the cap is crossed long before anything
    // would try to parse it.
    req.write('{"pad":"');
    pump();
  });
}

describe("POST /api/event past the 5 MB cap", () => {
  it("answers 413 instead of dropping the connection", async () => {
    const r = await postBytes(6 << 20);
    expect(r.err).toBeNull();
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: "event too large" });
  }, 20_000);

  it("does not then answer a second time on the way down", async () => {
    // Destroying the request raises `error` on it, and the handler for that
    // used to reply 400 — a second writeHead on a response already sent, thrown
    // out of an error handler with nothing waiting to catch it. The server
    // being alive for the next request is the assertion.
    await postBytes(6 << 20);
    const ok = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/health", method: "GET" }, res => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      });
      req.on("error", rejectStatus);
      req.end();
    });
    expect(ok).toBe(200);
  }, 20_000);

  it("leaves an ordinary event alone", async () => {
    const body = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: DIR });
    const r = await new Promise<{ status: number; body: string }>((doneOne, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/event", method: "POST",
        headers: { "Content-Type": "application/json" } }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", c => { text += c; });
        res.on("end", () => doneOne({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", fail);
      req.end(body);
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
  });
});
