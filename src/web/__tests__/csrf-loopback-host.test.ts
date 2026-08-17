// The mutation gate used to ask only that Origin and Host agree. Both are
// filled in from the URL the page was served from, so DNS rebinding makes them
// agree on a name the attacker owns: the victim opens http://attacker.example
// on the deck's port, the attacker re-points that record at 127.0.0.1, and the
// next POST arrives with Host: attacker.example:4317, a matching Origin and
// Sec-Fetch-Site: same-origin — fetch metadata is derived from the origin tuple,
// never from the address the socket landed on. The gate passed it, and because
// the browser calls the reply same-origin too, the page could read the body:
// POST /api/claude-accounts/admin {action:'share'} answers with the account's
// exported OAuth credentials, and the same hole reaches account remove/import,
// switch, /api/upgrade's global npm install, /api/restart and /api/clear.
//
// The Host must now name a loopback identity as well. These pin the attack
// itself, the loopback spellings that still have to work, and the one client
// that is allowed a Host of any shape because it is not a browser at all.
//
// The gate was then applied to mutations only, on the reasoning that a
// cross-site page cannot read a loopback reply. A REBOUND page can: the browser
// resolved the attacker's name to 127.0.0.1 itself, so it calls the answer
// same-origin and hands the body over. Every read was open to the same attack,
// and the reads are the interesting half — GET /api/events is the whole ring
// buffer, prompt text and Bash command lines and file contents included. The
// second half of this file pins the read gate and pins it at the routing table,
// where the routes actually live.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-csrf-loopback-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { isTrustedMutation, isTrustedRead, startServer } = await import("../../server/index.mjs");

const HOST = "127.0.0.1:4317";

describe("isTrustedMutation under DNS rebinding", () => {
  it("refuses a rebound page whose Origin and Host agree on a name the attacker owns", () => {
    // Every header here is self-consistent and every one is attacker-chosen.
    // Equality alone cannot tell this apart from the deck's own UI.
    expect(isTrustedMutation({
      origin: "http://attacker.example:4317", host: "attacker.example:4317", secFetchSite: "same-origin",
    })).toBe(false);
    // `none` is what a top-level navigation reports, so a rebound form POST
    // gets no further than a rebound fetch.
    expect(isTrustedMutation({
      origin: "http://attacker.example:4317", host: "attacker.example:4317", secFetchSite: "none",
    })).toBe(false);
    // Older Safari sends no fetch metadata at all, which is the shape the
    // Origin/Host comparison exists to cover — it must not be the way in.
    expect(isTrustedMutation({
      origin: "http://attacker.example:4317", host: "attacker.example:4317",
    })).toBe(false);
    // A subdomain of a name that reads as local is still a name in DNS.
    expect(isTrustedMutation({
      origin: "http://localhost.attacker.example:4317", host: "localhost.attacker.example:4317",
    })).toBe(false);
    expect(isTrustedMutation({
      origin: "http://127.0.0.1.attacker.example:4317", host: "127.0.0.1.attacker.example:4317",
    })).toBe(false);
  });

  it("refuses a browser request addressed to an address that is not this machine", () => {
    // A deck reached over the LAN, or through a proxy that keeps its own name
    // in the Host header, has no loopback binding left to authorize it.
    expect(isTrustedMutation({ origin: "http://192.168.1.5:4317", host: "192.168.1.5:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedMutation({ origin: "https://deck.example.com", host: "deck.example.com" })).toBe(false);
    expect(isTrustedMutation({ origin: "http://[fe80::1]:4317", host: "[fe80::1]:4317" })).toBe(false);
    // 0.0.0.0 is the unspecified address, not a loopback one, even though some
    // platforms let a browser reach a local listener through it.
    expect(isTrustedMutation({ origin: "http://0.0.0.0:4317", host: "0.0.0.0:4317" })).toBe(false);
  });

  it("still lets the deck's own UI through on every loopback spelling", () => {
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: HOST, secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://localhost:4317", host: "localhost:4317", secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://[::1]:4317", host: "[::1]:4317", secFetchSite: "same-origin" })).toBe(true);
    // The whole 127.0.0.0/8 is this machine: a second deck parked on 127.0.0.2
    // is as local as the first, and Windows, macOS and Linux all route it home.
    expect(isTrustedMutation({ origin: "http://127.0.0.2:4317", host: "127.0.0.2:4317" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://127.255.255.254:4317", host: "127.255.255.254:4317" })).toBe(true);
  });

  it("lets the hook through whatever Host it names", () => {
    // hook/hook.js is a bare Node http.request: no Origin, no fetch metadata,
    // and no ambient authority for a page to borrow. Rebinding is a browser
    // attack, so a client that is not a browser is not measured against it —
    // including when it addresses the deck through a name of its own.
    expect(isTrustedMutation({ host: "deck.local:4317" })).toBe(true);
    expect(isTrustedMutation({ host: HOST })).toBe(true);
    expect(isTrustedMutation()).toBe(true);
  });

  it("refuses a browser that sends fetch metadata but no Origin", () => {
    // Every browser sends Origin on a POST, but the gate must not rest on that:
    // metadata present means a page sent this, so the Host is measured too.
    expect(isTrustedMutation({ host: "attacker.example:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedMutation({ host: HOST, secFetchSite: "same-origin" })).toBe(true);
  });

  it("reads the Host header as it actually arrives", () => {
    // Case and surrounding whitespace are the client's business, not a signal.
    expect(isTrustedMutation({ origin: "http://localhost:4317", host: "LOCALHOST:4317" })).toBe(true);
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: ` ${HOST} ` })).toBe(true);
    // The long form of ::1 is the same address written out, and a browser that
    // sent no Origin has nothing else for it to be compared against.
    expect(isTrustedMutation({ host: "[0:0:0:0:0:0:0:1]:4317", secFetchSite: "same-origin" })).toBe(true);
    // Userinfo and a path have no business in a Host header, and both would
    // otherwise parse to a loopback hostname while naming something else.
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: `attacker.example@${HOST}` })).toBe(false);
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: `${HOST}/attacker.example` })).toBe(false);
  });
});

