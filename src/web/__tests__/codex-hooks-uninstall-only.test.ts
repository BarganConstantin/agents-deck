// Codex hooks do not fire reliably on Windows, so the deck stopped installing
// them and reads Codex's own rollout files instead. What was left behind was a
// full install recipe for a provider nothing installs — event list, hook
// directory, the lot — that still looked live enough to maintain (#253).
//
// Deleting it is only safe if the other half still works: a machine that ran an
// older deck has our forwarders sitting in ~/.codex/hooks.json, and
// `--uninstall` is the only thing that will ever take them out. So the entry
// keeps its settingsPath and nothing else, and these tests pin both sides of
// that — the install path refuses out loud rather than half-writing a Codex
// hook, and the uninstall path still finds and removes the old ones.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two temp dirs, in place BEFORE the installer is imported — it resolves both
// config dirs once at module load. $HOME and %USERPROFILE% are both set because
// os.homedir() reads one on POSIX and the other on Windows, so on no platform
// can this file reach the developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-codex-home-"));
const FAKE_CODEX = mkdtempSync(join(tmpdir(), "ccdeck-codex-dir-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = FAKE_CODEX;

// @ts-expect-error — .mjs server module, no types
const installer = await import("../../server/installer.mjs");
const { installHooks, uninstallHooks, CODEX_DIR } = installer as {
  installHooks: (o: { provider: string }) => Promise<unknown>;
  uninstallHooks: (o: { provider: string }) => Promise<{ changed: boolean; settingsPath: string }>;
  CODEX_DIR: string;
};

// Belt and braces: every write below lands under whatever the installer
// resolved, so if the override were ignored this file would edit a real
// hooks.json. Fail before a single test gets the chance.
if (!String(CODEX_DIR).startsWith(FAKE_CODEX)) {
  throw new Error(`refusing to run: installer resolved ${CODEX_DIR}, outside ${FAKE_CODEX}`);
}

const HOOKS = join(FAKE_CODEX, "hooks.json");

/** A hooks.json as an older deck would have left it. */
const legacy = () => JSON.stringify({
  hooks: {
    SessionStart: [
      { "__agent-dag": true, hooks: [{ type: "command", command: "node hook.js --provider codex" }] },
      { hooks: [{ type: "command", command: "echo mine" }] },
    ],
  },
}, null, 2) + "\n";

beforeEach(() => {
  rmSync(HOOKS, { force: true });
});

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(FAKE_CODEX, { recursive: true, force: true });
});

describe("installing hooks for Codex", () => {
  it("refuses, because nothing installs Codex hooks any more", async () => {
    await expect(installHooks({ provider: "codex" })).rejects.toThrow(/uninstall-only/);
  });

  it("leaves no hooks.json behind when it refuses", async () => {
    await installHooks({ provider: "codex" }).catch(() => {});
    expect(existsSync(HOOKS)).toBe(false);
  });

  it("still names an unknown provider as unknown rather than uninstall-only", async () => {
    await expect(installHooks({ provider: "gemini" })).rejects.toThrow(/unknown provider/);
  });
});

describe("uninstalling hooks an older deck installed", () => {
  it("removes our forwarder from a hooks.json we no longer write", async () => {
    writeFileSync(HOOKS, legacy());
    const res = await uninstallHooks({ provider: "codex" });
    expect(res.changed).toBe(true);
    expect(res.settingsPath).toBe(HOOKS);
    expect(readFileSync(HOOKS, "utf8")).not.toContain("--provider codex");
  });

  it("leaves the user's own hooks in that file alone", async () => {
    writeFileSync(HOOKS, legacy());
    await uninstallHooks({ provider: "codex" });
    expect(JSON.parse(readFileSync(HOOKS, "utf8")).hooks.SessionStart).toHaveLength(1);
    expect(readFileSync(HOOKS, "utf8")).toContain("echo mine");
  });

  it("says nothing changed when there is no hooks.json at all", async () => {
    expect((await uninstallHooks({ provider: "codex" })).changed).toBe(false);
  });
});

describe("the Codex event list", () => {
  it("is gone, since no settings file was ever written from it", () => {
    expect(Object.keys(installer)).not.toContain("CODEX_EVENTS");
  });
});
