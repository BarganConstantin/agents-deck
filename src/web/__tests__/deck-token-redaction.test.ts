// #387: the deck's own token could end up in the event log, which is served to
// callers that hold no credential at all.
//
// #366 made HOOK_TOKEN the one thing separating "may read" from "may mutate".
// But `POST /api/event` is deliberately open — hook/hook.js lives in the user's
// ~/.claude and requiring a credential there would silence every session whose
// hook predates that change — and `GET /api/events`, `GET /events` and
// events.jsonl are all readable without one. So any agent session that merely
// LOOKED at the discovery file (`cat ~/.claude/agent-dag/<pid>.json`, a `Read`
// of it, `grep -r ~/.claude`) posted the token straight into the ring buffer,
// where the other local UID and the sandboxed subprocess — the two callers #366
// exists to stop — could read it back and mutate with it.
//
// These drive the real server over real sockets and pin all three sinks the
// buffer feeds: the `GET /api/events` reply, the live SSE fan-out, and the
// events.jsonl file on disk. They drive BOTH entry points, because that is the
// whole design decision the fix turned on: hook events arrive through
// handleEventIngest and Codex events never touch an HTTP handler at all, so the
// redaction sits in pushEvent, where every event passes exactly once.
//
// Plain node, no DOM: the server is a .mjs module and the client here is
// node:http.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-token-redaction-"));
const CODEX_HOME = join(DIR, "codex");
const SESSIONS = join(CODEX_HOME, "sessions");
const LOG = join(DIR, "events.jsonl");
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = CODEX_HOME;
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}
mkdirSync(CODEX_HOME, { recursive: true });

// @ts-expect-error — plain .mjs module, no types
const { startServer, startCodexWatcher, hookToken } = await import("../../server/index.mjs");

const TOKEN: string = hookToken();
const MARKER = "[redacted: ccdeck token]";
const CODEX_SID = "6f1a0c3e-0000-4000-8000-abcdef123456";

let server: Server;
let port = 0;
let codexTimer: ReturnType<typeof setInterval> | null = null;

// One subscriber, connected before the first event and left open for the whole
// file. Everything it is ever handed accumulates here, so the assertions can ask
// the only question that matters about the fan-out: did the token EVER cross
// this socket, in any frame, in any test.
let sseText = "";
let sseReq: ClientRequest | null = null;

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: LOG, codex: false });
  port = (server.address() as AddressInfo).port;

  await new Promise<void>((done, fail) => {
    sseReq = request({ host: "127.0.0.1", port, path: "/events", method: "GET" }, res => {
      res.setEncoding("utf8");
      res.on("data", c => { sseText += c; });
      done();
    });
    sseReq.on("error", fail);
    sseReq.end();
  });

  // The Codex watcher is the second entry point and is started separately: it
  // tails rollout files off the disk and never passes through the router.
  codexTimer = startCodexWatcher("");
});

afterAll(async () => {
  if (codexTimer) clearInterval(codexTimer);
  sseReq?.destroy();
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

function post(path: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST" }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, text: out }));
    });
    req.on("error", fail);
    req.write(body);
    req.end();
  });
}

function get(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => done(out));
    });
    req.on("error", fail);
    req.end();
  });
}

/** The log is appended fire-and-forget, so read it only for what has landed. */
function logText(): string {
  try { return readFileSync(LOG, "utf8"); } catch { return ""; }
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() >= deadline) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 25));
  }
}

/** The same poll for a probe that has to go over the wire to be answered.
 *  Deliberately separate: handing an async fn to `waitFor` would hand it a
 *  Promise, which is truthy on the first pass and would end the wait before the
 *  watcher had done anything at all. */
