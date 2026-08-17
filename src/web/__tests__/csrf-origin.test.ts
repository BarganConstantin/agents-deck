// The deck's mutating POSTs used to run for anybody who could reach them, and
// on 127.0.0.1 that is every page the user's browser has open: a cross-site
// `fetch` with a CORS-safelisted `Content-Type: text/plain` sends no preflight,
// so a merely-visited page could remove a Claude account, import one, switch
// the live account, start a global npm upgrade or truncate the event log. These
// pin the gate that now stands in front of the routing table — and, just as
// importantly, pin that hook/hook.js still gets through, because it POSTs from
// a plain Node process that sends no Origin header at all.
//
// That gate asks whether a PAGE chose the request. It never asked who the
// caller is, and a request carrying neither header was waved through on the
// reasoning that a process able to POST here can already run anything as the
// user — true on a single-user laptop, false for the other accounts on a shared
// box, and false for a sandboxed subprocess allowed loopback egress. So
// `curl -XPOST localhost:4317/api/claude-accounts/admin -d '{"action":"share"}'`
// answered with the account's live OAuth refresh token in the clear. The second
// half of this file pins the credential that mutations now require.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched. The
// import used to be static, which read the real one.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-csrf-origin-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
// POST /api/upgrade is one of the routes under test and its handler starts a
// global `npm i -g`. This is what makes it decline before spawning anything, so
// the test measures the gate and never the installer.
process.env.AGENTS_DECK_NO_INSTALL = "1";
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { isTrustedMutation, startServer, hookToken, challengeProof } = await import("../../server/index.mjs");

const HOST = "127.0.0.1:4317";

