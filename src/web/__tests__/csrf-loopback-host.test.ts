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
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
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
const { isTrustedMutation } = await import("../../server/index.mjs");

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
