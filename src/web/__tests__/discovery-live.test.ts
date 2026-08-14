// Reported: a deck that is listening and serving normally ended up with no
// discovery file, and stayed that way. hook.js enumerates that directory and
// nothing else, so such a deck receives zero events — while looking, from the
// outside, exactly like an ordinary deck nobody has run a session against. Four
// decks were listening on the reporting machine and only three were registered.
//
// Registration used to be one write at boot: whatever removed the file
// afterwards, nothing ever put it back and nothing ever said it was gone. These
// tests pin the two halves of the fix — the file is re-asserted for as long as
// the deck runs, and a deck that cannot write it reports that instead of
// carrying on quietly.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The installer resolves the Claude config dir at import time: CLAUDE_CONFIG_DIR
// when set, otherwise ~/.claude via os.homedir(), which reads $HOME on POSIX and
// %USERPROFILE% on Windows. All three are pointed inside a temp directory BEFORE
// the module is loaded, so nothing in this file can reach the developer's own
// ~/.claude on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-discovery-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCodexHome = process.env.CODEX_HOME;
const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
delete process.env.CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const installer = await import("../../server/installer.mjs");
const {
  CLAUDE_DIR, AGENT_DAG_DIR, discoveryPath, writeDiscovery, ensureDiscovery, keepDiscovery,
} = installer as {
  CLAUDE_DIR: string;
  AGENT_DAG_DIR: string;
  discoveryPath: () => string;
  writeDiscovery: (o: { port: number; workspace?: string; token?: string }) => Promise<string>;
  ensureDiscovery: (o: { port: number; workspace?: string; token?: string })
    => Promise<{ file: string; rewritten: boolean }>;
  keepDiscovery: (o: {
    port: number; workspace?: string; token?: string; intervalMs?: number;
    onState?: (s: State) => void;
  }) => { file: string; check: () => Promise<State>; stop: () => void };
};

type State = { ok: boolean; rewritten: boolean; file: string; error: Error | null };

