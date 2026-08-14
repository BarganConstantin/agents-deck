// Reported: the single-writer election ended the duplicated events.jsonl lines
// for everything the hook delivers, and left the Codex rollout watcher writing
// its own copy from every deck. That watcher builds its events inside the server
// — it tails ~/.codex/sessions/**/rollout-*.jsonl and never sees a hook — so
// with N decks up, each Codex session start, prompt and tool call was appended
// to the one events.jsonl they share N times: the log grew and rotated N times
// as fast, and every replay of it on boot ingested each tool call N times. On
// Windows, where Codex hooks never fire, the rollout is the only Codex capture
// path there is, so the duplication was the whole of it.
//
// The decks now run the same election over the same discovery records for the
// rollouts they tail. These pin both halves: the rule itself — which must agree
// with the hook's copy of it, and must cover exactly the decks that read the
// same file — and a running deck that draws a rollout it was not elected to log.
import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The home the server thinks it has, the config dir the override points at, and
// the Codex home it tails — all temporary, all set before the server module is
// imported, because it resolves every one of them at import time. $HOME and
// %USERPROFILE% together cover POSIX and Windows. Nothing in this file can
// reach the developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-codex-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-codex-config-"));
const FAKE_CODEX = mkdtempSync(join(tmpdir(), "ccdeck-codex-rollouts-"));
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
const { AGENT_DAG_DIR, CODEX_DIR, discoveryPath, writeDiscovery, ensureDiscovery } = installer as {
  AGENT_DAG_DIR: string;
  CODEX_DIR: string;
  discoveryPath: () => string;
  writeDiscovery: (o: Record<string, unknown>) => Promise<string>;
  ensureDiscovery: (o: Record<string, unknown>) => Promise<{ file: string; rewritten: boolean }>;
};
// @ts-expect-error — .mjs server module, no types
const logWriter = await import("../../server/log-writer.mjs");
const { codexCwdInWorkspace, electWriters, writesCodexLog } = logWriter as {
  codexCwdInWorkspace: (cwd: string | null, workspace: string, platform?: string) => boolean;
  electWriters: (decks: Deck[], platform?: string) => Set<Deck>;
  writesCodexLog: (o: { decks: Deck[]; pid: number; cwd: string | null; platform?: string }) => boolean;
};

type Deck = { pid: number; port: number; workspace?: string; persist?: string | null; codex?: boolean };

// Belt and braces: the server sweeps the discovery dir it resolves and the
// watcher walks the Codex home it resolves, so if either override were ignored
// this file would be deleting a real deck's registration and reading real
// sessions.
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

