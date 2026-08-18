// #475: a Claude Code session run against Bedrock or Mantle writes a model id
// with a provider namespace in front of it, and every model pattern in this
// codebase is `^`-anchored, so none of them matched and the deck showed those
// users no model, no context window and no cost.
//
// WHERE THE GROUND TRUTH COMES FROM. There is no Bedrock transcript on any
// machine this suite has run on — the ids below are not invented and not
// inferred from the docs either. They are read off Claude Code 2.1.234's own
// model catalog, which carries a `provider_ids` block per model:
//
//   {id:"claude-opus-4-5", provider_ids:{
//      first_party:"claude-opus-4-5-20251101",
//      bedrock:"us.anthropic.claude-opus-4-5-20251101-v1:0",
//      vertex:"claude-opus-4-5@20251101",
//      foundry:"claude-opus-4-5", …}}
//
// and a closed region list, `["us","eu","apac","jp","au","us-gov","global"]`,
// which is also the enum accepted by ANTHROPIC_BEDROCK_REGION_PREFIX. Vertex
// is in that block for a reason: the issue guessed at "region-suffixed" Vertex
// ids, and the CLI's own help text says the opposite in as many words —
// "Vertex model IDs take no prefix" — so the `@date` forms below are here to
// prove they were already priced and still are, not to be fixed.
//
// The file is deliberately in two halves. The second half is the fix. The FIRST
// half is the whole risk of the fix: thirty-odd rate rows, several of them
// prefixes of each other and separated only by anchoring plus list order, all
// of which now match against a string that has been rewritten before they see
// it. Every rate is pinned as a literal, and the RATES table is read out of the
// source so a row nobody thought to pin fails the sweep rather than passing it.
//
// Plain node — no DOM, no rendering. Every function here is pure except the
// server's transcript reader, which gets a temp file.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ratesForModel, contextWindowForModel, type ModelRates } from "../pricing";
import { bareModelId, VENDOR_PREFIX_RE } from "../model-id";
import { shortModel } from "../model-label";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

// Fixed clock. One row (Sonnet 5) is a function of the date, and a suite that
// read the wall clock would pin a different number in September than in August.
const NOW = Date.UTC(2026, 7, 18);          // 2026-08-18, inside Sonnet 5's intro
const AFTER_INTRO = Date.UTC(2026, 8, 5);   // 2026-09-05, after it

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ── half one: no existing answer changes ────────────────────────────────────

const A = (input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number): ModelRates =>
  ({ input, output, cacheRead, cacheWrite, cacheWrite1h });
const O = (input: number, output: number, cacheRead: number, cacheWrite = 0): ModelRates =>
  ({ input, output, cacheRead, cacheWrite });

/** Every id RATES prices today, with the rate it priced at before this change.
 *  Written out as literals rather than derived from the table, because a proof
 *  that the table agrees with itself proves nothing. */
