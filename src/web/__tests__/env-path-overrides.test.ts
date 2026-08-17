// Two path readers built their own path to a directory the environment moves,
// and so read a tree that is empty on every machine that moves it.
//
// `quota.mjs` opened `~/.claude/.credentials.json` while Claude Code — and every
// other module on the Claude side of this deck — honours CLAUDE_CONFIG_DIR,
// which REPLACES ~/.claude rather than overlaying it. The failure is silent by
// construction: a missing credentials file is indistinguishable from a machine
// that keeps its token in the Keychain, so readOAuthToken() answered null
// forever and the quota chain skipped source 2 (one HTTPS GET, ~0.3s) for
// source 3 — up to three `claude --print /usage` child processes, ~3.0s each,
// each spending a request from the same ~28-30/hour usage budget that source 2
// would have spent one of. That budget is shared with claude-swap, and blowing
// it is what 429-ed claude-swap and emptied the accounts panel; see the header
// of src/server/quota.mjs and src/server/self-update.mjs.
//
// `bin/deck.js` printed `~/.codex/sessions` in the boot banner while the watcher
// in index.mjs tails `$CODEX_HOME/sessions`. Cosmetic until Codex sessions do
// not show up, at which point it is the only diagnostic the deck prints and it
// names a directory that does not exist.
//
// Everything below runs against a temp sandbox: HOME, USERPROFILE,
// CLAUDE_CONFIG_DIR, CODEX_HOME and claude-swap's store root all point inside
// it, so no assertion here can be satisfied — or contaminated — by the
// developer's own configuration.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-env-paths-"));
const FAKE_HOME   = join(SANDBOX, "home");
const FAKE_CLAUDE = join(SANDBOX, "claude-config");
const FAKE_CODEX  = join(SANDBOX, "codex-home");
// An empty directory that stands in for PATH while the quota chain runs, so a
// fall-through to source 3 cannot reach the real `claude` on the developer's
// machine — it must FAIL that test, not spend a request proving it.
const EMPTY_PATH  = join(SANDBOX, "no-bin");
for (const d of [FAKE_HOME, FAKE_CLAUDE, FAKE_CODEX, EMPTY_PATH]) mkdirSync(d, { recursive: true });

// Every one of these is read at module load by something imported below, so the
// sandbox has to be in place before the first import — and $HOME / %USERPROFILE%
// are both set because node's homedir() reads whichever one this platform has.
const prevEnv: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  // claude-swap's store is source 1 of the quota chain. Pointed into the
  // sandbox so the chain finds nothing and has to reach source 2 — which is the
  // source under test — instead of answering out of the developer's real store.
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
  PATH: process.env.PATH,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = FAKE_CODEX;
process.env.CLAUDE_SWAP_BACKUP = join(SANDBOX, "claude-swap-store");

// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const { credentialsPath, fetchClaudeQuota } = await import("../../server/quota.mjs");
// @ts-expect-error — .mjs server module, no types
const { CODEX_SESSIONS_DIR } = await import("../../server/index.mjs");

// Refuse to run at all if the sandbox did not take. The canonical reader is the
// one thing here that was already correct, so this checks the sandbox rather
// than the fix, and would fire on a machine where the developer has
// CLAUDE_CONFIG_DIR set for real and this file failed to override it.
const resolved = String(claudeConfigDir());
if (!resolved.startsWith(SANDBOX)) {
  throw new Error(`refusing to run: claude config dir resolved to ${resolved}, outside ${SANDBOX}`);
}

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  vi.unstubAllGlobals();
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("the OAuth credentials the quota chain borrows a token from", () => {
  it("is read out of $CLAUDE_CONFIG_DIR, which is where Claude Code put it", () => {
    expect(credentialsPath()).toBe(join(FAKE_CLAUDE, ".credentials.json"));
  });

  it("still falls back to ~/.claude when nothing has moved the config dir", () => {
    // The override is absent on most machines, and this is the path that has
    // always worked — a fix that followed the variable but lost the default
    // would break every deck that never set it.
    const was = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      expect(credentialsPath()).toBe(join(FAKE_HOME, ".claude", ".credentials.json"));
    } finally {
      process.env.CLAUDE_CONFIG_DIR = was;
    }
  });

  it("never reads ~/.claude on a machine that set the override", () => {
    // CLAUDE_CONFIG_DIR is a replacement, not an overlay: there is nothing in
    // ~/.claude to fall back TO, so a reader that consults it is not being
    // careful, it is being wrong.
    expect(credentialsPath()).not.toContain(join(FAKE_HOME, ".claude"));
  });
});

