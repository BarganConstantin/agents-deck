// The server's enrichment caches are keyed by session id and used to be
// written and never cleaned: the resolved model and its subagent signature,
// the four read-throttle stamps, the Codex rollout path and model. Nothing
// evicted them — no SessionEnd handling, no TTL — so a deck left up for weeks
// across hundreds of sessions (the 24/7 use this thing is built for) kept an
// entry per session it had ever seen, forever.
//
// Entries now expire by least-recent use against a cap. The cache is not
// exported, so these drive it the way the deck does — hook events in, envelopes
// out — and read it through the one place it is observable: pushEvent stamps a
// payload that carries no model with the model it remembers for that session.
// A session still in the cache gets the stamp; an evicted one does not.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-session-cache-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");

// Matches MAX_TRACKED_SESSIONS in src/server/index.mjs.
const CAP = 256;
const MODEL = "claude-opus-4-7";
const TRANSCRIPT = join(DIR, "transcript.jsonl");

let server: Server;
let port = 0;

beforeAll(async () => {
  writeFileSync(
    TRANSCRIPT,
    JSON.stringify({
      type: "assistant",
      message: { model: MODEL, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n",
    "utf8",
  );
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

function post(body: unknown): Promise<{ seq: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/event", method: "POST", headers: { "Content-Type": "application/json" } },
      res => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", c => { out += c; });
        res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

type Envelope = { seq: number; payload: { session_id?: string; model?: string; hook_event_name?: string } };

function since(seq: number): Promise<Envelope[]> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: `/api/events?since=${seq}` }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/** Feed one event carrying a transcript and wait until its model is resolved —
 *  the synthetic ModelObserved is the server saying "cached" — and then until
 *  the session goes quiet. A transcript kicks off three scans, and a
 *  UsageObserved landing later would count as fresh activity for the very
 *  session the test is about to push out. */
async function prime(sid: string): Promise<void> {
  const { seq } = await post({ hook_event_name: "UserPromptSubmit", session_id: sid, cwd: DIR, transcript_path: TRANSCRIPT, prompt: "hi" });
  let resolved = false;
  for (let i = 0; i < 400 && !resolved; i++) {
    const seen = await since(seq - 1);
    resolved = seen.some(e => e.payload.hook_event_name === "ModelObserved" && e.payload.session_id === sid);
    if (!resolved) await new Promise(r => setTimeout(r, 25));
  }
  if (!resolved) throw new Error(`model never resolved for ${sid}`);

  let last = -1;
  for (let quiet = 0; quiet < 8; ) {
    const seen = await since(0);
    const top = seen.reduce((m, e) => (e.payload.session_id === sid && e.seq > m ? e.seq : m), 0);
    if (top === last) quiet++; else { last = top; quiet = 0; }
    await new Promise(r => setTimeout(r, 25));
  }
}

/** The model the server stamped on a plain event for `sid`, or undefined when
 *  it no longer remembers that session. No transcript_path: nothing may refill
 *  the cache behind the assertion. */
async function stampedModel(sid: string): Promise<string | undefined> {
  const { seq } = await post({ hook_event_name: "Stop", session_id: sid, cwd: DIR });
  const seen = await since(seq - 1);
  return seen.find(e => e.seq === seq)?.payload.model;
}

/** Traffic from `count` sessions the deck has never seen before. */
async function otherSessions(count: number, tag: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    await post({ hook_event_name: "Stop", session_id: `${tag}-${i}`, cwd: DIR });
  }
}

describe("per-session cache expiry", () => {
  it("forgets a session pushed out by newer ones", async () => {
    const sid = "cold-session";
    await prime(sid);
    expect(await stampedModel(sid)).toBe(MODEL);

    await otherSessions(CAP + 8, "filler");

    expect(await stampedModel(sid)).toBeUndefined();
  }, 60_000);

  it("keeps a session that is still being used", async () => {
    const sid = "warm-session";
    await prime(sid);

    // Same volume of other sessions, except this one keeps talking — which is
    // what a live session on a long-running deck does.
    for (let round = 0; round < 8; round++) {
      await otherSessions(Math.ceil((CAP + 8) / 8), `warm-filler-${round}`);
      expect(await stampedModel(sid)).toBe(MODEL);
    }
  }, 60_000);
});
