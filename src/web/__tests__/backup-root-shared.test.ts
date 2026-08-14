// The claude-swap store had two path resolvers: claude-accounts.mjs, which the
// Accounts panel reads through, and a private copy in cswap-admin.mjs, whose
// readStore() diffs sequence.json before and after `cswap add` to work out
// which slot the new account landed on (#252). They agreed on an ordinary
// machine and disagreed on a Linux one with a relative XDG_DATA_HOME: the copy
// joined it as given, resolving the store against whatever directory the deck
// was launched from, while the reader ignored it as the XDG base-dir spec
// requires. Two roots means the panel reads one store while the add-detector
// looks at another and reports a successful sign-in as having created nothing.
//
// The spec-correct one won and is now exported and shared. These tests pin the
// rule and, more importantly, pin that both halves land on the same directory
// — which is the property that was actually broken.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The XDG rule only runs on Linux, and a test that skipped itself everywhere
// else would leave the rule unchecked on the two platforms most people develop
// on. os.platform() is forced instead, so this file asserts the same thing on
// Linux, macOS and Windows. Everything else in node:os stays real — homedir()
// in particular, because it reads the sandboxed $HOME / %USERPROFILE% below.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, platform: () => "linux" }, platform: () => "linux" };
});

// In place BEFORE the modules are imported: both resolve the store out of the
// home directory when no override is set, and a test that reached the real one
// would be reading — and this file writes sequence.json — the accounts of
// whoever is running it.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-store-home-"));
const FAKE_XDG = mkdtempSync(join(tmpdir(), "ccdeck-store-xdg-"));
const FAKE_OVERRIDE = mkdtempSync(join(tmpdir(), "ccdeck-store-override-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  AGENTS_DECK_CSWAP: process.env.AGENTS_DECK_CSWAP,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
// A name that cannot resolve, so nothing here can reach a real cswap binary.
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

// @ts-expect-error — plain JS module, no types
const { backupRoot } = await import("../../server/claude-accounts.mjs");
// @ts-expect-error — plain JS module, no types
const { readStore } = await import("../../server/cswap-admin.mjs");

const SANDBOXES = [FAKE_HOME, FAKE_XDG, FAKE_OVERRIDE];

/** Every write below goes to whatever backupRoot() names, so if the sandbox
 *  ever failed to take hold this file would create a store in the developer's
 *  own home directory. Refuse before that can happen. */
function sandboxedRoot(): string {
  const root = String(backupRoot());
  if (!SANDBOXES.some(dir => root.startsWith(dir))) {
    throw new Error(`refusing to run: store resolved to ${root}, outside ${SANDBOXES.join(", ")}`);
  }
  return root;
}

/** Put one account in the store the resolver names, and answer with its path. */
function seedStore(): string {
  const root = sandboxedRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "sequence.json"),
    JSON.stringify({ accounts: { 1: { email: "someone@example.com" } }, activeAccountNumber: 1 }),
  );
  return root;
}

beforeEach(() => {
  delete process.env.CLAUDE_SWAP_BACKUP;
  delete process.env.XDG_DATA_HOME;
});

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  for (const dir of SANDBOXES) rmSync(dir, { recursive: true, force: true });
});

describe("where the claude-swap store is", () => {
  it("obeys CLAUDE_SWAP_BACKUP ahead of everything else", () => {
    process.env.CLAUDE_SWAP_BACKUP = FAKE_OVERRIDE;
    process.env.XDG_DATA_HOME = FAKE_XDG;
    expect(backupRoot()).toBe(FAKE_OVERRIDE);
  });

  it("puts the store under an absolute XDG_DATA_HOME", () => {
    process.env.XDG_DATA_HOME = FAKE_XDG;
    expect(backupRoot()).toBe(join(FAKE_XDG, "claude-swap"));
  });

  it("ignores a relative XDG_DATA_HOME, which the spec calls invalid", () => {
    process.env.XDG_DATA_HOME = "no-such-relative-xdg";
    expect(backupRoot()).toBe(join(FAKE_HOME, ".local/share/claude-swap"));
  });

  it("falls back to the home directory when XDG_DATA_HOME is unset", () => {
    expect(backupRoot()).toBe(join(FAKE_HOME, ".local/share/claude-swap"));
  });
});

describe("the accounts reader and the add-detector", () => {
  it("agree on the store when CLAUDE_SWAP_BACKUP names it", async () => {
    process.env.CLAUDE_SWAP_BACKUP = FAKE_OVERRIDE;
    seedStore();
    expect((await readStore()).slots).toEqual(["1"]);
  });

  it("agree on the store an absolute XDG_DATA_HOME names", async () => {
    process.env.XDG_DATA_HOME = FAKE_XDG;
    seedStore();
    expect((await readStore()).slots).toEqual(["1"]);
  });

  it("agree that a relative XDG_DATA_HOME names nothing", async () => {
    process.env.XDG_DATA_HOME = "no-such-relative-xdg";
    const root = seedStore();
    expect(root).toBe(join(FAKE_HOME, ".local/share/claude-swap"));
    expect((await readStore()).slots).toEqual(["1"]);
  });
});