// hook.js is CommonJS inside a "type": "module" package, so it is only loadable
// as itself from outside that tree — which is also the only way it ever runs,
// since the installer copies it into the Claude config dir. Requiring the copy
// exports the rules and starts nothing: the runtime is behind require.main.
const HOOK_DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-hook-"));
const HOOK_COPY = join(HOOK_DIR, "hook.cjs");
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js"), HOOK_COPY);
const hook = createRequire(import.meta.url)(HOOK_COPY) as {
  electWriters: (decks: Deck[], platform?: string) => Set<Deck>;
};

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX, HOOK_DIR]) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("deciding which deck logs a rollout it is tailing", () => {
  const MY_PID = 77;
  const THEIR_PID = 78;
  const CWD = "/srv/proj";
  const deck = (pid: number, port: number, over: Partial<Deck> = {}): Deck =>
    ({ pid, port, workspace: "", persist: "/home/u/.claude/agent-dag/events.jsonl", codex: true, ...over });
  const self = deck(MY_PID, 4325);
  const writes = (decks: Deck[], platform = "linux") =>
    writesCodexLog({ decks, pid: MY_PID, cwd: CWD, platform });

  it("writes when it is the only deck reading the file", () => {
    expect(writes([self])).toBe(true);
  });

  it("leaves the copy on disk to the lowest-port deck sharing its log", () => {
    expect(writes([self, deck(THEIR_PID, 4317)])).toBe(false);
  });

  it("writes when it is itself the lowest-port deck sharing that log", () => {
    expect(writes([self, deck(THEIR_PID, 4400)])).toBe(true);
  });

  it("writes when the other deck was given its own --history file", () => {
    expect(writes([self, deck(THEIR_PID, 4317, { persist: "/tmp/mine.jsonl" })])).toBe(true);
  });

  it("writes when the other deck keeps no log at all", () => {
    // --no-persist. Electing it would have meant the rollout was recorded by
    // nobody.
    expect(writes([self, deck(THEIR_PID, 4317, { persist: null })])).toBe(true);
  });

  it("writes when the other deck is scoped to a workspace this rollout is not in", () => {
    // It never opens this file, so it is not a second copy — it is no copy.
    expect(writes([self, deck(THEIR_PID, 4317, { workspace: "/srv/other" })])).toBe(true);
  });

  it("defers to a deck scoped to a workspace that does contain this rollout", () => {
    expect(writes([self, deck(THEIR_PID, 4317, { workspace: "/srv" })])).toBe(false);
  });

  it("writes when the other deck is not tailing rollouts at all", () => {
    // --no-codex: it reads no rollout, so electing it would drop every Codex
    // event on the floor while both decks believed the other had it.
    expect(writes([self, deck(THEIR_PID, 4317, { codex: false })])).toBe(true);
  });

  it("assumes a deck too old to say either way is tailing them, as it was", () => {
    const old = deck(THEIR_PID, 4317);
    delete old.codex;
    expect(writes([self, old])).toBe(false);
  });

  it("writes while it has no discovery record of its own to be elected by", () => {
    // The window before the first heartbeat writes the file, or a deck that
    // cannot write one at all. Duplicating a line is recoverable; a deck that
    // silently stops recording is not.
    expect(writes([deck(THEIR_PID, 4317)])).toBe(true);
  });

  it("writes nothing to elect over when it keeps no log itself", () => {
    expect(writes([deck(MY_PID, 4325, { persist: null }), deck(THEIR_PID, 4317)])).toBe(true);
  });

  it("treats two spellings of one log as one file where the filesystem does", () => {
    const win = "C:\\Users\\J\\.claude\\agent-dag\\events.jsonl";
    const pair = [
      deck(MY_PID, 4325, { persist: win }),
      deck(THEIR_PID, 4317, { persist: win.toLowerCase() }),
    ];
    const onWin = writesCodexLog({ decks: pair, pid: MY_PID, cwd: "C:\\srv\\proj", platform: "win32" });
    const onMac = writesCodexLog({ decks: pair, pid: MY_PID, cwd: CWD, platform: "darwin" });
    expect([onWin, onMac]).toEqual([false, false]);
    // On Linux those are two different files, and each one needs its writer.
    expect(writesCodexLog({ decks: pair, pid: MY_PID, cwd: CWD, platform: "linux" })).toBe(true);
  });
});

// Whether another deck reads this rollout has to be answered with the very
// predicate that deck runs to decide it — the deck's own capture check. Answer
// it any more strictly and the election covers the wrong set of decks: one that
// writes without being elected, or an elected one that never opened the file.
describe("which decks a rollout's workspace reaches", () => {
  it("reaches every deck when the deck is unscoped", () => {
    expect(codexCwdInWorkspace("/srv/proj", "", "linux")).toBe(true);
  });

  it("reaches a deck scoped to the directory itself, or one above it", () => {
    expect(codexCwdInWorkspace("/srv/proj", "/srv/proj", "linux")).toBe(true);
    expect(codexCwdInWorkspace("/srv/proj/sub", "/srv", "linux")).toBe(true);
  });

  it("does not reach a deck scoped to a sibling with a shared prefix", () => {
    expect(codexCwdInWorkspace("/srv/project-x", "/srv/proj", "linux")).toBe(false);
  });

  it("reaches a deck scoped to the root, which already ends in a separator", () => {
    expect(codexCwdInWorkspace("/srv/proj", "/", "linux")).toBe(true);
    expect(codexCwdInWorkspace("C:\\srv\\proj", "C:\\", "win32")).toBe(true);
  });

  it("compares Windows paths by Windows rules from any machine", () => {
    expect(codexCwdInWorkspace("C:\\Proj\\sub", "c:\\proj", "win32")).toBe(true);
    expect(codexCwdInWorkspace("C:\\Projects", "C:\\Proj", "win32")).toBe(false);
  });

  it("reaches nobody scoped when the rollout never said where it runs", () => {
    expect(codexCwdInWorkspace(null, "/srv", "linux")).toBe(false);
    expect(codexCwdInWorkspace(null, "", "linux")).toBe(true);
  });
});

