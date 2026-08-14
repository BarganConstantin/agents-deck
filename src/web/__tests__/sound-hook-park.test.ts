// Reported: turning the sound on parks the user's own afplay/PowerShell Stop
// hooks in ~/.agents-deck/parked-sound-hooks.json and strips them out of
// settings.json — but writeParked() caught every error and returned void, so a
// park that could not be written (root-owned ~/.agents-deck, a full disk, a
// Windows lock on the file) left the hooks in neither file while setSoundHook
// reported ok. readParked() had the mirror of it: any unreadable file counted as
// "nothing was ever parked", so a torn parked file was overwritten by the next
// toggle and the status endpoint said parked:0. These tests pin both halves —
// the park has to land before settings.json is touched, and a parked file that
// will not parse stops the toggle instead of being written over.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The module resolves its paths at import time: settings.json from
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) and the parked-hooks file from
// os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All of
// them are pointed at a temp directory BEFORE the module is loaded, so nothing
// here can reach the real ~/.claude or ~/.agents-deck on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-park-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/sound-hook.mjs");
const { setSoundHook, soundHookStatus, restoreParkedSoundHooks, SETTINGS_PATH, PARKED_PATH } = mod;

// Belt and braces. If either path ever stopped honouring the environment, this
// file would be rewriting the developer's own settings and deleting their parked
// hooks — so fail before a single test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: sound-hook resolved ${p}, outside ${FAKE_HOME}`);
  }
}

// The directory the parked file lives in, i.e. <fake home>/.agents-deck.
const PARK_DIR = dirname(String(PARKED_PATH));

mkdirSync(FAKE_CLAUDE, { recursive: true });

const restoreEnv = (
  key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME",
  was: string | undefined,
) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restoreEnv("HOME", prevHome);
  restoreEnv("USERPROFILE", prevUserProfile);
  restoreEnv("CLAUDE_CONFIG_DIR", prevConfigDir);
  restoreEnv("CODEX_HOME", prevCodexHome);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

// A hook a user wrote by hand: one OS-specific command ending in `|| true`, the
// exact thing the toggle sets aside and the exact thing that went missing.
const USER_SOUND_HOOK = {
  hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff || true" }],
};
const USER_AUDIT_HOOK = { hooks: [{ type: "command", command: "audit.sh" }] };

const settingsWithUserSound = () => JSON.stringify({
  model: "opus",
  permissions: { allow: ["Bash(git*)"] },
  hooks: { Stop: [USER_SOUND_HOOK], PreToolUse: [USER_AUDIT_HOOK] },
}, null, 2) + "\n";

/**
 * Make everything under ~/.agents-deck fail, on every platform, without root.
 * A regular file where the directory belongs is refused by mkdir, by readFile
 * and by the atomic write's open() alike — ENOTDIR on POSIX, the same class of
 * error on Windows — which is the unusable ~/.agents-deck the report describes.
 * Which of the two refusals comes out depends on whether the existing park is
 * read before the new one is written, so the tests below pin the outcome that
 * matters rather than the label.
 */
const blockParkDir = () => {
  rmSync(PARK_DIR, { recursive: true, force: true });
  writeFileSync(PARK_DIR, "not a directory", "utf8");
};

const unblockParkDir = () => rmSync(PARK_DIR, { recursive: true, force: true });

// A read-only directory is the one way to fail the write without also failing
// the read that precedes it. It is a no-op on Windows, where chmod only toggles
// the read-only bit, and for root, who is allowed anyway — so probe it instead
// of assuming, and skip that test rather than report a false pass.
const readOnlyDirBlocksWrites = (() => {
  const probe = mkdtempSync(join(FAKE_HOME, "ro-probe-"));
  try {
    chmodSync(probe, 0o555);
    writeFileSync(join(probe, "x"), "x");
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o755);
    rmSync(probe, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  unblockParkDir();
});

describe("the sound toggle when the park cannot be written", () => {
  it("refuses to turn the sound on, and leaves settings.json byte for byte", async () => {
    const before = settingsWithUserSound();
    writeFileSync(SETTINGS_PATH, before, "utf8");
    blockParkDir();

    const res = await setSoundHook(true);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^parked_/);
    expect(res.parkedPath).toBe(PARKED_PATH);
    // The whole point: the hook is still where the user wrote it.
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(before);
  });

  it("refuses to turn the sound off too, because the same hooks would be dropped", async () => {
    const before = settingsWithUserSound();
    writeFileSync(SETTINGS_PATH, before, "utf8");
    blockParkDir();

    const res = await setSoundHook(false);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^parked_/);
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(before);
  });

  it.skipIf(!readOnlyDirBlocksWrites)("refuses when the park reads but cannot be replaced", async () => {
    // The failure the report is actually about: the old contents are perfectly
    // readable, and only the write goes wrong. It used to be swallowed whole.
    const before = settingsWithUserSound();
    writeFileSync(SETTINGS_PATH, before, "utf8");
    mkdirSync(PARK_DIR, { recursive: true });
    writeFileSync(PARKED_PATH, "[]\n", "utf8");
    chmodSync(PARK_DIR, 0o555);
    try {
      const res = await setSoundHook(true);

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("parked_unwritable");
      expect(res.message).toMatch(/neither file/);
      expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(before);
      expect(readFileSync(PARKED_PATH, "utf8")).toBe("[]\n");
    } finally {
      chmodSync(PARK_DIR, 0o755);
    }
  });

  it("still reports the user's hook afterwards, instead of a file with nothing in it", async () => {
    writeFileSync(SETTINGS_PATH, settingsWithUserSound(), "utf8");
    blockParkDir();

    await setSoundHook(true);
    unblockParkDir();

    const status = await soundHookStatus();
    expect(status.ok).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.parked).toBe(0);
    // Not parked, not deleted: still a foreign sound hook the deck can see.
    expect(status.foreign).toHaveLength(1);
    expect(status.foreign[0].command).toContain("afplay");
  });

  it("turns on as normal once the park can be written again", async () => {
    writeFileSync(SETTINGS_PATH, settingsWithUserSound(), "utf8");
    blockParkDir();
    expect((await setSoundHook(true)).ok).toBe(false);

    unblockParkDir();
    expect((await setSoundHook(true)).ok).toBe(true);

    const written = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    expect(JSON.stringify(written.hooks.Stop)).toContain("__agent-dag-sound");
    expect(JSON.stringify(written.hooks.Stop)).not.toContain("afplay");
    expect(JSON.parse(readFileSync(PARKED_PATH, "utf8"))).toEqual([USER_SOUND_HOOK]);
  });
});

