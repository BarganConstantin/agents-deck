// Claude's 5h/7d percentages are one account's, not one machine's: quota.mjs
// reads them for whichever account claude-swap has active. Switching accounts
// from the accounts panel therefore invalidates every number the usage panel is
// showing — and the usage panel is the one component that cannot know, since it
// polls /api/quota on its own timer and the switch happened in a sibling that
// owns none of its state. So the server has to say so, and until this landed it
// said nothing: the roster flipped to the new account while the big quota bars
// went on showing the previous one's, two panels on one screen disagreeing about
// the same account, with the stale one being the one the user just clicked.
//
// Dropping the result cache is only half of it. `_lastGood` — the reading the
// deck already paid a request for — is what both of _doFetch's fallbacks hand
// back when nothing else can answer, and freshest() ranks it by fetchedAt, so it
// beats any store row for an account nobody has collected for since. Left in
// place it puts the previous account's percentages back on screen one poll later
// under a "stale" label, which is worse than an empty panel: the label vouches
// for them as this account's, merely old. #289 pinned that a held reading keeps
// the timestamp of the answer it actually is; a switch is the case where there
// is no answer to hold at all.
//
// Nothing here spawns the claude CLI or cswap, reads claude-swap's store or
// reaches the network: child_process and claude-accounts.mjs are replaced
// wholesale, and every home the module resolves at import time points into a
// temp directory.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-quota-switch-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
// quota.mjs builds ~/.claude/.credentials.json out of homedir() at import time,
// and homedir() reads HOME on POSIX and USERPROFILE on Windows — both are set
// above, so this holds on all three platforms. Stop before the import if not.
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

// claude-swap's store, as activeAccountUsage() answers it — replaced entirely,
// so which account is active and what was collected for it is ours to choose.
const { swap } = vi.hoisted(() => ({ swap: { entry: null as unknown } }));
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => swap.entry,
  // The collector declines — nothing in this file may touch the network.
  requestCollection: async () => false,
}));

// The `claude` CLI, which must never actually run. The seam is exec.mjs's `run`:
// quota.mjs used to build a shell command line and hand it to `exec()`, which is
// how a home directory containing `$(…)` became shell code (see
// no-shell-hook-commands.test.ts), and it now spawns an argument vector instead.
// `run` never rejects and never throws, so the stand-in answers the shape it
// does rather than raising. Replaced rather than wrapped, so nothing in this
// file can reach a real child process by any route.
const { cli } = vi.hoisted(() => ({ cli: { stdout: "", stderr: "", calls: [] as string[][] } }));
vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    cli.calls.push([cmd, ...args]);
    return { ok: true, code: 0, killed: false, timedOut: false, stdout: cli.stdout, stderr: cli.stderr };
  },
}));

type Quota = {
  ok: boolean;
  fetchedAt: number;
  reason?: string;
  source?: string;
  stale?: boolean;
  session5hPct?: number;
  week7dPct?: number;
};
type QuotaModule = {
  fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota>;
  invalidateQuotaCache: () => void;
};

const MIN = 60_000;
// Inside STORE_TRUSTED_MS, so the row is served and remembered as the last known
// good reading — which is the thing a switch has to throw away.
const STORE_AGE = 40 * MIN;

/** claude-swap's row for whichever account is active, collected `ageMs` ago. */
const row = (num: number, pct: number, ageMs = STORE_AGE) => ({
  num,
  email: `account-${num}@b.c`,
  fetchedAt: Date.now() - ageMs,
  lastGood: {
    five_hour: { pct, resets_at: "2026-08-14T18:00:00Z" },
    seven_day: { pct: Math.round(pct / 3), resets_at: "2026-08-19T04:00:00Z" },
  },
});

let mod: QuotaModule;

beforeEach(async () => {
  swap.entry = null;
  cli.calls.length = 0;
  // What the CLI prints when it cannot answer: the preamble that proves it ran,
  // and not one quota line.
  cli.stdout = "Claude Code usage\nCurrent subscription: Max\n";
  cli.stderr = "";
  // A fresh module per test — the result cache, the last-known-good reading and
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

/** Serve one good reading for account 2, the way a poll before the switch did. */
async function readingForAccount2() {
  swap.entry = row(2, 63);
  const before = await mod.fetchClaudeQuota();
  expect(before).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 63 });
  return before;
}

