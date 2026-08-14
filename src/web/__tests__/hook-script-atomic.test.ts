// Reported: the installer put hook.js into place with copyFile, which truncates
// the destination and only then writes it. That file is the script every live
// Claude Code session executes on each tool call, and the copy happens on every
// deck boot — so booting the deck with sessions open can hand one of them an
// empty or half-written program: the event is silently dropped, or node exits
// with a SyntaxError in the user's session. These tests pin the fix: the script
// is replaced by renaming a finished copy over the name, and a re-install that
// would produce the same bytes does not touch the file at all.
import { describe, it, expect, afterAll } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The installer resolves the Claude config dir at import time: CLAUDE_CONFIG_DIR
// when set, otherwise ~/.claude via os.homedir(), which reads $HOME on POSIX and
// %USERPROFILE% on Windows. All three are pointed inside a temp directory BEFORE
// the module is loaded, so nothing here can reach the developer's own ~/.claude
// on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-hookscript-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCodexHome = process.env.CODEX_HOME;
const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
delete process.env.CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const { installHooks, CLAUDE_DIR } = await import("../../server/installer.mjs");

// Belt and braces. If the config dir ever stopped honouring the environment,
// this file would be rewriting the developer's own hook script — so fail before
// a single test gets the chance.
if (!String(CLAUDE_DIR).startsWith(FAKE_HOME)) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${FAKE_HOME}`);
}

const INSTALL_DIR = join(CLAUDE_DIR, "agent-dag");
const INSTALLED = join(INSTALL_DIR, "hook.js");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const PACKAGED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
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

describe("installHooks puts hook.js in place atomically", () => {
  it("installs the packaged script byte for byte", async () => {
    rmSync(SETTINGS, { force: true });
    rmSync(INSTALL_DIR, { recursive: true, force: true });

    const res = await installHooks({ provider: "claude" });

    expect(res.hookPath).toBe(INSTALLED);
    expect(readFileSync(INSTALLED, "utf8")).toBe(readFileSync(PACKAGED, "utf8"));
  });

  it.skipIf(!hardLinksWork)("replaces the script by rename instead of writing into it", async () => {
    // Stand in for an outdated hook.js from a previous version: the bytes differ,
    // so the installer has to replace it. A session that opened the old file
    // before the install keeps reading a whole program — which is what the second
    // name proves here, since an in-place truncate-and-write would have emptied it.
    const stale = "// installed by an older deck\n";
    writeFileSync(INSTALLED, stale, "utf8");
    const witness = join(INSTALL_DIR, "hook.witness");
    rmSync(witness, { force: true });
    linkSync(INSTALLED, witness);

    await installHooks({ provider: "claude" });

    expect(readFileSync(witness, "utf8")).toBe(stale);
    expect(readFileSync(INSTALLED, "utf8")).toBe(readFileSync(PACKAGED, "utf8"));
    rmSync(witness, { force: true });
  });

  it("leaves no temp file behind in the hook dir", async () => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    await installHooks({ provider: "claude" });
    expect(readdirSync(INSTALL_DIR).filter(name => name.includes(".tmp"))).toEqual([]);
  });

  it("does not touch the script when the installed one is already identical", async () => {
    // The boot-with-sessions-open case. Every launch re-installs, and on all but
    // the first the bytes match — so the safest thing is to not replace the file
    // a session may be executing at all.
    await installHooks({ provider: "claude" });

    // Back-date the file to something no write could produce. mtime is the one
    // "was this written?" signal every platform reports the same way.
    const longAgo = new Date("2001-01-01T00:00:00Z");
    utimesSync(INSTALLED, longAgo, longAgo);

    await installHooks({ provider: "claude" });

    expect(statSync(INSTALLED).mtime.getTime()).toBe(longAgo.getTime());
    expect(readFileSync(INSTALLED, "utf8")).toBe(readFileSync(PACKAGED, "utf8"));
  });
});
