// Reported: a ~/.claude/settings.json that JSON.parse rejects — a stray comma,
// a UTF-8 BOM from Notepad, a half-written file caught mid-save by another
// process — was treated exactly like a missing one, and the hook installer
// wrote a fresh file containing nothing but its own hooks. Every permission,
// env var, model pin, statusLine and user hook in it was gone, with no backup,
// on a code path that runs unconditionally at every boot. These tests pin both
// halves of the fix: the file survives, and the refusal is loud.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The installer resolves the Claude config dir at import time: CLAUDE_CONFIG_DIR
// when set, otherwise ~/.claude via os.homedir(), which reads $HOME on POSIX and
// %USERPROFILE% on Windows. The override is cleared and both home variables are
// pointed at a temp directory BEFORE the module is loaded, so nothing in this
// file can reach the developer's own config dir on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-settings-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCodexHome = process.env.CODEX_HOME;
const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.CODEX_HOME;
delete process.env.CLAUDE_CONFIG_DIR;

// @ts-expect-error — .mjs server module, no types
const { installHooks, CLAUDE_DIR } = await import("../../server/installer.mjs");

// Belt and braces. If homedir() ever stopped honouring the environment, this
// file would be rewriting the developer's own settings.json — so fail before a
// single test gets the chance.
if (!String(CLAUDE_DIR).startsWith(FAKE_HOME)) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${FAKE_HOME}`);
}

const SETTINGS = join(CLAUDE_DIR, "settings.json");
mkdirSync(CLAUDE_DIR, { recursive: true });

const restore = (
  key: "HOME" | "USERPROFILE" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
  was: string | undefined,
) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("CODEX_HOME", prevCodexHome);
  restore("CLAUDE_CONFIG_DIR", prevClaudeConfigDir);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("installHooks and a settings.json it cannot parse", () => {
  it("refuses, keeps every byte, and names the file", async () => {
    // Valid-looking to a human, rejected by JSON.parse: one trailing comma.
    const corrupt = [
      "{",
      '  "model": "opus",',
      '  "permissions": { "allow": ["Bash(git*)"] },',
      "}",
      "",
    ].join("\n");
    writeFileSync(SETTINGS, corrupt, "utf8");

    await expect(installHooks({ provider: "claude" })).rejects.toMatchObject({
      code: "SETTINGS_UNREADABLE",
    });
    // The whole point: what the user had is still there, untouched.
    expect(readFileSync(SETTINGS, "utf8")).toBe(corrupt);
  });

  it("says what to do about it, since only the user can repair the file", async () => {
    writeFileSync(SETTINGS, "{ oops", "utf8");
    await expect(installHooks({ provider: "claude" })).rejects.toThrow(/Refusing to overwrite/);
    // A plain string asserts a substring, so the Windows path with its
    // backslashes is matched as-is rather than as a regex.
    await expect(installHooks({ provider: "claude" })).rejects.toThrow(SETTINGS);
    expect(readFileSync(SETTINGS, "utf8")).toBe("{ oops");
  });

  it("refuses parseable JSON that is not a settings object, rather than writing over it", async () => {
    // Merging `hooks` into an array would produce a file Claude Code cannot
    // read, and the original would be gone.
    writeFileSync(SETTINGS, '["not", "settings"]', "utf8");
    await expect(installHooks({ provider: "claude" })).rejects.toThrow(/Refusing to overwrite/);
    expect(readFileSync(SETTINGS, "utf8")).toBe('["not", "settings"]');
  });
});

describe("installHooks and a settings.json it can read", () => {
  it("still creates the file when there is genuinely none — ENOENT is not corruption", async () => {
    rmSync(SETTINGS, { force: true });
    const res = await installHooks({ provider: "claude" });
    expect(res.settingsPath).toBe(SETTINGS);
    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.hooks.SessionStart).toHaveLength(1);
  });

  it("keeps the user's settings and their own hooks alongside ours", async () => {
    writeFileSync(SETTINGS, JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(git*)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    }, null, 2), "utf8");

    await installHooks({ provider: "claude" });

    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.permissions).toEqual({ allow: ["Bash(git*)"] });
    // Ours appended, theirs still first — dedupe only ever drops our own marks.
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0].hooks[0].command).toBe("say done");
  });

  it("reads a file saved with a UTF-8 BOM, which is how Notepad writes one", async () => {
    // This is the reported reproduction. A BOM makes JSON.parse throw on a file
    // whose JSON is perfectly fine, so before the fix this exact file was the
    // one that got destroyed. It has to parse, not merely survive. Written as
    // fromCharCode so the mark is visible to whoever reads this next.
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(SETTINGS, bom + JSON.stringify({ model: "sonnet" }, null, 2), "utf8");

    await installHooks({ provider: "claude" });

    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.model).toBe("sonnet");
    expect(written.hooks.SessionStart).toHaveLength(1);
  });

  it("stays idempotent — a second install does not stack duplicate forwarders", async () => {
    rmSync(SETTINGS, { force: true });
    await installHooks({ provider: "claude" });
    await installHooks({ provider: "claude" });
    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.hooks.SessionStart).toHaveLength(1);
  });

  it("writes nothing at all when it refuses — no stray hook dir left behind", async () => {
    const dir = join(CLAUDE_DIR, "agent-dag");
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(SETTINGS, "{,}", "utf8");
    await expect(installHooks({ provider: "claude" })).rejects.toThrow(/Refusing to overwrite/);
    expect(existsSync(dir)).toBe(false);
  });
});