// hook.js is copied out of the package and run standalone, so it cannot import
// the server's copy of this rule and keeps its own. A disagreement between the
// two means one log line written twice, or none at all — so they are compared
// directly rather than trusted to have been kept in step.
describe("the server's election and the hook's", () => {
  const deck = (pid: number, port: number, persist?: string | null): Deck => ({ pid, port, persist });
  const ports = (decks: Deck[], writers: Set<Deck>) =>
    decks.filter(d => writers.has(d)).map(d => d.port).sort((a, b) => a - b);

  const tables: Array<[string, Deck[]]> = [
    ["decks sharing the default log", [deck(1, 4385, "/l.jsonl"), deck(2, 4317, "/l.jsonl"), deck(3, 4325, "/l.jsonl")]],
    ["a deck with its own --history file", [deck(1, 4317, "/l.jsonl"), deck(2, 4325, "/mine.jsonl")]],
    ["a deck keeping no log", [deck(1, 4317, null), deck(2, 4325, "/l.jsonl")]],
    ["decks too old to report a log", [deck(1, 4317), deck(2, 4325)]],
    ["one deck alone", [deck(1, 4317, "/l.jsonl")]],
    ["a tie on port broken by pid", [deck(7, 4317, "/l.jsonl"), deck(2, 4317, "/l.jsonl")]],
    ["two spellings of one path", [deck(1, 4317, "C:\\U\\J\\events.jsonl"), deck(2, 4325, "c:\\u\\j\\events.jsonl")]],
  ];

  for (const [what, decks] of tables) {
    for (const platform of ["linux", "darwin", "win32"]) {
      it(`elects the same writer for ${what} on ${platform}`, () => {
        expect(ports(decks, electWriters(decks, platform)))
          .toEqual(ports(decks, hook.electWriters(decks, platform)));
      });
    }
  }
});

// The election is only as good as what the decks advertise, and a deck that
// tails no rollout must never be elected to record one. Left out of the record,
// no deck can tell; left out of ensureDiscovery's comparison, a record missing
// it passes as ours forever and the field never appears.
describe("the Codex setting in the discovery record", () => {
  const TOKEN = "3f9a1c0d5e21";
  const wipe = () => rmSync(discoveryPath(), { force: true });

  afterEach(() => wipe());

  it("says this deck is tailing rollouts", async () => {
    await writeDiscovery({ port: 4326, workspace: "", token: TOKEN, persist: LOG, codex: true });
    expect(JSON.parse(readFileSync(discoveryPath(), "utf8")).codex).toBe(true);
  });

  it("says a --no-codex deck is not", async () => {
    await writeDiscovery({ port: 4326, workspace: "", token: TOKEN, persist: LOG, codex: false });
    expect(JSON.parse(readFileSync(discoveryPath(), "utf8")).codex).toBe(false);
  });

  it("leaves the deck's own record alone, so the heartbeat is not a rewrite loop", async () => {
    await writeDiscovery({ port: 4326, workspace: "", token: TOKEN, persist: LOG, codex: false });
    const before = readFileSync(discoveryPath(), "utf8");
    const res = await ensureDiscovery({ port: 4326, workspace: "", token: TOKEN, persist: LOG, codex: false });
    expect(res.rewritten).toBe(false);
    // A rewrite stamps a new startedAt — proof this was a read, not a write.
    expect(readFileSync(discoveryPath(), "utf8")).toBe(before);
  });

  it("replaces a record that says the opposite, or does not say", async () => {
    for (const stale of [{ codex: false }, {}]) {
      writeFileSync(discoveryPath(), JSON.stringify({
        pid: process.pid, port: 4326, workspace: "", token: TOKEN, persist: LOG, ...stale,
      }));
      const res = await ensureDiscovery({ port: 4326, workspace: "", token: TOKEN, persist: LOG, codex: true });
      expect(res.rewritten).toBe(true);
      expect(JSON.parse(readFileSync(discoveryPath(), "utf8")).codex).toBe(true);
    }
  });
});

