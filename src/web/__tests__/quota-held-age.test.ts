// `claude --print /usage` routinely answers without its "Current session/week"
// lines — a cold invocation, or right after a hard refresh — and the branch that
// handles it keeps serving the last reading the deck did get rather than
// regressing the panel to 0%. It used to re-stamp that reading with
// `fetchedAt: now`, and fetchedAt is the age of the DATA, not of our read of it:
// the usage panel printed "just now" over percentages collected hours earlier,
// held it for a full poll cycle, then snapped back to the true age — an age
// label that oscillates and periodically vouches for numbers the deck itself has
// already marked stale. self-update.mjs keeps `at` (when npm answered) apart
// from `failedAt` (when the last attempt failed) for exactly this reason; a held
// quota reading has to carry the timestamp of the answer it actually is.
//
// Nothing here spawns the claude CLI, reads claude-swap's store or reaches the
// network: child_process and claude-accounts.mjs are replaced wholesale, and
// every home the module resolves at import time points into a temp directory.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-quota-held-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
// quota.mjs builds ~/.claude/.credentials.json out of homedir() at import time,
// and homedir() reads HOME on POSIX and USERPROFILE on Windows — both are set
// above, so this holds on all three platforms. Stop before the import if not.
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

// claude-swap's store, as activeAccountUsage() answers it. Replaced entirely, so
// no test here reads the real store and the age of the row is ours to choose.
const { swap } = vi.hoisted(() => ({ swap: { entry: null as unknown, collections: 0 } }));
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => swap.entry,
  // The collector declines — nothing in this file may touch the network.
  requestCollection: async () => { swap.collections++; return false; },
}));

// The `claude` CLI, which must never actually run. quota.mjs promisifies exec at
// import time and node's real exec carries the custom implementation promisify()
// prefers; without it here, execAsync would resolve to a bare stdout string and
// the module would read stderr off undefined.
const { cli } = vi.hoisted(() => ({ cli: { stdout: "", stderr: "", calls: [] as string[] } }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const exec = () => { throw new Error("test: exec is blocked"); };
  (exec as unknown as Record<symbol, unknown>)[promisify.custom] = async (cmd: string) => {
    cli.calls.push(cmd);
    return { stdout: cli.stdout, stderr: cli.stderr };
  };
  return { exec, default: { exec } };
});

type Quota = {
  ok: boolean;
  fetchedAt: number;
  source?: string;
  stale?: boolean;
  session5hPct?: number;
  week7dPct?: number;
};
type QuotaModule = { fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota> };

const MIN = 60_000;
// Inside STORE_TRUSTED_MS, so the row is served and remembered — and far enough
// from "now" that a re-stamped timestamp cannot pass for the real one.
const STORE_AGE = 40 * MIN;

/** claude-swap's row for the active account, collected `ageMs` ago. */
const row = (ageMs: number) => ({
  num: 2,
  email: "a@b.c",
  fetchedAt: Date.now() - ageMs,
  lastGood: {
    five_hour: { pct: 63, resets_at: "2026-08-14T18:00:00Z" },
    seven_day: { pct: 18, resets_at: "2026-08-19T04:00:00Z" },
  },
});

let mod: QuotaModule;

beforeEach(async () => {
  swap.entry = null;
  swap.collections = 0;
  cli.calls.length = 0;
  // What the CLI prints on the cold invocation this branch exists for: the
  // preamble that proves it ran, and not one quota line.
  cli.stdout = "Claude Code usage\nCurrent subscription: Max\n";
  cli.stderr = "";
  // A fresh module per test — the last-known-good reading, the result cache and
  // the self-poll floor are all module state.
  vi.resetModules();
  mod = await import("../../server/quota.mjs") as unknown as QuotaModule;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

/** Serve one good store row, then take the store away and let the CLI answer
 *  with nothing the parser recognises. */
async function heldAfterEmptyCli() {
  swap.entry = row(STORE_AGE);
  const good = await mod.fetchClaudeQuota();
  expect(good.source).toBe("claude-swap");   // this is the reading that gets held
  swap.entry = null;
  // `force` skips the 60s result cache, and the self-poll floor has not been
  // spent yet, so this call really does reach the CLI.
  return { good, held: await mod.fetchClaudeQuota({ force: true }) };
}

describe("a quota reading held through an empty `claude --print /usage`", () => {
  it("keeps the age of the numbers, not the age of the read that found none", async () => {
    const { good, held } = await heldAfterEmptyCli();

    expect(cli.calls).toHaveLength(3);            // the retry loop ran, and found nothing
    expect(held.fetchedAt).toBe(good.fetchedAt);  // the defect: this used to be `now`
    expect(Date.now() - held.fetchedAt).toBeGreaterThanOrEqual(STORE_AGE);
  });

  it("still serves the numbers it holds rather than regressing the panel to 0%", async () => {
    const { held } = await heldAfterEmptyCli();

    expect(held).toMatchObject({
      ok: true, source: "claude-swap", session5hPct: 63, week7dPct: 18, stale: true,
    });
  });

  it("ages the same as the reading the self-poll floor serves without a CLI at all", async () => {
    // The sibling fallback, one poll later: the floor was just spent, so this
    // one hands back what it holds without spawning anything. The two branches
    // serve the same reading, and one of them re-stamping it is precisely how
    // the panel came to flip to "just now" every five minutes.
    const { held } = await heldAfterEmptyCli();
    const spent = cli.calls.length;

    const floored = await mod.fetchClaudeQuota({ force: true });

    expect(cli.calls).toHaveLength(spent);
    expect(floored.fetchedAt).toBe(held.fetchedAt);
    expect(floored.stale).toBe(true);
  });
});
