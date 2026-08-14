// `codex login` creates ~/.codex, but ~/.codex/sessions only shows up when the
// first session actually starts. The watcher used to check for that directory
// once, at boot, and return without arming its poll timer when it was missing —
// so on a fresh Codex install the deck printed "✓ Codex sessions → watching
// ~/.codex/sessions" and then captured nothing until it was restarted, with
// rollout tailing being the only Codex capture path there is. The timer now
// starts unconditionally and the poll doubles as the existence re-check (no
// fs.watch: it throws on a missing path and only watches recursively on macOS
// and Windows). These pin that the watcher arms itself with the directory
// missing and picks up the first rollout that appears afterwards.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything below lives inside this temp directory — the real ~/.codex is
// never read or written. CODEX_HOME is resolved at module import time, so it
// has to be set before the dynamic import a few lines down.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-watch-"));
const CODEX_HOME = join(DIR, "codex-home");
const SESSIONS = join(CODEX_HOME, "sessions");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;
// `codex login` state without a single session yet: the home exists, sessions/
// does not.
mkdirSync(CODEX_HOME, { recursive: true });

// @ts-expect-error — .mjs server module, no types
const { startCodexWatcher, eventsSince } = await import("../../server/index.mjs");

const SID = "6f1a0c3e-0000-4000-8000-abcdef123456";
const CWD = join(DIR, "workspace");

let timer: ReturnType<typeof setInterval> | null = null;

beforeAll(() => {
  // Empty workspace filter — capture every session, whatever its cwd.
  timer = startCodexWatcher("");
});

afterAll(() => {
  if (timer) clearInterval(timer);
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
  rmSync(DIR, { recursive: true, force: true });
});

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/** Poll until `fn` returns something truthy, or give up. */
async function waitFor<T>(fn: () => T | undefined | null, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error("timed out waiting for the watcher");
    await new Promise(r => setTimeout(r, 50));
  }
}

function codexEvents() {
  return eventsSince(0)
    .filter((e: { source: string }) => e.source === "codex")
    .map((e: { payload: Record<string, unknown> }) => e.payload)
    .filter((p: Record<string, unknown>) => p.session_id === SID);
}

describe("codex watcher with a sessions directory that appears after boot", () => {
  it("arms its poll timer even though ~/.codex/sessions is missing", () => {
    expect(timer).toBeTruthy();
  });

  it("stays quiet while there is nothing to read", async () => {
    await new Promise(r => setTimeout(r, 200));
    expect(codexEvents()).toEqual([]);
  });

  it("picks up the first rollout written after the deck started", async () => {
    // The user runs `codex` for the first time: Codex creates the whole
    // sessions/<year>/<month>/<day> tree and writes the rollout.
    const dayDir = join(SESSIONS, "2026", "08", "14");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, `rollout-2026-08-14T10-00-00-${SID}.jsonl`),
      line({ type: "session_meta", payload: { id: SID, cwd: CWD } }) +
        line({ type: "turn_context", payload: { model: "gpt-5-codex" } }) +
        line({ type: "event_msg", payload: { type: "user_message", message: "hello codex" } }),
      "utf8",
    );

    const events = await waitFor(() => {
      const found = codexEvents();
      return found.some((p: Record<string, unknown>) => p.hook_event_name === "UserPromptSubmit") ? found : null;
    });

    // The lazy root lands first, then the prompt — a live session, not a
    // skipped-history one.
    expect(events[0]).toMatchObject({ hook_event_name: "SessionStart", session_id: SID, cwd: CWD, provider: "codex" });
    expect(events.find((p: Record<string, unknown>) => p.hook_event_name === "UserPromptSubmit"))
      .toMatchObject({ prompt: "hello codex", model: "gpt-5-codex" });
  }, 20000);
});
