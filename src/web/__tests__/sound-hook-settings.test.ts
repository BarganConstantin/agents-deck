// Reported: the deck's sound toggle read ~/.claude/settings.json with a
// JSON.parse wrapped in a bare catch, so a file made unparseable by a trailing
// comma or a Notepad BOM looked exactly like a missing one. Clicking the switch
// then wrote that empty object back with only the sound entry in it, and every
// permission, env var and user hook in the file was gone — atomically, and
// reporting ok. These tests pin the fix: the toggle refuses on a file it cannot
// parse, says so, and still works on the files it can.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module resolves its paths at import time: settings.json from
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) and the parked-hooks file from
// os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All
// three are pointed at a temp directory BEFORE the module is loaded, so nothing
// here can reach the real ~/.claude on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-sound-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/sound-hook.mjs");
const { setSoundHook, soundHookStatus, restoreParkedSoundHooks, SETTINGS_PATH, PARKED_PATH } = mod;

// Belt and braces. If either path ever stopped honouring the environment, this
// file would be rewriting the developer's own settings — so fail before a
// single test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: sound-hook resolved ${p}, outside ${FAKE_HOME}`);
  }
}

mkdirSync(FAKE_CLAUDE, { recursive: true });

const restore = (key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR", was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("CLAUDE_CONFIG_DIR", prevConfigDir);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

// The reported reproduction: a settings.json a human would call valid, rejected
// by JSON.parse over one trailing comma, carrying the things worth losing.
const CORRUPT = [
  "{",
  '  "permissions": { "allow": ["Bash(git*)"] },',
  '  "env": { "FOO": "bar" },',
  '  "hooks": { "PreToolUse": [{ "hooks": [{ "type": "command", "command": "audit.sh" }] }] },',
  "}",
  "",
].join("\n");

describe("the sound toggle and a settings.json it cannot parse", () => {
  it("refuses to turn the sound on, and keeps every byte of the file", async () => {
    writeFileSync(SETTINGS_PATH, CORRUPT, "utf8");

    const res = await setSoundHook(true);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("settings_unreadable");
    expect(res.message).toMatch(/Refusing to overwrite/);
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(CORRUPT);
  });

  it("refuses to turn the sound off just the same", async () => {
    writeFileSync(SETTINGS_PATH, CORRUPT, "utf8");

    const res = await setSoundHook(false);

    expect(res.ok).toBe(false);
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(CORRUPT);
  });

  it("reports the refusal instead of a healthy 'off' the user would act on", async () => {
    writeFileSync(SETTINGS_PATH, CORRUPT, "utf8");

    const status = await soundHookStatus();

    expect(status.ok).toBe(false);
    expect(status.reason).toBe("settings_unreadable");
    expect(status.settingsPath).toBe(SETTINGS_PATH);
  });

  it("refuses to restore parked hooks, and keeps them parked for later", async () => {
    // Park one of the user's own hooks against a readable file first, so the
    // restore has something to put back.
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }] },
    }, null, 2), "utf8");
    await setSoundHook(true);
    expect((await soundHookStatus()).parked).toBe(1);

    // Now the file goes bad before they shift-click to get it back.
    writeFileSync(SETTINGS_PATH, CORRUPT, "utf8");
    const res = await restoreParkedSoundHooks();

    expect(res.ok).toBe(false);
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(CORRUPT);
    // Still parked — the restore works once they repair the file.
    expect(JSON.parse(readFileSync(PARKED_PATH, "utf8"))).toHaveLength(1);
  });
});

describe("the sound toggle and a settings.json it can read", () => {
  it("keeps the rest of the file when it adds and removes its own hook", async () => {
    rmSync(PARKED_PATH, { force: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(git*)"] },
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "audit.sh" }] }] },
    }, null, 2), "utf8");

    expect((await setSoundHook(true)).ok).toBe(true);
    let written = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.permissions).toEqual({ allow: ["Bash(git*)"] });
    expect(written.hooks.PreToolUse).toHaveLength(1);
    expect(written.hooks.Stop).toHaveLength(1);

    expect((await setSoundHook(false)).ok).toBe(true);
    written = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.hooks.PreToolUse).toHaveLength(1);
    expect(written.hooks.Stop).toBeUndefined();
  });

  it("reads a file saved with a UTF-8 BOM, which is how Notepad writes one", async () => {
    // A BOM makes JSON.parse throw on JSON that is otherwise perfectly fine, so
    // before the fix this exact file was one of the ones that got destroyed. It
    // has to parse, not merely survive.
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(SETTINGS_PATH, bom + JSON.stringify({ model: "sonnet" }, null, 2), "utf8");

    expect((await setSoundHook(true)).ok).toBe(true);

    const written = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    expect(written.model).toBe("sonnet");
    expect(written.hooks.Stop).toHaveLength(1);
  });

  it("still creates the file when there is genuinely none — ENOENT is not corruption", async () => {
    rmSync(SETTINGS_PATH, { force: true });

    expect((await setSoundHook(true)).ok).toBe(true);

    const written = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    expect(written.hooks.Stop).toHaveLength(1);
  });
});