describe("which quota source a readable token buys", () => {
  it("answers from the OAuth API and spawns no Claude Code at all", async () => {
    // Source 2 costs one HTTPS GET. Source 3 costs up to three whole `claude
    // --print /usage` processes — measured at ~3.0s each against ~0.3s for the
    // GET — and each of those spends a request from the same hourly budget the
    // GET would have spent one of. Which source runs is decided entirely by
    // whether the credentials file was found, which is why this test exists in
    // the same file as the path above it.
    writeFileSync(
      join(FAKE_CLAUDE, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat-sandbox",
          // Far enough out that this file does not start failing on a date.
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
      }),
      "utf8",
    );

    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: { headers?: Record<string, string> } = {}) => {
      seen.push(String(init.headers?.Authorization ?? ""));
      expect(String(url)).toBe("https://api.anthropic.com/api/oauth/usage");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          five_hour: { utilization: 41, resets_at: "2026-08-17T14:40:00Z" },
          seven_day: { utilization: 18, resets_at: "2026-08-24T04:00:00Z" },
        }),
      };
    }));

    // Nothing executable is reachable while the chain runs. If the credentials
    // path regressed, source 3 fails here rather than spending a real request —
    // and says so through the log line counted below.
    const realPath = process.env.PATH;
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    process.env.PATH = EMPTY_PATH;
    let quota: { ok?: boolean; source?: string; session5hPct?: number; week7dPct?: number };
    try {
      quota = await fetchClaudeQuota({ force: true });
    } finally {
      process.env.PATH = realPath;
      console.error = realError;
    }

    expect(quota.ok).toBe(true);
    expect(quota.source, "fell through to the CLI, which is the expensive path").toBe("api");
    expect(quota.session5hPct).toBe(41);
    expect(quota.week7dPct).toBe(18);
    // One call, carrying the token that was found where Claude Code left it.
    expect(seen).toEqual(["Bearer sk-ant-oat-sandbox"]);
    // And the direct evidence that no child process was attempted: source 3
    // reports every failed `claude` run through this line, three times per poll.
    expect(errors.filter(e => /claude CLI failed/.test(e))).toEqual([]);
  }, 20_000);
});

describe("the Codex sessions directory the boot banner names", () => {
  it("is the one the watcher tails, resolved from $CODEX_HOME", () => {
    expect(CODEX_SESSIONS_DIR).toBe(join(FAKE_CODEX, "sessions"));
  });

  it("is printed by bin/deck.js from that same binding rather than rebuilt", () => {
    // bin/deck.js boots a server and refuses to start without a built UI, so it
    // cannot be run from here; what is checkable — and what the bug actually was
    // — is whether the banner row names the watcher's directory or computes a
    // second one of its own.
    const deck = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
    const watching = deck.split("\n").find(l => l.includes("Codex sessions") && l.includes("watching"));
    expect(watching, "the banner no longer has a row for the sessions directory").toBeDefined();
    expect(watching).toContain("CODEX_SESSIONS_DIR");
  });

  it("is nowhere rebuilt from the home directory in bin/deck.js", () => {
    // The exact expression that shipped. Spelled loosely enough that reordering
    // the join's arguments or switching quote style cannot smuggle it back.
    const deck = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
    const rebuilt = deck
      .split("\n")
      .filter(l => !l.trimStart().startsWith("//"))
      .filter(l => /homedir\(\)/.test(l) && /\.codex/.test(l));
    expect(rebuilt).toEqual([]);
  });
});