// Belt and braces. If the config dir ever stopped honouring the environment,
// every write below would land in the developer's own ~/.claude and the deletes
// would take out a real deck's registration — so fail before a single test gets
// the chance.
for (const p of [CLAUDE_DIR, AGENT_DAG_DIR, discoveryPath()]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: installer resolved ${p}, outside ${FAKE_HOME}`);
  }
}

const FILE = discoveryPath();
const PORT = 4326;
const TOKEN = randomBytes(32).toString("hex");
const WORKSPACE = "";

const read = () => JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
const wipe = () => rmSync(FILE, { recursive: true, force: true });
const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms); });

/** Wait for a condition, or give up — never a bare sleep long enough to be slow. */
async function until(cond: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await sleep(10);
  return cond();
}

const restore = (
  key: "HOME" | "USERPROFILE" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
  was: string | undefined,
) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

beforeEach(() => {
  mkdirSync(AGENT_DAG_DIR, { recursive: true });
  wipe();
});

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("CODEX_HOME", prevCodexHome);
  restore("CLAUDE_CONFIG_DIR", prevClaudeConfigDir);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("a discovery file that goes missing under a running deck", () => {
  it("is written when the deck has never registered", async () => {
    const res = await ensureDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN });
    expect(res.rewritten).toBe(true);
    expect(res.file).toBe(FILE);
    expect(read()).toMatchObject({ pid: process.pid, port: PORT, workspace: "", token: TOKEN });
  });

  // The whole point: the deck is still alive, so the answer is to put the file
  // back, not to notice it is gone and carry on.
  it("comes back when something deletes it", async () => {
    await writeDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN });
    wipe();
    expect(existsSync(FILE)).toBe(false);

    const res = await ensureDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN });
    expect(res.rewritten).toBe(true);
    // Everything hook.js needs to reach this deck, in the file it reads.
    expect(read()).toMatchObject({ pid: process.pid, port: PORT, token: TOKEN });
  });

  it("is left untouched while it already says the right thing", async () => {
    await writeDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN });
    const before = read();
    const res = await ensureDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN });
    expect(res.rewritten).toBe(false);
    // A rewrite would stamp a new startedAt — proof this was a read, not a write.
    expect(read()).toEqual(before);
  });

  // A file under our own pid that we did not write: a deck from a previous run
  // whose pid the OS handed back to us, or a half-written one. Trusting it would
  // send every hook at a port that is not ours, or at nothing at all.
  const wrong: Array<[string, () => void]> = [
    ["names another port", () => writeFileSync(FILE, JSON.stringify({ pid: process.pid, port: PORT + 1, workspace: "", token: TOKEN }))],
    ["carries another token", () => writeFileSync(FILE, JSON.stringify({ pid: process.pid, port: PORT, workspace: "", token: "not-ours" }))],
    ["carries no token at all", () => writeFileSync(FILE, JSON.stringify({ pid: process.pid, port: PORT, workspace: "" }))],
    ["names another workspace", () => writeFileSync(FILE, JSON.stringify({ pid: process.pid, port: PORT, workspace: "/somewhere/else", token: TOKEN }))],
    ["is not JSON at all", () => writeFileSync(FILE, "half a fi")],
    ["is empty", () => writeFileSync(FILE, "")],
  ];

  for (const [what, plant] of wrong) {
    it(`is replaced when the file on disk ${what}`, async () => {
      plant();
      const res = await ensureDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN });
      expect(res.rewritten).toBe(true);
      expect(read()).toMatchObject({ pid: process.pid, port: PORT, workspace: "", token: TOKEN });
    });
  }

  it("keeps the file readable by its owner alone", async () => {
    // The token is the deck's key material — see writeDiscovery. Windows has no
    // POSIX mode to check; NTFS inherits per-user ACLs from the profile dir.
    await ensureDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN });
    if (process.platform !== "win32") {
      expect(statSync(FILE).mode & 0o777).toBe(0o600);
    }
  });
});

describe("the deck's registration while it runs", () => {
  it("heals a deleted file on its own, and says it did", async () => {
    const seen: State[] = [];
    const keep = keepDiscovery({
      port: PORT, workspace: WORKSPACE, token: TOKEN, intervalMs: 25,
      onState: s => { seen.push(s); },
    });
    try {
      await keep.check();
      expect(existsSync(FILE)).toBe(true);
      expect(seen).toHaveLength(1);

      // The reported state: the deck runs on, the file is gone.
      wipe();
      expect(await until(() => existsSync(FILE))).toBe(true);
      expect(read()).toMatchObject({ pid: process.pid, port: PORT, token: TOKEN });

      // And it is not a silent repair — the deck is told, so it can tell the user.
      expect(await until(() => seen.length >= 2)).toBe(true);
      expect(seen[1]).toMatchObject({ ok: true, rewritten: true, file: FILE });
    } finally {
      keep.stop();
    }
  });

  it("says nothing at all while the file is simply there", async () => {
    const seen: State[] = [];
    const keep = keepDiscovery({
      port: PORT, workspace: WORKSPACE, token: TOKEN, intervalMs: 10,
      onState: s => { seen.push(s); },
    });
    try {
      await keep.check();
      await sleep(120); // ~12 ticks, none of which has anything to report
      expect(seen).toHaveLength(1);
    } finally {
      keep.stop();
    }
  });

  // Shutdown unlinks the file and then waits on open connections; a tick landing
  // in that window would re-register a deck that is leaving, and leave the file
  // behind for hooks to post at once nothing is listening.
  it("stops re-asserting once stopped", async () => {
    const keep = keepDiscovery({ port: PORT, workspace: WORKSPACE, token: TOKEN, intervalMs: 10 });
    await keep.check();
    keep.stop();
    wipe();
    await sleep(120);
    expect(existsSync(FILE)).toBe(false);
  });
});

describe("a deck that cannot write its discovery file", () => {
  // Something else holds the name — the reported state's worst case, where
  // healing is impossible. Silently listening is the one thing it must not do.
  // A directory in the file's place fails the write on Linux, macOS and Windows
  // alike, without needing root, a full disk, or a permission trick that is
  // portable nowhere.
  it("reports the failure instead of listening quietly", async () => {
    const seen: State[] = [];
    mkdirSync(FILE, { recursive: true });
    const keep = keepDiscovery({
      port: PORT, workspace: WORKSPACE, token: TOKEN, intervalMs: 10,
      onState: s => { seen.push(s); },
    });
    try {
      const state = await keep.check();
      expect(state.ok).toBe(false);
      expect(state.error).toBeInstanceOf(Error);
      expect(state.file).toBe(FILE);
      expect(seen).toHaveLength(1);
      expect(seen[0].ok).toBe(false);

      // And it says so once, not once every tick for the rest of the day.
      await sleep(120);
      expect(seen).toHaveLength(1);

      // Once the obstruction is gone the deck registers and reports the recovery.
      rmSync(FILE, { recursive: true, force: true });
      expect(await until(() => seen.length >= 2)).toBe(true);
      expect(seen[seen.length - 1]).toMatchObject({ ok: true, rewritten: true });
      expect(read()).toMatchObject({ pid: process.pid, port: PORT, token: TOKEN });
    } finally {
      keep.stop();
      rmSync(FILE, { recursive: true, force: true });
    }
  });
});