describe("isTrustedMutation", () => {
  it("lets the deck's own UI through", () => {
    // Browsers send Origin on same-origin POSTs too, so the UI arrives with
    // both headers filled in and both agreeing.
    expect(isTrustedMutation({
      origin: "http://127.0.0.1:4317", host: HOST, secFetchSite: "same-origin",
    })).toBe(true);
    // Same deck, reached as localhost — the Host header follows the URL bar.
    expect(isTrustedMutation({
      origin: "http://localhost:4317", host: "localhost:4317", secFetchSite: "same-origin",
    })).toBe(true);
    // Older Safari sends no Sec-Fetch-Site; Origin alone still has to match.
    expect(isTrustedMutation({ origin: "http://127.0.0.1:4317", host: HOST })).toBe(true);
  });

  it("lets a non-browser client with no Origin through", () => {
    // hook/hook.js is a bare http.request from the user's own machine. It sends
    // no Origin and no fetch metadata, and it has no ambient authority to abuse.
    expect(isTrustedMutation({ host: HOST })).toBe(true);
    expect(isTrustedMutation({ origin: undefined, host: HOST, secFetchSite: undefined })).toBe(true);
    expect(isTrustedMutation({ origin: "", host: HOST })).toBe(true);
    expect(isTrustedMutation()).toBe(true);
  });

  it("refuses a cross-site page, whichever signal gives it away", () => {
    expect(isTrustedMutation({
      origin: "https://evil.example", host: HOST, secFetchSite: "cross-site",
    })).toBe(false);
    // Sec-Fetch-Site alone is enough, even if the Origin were somehow absent.
    expect(isTrustedMutation({ host: HOST, secFetchSite: "cross-site" })).toBe(false);
    expect(isTrustedMutation({ host: HOST, secFetchSite: "same-site" })).toBe(false);
    // And Origin alone is enough on a browser that sends no fetch metadata.
    expect(isTrustedMutation({ origin: "https://evil.example", host: HOST })).toBe(false);
  });

  it("refuses another server on the same loopback address", () => {
    // A page served from http://localhost:8000 is as cross-origin as evil.com;
    // the port is part of the origin and the browser fills Host from the URL it
    // is posting to, so the two can never be made to agree.
    expect(isTrustedMutation({ origin: "http://localhost:8000", host: "localhost:4317" })).toBe(false);
    expect(isTrustedMutation({ origin: "http://127.0.0.1:8000", host: HOST })).toBe(false);
    // Scheme differs, host matches — still a different origin's port.
    expect(isTrustedMutation({ origin: "https://127.0.0.1:8443", host: HOST })).toBe(false);
  });

  it("refuses the opaque null origin", () => {
    // A sandboxed iframe or a data: URL posts with `Origin: null`. It parses as
    // nothing and must not be mistaken for a client that sent no Origin.
    expect(isTrustedMutation({ origin: "null", host: HOST })).toBe(false);
    expect(isTrustedMutation({ origin: "null", host: HOST, secFetchSite: "cross-site" })).toBe(false);
  });

  it("reads the header values as they actually arrive", () => {
    // Sec-Fetch-Site is lowercase on the wire but compared case-insensitively,
    // and `none` is a user-typed navigation, which no page can produce.
    expect(isTrustedMutation({ origin: "http://127.0.0.1:4317", host: HOST, secFetchSite: "None" })).toBe(true);
    expect(isTrustedMutation({ origin: "HTTP://127.0.0.1:4317", host: "127.0.0.1:4317" })).toBe(true);
    // Default ports are spelled both ways depending on the client. (This pair
    // used to be spelled with a `deck.local` host, which is precisely the
    // rebindable shape csrf-loopback-host.test.ts now refuses.)
    expect(isTrustedMutation({ origin: "http://localhost", host: "localhost:80" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://localhost:80", host: "localhost" })).toBe(true);
    // IPv6 loopback keeps its brackets on both sides.
    expect(isTrustedMutation({ origin: "http://[::1]:4317", host: "[::1]:4317" })).toBe(true);
    // An Origin with nothing to compare against is not a match.
    expect(isTrustedMutation({ origin: "http://127.0.0.1:4317", host: "" })).toBe(false);
  });
});

describe("mutations require the deck's own authority", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    });
    for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTS_DECK_NO_INSTALL"]) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    rmSync(DIR, { recursive: true, force: true });
  });

  function post(path: string, { headers = {}, body = "" }: { headers?: Record<string, string>; body?: string } = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // Every protected route, each with a body its handler refuses on its own
  // terms. `cleared` is the status that says the credential got past the gate
  // and the handler then answered for itself — deliberately not a success,
  // because succeeding at `share` would export a real account and succeeding at
  // `upgrade` would install a package over the machine running the tests.
  const PROTECTED = [
    { path: "/api/claude-accounts/admin", body: '{"action":"__probe__"}', cleared: 400 },  // unknown_action
    { path: "/api/cswap-auto", body: '{"action":"__probe__"}', cleared: 400 },             // unknown_action
    { path: "/api/claude-accounts/switch", body: "not json", cleared: 400 },               // bad_request
    { path: "/api/sound-hook", body: "not json", cleared: 400 },                           // bad_request
    { path: "/api/upgrade", body: "", cleared: 409 },                                      // declines to install
    { path: "/api/restart", body: "", cleared: 501 },                                      // unsupervised
    { path: "/api/clear", body: "", cleared: 200 },                                        // genuinely runs
  ];

  it("refuses a caller that presents nothing at all", async () => {
    // The report's own reproduction, on every route it reaches. This is a plain
    // local POST: no Origin, no fetch metadata, no token.
    for (const { path, body } of PROTECTED) {
      expect(await post(path, { body }), `${path} acted for an unauthenticated caller`).toBe(401);
    }
  });

  it("accepts the deck's token, raw or as a challenge proof", async () => {
    for (const { path, body, cleared } of PROTECTED) {
      expect(await post(path, { body, headers: { "x-ccdeck-token": hookToken() } }), path).toBe(cleared);
    }
    // The hashed form hook/hook.js already speaks. The nonce is the caller's,
    // so the same token yields a different proof every time.
    for (const { path, body, cleared } of PROTECTED) {
      const nonce = `n-${path}`;
      const proof = `${nonce}:${challengeProof(hookToken(), nonce)}`;
      expect(await post(path, { body, headers: { "x-ccdeck-proof": proof } }), path).toBe(cleared);
    }
  });

  it("accepts the deck's own page", async () => {
    // What the browser actually sends: Origin on every POST including a
    // same-origin one, fetch metadata saying same-origin, and a Host the
    // browser filled in from the URL bar.
    const ui = {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    };
    for (const { path, body, cleared } of PROTECTED) {
      expect(await post(path, { body, headers: ui }), path).toBe(cleared);
    }
    // And under `npm run dev:web`, where vite serves the page on 5174 and
    // proxies /api here with the browser's headers carried through.
    const viteProxied = { Host: "127.0.0.1:5174", Origin: "http://127.0.0.1:5174", "Sec-Fetch-Site": "same-origin" };
    expect(await post("/api/clear", { headers: viteProxied })).toBe(200);
  });

  it("refuses a credential that is merely the right shape", async () => {
    const probe = { path: "/api/claude-accounts/admin", body: '{"action":"__probe__"}' };
    const nonce = "n";
    for (const headers of [
      { "x-ccdeck-token": "0".repeat(64) },                                // right length, wrong bytes
      { "x-ccdeck-token": "" },
      { "x-ccdeck-token": hookToken().slice(0, -1) },                      // one byte short
      { "x-ccdeck-proof": challengeProof(hookToken(), nonce) },            // no nonce to check it against
      { "x-ccdeck-proof": `${nonce}:` },
      { "x-ccdeck-proof": `${nonce}:${challengeProof(hookToken(), "other")}` }, // proof of another nonce
      { "x-ccdeck-proof": `${nonce}:${challengeProof("0".repeat(64), nonce)}` }, // proof of another token
      { "x-ccdeck-proof": `${"n".repeat(300)}:${challengeProof(hookToken(), "n".repeat(300))}` }, // nonce past the cap
    ]) {
      expect(await post(probe.path, { body: probe.body, headers }), JSON.stringify(headers)).toBe(401);
    }
  });

  it("keeps the hook's ingest open, because the hook is not ours to upgrade", async () => {
    // hook/hook.js lives in the user's ~/.claude and is loaded by whatever
    // session is already running. A credential here would silence every session
    // whose hook predates this change until each one is reinstalled — and the
    // route carries no credential and destroys nothing.
    const body = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "" });
    expect(await post("/api/event", { body })).toBe(200);
  });

  it("answers the cross-site page before it ever asks who it is", async () => {
    // Order matters only for the error the caller sees, but that error is what
    // a reader debugging this will go on: a page is turned away as a page.
    const rebound = { Host: "attacker.example:4317", Origin: "http://attacker.example:4317", "Sec-Fetch-Site": "same-origin" };
    expect(await post("/api/clear", { headers: rebound })).toBe(403);
    expect(await post("/api/clear", { headers: { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" } })).toBe(403);
    // Even holding the token: a request a page chose is refused whoever else
    // may be behind it.
    expect(await post("/api/clear", { headers: { ...rebound, "x-ccdeck-token": hookToken() } })).toBe(403);
  });

  it("leaves reads alone — they answer to the gate above, not to this one", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/health", method: "GET" }, res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});