describe("isTrustedRead under DNS rebinding", () => {
  it("refuses a rebound page's reads", () => {
    // The same self-consistent, entirely attacker-chosen header set as above.
    // A read carrying it used to be answered in full.
    expect(isTrustedRead({ host: "attacker.example:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedRead({
      origin: "http://attacker.example:4317", host: "attacker.example:4317", secFetchSite: "same-origin",
    })).toBe(false);
    // A GET sends no Origin unless it is a CORS request, so fetch metadata is
    // usually the only thing marking a read as a page's. Either one is enough.
    expect(isTrustedRead({ origin: "http://attacker.example:4317", host: "attacker.example:4317" })).toBe(false);
    expect(isTrustedRead({ host: "localhost.attacker.example:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedRead({ host: "192.168.1.5:4317", secFetchSite: "same-origin" })).toBe(false);
  });

  it("lets the deck's own page read on every loopback spelling", () => {
    expect(isTrustedRead({ host: HOST, secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ origin: `http://${HOST}`, host: HOST, secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ host: "localhost:4317", secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ host: "[::1]:4317", secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ host: "127.0.0.2:4317", secFetchSite: "same-origin" })).toBe(true);
  });

  it("lets a client that is not a browser read whatever Host it names", () => {
    // hook/hook.js again: no Origin, no fetch metadata, nothing to rebind.
    expect(isTrustedRead({ host: "deck.local:4317" })).toBe(true);
    expect(isTrustedRead({ host: HOST })).toBe(true);
    expect(isTrustedRead({ origin: "", secFetchSite: "" })).toBe(true);
    expect(isTrustedRead()).toBe(true);
  });

  it("does not borrow the mutation gate's Sec-Fetch-Site test", () => {
    // Deliberate, and the reason this is a separate predicate. A `cross-site`
    // read of a loopback address is an ordinary top-level navigation — a link
    // to the deck clicked on some other page — and the document it loads is the
    // deck's own UI on the deck's own origin. Rebinding does not travel that
    // way: a rebound page's own requests report `same-origin`, and what gives
    // it away is the Host.
    expect(isTrustedRead({ host: HOST, secFetchSite: "cross-site" })).toBe(true);
    expect(isTrustedRead({ host: HOST, secFetchSite: "same-site" })).toBe(true);
    expect(isTrustedMutation({ host: HOST, secFetchSite: "cross-site" })).toBe(false);
  });
});

// Every named route, at the routing table rather than at the predicate. The
// gate is one line in front of the table, so a route escaping it would be a
// routing bug rather than a logic bug and the unit tests above would not see it.
describe("the rebinding gate in front of the routing table", () => {
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
  });

  function call(path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
  }

  // Node's global fetch cannot express this: undici treats Host as a forbidden
  // header and silently drops it, so the request would arrive at the real
  // address and pass. node:http sends what it is given.
  const rebound = {
    Host: "attacker.example:4317",
    Origin: "http://attacker.example:4317",
    "Sec-Fetch-Site": "same-origin",
  };

  const READS = [
    "/api/events?since=0",        // the whole ring buffer
    "/api/claude-accounts",       // account emails, org names, aliases
    "/api/claude-accounts/login", // a live OAuth authorize URL
    "/api/health",                // the absolute workspace path
    "/api/sound-hook",            // the user's own hook command lines
    "/api/hook-challenge?nonce=n", // a proof oracle for the deck's token
    "/api/version",
    "/api/quota",
    "/api/ccusage",
    "/api/codex-usage",
    "/api/codex-quota",
    "/api/cswap-auto",
    "/events",                    // the same buffer, live
    "/",                          // and the page itself
    "/assets/app.js",
  ];

  it("refuses every read from a rebound page", async () => {
    for (const path of READS) {
      expect(await call(path, rebound), `${path} answered a rebound page`).toBe(403);
    }
  });

  it("still answers the deck's own page", async () => {
    const ui = {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    };
    expect(await call("/api/health", ui)).toBe(200);
    expect(await call("/api/events?since=0", ui)).toBe(200);
    // The Host the browser sends follows the URL bar, not the socket.
    expect(await call("/api/health", { ...ui, Host: "localhost:4317", Origin: "http://localhost:4317" })).toBe(200);
  });

  it("still answers a client that sends no browser headers at all", async () => {
    // hook/hook.js, and the deck's own tooling. This is the shape that must not
    // be measured against a rebinding attack it cannot be part of.
    expect(await call("/api/health", {})).toBe(200);
    expect(await call("/api/health", { Host: "deck.local:4317" })).toBe(200);
  });
});
