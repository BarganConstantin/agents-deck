// The dispatcher in src/server/index.mjs used to build its URL against
// `http://${req.headers.host}`. Node's HTTP parser hands that header through
// verbatim, so `Host: bad host` made `new URL` throw inside the request
// listener — an uncaughtException, worker exit 1, and a supervisor that takes
// the whole deck down with it. One crafted request, no canvas. These pin the
// two halves of the fix: the base is a constant, and nothing throws.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no types
import { requestUrl } from "../../server/index.mjs";

describe("requestUrl", () => {
  it("routes on the path and the query", () => {
    const url = requestUrl("/api/events?since=7");
    expect(url?.pathname).toBe("/api/events");
    expect(url?.searchParams.get("since")).toBe("7");
  });

  it("defaults a missing request target to the root", () => {
    expect(requestUrl(undefined)?.pathname).toBe("/");
  });

  it("anchors the URL to a constant base, never to the Host header", () => {
    // The authority half is what the header used to poison. Only the path and
    // the query are read downstream, so it stays a constant no client can
    // reach — the header is not even an argument here any more.
    expect(requestUrl("/api/health")?.host).toBe("localhost");
  });

  it("answers null instead of throwing on a target the URL parser rejects", () => {
    // `GET // HTTP/1.1` is accepted by Node's parser and arrives as "//",
    // which throws ERR_INVALID_URL against any base at all — so this crashed
    // the server even without a malformed Host.
    for (const target of ["//", "//bad host/x", "http://bad host/x", "//[::1"]) {
      expect(requestUrl(target), target).toBeNull();
    }
  });
});
