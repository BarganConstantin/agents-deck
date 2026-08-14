// Reported: writeFileAtomic built its temp path out of the target plus the pid
// alone, so every write to one file inside one deck shared a single temp file.
// Two clients toggling the sound within the same few milliseconds — two deck
// tabs, or a scripted request — both opened that path with O_TRUNC and both
// wrote their own JSON at offset zero, so what got renamed over settings.json
// was the shorter payload with the tail of the longer one still behind it.
// Unparseable, and readSettingsForWrite turns unparseable into a permanent
// SETTINGS_UNREADABLE refusal: every later toggle and every hook install
// declines until the user repairs the file by hand. The writer that lost the
// race found its temp file already renamed away and threw ENOENT on top of it.
// These tests run the writes genuinely at once and pin both halves — every
// writer gets a temp file of its own, and the target is left as one whole
// payload rather than a splice of two.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both modules resolve their paths at import time: settings.json from
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) and the parked-hooks file from
// os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All
// four are pointed inside a temp directory BEFORE either module is loaded, so
// nothing here can reach the developer's own ~/.claude, ~/.codex or
// ~/.agents-deck on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-race-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");

// @ts-expect-error — .mjs server module, no types
const { writeFileAtomic, CLAUDE_DIR } = await import("../../server/installer.mjs");
// @ts-expect-error — .mjs server module, no types
const { setSoundHook, soundHookStatus, SETTINGS_PATH, PARKED_PATH } = await import("../../server/sound-hook.mjs");

// Belt and braces. If any of those paths ever stopped honouring the
// environment, this file would be racing writes against the developer's own
// settings.json — the exact file the bug corrupts — so fail before a single
// test gets the chance.
for (const p of [CLAUDE_DIR, SETTINGS_PATH, PARKED_PATH]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: server module resolved ${p}, outside ${FAKE_HOME}`);
  }
}

mkdirSync(CLAUDE_DIR, { recursive: true });
const RACE = join(CLAUDE_DIR, "race.json");

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

// Payloads big enough that two of them are still in each other's way when the
// second write starts, and different enough in length that a splice of the two
// cannot come out as valid JSON by accident. The tag says which one won.
const payload = (tag: string, pad: number) => JSON.stringify({ tag, pad: "x".repeat(pad) }, null, 2) + "\n";

// allSettled rather than all, and the rejection reason is carried into the
// assertion: on the unfixed code the loser rejects with ENOENT from its rename,
// and a bare "rejected" in the diff would not say why.
const settle = async (promises: Promise<unknown>[]) =>
  (await Promise.allSettled(promises)).map(r =>
    r.status === "fulfilled" ? "fulfilled" : `rejected: ${(r.reason as any)?.code ?? r.reason}`);

const strayTemps = (dir: string) => readdirSync(dir).filter(name => name.includes(".tmp"));

describe("two writes landing on one file at the same moment", () => {
  it("lets both of them finish instead of failing the loser's rename", async () => {
    rmSync(RACE, { force: true });

    const done = await settle([
      writeFileAtomic(RACE, payload("big", 200_000)),
      writeFileAtomic(RACE, payload("small", 50_000)),
    ]);

    expect(done).toEqual(["fulfilled", "fulfilled"]);
  });

  it("leaves one whole payload behind, never one spliced onto the tail of the other", async () => {
    rmSync(RACE, { force: true });
    const big = payload("big", 200_000);
    const small = payload("small", 50_000);

    await settle([writeFileAtomic(RACE, big), writeFileAtomic(RACE, small)]);

    // A spliced file throws right here, which is what the report reproduced:
    // "Unexpected non-whitespace character after JSON at position 50021".
    const written = readFileSync(RACE, "utf8");
    const parsed = JSON.parse(written);
    expect(["big", "small"]).toContain(parsed.tag);
    // Length, not the string itself: a 200KB diff on failure helps nobody, and a
    // short payload wearing a long one's tail is exactly a length mismatch.
    expect(written.length).toBe(parsed.tag === "big" ? big.length : small.length);
  });

  it("does the same with eight writers, and cleans up every temp file after", async () => {
    rmSync(RACE, { force: true });
    const payloads = new Map(
      Array.from({ length: 8 }, (_, i) => [`w${i}`, payload(`w${i}`, 20_000 * (i + 1))] as const),
    );

    const done = await settle([...payloads.values()].map(text => writeFileAtomic(RACE, text)));

    expect(done).toEqual(Array(8).fill("fulfilled"));
    const written = readFileSync(RACE, "utf8");
    const parsed = JSON.parse(written);
    expect(payloads.has(parsed.tag)).toBe(true);
    expect(written.length).toBe(payloads.get(parsed.tag)!.length);
    // Eight temp files at once, and not one of them outlives the write.
    expect(strayTemps(CLAUDE_DIR)).toEqual([]);
  });

  it("takes no temp file with it when the write cannot be renamed into place", async () => {
    // A target that no rename can replace, on every platform: a directory.
    // EISDIR on POSIX, a sharing violation Windows retries and then gives up on.
    // Either way the temp file beside it has to go, or a deck that keeps failing
    // keeps littering the config dir.
    const blocked = join(CLAUDE_DIR, "blocked-target");
    mkdirSync(blocked, { recursive: true });

    await expect(writeFileAtomic(blocked, "{}\n")).rejects.toThrow();

    expect(strayTemps(CLAUDE_DIR)).toEqual([]);
    rmSync(blocked, { recursive: true, force: true });
  });
});

describe("two deck tabs toggling the sound within the same few milliseconds", () => {
  it("leaves settings.json readable, with every setting the user had", async () => {
    // Bulky on purpose: the two rewrites overlap for long enough that a shared
    // temp file could not survive it, which is the whole scenario in the report.
    const allow = Array.from({ length: 4000 }, (_, i) => `Bash(cmd${i}:*)`);
    writeFileSync(SETTINGS_PATH, JSON.stringify({ model: "opus", permissions: { allow } }, null, 2) + "\n", "utf8");

    // Both tabs click the same way, so the two toggles do the same work in the
    // same order and arrive at the temp file together — which is what makes this
    // the reachable version of the bug rather than a contrived one. They race
    // over notify.js as well as settings.json, and both files have to survive it.
    const done = await settle([setSoundHook(true), setSoundHook(true)]);

    expect(done).toEqual(["fulfilled", "fulfilled"]);
    const written = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.permissions.allow).toHaveLength(4000);
  });

  it("does not leave the toggle refusing every later click with SETTINGS_UNREADABLE", async () => {
    // The cost of the corruption, rather than the corruption itself: one torn
    // write used to end with a settings.json nothing would rewrite again until
    // the user repaired it by hand.
    const status = await soundHookStatus();

    expect(status.ok).toBe(true);
    expect(strayTemps(CLAUDE_DIR)).toEqual([]);

    const back = await setSoundHook(true);
    expect(back.ok).toBe(true);
    expect(JSON.stringify(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")).hooks.Stop)).toContain("__agent-dag-sound");
  });
});
