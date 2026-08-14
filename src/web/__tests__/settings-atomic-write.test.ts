// Reported: the hook installer replaced ~/.claude/settings.json with a bare
// writeFile, and did it on every launch even when the entries it wanted were
// already there and identical. Two ways that loses data: a crash or power cut
// between truncate and flush leaves a half-written settings.json, and any change
// another process makes to the file between our read and our write is silently
// discarded. These tests pin the two halves of the fix — the replacement is a
// same-directory temp file renamed over the target, and a launch that would
// produce identical bytes writes nothing at all.
import { describe, it, expect, afterAll } from "vitest";
import {
  linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The installer resolves the Claude config dir at import time: CLAUDE_CONFIG_DIR
// when set, otherwise ~/.claude via os.homedir(), which reads $HOME on POSIX and
// %USERPROFILE% on Windows. The override is cleared and both home variables are
// pointed at a temp directory BEFORE the module is loaded, so nothing in this
// file can reach the developer's own config dir on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-atomic-"));
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

// A hard link is the only portable way to ask "was this file replaced, or
// overwritten in place?" — both names share one inode until a rename gives the
// visible name a new one. Almost every filesystem supports it; the one that
// does not gets the test skipped rather than a false failure.
const hardLinksWork = (() => {
  const probe = join(FAKE_HOME, "probe");
  const linked = join(FAKE_HOME, "probe.link");
  try {
    writeFileSync(probe, "x");
    linkSync(probe, linked);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
    rmSync(linked, { force: true });
  }
})();

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

describe("installHooks writes settings.json atomically", () => {
  it.skipIf(!hardLinksWork)("replaces the file by rename instead of writing into it", async () => {
    rmSync(SETTINGS, { force: true });
    const original = JSON.stringify({ model: "opus" }, null, 2) + "\n";
    writeFileSync(SETTINGS, original, "utf8");

    // Second name for the same inode. Whatever the installer does to the bytes
    // of the existing file, this name sees it too.
    const witness = join(CLAUDE_DIR, "settings.witness");
    linkSync(SETTINGS, witness);

    await installHooks({ provider: "claude" });

    // settings.json has the hooks; the old inode still holds exactly what was
    // there before. That can only happen if a different file was renamed over
    // the name — an in-place write would have changed both.
    expect(readFileSync(witness, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).hooks.SessionStart).toHaveLength(1);
    rmSync(witness, { force: true });
  });

  it("leaves no temp file behind on a successful install", async () => {
    rmSync(SETTINGS, { force: true });
    await installHooks({ provider: "claude" });
    const strays = readdirSync(CLAUDE_DIR).filter(name => name.includes(".tmp"));
    expect(strays).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps the file's permissions", async () => {
    // A settings.json the user restricted to 0600 must not come back 0644 just
    // because a rename creates a fresh directory entry.
    rmSync(SETTINGS, { force: true });
    writeFileSync(SETTINGS, JSON.stringify({ model: "opus" }, null, 2) + "\n", { mode: 0o600 });

    await installHooks({ provider: "claude" });

    expect(statSync(SETTINGS).mode & 0o777).toBe(0o600);
  });
});

describe("installHooks skips the write when nothing would change", () => {
  it("does not touch the file on a second install", async () => {
    rmSync(SETTINGS, { force: true });
    writeFileSync(SETTINGS, JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(git*)"] },
    }, null, 2) + "\n", "utf8");

    const first = await installHooks({ provider: "claude" });
    expect(first.changed).toBe(true);
    const installed = readFileSync(SETTINGS, "utf8");

    // Back-date the file to something no write could produce. mtime is the one
    // "was this written?" signal every platform reports the same way — comparing
    // inodes is not portable to Windows, and a fresh mtime is not distinguishable
    // from the previous one at this speed.
    const longAgo = new Date("2001-01-01T00:00:00Z");
    utimesSync(SETTINGS, longAgo, longAgo);

    const second = await installHooks({ provider: "claude" });
    expect(second.changed).toBe(false);
    expect(statSync(SETTINGS).mtime.getTime()).toBe(longAgo.getTime());
    expect(readFileSync(SETTINGS, "utf8")).toBe(installed);
  });

  it("writes again as soon as the file really differs", async () => {
    // The skip is a byte comparison, not a "we ran once already" flag: strip our
    // hooks back out and the next launch has to put them back.
    const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
    delete settings.hooks;
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf8");

    const res = await installHooks({ provider: "claude" });

    expect(res.changed).toBe(true);
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).hooks.SessionStart).toHaveLength(1);
  });

  it("preserves a concurrent edit made between two launches", async () => {
    // The lost-update case from the report, in slow motion: Claude Code adds a
    // permission after our install. The next launch must not roll it back.
    const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
    settings.permissions = { allow: ["Bash(git*)", "Bash(npm test)"] };
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf8");

    await installHooks({ provider: "claude" });

    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.permissions.allow).toContain("Bash(npm test)");
    expect(written.hooks.SessionStart).toHaveLength(1);
  });
});
