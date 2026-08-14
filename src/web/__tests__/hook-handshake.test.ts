// Reported: a discovery file outlives the deck that wrote it — SIGKILL, a power
// cut, anything that skips the shutdown path — and the only staleness check
// anywhere is a signal-0 probe of the recorded pid. Once the OS recycles that
// pid onto a long-lived process the file passes forever, while the port it
// names may by then belong to something else entirely (4317, the deck's own
// default, is also the standard OTLP collector port). Every hook event from
// every session — prompt text, tool inputs, tool results, cwd — was then POSTed
// there before a single byte of response was read.
//
// The fix makes the listener prove it is the deck that wrote the file: the deck
// stores a per-start random token there, and the hook sends nothing until the
// port hashes that token against a nonce it has never seen. These tests pin
// both halves — that an honest deck still receives events, and that a stranger
// on the port receives nothing but the challenge.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself once outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. A .cjs copy reproduces
// that without an install, and requiring it starts nothing: main() is behind
// require.main.
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-handshake-"));
const COPY = join(ROOT, "hook.cjs");
copyFileSync(HOOK, COPY);

const hook = createRequire(import.meta.url)(COPY) as {
  challengeProof: (token: string, nonce: string) => string;
};
// @ts-expect-error — .mjs server module, no types
const { challengeProof, hookToken } = await import("../../server/index.mjs");

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

type Seen = { method: string; path: string; body: string };

/** A listener plus a log of everything the hook said to it. */
async function listener(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", body: "" };
    seen.push(entry);
    req.on("data", c => { entry.body += c; });
    // The hook hangs up on some of the listeners below; an unhandled stream
    // error would then take the whole test worker down with it.
    req.on("error", () => {});
    res.on("error", () => {});
    handler(req, res, entry);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>(done => {
    // One of the listeners below never answers, so a socket may still be half
    // open when the hook gives up; close() alone would wait on it.
    server.closeAllConnections?.();
    server.close(() => done());
  });
  return { seen, port, close };
}

/** A listener that answers the challenge the way a real deck does. */
function honestDeck(token: string) {
  return (req: IncomingMessage, res: ServerResponse, entry: Seen) => {
    const url = new URL(entry.path, "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      const proof = challengeProof(token, url.searchParams.get("nonce"));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof }));
    }
    req.on("end", () => res.writeHead(200).end());
  };
}

const PROMPT = "SECRET-PROMPT-do-not-leak";
const EVENT = { cwd: process.cwd(), hook_event_name: "UserPromptSubmit", prompt: PROMPT };

/**
 * Run the installed-shape hook against a discovery dir of our own, with the
 * config dir override pointed at a temp tree — the real ~/.claude is never read
 * or written by any of this, on any platform.
 */
async function runHook(discovery: Record<string, unknown>) {
  const home = mkdtempSync(join(ROOT, "home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(discovery), "utf8");

  const child = spawn(process.execPath, [COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify(EVENT));
  await new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("exit", () => done());
  });
}

// A discovery file for a deck that is alive (our own pid) and machine-wide
// (empty workspace matches every cwd) — everything except identity is in order,
// so identity is the only thing under test.
const discoveryFor = (port: number, token: string) => ({
  pid: process.pid,
  port,
  workspace: "",
  token,
  startedAt: new Date().toISOString(),
});

describe("the hook and the deck derive the same proof", () => {
  // hook.js cannot import from src/ — it runs standalone once installed — so the
  // function is written twice. If the copies ever drift the deck goes silently
  // blind, which is precisely the failure this whole mechanism is meant to make
  // impossible to reach by accident.
  it("agrees on the proof for a token and nonce", () => {
    const token = randomBytes(32).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    expect(hook.challengeProof(token, nonce)).toBe(challengeProof(token, nonce));
  });

  it("gives a different answer for a different nonce or token", () => {
    const token = randomBytes(32).toString("hex");
    const a = hook.challengeProof(token, "nonce-a");
    expect(a).not.toBe(hook.challengeProof(token, "nonce-b"));
    expect(a).not.toBe(hook.challengeProof(randomBytes(32).toString("hex"), "nonce-a"));
  });

  it("gives every deck process a token of its own", () => {
    expect(hookToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a deck that proves itself", () => {
  it("still receives the event", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      await runHook(discoveryFor(deck.port, token));
    } finally {
      await deck.close();
    }

    const posts = deck.seen.filter(s => s.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/api/event");
    expect(JSON.parse(posts[0].body)).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: PROMPT,
      provider: "claude",
    });
  }, 10_000);

  it("is challenged on a fresh nonce every time", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      await runHook(discoveryFor(deck.port, token));
      await runHook(discoveryFor(deck.port, token));
    } finally {
      await deck.close();
    }

    const nonces = deck.seen
      .filter(s => s.path.startsWith("/api/hook-challenge"))
      .map(s => new URL(s.path, "http://127.0.0.1").searchParams.get("nonce"));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  }, 10_000);
});

describe("a stranger on the recorded port", () => {
  // The reported scenario: the deck died uncleanly, the pid was recycled onto
  // some other long-lived process, and the port now belongs to an unrelated
  // local service. Whatever that service does with the challenge, it must not
  // end up holding the user's prompt.
  const strangers: Array<[string, (req: IncomingMessage, res: ServerResponse) => void]> = [
    ["one that knows nothing of the deck's API", (_req, res) => {
      res.writeHead(404).end("not found");
    }],
    ["one that answers with a proof it guessed", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof: randomBytes(32).toString("hex") }));
    }],
    ["one that echoes whatever it is asked for", (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof: req.url }));
    }],
    ["one that answers with a flood of data", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`{"proof":"${"a".repeat(200_000)}"}`);
    }],
    ["one that accepts the connection and says nothing", () => { /* hangs until the hook gives up */ }],
  ];

  for (const [what, handler] of strangers) {
    it(`gets the challenge and nothing else — ${what}`, async () => {
      const stranger = await listener(handler);
      try {
        // The token in the file belongs to the deck that died; the stranger has
        // never seen it.
        await runHook(discoveryFor(stranger.port, randomBytes(32).toString("hex")));
      } finally {
        await stranger.close();
      }

      expect(stranger.seen.length).toBeGreaterThan(0);
      expect(stranger.seen.every(s => s.method === "GET")).toBe(true);
      expect(stranger.seen.every(s => s.path.startsWith("/api/hook-challenge"))).toBe(true);
      const said = JSON.stringify(stranger.seen);
      expect(said).not.toContain(PROMPT);
      expect(said).not.toContain("UserPromptSubmit");
    }, 10_000);
  }
});

describe("a discovery file with no token at all", () => {
  // Written by a deck from before the handshake existed — or forged by hand.
  // Either way the port cannot be authenticated, so it is not contacted: that
  // deck writes a token into its file the moment it restarts.
  it("is not contacted", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      const { token: _dropped, ...untokened } = discoveryFor(deck.port, token);
      await runHook(untokened);
      await runHook({ ...untokened, token: "" });
    } finally {
      await deck.close();
    }
    expect(deck.seen).toHaveLength(0);
  }, 10_000);
});
