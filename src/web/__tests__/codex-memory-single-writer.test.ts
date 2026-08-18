// #447 — the one Codex event the single-writer election did not cover.
//
// Every event the rollout watcher produces goes out through emitCodexEvent,
// which carries the per-batch verdict of writesCodexLog: N decks tailing one
// rollout all DRAW it (that fan-out is #405's whole point) and exactly one of
// them appends it to the events.jsonl they share. `maybeResolveCodexMemory` —
// the AGENTS.md scan #399 added — pushed with no opts at all, so pushEvent fell
// through to writesLogFor, which answers from `foreignSessions`. That set is
// filled by exactly one thing, noteLogWriter off an incoming hook POST marked
// `?persist=0`. A Codex rollout is read inside the server and never reaches an
// HTTP handler, and the installer keeps the Codex provider for uninstall only,
// so a Codex session id can never get into that set: every deck answered "mine"
// and every deck wrote the line.
//
// WHAT IT COST, MEASURED, because the honest size of a bug belongs next to its
// fix. The scan is throttled to one call per session per CONTEXT_READ_THROTTLE_MS
// (4s) AND only runs on a tick where the rollout actually grew, so the ceiling of
// ~900 lines/hour/deck is a session that produces bytes in every single 4-second
// window for a solid hour. Replaying the 10 real rollouts under this machine's
// CODEX_HOME through that gate — 38.5 hours of session wall-clock — fires it 270
// times, i.e. 7 per session-hour, not 900. At 412 bytes a line that is 111 KB per
// extra deck across those 38 hours: 0.2% of the 50 MB the log rotates at, and it
// would take ~141 hours of unbroken Codex activity per extra deck to fill one
// rotation. On disk this is a tidiness fix.
//
// Where it is not tidiness is the line COUNT. Those same 10 sessions produce 612
// real events between them, so with two decks up the duplicates are 270 of 1152
// lines — 23% of the log — and boot replay pushes every one of them through the
// 2000-entry ring buffer, evicting genuine tool calls from what a reconnecting
// tab is shown. That is the cost worth fixing, and it is a cost in eviction
// rather than in wrong state: the reducer's ContextObserved branch assigns
// field by field, so a duplicate is idempotent. The last test here pins that,
// because "it double-counts" and "it wastes a slot" want different fixes and
// the difference is not obvious from the payload.
//
// Plain node, no DOM: the first two tests drive the real watcher against a real
// rollout in a temp sandbox, the third drives the real reducer.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

// The home the server thinks it has, the config dir the discovery override
// points at, and the Codex home it tails — all temporary, all set before the
// server module is imported, because it resolves every one of them at import
// time. $HOME and %USERPROFILE% together cover POSIX and Windows. Nothing in
// this file can reach the developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-codexmem-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-codexmem-config-"));
const FAKE_CODEX = mkdtempSync(join(tmpdir(), "ccdeck-codexmem-rollouts-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
process.env.CODEX_HOME = FAKE_CODEX;

// @ts-expect-error — .mjs server module, no types
const { startServer, eventsSince } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const installer = await import("../../server/installer.mjs");
const { AGENT_DAG_DIR, CODEX_DIR, discoveryPath, writeDiscovery } = installer as {
  AGENT_DAG_DIR: string;
  CODEX_DIR: string;
  discoveryPath: () => string;
  writeDiscovery: (o: Record<string, unknown>) => Promise<string>;
};

// Belt and braces, the same check codex-single-log-writer.test.ts makes: the
// server sweeps the discovery dir it resolved and the watcher walks the Codex
// home it resolved, so if either override were ignored this file would be
// deleting a real deck's registration and reading real sessions.
for (const [p, root] of [
  [claudeConfigDir(), FAKE_CONFIG],
  [AGENT_DAG_DIR, FAKE_CONFIG],
  [discoveryPath(), FAKE_CONFIG],
  [CODEX_DIR, FAKE_CODEX],
] as const) {
  if (!String(p).startsWith(root)) {
    throw new Error(`refusing to run: resolved ${p}, outside ${root}`);
  }
}

const LOG = join(FAKE_CONFIG, "agent-dag", "events.jsonl");
const server: Server = await startServer({ port: 0, persist: LOG, workspace: "", codex: true });
const PORT = (server.address() as AddressInfo).port;

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX]) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

