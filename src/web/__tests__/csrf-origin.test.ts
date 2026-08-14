// The deck's mutating POSTs used to run for anybody who could reach them, and
// on 127.0.0.1 that is every page the user's browser has open: a cross-site
// `fetch` with a CORS-safelisted `Content-Type: text/plain` sends no preflight,
// so a merely-visited page could remove a Claude account, import one, switch
// the live account, start a global npm upgrade or truncate the event log. These
// pin the gate that now stands in front of the routing table — and, just as
// importantly, pin that hook/hook.js still gets through, because it POSTs from
// a plain Node process that sends no Origin header at all.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no types
import { isTrustedMutation } from "../../server/index.mjs";

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
    // Default ports are spelled both ways depending on the client.
    expect(isTrustedMutation({ origin: "http://deck.local", host: "deck.local:80" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://deck.local:80", host: "deck.local" })).toBe(true);
    // IPv6 loopback keeps its brackets on both sides.
    expect(isTrustedMutation({ origin: "http://[::1]:4317", host: "[::1]:4317" })).toBe(true);
    // An Origin with nothing to compare against is not a match.
    expect(isTrustedMutation({ origin: "http://127.0.0.1:4317", host: "" })).toBe(false);
  });
});
