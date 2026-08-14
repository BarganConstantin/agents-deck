// The per-path transcript scan cursors live in a map capped at 256 paths, and
// the prune ran before the entry a scan had just inserted was stamped. Its
// stamp was still 0 — the smallest in the map — so the newcomer was always the
// one deleted, in the same tick it was created. A deck that had seen 256
// distinct transcripts (one per session, plus one per agent-*.jsonl) froze on
// the first 256 paths for the rest of the process: every transcript after that
// re-read its whole JSONL from byte 0 on every ~2.5s pass instead of folding
// only the appended bytes, which is the O(n)-per-pass synchronous stall the
// cursor exists to remove. Totals stayed correct, so nothing but the cost of a
// long-lived deck ever showed it.
//
// These pin what the cache does once it is over the cap: the newcomer keeps
// its cursor, the path nobody has scanned in a while is the one that goes, and
// scanning a path again keeps it alive.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every path below lives inside this temp directory, and the server module
// resolves the Claude and Codex config directories from the home directory at
// import time — so all four point at the sandbox BEFORE the dynamic import and
// no test here can reach the developer's real ~/.claude or ~/.codex on any
// platform.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-scan-lru-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { readUsageFromTranscript } = await import("../../server/index.mjs");

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

/** Every transcript this file touches, resolved under the sandbox or not at
 *  all. `join` normalises `..`, so a name that tried to climb out lands
 *  outside DIR and aborts the run rather than writing next to it. */
function transcript(name: string): string {
  const path = join(DIR, name);
  if (!path.startsWith(DIR)) throw new Error("refusing to run: transcript path escaped the sandbox");
  return path;
}

function assistant(inputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: inputTokens, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    },
  }) + "\n";
}

// Matches MAX_TRANSCRIPT_SCANS in src/server/index.mjs.
const CAP = 256;
const FIRST = assistant(100);
// Same byte length as FIRST, so a cursor parked at its end cannot tell the
// prefix changed — the trick transcript-incremental.test.ts already uses to
// tell a tail read from a full re-read.
const REWRITTEN = FIRST.replace('"input_tokens":100', '"input_tokens":999');
const APPENDED = assistant(7);
const CURSOR_KEPT = 107;   // 100 folded on the first pass + the appended 7
const FULL_REREAD = 1006;  // the rewritten 999 + the appended 7

/** Scan a transcript once, so the cache holds a cursor at its end. */
async function seenOnce(name: string): Promise<string> {
  const path = transcript(name);
  writeFileSync(path, FIRST);
  expect((await readUsageFromTranscript(path)).input_tokens).toBe(100);
  return path;
}

/** Rewrite the bytes the first pass folded, append one line, scan again, and
 *  return the total: CURSOR_KEPT if the entry survived, FULL_REREAD if it was
 *  evicted and the scanner started over from byte 0. */
async function totalAfterAppend(path: string): Promise<number> {
  writeFileSync(path, REWRITTEN + APPENDED);
  return (await readUsageFromTranscript(path)).input_tokens;
}

/** Scan `count` transcripts nothing will ever look at again, the way a deck
 *  accumulates dead session and agent-*.jsonl paths over days of uptime. */
async function flood(tag: string, count: number): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) paths.push(await seenOnce(`${tag}-${i}.jsonl`));
  return paths;
}

let filled: string[] = [];

beforeAll(async () => {
  expect(REWRITTEN.length).toBe(FIRST.length);
  filled = await flood("fill", CAP + 8);
});

describe("the transcript scan cache once it is over its cap", () => {
  it("keeps the cursor of a transcript first seen after the cache filled up", async () => {
    const path = await seenOnce("newcomer.jsonl");
    expect(await totalAfterAppend(path)).toBe(CURSOR_KEPT);
  });

  it("drops the transcript that has gone longest without a scan, not the newest one", async () => {
    // filled[0] was scanned before every other path and never again; the last
    // one flooded is the most recent use in the map.
    expect(await totalAfterAppend(filled[0])).toBe(FULL_REREAD);
    expect(await totalAfterAppend(filled[filled.length - 1])).toBe(CURSOR_KEPT);
  });

  it("keeps a transcript that is still being scanned while a cap's worth of new ones arrive", async () => {
    const veteran = await seenOnce("veteran.jsonl");
    // Enough new paths to put the veteran back at the head of the queue.
    await flood("wave-a", CAP - 1);
    // Scanning it again is a use, so it goes to the back and outlives another
    // full wave. A cache that only ordered by first insert would lose it here.
    expect((await readUsageFromTranscript(veteran)).input_tokens).toBe(100);
    await flood("wave-b", CAP - 1);
    expect(await totalAfterAppend(veteran)).toBe(CURSOR_KEPT);
  });
});