const PINNED: Array<[string, ModelRates]> = [
  // Claude — one per row, plus every alias each row's comment claims.
  ["claude-fable-5",   A(10, 50, 1, 12.5, 20)],
  ["claude-mythos-5",  A(10, 50, 1, 12.5, 20)],
  ["claude-opus-5",    A(5, 25, 0.5, 6.25, 10)],
  ["claude-sonnet-5",  A(2, 10, 0.2, 2.5, 4)],       // intro rate at NOW
  ["claude-opus-4-5",  A(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4-6",  A(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4-7",  A(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4-8",  A(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4",    A(15, 75, 1.5, 18.75, 30)],
  ["claude-opus-4-1",  A(15, 75, 1.5, 18.75, 30)],
  ["claude-sonnet-4-5", A(3, 15, 0.3, 3.75, 6)],
  ["claude-sonnet-4-6", A(3, 15, 0.3, 3.75, 6)],
  ["claude-sonnet-4",   A(3, 15, 0.3, 3.75, 6)],
  ["claude-haiku-4-5",  A(1, 5, 0.1, 1.25, 2)],
  ["claude-haiku-3-5",  A(0.8, 4, 0.08, 1, 1.6)],
  // Claude, the other spellings pricing.ts already accepted: the `_`
  // separator, the `.` version separator, the 8-digit release date, CC's
  // `[1m]` context banner, and Vertex's `@date`.
  ["claude_opus_5",                A(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4.1",              A(15, 75, 1.5, 18.75, 30)],
  ["claude-opus-4-7-20250101",     A(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-5[1m]",            A(5, 25, 0.5, 6.25, 10)],
  ["claude-opus-4@20250514",       A(15, 75, 1.5, 18.75, 30)],
  ["claude-opus-4-1@20250805",     A(15, 75, 1.5, 18.75, 30)],
  ["claude-opus-4-5@20251101",     A(5, 25, 0.5, 6.25, 10)],
  ["claude-sonnet-4-5@20250929",   A(3, 15, 0.3, 3.75, 6)],
  ["claude-sonnet-4@20250514",     A(3, 15, 0.3, 3.75, 6)],
  ["claude-haiku-4-5@20251001",    A(1, 5, 0.1, 1.25, 2)],
  // OpenAI / Codex — one per row, plus the aliases the rows name.
  ["gpt-5.6-cyber",       O(12.5, 75, 1.25)],
  ["gpt-5.6-luna",        O(0.2, 1.2, 0.02, 0.25)],
  ["gpt-5.6-terra",       O(2, 12, 0.2, 2.5)],
  ["gpt-5.6-sol",         O(5, 30, 0.5, 6.25)],
  ["gpt-5.6",             O(5, 30, 0.5, 6.25)],
  ["gpt-5.5-pro",         O(30, 180, 30)],
  ["gpt-5.5",             O(5, 30, 0.5)],
  ["gpt-5.4-pro",         O(30, 180, 3)],
  ["gpt-5.4-mini",        O(0.75, 4.5, 0.075)],
  ["gpt-5.4-nano",        O(0.2, 1.25, 0.02)],
  ["gpt-5.4",             O(2.5, 15, 0.25)],
  ["gpt-5.3-codex-spark", O(1.75, 14, 0.175)],
  ["gpt-5.3-codex",       O(1.75, 14, 0.175)],
  ["gpt-5.2-pro",         O(21, 168, 21)],
  ["gpt-5.2",             O(1.75, 14, 0.175)],
  ["gpt-5.1-codex-mini",  O(0.25, 2, 0.025)],
  ["gpt-5.1-codex-max",   O(1.25, 10, 0.125)],
  ["gpt-5.1-codex",       O(1.25, 10, 0.125)],
  ["gpt-5.1-chat-latest", O(1.25, 10, 0.125)],
  ["gpt-5.1",             O(1.25, 10, 0.125)],
  ["gpt-5-pro",           O(15, 120, 15)],
  ["gpt-5-mini",          O(0.25, 2, 0.025)],
  ["gpt-5-nano",          O(0.05, 0.4, 0.005)],
  ["gpt-5-codex",         O(1.25, 10, 0.125)],
  ["gpt-5",               O(1.25, 10, 0.125)],
  ["codex-mini-latest",   O(1.5, 6, 0.375)],
  ["o1-pro",              O(150, 600, 150)],
  ["o1",                  O(15, 60, 7.5)],
  ["o3-mini",             O(1.1, 4.4, 0.55)],
  ["o3-pro",              O(20, 80, 20)],
  ["o4-mini",             O(1.1, 4.4, 0.275)],
  ["o3",                  O(2, 8, 0.5)],
  // The underscore spellings every `[-_]` in the table exists to accept.
  ["gpt_5_4_nano",        O(0.2, 1.25, 0.02)],
  ["gpt_5_1_codex",       O(1.25, 10, 0.125)],
  ["gpt_5_6_luna",        O(0.2, 1.2, 0.02, 0.25)],
];

describe("every rate the table already gave, unchanged", () => {
  for (const [id, rates] of PINNED) {
    it(`prices ${id} exactly as before`, () => {
      expect(ratesForModel(id, NOW)).toEqual(rates);
    });
  }

  it("still refuses the ids it always refused", () => {
    // The `not priced` answers pricing.ts argues for at length: an unrecognised
    // member of a known family must NOT inherit a sibling's price.
    for (const id of ["gpt-5.7", "gpt-5.10", "gpt-4o", "claude-opus-9", "claude-3-opus", "o5", "llama-3"]) {
      expect(ratesForModel(id, NOW), id).toBeNull();
    }
  });

  it("still switches Sonnet 5 at its cutover", () => {
    expect(ratesForModel("claude-sonnet-5", AFTER_INTRO)).toEqual(A(3, 15, 0.3, 3.75, 6));
  });
});

/** The RATES block, sliced out of the source, and every `match:` literal in it
 *  rebuilt as a RegExp. Reading the table rather than importing it (it is not
 *  exported, and exporting it to be tested would be the tail wagging the dog)
 *  is what makes the sweep above a COVERAGE claim: a row added tomorrow with no
 *  pinned id fails here instead of quietly going unproven. */
function ratesRowPatterns(): RegExp[] {
  const text = src("../pricing.ts");
  const start = text.indexOf("const RATES");
  expect(start, "RATES declaration").toBeGreaterThan(-1);
  const end = text.indexOf("\n];", start);
  expect(end, "end of RATES").toBeGreaterThan(start);
  const block = text.slice(start, end);
  const out: RegExp[] = [];
  for (const m of block.matchAll(/match:\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/g)) {
    out.push(new RegExp(m[1], m[2]));
  }
  return out;
}

describe("the pinned table covers the whole rate table", () => {
  it("hits every row in RATES", () => {
    const patterns = ratesRowPatterns();
    expect(patterns.length).toBeGreaterThan(25);
    const unreached = patterns
      .filter(p => !PINNED.some(([id]) => p.test(id)))
      .map(p => p.source);
    expect(unreached).toEqual([]);
  });
});

// ── half two: the provider namespace ────────────────────────────────────────

/** The prefixes Claude Code 2.1.234 can put in front of `anthropic.`, plus the
 *  bare namespace Mantle and a plain Bedrock foundation model use. */
const PREFIXES = [
  "us.anthropic.",
  "eu.anthropic.",
  "apac.anthropic.",
  "jp.anthropic.",
  "au.anthropic.",
  "us-gov.anthropic.",
  "global.anthropic.",
  "anthropic.",
];

/** Real Bedrock ids, copied verbatim out of the CLI's model catalog. The
 *  `-v1:0` tail is a deployment revision, not a model, and is exactly the kind
 *  of thing an unanchored pattern would trip over. */
const BEDROCK_IDS: Array<[string, ModelRates]> = [
  ["us.anthropic.claude-opus-4-1-20250805-v1:0",   A(15, 75, 1.5, 18.75, 30)],
  ["us.anthropic.claude-opus-4-20250514-v1:0",     A(15, 75, 1.5, 18.75, 30)],
  ["us.anthropic.claude-opus-4-5-20251101-v1:0",   A(5, 25, 0.5, 6.25, 10)],
  ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", A(3, 15, 0.3, 3.75, 6)],
  ["us.anthropic.claude-sonnet-4-20250514-v1:0",   A(3, 15, 0.3, 3.75, 6)],
  ["eu.anthropic.claude-haiku-4-5-20251001-v1:0",  A(1, 5, 0.1, 1.25, 2)],
  ["us.anthropic.claude-opus-4-6-v1",              A(5, 25, 0.5, 6.25, 10)],
  ["us.anthropic.claude-opus-4-7",                 A(5, 25, 0.5, 6.25, 10)],
  ["us.anthropic.claude-opus-4-8",                 A(5, 25, 0.5, 6.25, 10)],
  ["us.anthropic.claude-opus-5",                   A(5, 25, 0.5, 6.25, 10)],
  ["us.anthropic.claude-sonnet-4-6",               A(3, 15, 0.3, 3.75, 6)],
  ["us.anthropic.claude-sonnet-5",                 A(2, 10, 0.2, 2.5, 4)],
  ["us.anthropic.claude-fable-5",                  A(10, 50, 1, 12.5, 20)],
  ["us.anthropic.claude-mythos-5",                 A(10, 50, 1, 12.5, 20)],
  ["anthropic.claude-mythos-5",                    A(10, 50, 1, 12.5, 20)],
];

describe("Bedrock and Mantle ids reach the rate table", () => {
  for (const [id, rates] of BEDROCK_IDS) {
    it(`prices ${id}`, () => {
      expect(ratesForModel(id, NOW)).toEqual(rates);
    });
  }

  it("gives every region prefix the answer its bare id gets", () => {
    // The claim the issue makes, swept rather than sampled: for every Claude id
    // the table knows and every namespace the CLI can write, the prefixed form
    // must be worth exactly what the bare form is worth.
    const claudeIds = PINNED.filter(([id]) => /^claude/.test(id)).map(([id]) => id);
    for (const prefix of PREFIXES) {
      for (const id of claudeIds) {
        expect(ratesForModel(prefix + id, NOW), prefix + id)
          .toEqual(ratesForModel(id, NOW));
      }
    }
  });

  it("leaves Vertex alone, because Vertex ids carry no prefix", () => {
    // "Vertex model IDs take no prefix" — the CLI's own words. Current-
    // generation models use the bare first-party id; dated snapshots use `@`.
    // Both already matched, and the point of this is that they still do.
    expect(ratesForModel("claude-opus-4@20250514", NOW)).toEqual(A(15, 75, 1.5, 18.75, 30));
    expect(ratesForModel("claude-opus-4-5@20251101", NOW)).toEqual(A(5, 25, 0.5, 6.25, 10));
    expect(ratesForModel("claude-sonnet-4-5@20250929", NOW)).toEqual(A(3, 15, 0.3, 3.75, 6));
    expect(ratesForModel("claude-opus-5", NOW)).toEqual(A(5, 25, 0.5, 6.25, 10));
    expect(bareModelId("claude-opus-4@20250514")).toBe("claude-opus-4@20250514");
  });

  it("still returns null for a genuinely unknown id, prefixed or not", () => {
    for (const id of ["us.anthropic.claude-opus-9", "anthropic.claude-3-opus-20240229-v1:0",
                      "us.anthropic.llama-3-70b", "us.meta.llama3-70b-instruct-v1:0"]) {
      expect(ratesForModel(id, NOW), id).toBeNull();
    }
  });

  it("strips only the namespaces the CLI actually writes", () => {
    // The list is closed on purpose. An open `[a-z-]+\.anthropic\.` would take
    // any word at all as a region, and the id it would then price is one the
    // deck was never handed by Claude Code.
    for (const id of ["evil.anthropic.claude-opus-5", "com.anthropic.claude-opus-5",
                      "xx.anthropic.claude-opus-5"]) {
      expect(bareModelId(id), id).toBe(id);
      expect(ratesForModel(id, NOW), id).toBeNull();
    }
    // A real prefix followed by something that is not a model id: the prefix
    // comes off — it IS the prefix — and what is left still buys no rate,
    // which is the answer that matters.
    expect(bareModelId("us.anthropic.evil.claude-opus-5")).toBe("evil.claude-opus-5");
    expect(ratesForModel("us.anthropic.evil.claude-opus-5", NOW)).toBeNull();
  });

  it("removes nothing from an id that has no namespace", () => {
    for (const [id] of PINNED) expect(bareModelId(id), id).toBe(id);
  });
});

describe("the context window follows the same id", () => {
  it("gives a Bedrock Opus 5 the 1M window its bare id gets", () => {
    expect(contextWindowForModel("us.anthropic.claude-opus-5")).toBe(1_000_000);
    expect(contextWindowForModel("apac.anthropic.claude-sonnet-5")).toBe(1_000_000);
    expect(contextWindowForModel("us.anthropic.claude-opus-4-5-20251101-v1:0")).toBe(1_000_000);
    expect(contextWindowForModel("anthropic.claude-mythos-5")).toBe(1_000_000);
  });

  it("keeps the 200K default for the Bedrock models that have it", () => {
    expect(contextWindowForModel("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(200_000);
    expect(contextWindowForModel("us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe(200_000);
  });

  it("changes no window any id already had", () => {
    const before: Record<string, number> = {
      "claude-opus-5": 1_000_000, "claude-sonnet-5": 1_000_000, "claude-opus-4-8": 1_000_000,
      "claude-sonnet-4-6": 1_000_000, "claude-fable-5": 1_000_000, "claude-opus-5[1m]": 1_000_000,
      "claude-opus-4-1": 200_000, "claude-haiku-4-5": 200_000, "claude-sonnet-4-5": 200_000,
      "gpt-5.6-cyber": 400_000, "gpt-5.6": 1_050_000, "gpt-5.5": 1_050_000,
      "gpt-5.4-mini": 400_000, "gpt-5.4": 1_050_000, "gpt-5.3-codex-spark": 128_000,
      "gpt-5.3-codex": 400_000, "gpt-5.2": 400_000, "gpt-5": 400_000,
      "codex-mini-latest": 200_000, "o3": 200_000, "unknown-model": 200_000,
    };
    for (const [id, window] of Object.entries(before)) {
      expect(contextWindowForModel(id), id).toBe(window);
    }
  });
});

describe("the model chip", () => {
  it("labels a Bedrock id by its model, not its ARN-ish shape", () => {
    expect(shortModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(shortModel("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Haiku 4.5");
    expect(shortModel("us-gov.anthropic.claude-opus-5")).toBe("Opus 5");
    expect(shortModel("anthropic.claude-mythos-5")).toBe("Mythos 5");
  });

  it("prints what it always printed for the ids it already handled", () => {
    expect(shortModel("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(shortModel("claude-opus-4-7-20250101")).toBe("Opus 4.7");
    expect(shortModel("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark");
    expect(shortModel("o3-mini")).toBe("o3-mini");
    expect(shortModel("gpt-4o")).toBe("gpt-4o");
  });
});

// ── the two gates upstream of pricing ───────────────────────────────────────
// The issue's account stopped at `ratesForModel` returning null. It never got
// that far: a Bedrock id has to pass two `^claude` tests before any rate is
// looked up, and failing either one means the agent carries no model at all.

describe("the reducer keeps a Bedrock model", () => {
  const envelope = (payload: HookPayload): HookEnvelope =>
    ({ seq: 1, receivedAt: Date.now(), source: "hook", payload });

  const attach = (model: unknown, session: string) =>
    applyEvent(initialState(), envelope({
      hook_event_name: "PreToolUse", session_id: session, tool_name: "Read", model,
    })).agents.get(session)?.model;

  it("attaches the raw prefixed id to the agent", () => {
    expect(attach("us.anthropic.claude-opus-5", "s1")).toBe("us.anthropic.claude-opus-5");
    expect(attach("anthropic.claude-sonnet-4-5-20250929-v1:0", "s2"))
      .toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  it("still attaches the ids it always attached", () => {
    expect(attach("claude-opus-4-7", "s3")).toBe("claude-opus-4-7");
    expect(attach("gpt-5.6-luna", "s4")).toBe("gpt-5.6-luna");
    expect(attach("o3-mini", "s5")).toBe("o3-mini");
  });

  it("still ignores what is not a model id", () => {
    expect(attach("sonnet", "s6")).toBeFalsy();
    expect(attach({ rootModel: "claude-opus-5" }, "s7")).toBeFalsy();
    expect(attach("evil.anthropic.claude-opus-5", "s8")).toBeFalsy();
  });
});

describe("the server's transcript filter", () => {
  // MODEL_ID_RE is a literal in a plain .mjs file that node runs with no build
  // step, so it cannot import model-id.ts. This reads it back out of the source
  // and holds it to the exact rule the shared helper states, which is the only
  // thing keeping the two copies from drifting.
  const literal = /const MODEL_ID_RE = (\/(?:[^/\\\n]|\\.)+\/[a-z]*)/.exec(src("../../server/index.mjs"));
  const body = /^\/((?:[^/\\]|\\.)+)\/([a-z]*)$/.exec(literal?.[1] ?? "");
  const MODEL_ID_RE = new RegExp(body?.[1] ?? "$^", body?.[2] ?? "");

  it("is still a regex this test could find", () => {
    expect(literal, "MODEL_ID_RE literal in src/server/index.mjs").not.toBeNull();
  });

  it("accepts exactly the ids whose bare form is a Claude id", () => {
    const ids = [
      ...PINNED.map(([id]) => id),
      ...BEDROCK_IDS.map(([id]) => id),
      ...PREFIXES.map(p => `${p}claude-opus-5`),
      "evil.anthropic.claude-opus-5", "com.anthropic.claude-opus-5",
      "us.meta.llama3-70b-instruct-v1:0", "sonnet", "opus", "<synthetic>", "",
    ];
    for (const id of ids) {
      expect(MODEL_ID_RE.test(id), id).toBe(/^claude[-_]/i.test(bareModelId(id)));
    }
  });

  it("uses the same namespace list the client does", () => {
    for (const p of PREFIXES) expect(VENDOR_PREFIX_RE.test(`${p}claude-opus-5`), p).toBe(true);
    expect(VENDOR_PREFIX_RE.test("evil.anthropic.claude-opus-5")).toBe(false);
  });
});

describe("the server reads a Bedrock model off a real transcript", () => {
  const DIR = mkdtempSync(join(tmpdir(), "ccdeck-bedrock-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = DIR;
  process.env.USERPROFILE = DIR;

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    rmSync(DIR, { recursive: true, force: true });
  });

  it("resolves the root model from a prefixed id", async () => {
    // @ts-expect-error — .mjs server module, no types
    const { readModelFromTranscript } = await import("../../server/index.mjs");
    const path = join(DIR, "bedrock.jsonl");
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", usage: { input_tokens: 1, output_tokens: 1 } },
    }) + "\n");
    const read = await readModelFromTranscript(path);
    expect(read?.rootModel).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(ratesForModel(read?.rootModel, NOW)).toEqual(A(3, 15, 0.3, 3.75, 6));
  });

  it("still resolves a first-party id", async () => {
    // @ts-expect-error — .mjs server module, no types
    const { readModelFromTranscript } = await import("../../server/index.mjs");
    const path = join(DIR, "first-party.jsonl");
    writeFileSync(path, JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-7", usage: { input_tokens: 1, output_tokens: 1 } },
    }) + "\n");
    expect((await readModelFromTranscript(path))?.rootModel).toBe("claude-opus-4-7");
  });
});