async function waitForServed(needle: string, ms = 20000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const text = await get("/api/events?since=0");
    if (text.includes(needle)) return text;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${needle}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

describe("the deck's own token never reaches the unauthenticated event log", () => {
  it("keeps a token posted through the hook's ingest out of GET /api/events", async () => {
    // What CC actually records when an agent reads the discovery file: the tool
    // response carries the file verbatim, token and all. Nested two levels deep
    // and inside an array as well, because the redaction walks the payload and
    // both shapes have to be covered.
    const body = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "sess-ingest",
      cwd: "/repo",
      tool_name: "Read",
      tool_response: {
        file: {
          filePath: "/home/u/.claude/agent-dag/1234.json",
          content: `{\n  "pid": 1234,\n  "port": 4317,\n  "token": "${TOKEN}"\n}\n`,
        },
        lines: ["port: 4317", `token: ${TOKEN}`],
      },
    });
    expect((await post("/api/event", body)).status).toBe(200);

    const served = await get("/api/events?since=0");
    expect(served).not.toContain(TOKEN);
    // And the event is still there, redacted rather than dropped: a session that
    // read the discovery file is an ordinary session and belongs on the canvas.
    expect(served).toContain("sess-ingest");
    expect(served).toContain(MARKER);
    // The surrounding text survives, so the tool call is still readable.
    expect(served).toContain("/home/u/.claude/agent-dag/1234.json");
    expect(served).toContain("port: 4317");
  });

  it("keeps it out of the live SSE fan-out", async () => {
    await waitFor(() => sseText.includes("sess-ingest"));
    expect(sseText).not.toContain(TOKEN);
    expect(sseText).toContain(MARKER);
  });

  it("keeps it out of events.jsonl", async () => {
    const text = await waitFor(() => {
      const t = logText();
      return t.includes("sess-ingest") ? t : null;
    });
    expect(text).not.toContain(TOKEN);
    expect(text).toContain(MARKER);
  });

  it("redacts a bare top-level JSON string too", async () => {
    // `POST /api/event` parses whatever JSON it is handed, and a bare string is
    // legal JSON — a primitive payload cannot be redacted in place, so the
    // redaction has to hand one back rather than mutate it.
    expect((await post("/api/event", JSON.stringify(`marker-bare ${TOKEN} tail`))).status).toBe(200);
    const served = await get("/api/events?since=0");
    expect(served).toContain("marker-bare");
    expect(served).not.toContain(TOKEN);
  });
});

describe("the Codex entry point, which never touches an HTTP handler", () => {
  it("keeps a token out of all three sinks", async () => {
    // Codex events arrive through the rollout watcher and emitCodexEvent, not
    // through the ingest handler — this is the second door that made pushEvent
    // the right place for the check. A Codex user typing the file's contents
    // into a prompt (or pasting them) lands here.
    const dayDir = join(SESSIONS, "2026", "08", "14");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, `rollout-2026-08-14T10-00-00-${CODEX_SID}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: CODEX_SID, cwd: join(DIR, "workspace") } })}\n` +
        `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `codex-probe token=${TOKEN} end` } })}\n`,
      "utf8",
    );

    const text = await waitForServed("codex-probe");

    expect(text).not.toContain(TOKEN);
    expect(text).toContain(MARKER);
    expect(text).toContain("codex-probe");

    await waitFor(() => sseText.includes("codex-probe"));
    expect(sseText).not.toContain(TOKEN);

    const onDisk = await waitFor(() => {
      const t = logText();
      return t.includes("codex-probe") ? t : null;
    });
    expect(onDisk).not.toContain(TOKEN);
    expect(onDisk).toContain(MARKER);
  }, 30000);
});

describe("an event that does not carry the token", () => {
  it("comes back byte for byte as it was posted", async () => {
    // The cost of a redaction pass is only acceptable if it is invisible to
    // every ordinary event, and "invisible" has to mean the bytes, not a
    // resemblance. No transcript_path, so none of the enrichment scanners fire
    // and nothing else can touch the payload either.
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "sess-clean",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls -la", description: "list files" },
      nested: { deep: { deeper: ["a", "b", { z: "0123456789abcdef" }] } },
      n: 42,
      t: true,
      nul: null,
    };
    const body = JSON.stringify(payload);
    expect((await post("/api/event", body)).status).toBe(200);

    const served = JSON.parse(await get("/api/events?since=0")) as Array<{ payload: unknown }>;
    const mine = served.find(e => (e.payload as { session_id?: string })?.session_id === "sess-clean");
    expect(mine).toBeTruthy();
    expect(mine!.payload).toEqual(payload);
    // Byte for byte, not merely deep-equal: key order survives too, so nothing
    // rebuilt the object on the way through.
    expect(JSON.stringify(mine!.payload)).toBe(body);

    const line = await waitFor(() => logText().split("\n").find(l => l.includes("sess-clean")));
    expect(JSON.stringify(JSON.parse(line).payload)).toBe(body);
  });
});
