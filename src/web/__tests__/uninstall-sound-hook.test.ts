// Reported: `agents-deck --uninstall` left the deck's sound hook installed.
// uninstallHooks only recognises the `__agent-dag` mark the event forwarders
// carry, and the sound entry is marked `__agent-dag-sound` with a command
// pointing at notify.js — so it survived, and a sound kept playing on every turn
// after the deck was supposedly gone. Worse, turning the toggle on parks the
// user's own afplay/PowerShell Stop hooks in ~/.agents-deck/parked-sound-hooks.json
// and only the running deck UI can put them back; once uninstalled, hooks the
// user wrote themselves were stranded in a file they had never heard of. These
// tests drive the real CLI and pin both halves: the deck's entry goes, and the
// user's own hooks come back.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Both server modules resolve their paths at import time: settings.json from
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) and the parked-hooks file from
// os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All
// three are pointed at a temp directory BEFORE anything is loaded — and passed
// to the CLI child process below — so nothing here can reach the real ~/.claude
// on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-uninstall-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;

// @ts-expect-error — .mjs server module, no types
const soundMod = await import("../../server/sound-hook.mjs");
// @ts-expect-error — .mjs server module, no types
const installerMod = await import("../../server/installer.mjs");
const { setSoundHook, uninstallSoundHook, SETTINGS_PATH, PARKED_PATH } = soundMod;
const { installHooks, CLAUDE_DIR } = installerMod;

// Belt and braces. If any of these ever stopped honouring the environment, this
// file would be rewriting the developer's own settings — so fail before a single
// test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH, CLAUDE_DIR]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: resolved ${p}, outside ${FAKE_HOME}`);
  }
}

mkdirSync(FAKE_CLAUDE, { recursive: true });

const DECK_CLI = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const CHILD_ENV = {
  ...process.env,
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  CLAUDE_CONFIG_DIR: FAKE_CLAUDE,
};

/** Run the real `agents-deck --uninstall`. Throws if it exits non-zero. */
const runUninstall = () =>
  execFileSync(process.execPath, [DECK_CLI, "--uninstall"], {
    env: CHILD_ENV,
    encoding: "utf8",
    timeout: 30_000,
  });

const readSettings = () => JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
const readParked = () => JSON.parse(readFileSync(PARKED_PATH, "utf8"));

// The hook a user writes by hand, and the one the toggle sets aside for them.
const USER_SOUND_HOOK = {
  hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff || true" }],
};
const USER_AUDIT_HOOK = { hooks: [{ type: "command", command: "audit.sh" }] };

const restoreEnv = (key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR", was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restoreEnv("HOME", prevHome);
  restoreEnv("USERPROFILE", prevUserProfile);
  restoreEnv("CLAUDE_CONFIG_DIR", prevConfigDir);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("agents-deck --uninstall", () => {
  it("removes the sound hook it installed and gives the user their own back", async () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(git*)"] },
      hooks: { Stop: [USER_SOUND_HOOK], PreToolUse: [USER_AUDIT_HOOK] },
    }, null, 2), "utf8");

    // The state an actual user is in: hooks installed, sound toggled on from the
    // topbar — which parked the afplay hook they wrote themselves.
    await installHooks({ provider: "claude" });
    expect((await setSoundHook(true)).ok).toBe(true);
    expect(readParked()).toHaveLength(1);
    expect(JSON.stringify(readSettings())).toContain("__agent-dag-sound");

    runUninstall();

    const after = readSettings();
    // Nothing of the deck's is left in the file — not the event forwarders, and
    // not the sound entry that used to keep playing after "uninstall".
    expect(JSON.stringify(after)).not.toContain("__agent-dag");
    expect(JSON.stringify(after)).not.toContain("notify.js");
    // Their own hook is back where they wrote it, byte for byte.
    expect(after.hooks.Stop).toEqual([USER_SOUND_HOOK]);
    expect(readParked()).toHaveLength(0);
    // And the rest of the file is untouched.
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(git*)"] });
    expect(after.hooks.PreToolUse).toEqual([USER_AUDIT_HOOK]);
  }, 30_000);

  it("keeps the parked hooks parked when settings.json cannot be parsed", async () => {
    // Park one first, against a file that still reads.
    rmSync(PARKED_PATH, { force: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      hooks: { Stop: [USER_SOUND_HOOK] },
    }, null, 2), "utf8");
    expect((await setSoundHook(true)).ok).toBe(true);
    expect(readParked()).toHaveLength(1);

    // Then the file goes bad — a trailing comma is enough — before the uninstall.
    const corrupt = '{\n  "model": "opus",\n}\n';
    writeFileSync(SETTINGS_PATH, corrupt, "utf8");

    const res = await uninstallSoundHook();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("settings_unreadable");
    // Nothing written, nothing dropped: the restore still works once they repair
    // the file, which is the only reason the parked copy exists.
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(corrupt);
    expect(readParked()).toHaveLength(1);
  });

  it("says nothing and changes nothing on a machine that never turned it on", async () => {
    rmSync(PARKED_PATH, { force: true });
    const plain = JSON.stringify({ model: "opus", hooks: { Stop: [USER_SOUND_HOOK] } }, null, 2) + "\n";
    writeFileSync(SETTINGS_PATH, plain, "utf8");

    runUninstall();

    // A hook the deck never installed is not the deck's to remove.
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(plain);
  }, 30_000);
});