// The whole thing, running: a deck tailing a rollout that a second, lower-port
// deck is registered to log. This is the shape the audit reproduced — two decks,
// one rollout, eight lines in a log that should hold four.
describe("a deck tailing a rollout another deck was elected to log", () => {
  const SID = "9c2f1b7a-1111-4000-8000-0123456789ab";
  const CWD = join(FAKE_HOME, "workspace");
  const DAY = join(FAKE_CODEX, "sessions", "2026", "08", "14");
  const ROLLOUT = join(DAY, `rollout-2026-08-14T09-00-00-${SID}.jsonl`);
  // A pid that is alive and is not ours: the process that started this one. A
  // record whose pid is dead is swept, and would elect nobody.
  const OTHER = join(AGENT_DAG_DIR, `${process.ppid}.json`);
  const line = (obj: unknown) => JSON.stringify(obj) + "\n";

  const logged = (): Record<string, any>[] =>
    (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter(Boolean).map(l => JSON.parse(l));

  const drawn = () => eventsSince(0)
    .filter((e: { source: string }) => e.source === "codex")
    .map((e: { payload: Record<string, unknown> }) => e.payload)
    .filter((p: Record<string, unknown>) => p.session_id === SID);

  async function waitFor(cond: () => boolean, ms = 15000) {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await tick(50);
    // Then a little longer, which is the window a copy that should NOT be on
    // disk would land in: the append is fire-and-forget.
    await tick(100);
    return cond();
  }

  beforeAll(async () => {
    // Both decks registered before a single rollout line exists, so the very
    // first event the watcher produces is already subject to the election.
    await writeDiscovery({ port: PORT, workspace: "", token: "ours", persist: LOG, codex: true });
    writeFileSync(OTHER, JSON.stringify({
      pid: process.ppid, port: 1, workspace: "", token: "theirs", persist: LOG, codex: true,
    }));
    mkdirSync(DAY, { recursive: true });
    // The watcher's first pass skips whatever is already on disk, so the
    // rollout has to appear after it — as a live session does.
    await tick(300);
  });

  afterAll(() => rmSync(OTHER, { force: true }));

  it("draws the session but leaves the one copy on disk to that deck", async () => {
    writeFileSync(ROLLOUT,
      line({ type: "session_meta", payload: { id: SID, cwd: CWD } }) +
      line({ type: "event_msg", payload: { type: "user_message", message: "hello codex" } }) +
      line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_ONE", arguments: "{}" } }),
      "utf8");

    expect(await waitFor(() => drawn().some(p => p.hook_event_name === "PreToolUse"))).toBe(true);
    // Every deck draws it — that fan-out is the point, only the second copy on
    // disk is dropped.
    expect(drawn().map(p => p.hook_event_name))
      .toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse"]);
    expect(logged()).toEqual([]);
  }, 20000);

  it("takes the log back the moment that deck is gone", async () => {
    // The election runs against the decks registered right now, so the next
    // batch of lines is this deck's to record.
    rmSync(OTHER, { force: true });
    appendFileSync(ROLLOUT,
      line({ type: "response_item", payload: { type: "function_call_output", call_id: "call_ONE", output: "ok" } }),
      "utf8");

    expect(await waitFor(() => drawn().some(p => p.hook_event_name === "PostToolUse"))).toBe(true);
    expect(logged().map(e => e.payload)).toMatchObject([
      { hook_event_name: "PostToolUse", session_id: SID, tool_use_id: "call_ONE" },
    ]);
  }, 20000);
});
