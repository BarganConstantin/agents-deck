// Model, usage and context enrichment all read the same transcript JSONL, and
// each one used to re-read and re-parse the whole file every couple of
// seconds. Transcripts reach tens of MB, so the scan cost grew with the
// session and ran as one synchronous block that stalled SSE broadcasts and
// event ingest. The scanners now keep a byte cursor per file and fold only the
// appended lines into running state. These pin the three things that can go
// wrong with a cursor: bytes counted twice, bytes re-read after they were
// already folded, and a cursor left pointing past the end of a file that
// shrank.
import { describe, it, expect, afterAll } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nothing here goes near the real ~/.claude — every path is inside this temp
// directory — but the server module resolves CODEX_HOME from the home
// directory at import time, so point that at the temp dir too.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-transcript-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;

// @ts-expect-error — .mjs server module, no types
const { readModelFromTranscript, readUsageFromTranscript, readContextFromTranscript } =
  await import("../../server/index.mjs");

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  rmSync(DIR, { recursive: true, force: true });
});

/** One transcript line. Transcripts are JSONL: one object, one "\n". */
function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function assistant(inputTokens: number, outputTokens: number, model = "claude-opus-4-7") {
  return line({
    type: "assistant",
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

describe("incremental transcript usage", () => {
  it("adds up appended blocks without counting the old ones again", async () => {
    const path = join(DIR, "usage.jsonl");
    writeFileSync(path, assistant(10, 1));

    expect(await readUsageFromTranscript(path)).toEqual({
      input_tokens: 10, output_tokens: 1,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });

    // A second pass with nothing appended must be a no-op, not a re-count.
    expect(await readUsageFromTranscript(path)).toEqual({
      input_tokens: 10, output_tokens: 1,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });

    appendFileSync(path, assistant(5, 2));
    expect(await readUsageFromTranscript(path)).toEqual({
      input_tokens: 15, output_tokens: 3,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });
  });

  it("counts concurrent readers of the same file once", async () => {
    const path = join(DIR, "concurrent.jsonl");
    writeFileSync(path, assistant(40, 4));
    // Model, usage and context all fire off the same hook event. If they each
    // read the appended bytes the totals would triple.
    const [, usage] = await Promise.all([
      readModelFromTranscript(path),
      readUsageFromTranscript(path),
      readContextFromTranscript(path),
    ]);
    expect(usage.input_tokens).toBe(40);
    expect(usage.output_tokens).toBe(4);
  });

  it("reads only the bytes appended since the last pass", async () => {
    const path = join(DIR, "tail.jsonl");
    const first = assistant(100, 0);
    writeFileSync(path, first);
    expect((await readUsageFromTranscript(path)).input_tokens).toBe(100);

    // Rewrite the already-folded prefix with a different value of the same
    // byte length and append a new line. A scanner that re-read the file from
    // byte 0 would report 999 + 7; one that reads only the tail keeps the 100
    // it folded and adds 7.
    const rewritten = first.replace('"input_tokens":100', '"input_tokens":999');
    expect(rewritten.length).toBe(first.length);
    writeFileSync(path, rewritten + assistant(7, 0));

    expect((await readUsageFromTranscript(path)).input_tokens).toBe(107);
  });

  it("starts over when the file shrank", async () => {
    const path = join(DIR, "rotated.jsonl");
    writeFileSync(path, assistant(10, 0) + assistant(20, 0) + assistant(30, 0));
    expect((await readUsageFromTranscript(path)).input_tokens).toBe(60);

    // Truncated / rotated / replaced: the cursor now points past the end, so
    // the tail it would read is meaningless. Rescan from byte 0 instead.
    writeFileSync(path, assistant(7, 0));
    expect((await readUsageFromTranscript(path)).input_tokens).toBe(7);
  });

  it("holds back a partially written last line until its newline lands", async () => {
    const path = join(DIR, "partial.jsonl");
    writeFileSync(path, assistant(10, 0));
    expect((await readUsageFromTranscript(path)).input_tokens).toBe(10);

    const torn = assistant(25, 0);
    appendFileSync(path, torn.slice(0, 20));            // no newline yet
    expect((await readUsageFromTranscript(path)).input_tokens).toBe(10);

    appendFileSync(path, torn.slice(20));               // rest of the line
    expect((await readUsageFromTranscript(path)).input_tokens).toBe(35);
  });
});

describe("incremental transcript model", () => {
  it("picks up a model that only appears in a later append", async () => {
    const path = join(DIR, "model.jsonl");
    writeFileSync(path, line({ type: "user", message: { role: "user", content: "hi" } }));
    expect(await readModelFromTranscript(path)).toBeNull();

    appendFileSync(path, assistant(1, 1, "claude-opus-4-7"));
    expect((await readModelFromTranscript(path)).rootModel).toBe("claude-opus-4-7");

    // Later lines win — a session can switch model mid-flight.
    appendFileSync(path, assistant(1, 1, "claude-haiku-4-5"));
    expect((await readModelFromTranscript(path)).rootModel).toBe("claude-haiku-4-5");
  });

  it("keeps legacy sidechain models out of the root slot", async () => {
    const path = join(DIR, "sidechain.jsonl");
    writeFileSync(path, assistant(1, 1, "claude-opus-4-7"));
    appendFileSync(path, line({
      type: "assistant",
      isSidechain: true,
      parentToolUseID: "toolu_42",
      message: { model: "claude-haiku-4-5" },
    }));

    const result = await readModelFromTranscript(path);
    expect(result.rootModel).toBe("claude-opus-4-7");
    expect(result.subagentModels).toEqual({ toolu_42: "claude-haiku-4-5" });
  });
});

describe("incremental transcript context", () => {
  it("accumulates counts across appends", async () => {
    const path = join(DIR, "context.jsonl");
    writeFileSync(path, line({ type: "user", message: { role: "user", content: "one" } }));
    expect(await readContextFromTranscript(path)).toMatchObject({ msgsUser: 1, msgsAssistant: 0 });

    appendFileSync(path, assistant(500, 10));
    expect(await readContextFromTranscript(path)).toMatchObject({
      msgsUser: 1, msgsAssistant: 1, currentContextTokens: 500,
    });
  });

  it("drops everything before a /clear that arrives in a later append", async () => {
    const path = join(DIR, "cleared.jsonl");
    writeFileSync(path, line({ type: "user", message: { role: "user", content: "one" } }) + assistant(500, 10));
    expect(await readContextFromTranscript(path)).toMatchObject({ msgsUser: 1, currentContextTokens: 500 });

    // CC writes the marker into the transcript and resets its window to ~0
    // while the file keeps growing.
    appendFileSync(path, line({
      type: "user",
      message: { role: "user", content: "<command-name>/clear</command-name>" },
    }));
    expect(await readContextFromTranscript(path)).toMatchObject({
      msgsUser: 0, msgsAssistant: 0, currentContextTokens: 0,
    });

    appendFileSync(path, line({ type: "user", message: { role: "user", content: "fresh" } }));
    appendFileSync(path, assistant(20, 1));
    expect(await readContextFromTranscript(path)).toMatchObject({
      msgsUser: 1, msgsAssistant: 1, currentContextTokens: 20,
    });
  });
});