// The one condition the pre-existing fixture could not have. codex-single-log-
// writer.test.ts runs against mkdtemp directories with no AGENTS.md anywhere,
// and maybeResolveCodexMemory returns without emitting when the file list comes
// back empty — so the case that reaches this bug is precisely the one that
// fixture cannot reach. Here the rollout's cwd holds a real AGENTS.md.
describe("the AGENTS.md scan and the deck elected to write the log", () => {
  const SID = "4d81aa30-2222-4000-8000-fedcba987654";
  const CWD = join(FAKE_HOME, "codex-workspace");
  const DAY = join(FAKE_CODEX, "sessions", "2026", "08", "18");
  const ROLLOUT = join(DAY, `rollout-2026-08-18T10-00-00-${SID}.jsonl`);
  // A pid that is alive and is not ours: the process that started this one. A
  // record whose pid is dead is swept, and would elect nobody.
  const OTHER = join(AGENT_DAG_DIR, `${process.ppid}.json`);
  const line = (obj: unknown) => JSON.stringify(obj) + "\n";

  const logged = (): Array<{ source: string; payload: Record<string, unknown> }> =>
    (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter(Boolean).map(l => JSON.parse(l));

  const loggedContext = () => logged()
    .map(e => e.payload)
    .filter(p => p.hook_event_name === "ContextObserved" && p.session_id === SID);

  const drawnContext = () => eventsSince(0)
    .map((e: { payload: Record<string, unknown> }) => e.payload)
    .filter((p: Record<string, unknown>) => p.hook_event_name === "ContextObserved" && p.session_id === SID);

  async function waitFor(cond: () => boolean, ms = 15000) {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await tick(50);
    // Then a little longer, which is the window a copy that should NOT be on
    // disk would land in: the append is fire-and-forget.
    await tick(200);
    return cond();
  }

  beforeAll(async () => {
    // Both decks registered before a single rollout line exists, so the very
    // first event the watcher produces is already subject to the election. The
    // other deck holds the lower port, so it holds the file.
    await writeDiscovery({ port: PORT, workspace: "", token: "ours", persist: LOG, codex: true });
    writeFileSync(OTHER, JSON.stringify({
      pid: process.ppid, port: 1, workspace: "", token: "theirs", persist: LOG, codex: true,
    }));
    mkdirSync(CWD, { recursive: true });
    writeFileSync(join(CWD, "AGENTS.md"), "# house rules\n\nbe brief.\n", "utf8");
    mkdirSync(DAY, { recursive: true });
    // The watcher's first pass skips whatever is already on disk, so the rollout
    // has to appear after it — as a live session does.
    await tick(300);
  });

  afterAll(() => rmSync(OTHER, { force: true }));

  it("draws the memory files but leaves the copy on disk to the elected deck", async () => {
    writeFileSync(ROLLOUT,
      line({ type: "session_meta", payload: { id: SID, cwd: CWD } }) +
      line({ type: "event_msg", payload: { type: "user_message", message: "hello codex" } }),
      "utf8");

    // The fan-out from #405 is intact: this deck is NOT the writer and still
    // draws the event, so its own context modal lists the AGENTS.md files.
    expect(await waitFor(() => drawnContext().length > 0)).toBe(true);
    const files = (drawnContext()[0].context as { memoryFiles: Array<{ path: string }> }).memoryFiles;
    expect(files.map(f => f.path)).toContain(join(CWD, "AGENTS.md"));

    // …and writes none of it. The whole batch belongs to the other deck: the
    // root, the prompt and the memory scan alike.
    expect(loggedContext()).toEqual([]);
    expect(logged()).toEqual([]);
  }, 25000);

  it("writes exactly one copy once it is the deck holding the log", async () => {
    rmSync(OTHER, { force: true });
    // Past the per-session throttle, so the next batch is allowed to scan again.
    await tick(4200);
    appendFileSync(ROLLOUT,
      line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_ONE", arguments: "{}" } }),
      "utf8");

    expect(await waitFor(() => loggedContext().length > 0)).toBe(true);
    // One line, not one per deck that ever tailed the rollout. Written by this
    // deck now that nobody else holds the file.
    expect(loggedContext()).toHaveLength(1);
    expect(loggedContext()[0]).toMatchObject({ hook_event_name: "ContextObserved", provider: "codex", session_id: SID });
  }, 25000);
});

// What a log that ALREADY holds the duplicates replays to. This is the question
// the disk-usage framing hides: ContextObserved has merged field by field since
// #399, and "merge" could mean either accumulate or assign. It assigns — so a
// replayed duplicate is idempotent and the damage is confined to ring-buffer
// slots. Pinned here so a later change to that branch cannot quietly turn a
// wasted slot into wrong numbers on the canvas.
describe("replaying a log that already contains the duplicates", () => {
  const SID = "7bd2f014-3333-4000-8000-0f1e2d3c4b5a";
  const CWD = "/repo";
  const T0 = 1_700_000_000_000;
  const MEMORY = [{ path: "/repo/AGENTS.md", bytes: 4210 }, { path: "/home/u/.codex/AGENTS.md", bytes: 812 }];

  /** The Codex memory scan's event, exactly as maybeResolveCodexMemory pushes it. */
  const contextObserved: HookPayload = {
    hook_event_name: "ContextObserved",
    session_id: SID,
    provider: "codex",
    context: { memoryFiles: MEMORY },
  } as unknown as HookPayload;

  /** Replay every payload in order through the real reducer, the way replayLog
   *  feeds the buffer and the tab feeds the canvas. `seq` climbs so the
   *  reducer's monotonic guard does not drop the later copies — which is the
   *  point: the duplicates are separate lines with separate seqs, not one line
   *  seen twice. */
  const replay = (payloads: HookPayload[]): GraphState => {
    let state = initialState();
    payloads.forEach((payload, i) => {
      const env: HookEnvelope = { seq: i + 1, receivedAt: T0 + i * 1000, source: "replay", payload, replay: true };
      state = applyEvent(state, env);
    });
    return state;
  };

  const root = (s: GraphState) => s.agents.get(SID);

  const start: HookPayload = {
    hook_event_name: "SessionStart", session_id: SID, cwd: CWD, provider: "codex",
  } as unknown as HookPayload;

  // A Claude-shaped ContextObserved: the only producer that sends the numeric
  // composition counts. It shares the branch with the Codex one, so if the merge
  // accumulated anything it would be these.
  const counted: HookPayload = {
    hook_event_name: "ContextObserved",
    session_id: SID,
    context: { msgsUser: 12, msgsAssistant: 11, toolUses: 30, toolResults: 29, systemReminders: 4, currentContextTokens: 47_355 },
  } as unknown as HookPayload;

  it("lands on the same state as a log with a single copy", () => {
    const clean = replay([start, counted, contextObserved]);
    // Three decks up for a while: the elected one's copy plus five strays.
    const dirty = replay([start, counted, ...Array.from({ length: 6 }, () => contextObserved)]);
    expect(root(dirty)?.context).toEqual(root(clean)?.context);
  });

  it("does not double-count anything a duplicate carries", () => {
    const dirty = replay([start, counted, ...Array.from({ length: 6 }, () => contextObserved)]);
    const ctx = root(dirty)?.context;
    // The file list is replaced, never appended to: six copies of a two-file
    // list is still a two-file list.
    expect(ctx?.memoryFiles).toEqual(MEMORY);
    // And the numbers the other producer established survive at their own
    // values rather than being summed or reset to zero — an absent key means
    // "this producer has nothing to say", which is what makes the duplicate
    // harmless.
    expect(ctx?.msgsUser).toBe(12);
    expect(ctx?.toolUses).toBe(30);
    expect(ctx?.currentContextTokens).toBe(47_355);
  });

  it("keeps the same answer whichever order the copies arrive in", () => {
    // The elected deck and a stray are two processes appending to one file, so
    // the interleaving is not fixed. Both orders have to reduce alike or the
    // "duplicates are idempotent" claim only holds for one of them.
    const before = replay([start, contextObserved, contextObserved, counted]);
    const after = replay([start, counted, contextObserved, contextObserved]);
    expect(before.agents.get(SID)?.context).toEqual(after.agents.get(SID)?.context);
  });
});
