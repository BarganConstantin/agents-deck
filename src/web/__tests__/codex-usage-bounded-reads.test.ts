// fetchCodexUsage used to fan a Promise.all out over every rollout file whose
// session started in the last 7 days, and each of those reads pulled the whole
// file into a Buffer and then copied it into a string. That made the peak
// working set a function of total weekly log volume rather than of anything
// bounded — and since the usage panel polls the endpoint every 60s against a
// 60s cache, the spike came back on nearly every poll. Opening every file at
// once also risked EMFILE, which readTokenSeries turns into a silent
// undercount. These tests pin the two caps and the line stitching the chunked
// reader needs to get right.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Counts how many file handles the module holds open at the same time and
// records every positional read. Hoisted because vi.mock factories run before
// the module body.
const probe = vi.hoisted(() => ({
  open: 0,
  peakOpen: 0,
  reads: [] as number[],
  reset() { this.open = 0; this.peakOpen = 0; this.reads.length = 0; },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const fh = await actual.open(...args);
      probe.open++;
      probe.peakOpen = Math.max(probe.peakOpen, probe.open);
      const read = fh.read.bind(fh) as (...a: unknown[]) => unknown;
      const close = fh.close.bind(fh);
      // A whole-file read shows up here as one read as long as the file; a
      // chunked one shows up as several bounded reads.
      Object.assign(fh, {
        read: (...readArgs: unknown[]) => {
          probe.reads.push(readArgs[2] as number);
          return read(...readArgs);
        },
        close: () => { probe.open--; return close(); },
      });
      return fh;
    },
  };
});

// Everything lives under this temp directory. CODEX_HOME is resolved at import
// time from the environment, and HOME/USERPROFILE are redirected as well so no
// fallback can reach the developer's real ~/.codex on any platform.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-usage-"));
const CODEX_HOME = join(DIR, "codex-home");
const SESSIONS = join(CODEX_HOME, "sessions");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;

// Every call below passes `force: true` — the same thing /api/codex-usage does
// for ?refresh=1 — which skips the 60s cache outright, so each case really does
// rescan the directory it just wrote.
// @ts-expect-error — .mjs server module, no types
const { fetchCodexUsage } = await import("../../server/codex-usage.mjs");

const restore = (key: "HOME" | "USERPROFILE" | "CODEX_HOME", was: string | undefined) => {
  if (was === undefined) delete process.env[key]; else process.env[key] = was;
};

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("CODEX_HOME", prevCodexHome);
  rmSync(DIR, { recursive: true, force: true });
});

// An hour ago: inside both the 5h and the 7d window.
const AT = new Date(Date.now() - 60 * 60 * 1000);

/** Rollout filenames carry the session start with dashes in the time part. */
function rolloutName(id: string): string {
  const [date, time] = AT.toISOString().slice(0, 19).split("T");
  return `rollout-${date}T${time.replace(/:/g, "-")}-${id}.jsonl`;
}

/** sessions/<year>/<month>/<day>, wiped so each test starts from nothing. */
function freshDayDir(): string {
  rmSync(SESSIONS, { recursive: true, force: true });
  const [y, m, d] = AT.toISOString().slice(0, 10).split("-");
  const dir = join(SESSIONS, y, m, d);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One token_count event. `total` is cumulative for the session so far. */
function tokenCount(total: number, filler = ""): string {
  return JSON.stringify({
    timestamp: AT.toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total,
          output_tokens: 0,
          cached_input_tokens: 0,
          total_tokens: total,
        },
      },
    },
    // Rollouts are mostly prompt and response text; this stands in for it.
    filler,
  }) + "\n";
}

describe("fetchCodexUsage over a week of rollout files", () => {
  it("keeps only a handful of files open at once and still counts them all", async () => {
    const dir = freshDayDir();
    const FILES = 24;
    for (let i = 0; i < FILES; i++) {
      writeFileSync(join(dir, rolloutName(`session-${String(i).padStart(2, "0")}`)), tokenCount(1000), "utf8");
    }
    probe.reset();

    const res = await fetchCodexUsage({ force: true });

    // Every file was read: a pool that quietly drops work is worse than an
    // unbounded one.
    expect(res.ok).toBe(true);
    expect(res.window7d.sessionCount).toBe(FILES);
    expect(res.window7d.totalTokens).toBe(FILES * 1000);
    expect(res.window5h.totalTokens).toBe(FILES * 1000);
    // The whole point: 24 files did not become 24 simultaneous handles.
    expect(probe.peakOpen).toBeGreaterThan(0);
    expect(probe.peakOpen).toBeLessThanOrEqual(8);
    // And nothing was left open afterwards.
    expect(probe.open).toBe(0);
  });

  it("reads a large rollout in bounded chunks instead of one whole-file gulp", async () => {
    const dir = freshDayDir();
    // ~1.5 MB in a single line, well past any sane chunk size.
    writeFileSync(join(dir, rolloutName("session-big")), tokenCount(2000, "x".repeat(1_500_000)), "utf8");
    probe.reset();

    const res = await fetchCodexUsage({ force: true });

    expect(res.ok).toBe(true);
    expect(res.window7d.totalTokens).toBe(2000);
    // Several reads, none of which pulls the file in one piece.
    expect(probe.reads.length).toBeGreaterThan(1);
    for (const length of probe.reads) expect(length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("folds every line of a multi-megabyte rollout exactly once", async () => {
    const dir = freshDayDir();
    // Many events, each padded with multi-byte text, so chunk boundaries fall
    // in the middle of a line — and of a character — over and over. The totals
    // are cumulative, so the answer is the last event's value: a reader that
    // loses or corrupts the tail of a chunk reports one of the earlier ones.
    const EVENTS = 40;
    let body = "";
    for (let i = 1; i <= EVENTS; i++) body += tokenCount(i * 100, "🙂".repeat(10_000));
    writeFileSync(join(dir, rolloutName("session-many")), body, "utf8");

    const res = await fetchCodexUsage({ force: true });

    expect(res.ok).toBe(true);
    expect(res.window7d.sessionCount).toBe(1);
    expect(res.window7d.totalTokens).toBe(EVENTS * 100);
  });

  it("still counts a rollout whose last line has no trailing newline", async () => {
    const dir = freshDayDir();
    // A session that is still being written to can end mid-flush.
    writeFileSync(join(dir, rolloutName("session-open")), tokenCount(700).trimEnd(), "utf8");

    const res = await fetchCodexUsage({ force: true });

    expect(res.ok).toBe(true);
    expect(res.window7d.totalTokens).toBe(700);
  });
});