describe("the sound toggle and a parked file it cannot parse", () => {
  // What a kill or a full disk mid-write leaves behind: valid JSON up to the
  // point the process died, and hooks the user wrote inside it.
  const TRUNCATED = '[\n  {\n    "hooks": [\n      { "type": "command", "comm';

  const parkTruncated = () => {
    mkdirSync(PARK_DIR, { recursive: true });
    writeFileSync(PARKED_PATH, TRUNCATED, "utf8");
  };

  it("refuses to park on top of it, keeping both files as they were", async () => {
    const before = settingsWithUserSound();
    writeFileSync(SETTINGS_PATH, before, "utf8");
    parkTruncated();

    const res = await setSoundHook(true);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("parked_unreadable");
    expect(readFileSync(SETTINGS_PATH, "utf8")).toBe(before);
    expect(readFileSync(PARKED_PATH, "utf8")).toBe(TRUNCATED);
  });

  it("reports the unreadable file instead of counting it as nothing parked", async () => {
    writeFileSync(SETTINGS_PATH, settingsWithUserSound(), "utf8");
    parkTruncated();

    const status = await soundHookStatus();

    expect(status.ok).toBe(false);
    expect(status.reason).toBe("parked_unreadable");
    expect(status.parkedPath).toBe(PARKED_PATH);
  });

  it("refuses the restore rather than answering 'restored: 0' about hooks that are in there", async () => {
    writeFileSync(SETTINGS_PATH, settingsWithUserSound(), "utf8");
    parkTruncated();

    const res = await restoreParkedSoundHooks();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("parked_unreadable");
    // Left for repair — the restore works again once the file is fixed.
    expect(readFileSync(PARKED_PATH, "utf8")).toBe(TRUNCATED);
  });

  it("treats a missing parked file as nothing parked, because that is what it is", async () => {
    writeFileSync(SETTINGS_PATH, settingsWithUserSound(), "utf8");
    rmSync(PARKED_PATH, { force: true });

    expect((await setSoundHook(true)).ok).toBe(true);
    expect((await restoreParkedSoundHooks()).ok).toBe(true);
    expect((await soundHookStatus()).ok).toBe(true);
  });
});

// A hard link is the only portable way to ask "was this file replaced, or
// overwritten in place?" — both names share one inode until a rename gives the
// visible name a new one. Almost every filesystem supports it; the one that does
// not gets the test skipped rather than a false failure.
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

describe("the parked file is replaced, not written into", () => {
  it.skipIf(!hardLinksWork)("survives a kill mid-write as the previous whole file", async () => {
    // Park one hook, then park a second on top of it. The truncate-then-fill the
    // old writeFile did is what produced the unparseable file the tests above
    // have to refuse; a rename cannot leave a reader anything but one or the other.
    writeFileSync(SETTINGS_PATH, settingsWithUserSound(), "utf8");
    expect((await setSoundHook(true)).ok).toBe(true);
    const first = readFileSync(PARKED_PATH, "utf8");

    const witness = join(PARK_DIR, "parked.witness");
    rmSync(witness, { force: true });
    linkSync(PARKED_PATH, witness);

    writeFileSync(SETTINGS_PATH, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "paplay /usr/share/sounds/done.wav || true" }] }] },
    }, null, 2), "utf8");
    expect((await setSoundHook(true)).ok).toBe(true);

    expect(JSON.parse(readFileSync(PARKED_PATH, "utf8"))).toHaveLength(2);
    // The old inode still holds exactly what was there before, so the second
    // park went through a different file that was renamed over the name.
    expect(readFileSync(witness, "utf8")).toBe(first);
    rmSync(witness, { force: true });
  });
});
