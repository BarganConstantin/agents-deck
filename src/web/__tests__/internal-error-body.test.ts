// The catch-all around every request handler used to put the thrown error's
// own message into the 500 body, on the theory that a server bound to
// 127.0.0.1 is only ever read by the user's own tab. A DNS-rebound page
// reaches a loopback server as same-origin and reads that body, and the errors
// that reach this path carry absolute paths out of the user's home directory —
// a failed rename of ~/.claude/settings.json is one throw away from
// POST /api/sound-hook. These pin both halves: the wire says nothing, stderr
// still says everything.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no types
import { sendInternalError } from "../../server/index.mjs";

/** Just enough of a ServerResponse for the error path to run against. */
function fakeRes(headersSent = false) {
  const res = {
    headersSent,
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) res.body = chunk;
      res.ended = true;
    },
  };
  return res;
}

// A realistic throw: an absolute path through the user's home directory, on
// every platform the deck runs on.
const SECRETS = [
  "ENOENT: no such file or directory, rename '/Users/ada/.claude/settings.json'",
  "ENOENT: no such file or directory, rename '/home/ada/.claude/settings.json'",
  "EPERM: operation not permitted, rename 'C:\\Users\\ada\\.claude\\settings.json'",
];

describe("sendInternalError", () => {
  it("answers a generic 500 with no error detail in the body", () => {
    for (const secret of SECRETS) {
      const res = fakeRes();
      sendInternalError(res, new Error(secret), () => {});
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "internal error" });
      // Nothing of the message survives — not the path, not the errno, not a
      // truncated prefix of either.
      expect(res.body).not.toContain(".claude");
      expect(res.body).not.toContain("ENOENT");
      expect(res.body).not.toContain("EPERM");
      expect(res.body).not.toContain("ada");
      expect(res.ended).toBe(true);
    }
  });

  it("still hands the operator the whole error on stderr", () => {
    // Withholding it from the client is not the same as swallowing it: a
    // ReferenceError in the import path once spent a release looking like a
    // rejected share, and this log line is what makes that findable.
    const logged: unknown[][] = [];
    const err = new Error(SECRETS[0]);
    sendInternalError(fakeRes(), err, (...args: unknown[]) => { logged.push(args); });
    expect(logged).toHaveLength(1);
    // The error object itself, so the console prints its stack too.
    expect(logged[0][1]).toBe(err);
    expect(String(logged[0][1])).toContain("/Users/ada/.claude/settings.json");
  });

  it("logs a non-Error throw as well, and still says nothing on the wire", () => {
    const logged: unknown[][] = [];
    const res = fakeRes();
    sendInternalError(res, "spawn /opt/homebrew/bin/claude ENOENT", (...a: unknown[]) => { logged.push(a); });
    expect(logged[0][1]).toBe("spawn /opt/homebrew/bin/claude ENOENT");
    expect(JSON.parse(res.body)).toEqual({ error: "internal error" });
  });

  it("closes a response whose head already went out instead of writing twice", () => {
    // A handler that had already started streaming (SSE, a static file) cannot
    // take a status line any more; the connection just has to end.
    const res = fakeRes(true);
    sendInternalError(res, new Error(SECRETS[0]), () => {});
    expect(res.status).toBe(0);
    expect(res.body).toBe("");
    expect(res.ended).toBe(true);
  });
});