describe("the quota held across a Claude account switch", () => {
  it("stops serving the previous account's numbers the moment the switch is told to it", async () => {
    await readingForAccount2();
    // The switch lands, and claude-swap now answers for account 3.
    swap.entry = row(3, 7);
    // Without being told, the result cache is entitled to hold the old numbers
    // for the rest of its minute — which is the bug, in one line.
    expect(await mod.fetchClaudeQuota()).toMatchObject({ session5hPct: 63 });

    mod.invalidateQuotaCache();

    expect(await mod.fetchClaudeQuota()).toMatchObject({ ok: true, session5hPct: 7 });
  });

  it("says it has no reading yet rather than re-serving one the new account never earned", async () => {
    await readingForAccount2();
    // Spend the self-poll floor the way an ordinary refresh does, so the next
    // call lands in the fallback that hands back whatever is held.
    swap.entry = null;
    const held = await mod.fetchClaudeQuota({ force: true });
    expect(held).toMatchObject({ ok: true, session5hPct: 63, stale: true });

    // The switch. Nothing has been collected for the new account yet, so there
    // is genuinely nothing to say about it.
    mod.invalidateQuotaCache();
    const spent = cli.calls.length;
    const after = await mod.fetchClaudeQuota({ force: true });

    expect(after.ok).toBe(false);
    expect(after.reason).toBe("waiting");
    expect(after.session5hPct).toBeUndefined();
    expect(after.week7dPct).toBeUndefined();
    // And it stays inside the floor while saying so: a switch is not a reason to
    // spend the request budget that claude-swap shares with every other tool.
    expect(cli.calls).toHaveLength(spent);
  });

  it("drops the reading the empty-CLI branch would otherwise hold onto as well", async () => {
    // The other fallback: the floor allows a self-poll, `claude --print /usage`
    // answers without its quota lines, and the branch #289 fixed serves the last
    // known good reading instead of regressing the panel to 0%. That reading is
    // the previous account's too.
    await readingForAccount2();
    swap.entry = null;
    cli.stdout = "";          // not even the preamble, so nothing counts as a run

    mod.invalidateQuotaCache();
    const after = await mod.fetchClaudeQuota({ force: true });

    expect(cli.calls.length).toBeGreaterThan(0);   // it really did try
    expect(after.ok).toBe(false);
    expect(after.session5hPct).toBeUndefined();
    expect(after.stale).toBeUndefined();
  });

  it("still holds a reading through a bad read that no switch preceded", async () => {
    // The guard on the other side: invalidating too eagerly would throw away
    // numbers the deck paid a request for every time the CLI hiccuped, which is
    // the regression #289 exists to prevent.
    const before = await readingForAccount2();
    swap.entry = null;

    const after = await mod.fetchClaudeQuota({ force: true });

    expect(after).toMatchObject({ ok: true, session5hPct: 63, stale: true });
    expect(after.fetchedAt).toBe(before.fetchedAt);   // the answer it actually is
  });
});

const web = fileURLToPath(new URL("..", import.meta.url));
const server = readFileSync(`${web}../server/index.mjs`, "utf8");
const handler = /async function handleClaudeAccountSwitch[\s\S]*?\n}/.exec(server)?.[0] ?? "";

describe("the switch route", () => {
  it("tells the quota module the account moved, beside the roster it already told", () => {
    // The whole point of the module-state work above: nothing else in the deck
    // is in a position to make this call. /api/quota is polled by a component
    // that never hears about a switch, so ?refresh=1 can never arrive for one.
    expect(handler).toContain("invalidateClaudeAccountsCache();");
    expect(handler).toContain("invalidateQuotaCache();");
    expect(handler).toContain('join(PKG_ROOT, "src/server/quota.mjs")');
  });

  it("keeps the numbers when the switch was refused, since nothing moved", () => {
    // cswap answers `{ ok: false }` for a slot that does not exist, a missing
    // binary or a timeout. The active account is then whatever it was, and
    // discarding a reading would cost a real answer to fix nothing.
    expect(handler).toMatch(/if \(result\.ok\) \{[\s\S]*invalidateQuotaCache\(\);/);
  });
});
