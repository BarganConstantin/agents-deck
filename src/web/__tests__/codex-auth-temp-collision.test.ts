// Reported: persistAuth() staged the refreshed ~/.codex/auth.json in a sibling
// temp file named after the target plus process.pid, and filled it with a plain
// truncating write. A pid names a process, not a write, so that is one file
// shared by every write — the same shape writeFileAtomic had before v1.33.102.
// Two refreshes reaching it together both write their own JSON at offset zero,
// and what gets renamed over auth.json is the shorter payload with the tail of
// the longer one still behind it; the loser then finds its temp file already
// renamed away and throws ENOENT. That is not a retryable failure here: the
// refresh token is single-use and was spent server-side before the write, so a
// lost or spliced one logs the user out of Codex until they run `codex login`.
//
// The second half is the mode. `writeFile`'s `mode` applies only when the call
// creates the file, so a temp left behind by a deck killed between the write and
// the rename — whose pid the OS has since handed back out — was adopted whole,
// keeping its own permissions, and the rotated token sat in it at whatever those
// were until the chmod on the next line. A live refresh token must never be
// readable by another account, not even for that long.
//
// Two instances of the module stand in for two writers at one pid, because the
// module's own refresh queue serializes the writes one layer above the bug —
// what these tests pin is that the temp name survives on its own, which is what
// a second deck on the same home, or one refresh queue away, actually depends on.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Windows paths differ only in case between APIs, so the sandbox check folds it.
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b);

// `root` is filled in below, before codex-auth.mjs is imported; until then the
// guard rejects everything, so a write that somehow ran earlier still cannot
// reach a real credential file. `temps` records every temp file the writers
// created and the mode it carried the instant it existed — the window in which
// the rotated token is on disk under a name other than auth.json. `plant` asks
// for a leftover at the first temp name the code picks, the file a killed deck
// strands there.
const { fsCtl } = vi.hoisted(() => ({
  fsCtl: {
    root: "",
    temps: [] as { path: string; mode: number }[],
    plant: false,
    planted: "",
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fs = await import("node:fs");
  const guard = (p: unknown, what: string) => {
    const s = String(p);
    if (!fsCtl.root || !samePath(s, fsCtl.root)) {
      throw new Error(`test: refusing to ${what} ${s} outside ${fsCtl.root || "(sandbox not set up)"}`);
    }
  };
  // Called for whichever call creates the temp file: `open` once the fix routes
  // the write through the installer's createTemp, `writeFile` on the code that
  // built the name from the pid. Both go through here so the same assertions
  // describe both.
  const decoy = (path: string) => {
    if (!fsCtl.plant || !path.endsWith(".tmp")) return;
    fsCtl.plant = false;
    fsCtl.planted = path;
    fs.writeFileSync(path, "leftover from a deck that was killed mid-write", { mode: 0o666 });
    fs.chmodSync(path, 0o666);
  };
  const record = (path: string) => {
    if (!path.endsWith(".tmp")) return;
    fsCtl.temps.push({ path, mode: fs.statSync(path).mode & 0o777 });
  };
  const patched = {
    ...actual,
    open: (async (path: string, flags?: string, mode?: number) => {
      guard(path, "open");
      if (typeof flags === "string" && flags.includes("w")) decoy(String(path));
      const handle = await actual.open(path, flags as never, mode as never);
      if (typeof flags === "string" && flags.includes("w")) record(String(path));
      return handle;
    }) as unknown as typeof actual.open,
    writeFile: (async (path: string, ...rest: never[]) => {
      guard(path, "write");
      decoy(String(path));
      const out = await actual.writeFile(path as never, ...rest);
      // After the bytes, not before: this is the moment the token is in the file,
      // and the mode it has here is the one another account would have found.
      record(String(path));
      return out;
    }) as unknown as typeof actual.writeFile,
    rename: (async (from: string, to: string) => {
      guard(from, "rename");
      guard(to, "rename over");
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
  return { ...patched, default: patched };
});

// codex-auth resolves ~/.codex at import time: CODEX_HOME when set, otherwise
// homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All of
// them — plus CLAUDE_CONFIG_DIR, which the installer module it imports resolves
// the same way — point inside a temp dir BEFORE the module loads, so nothing
// here can read or replace the developer's own Codex credentials. realpathSync
// because persistAuth resolves symlinks and macOS hands out /var/folders temp
// dirs that really live under /private.
const FAKE_HOME = realpathSync(mkdtempSync(join(tmpdir(), "ccdeck-codex-temp-")));
const CODEX_DIR = join(FAKE_HOME, ".codex");
const AUTH = join(CODEX_DIR, "auth.json");
mkdirSync(CODEX_DIR, { recursive: true });
fsCtl.root = FAKE_HOME;

const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CODEX_HOME = CODEX_DIR;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");

const OLD_ACCESS = "old.access.token";
const OLD_REFRESH = "old-refresh-token";

// Two payloads far enough apart in length that a splice of them cannot come out
// as valid JSON by accident, and long enough that the two writes are genuinely
// inside each other rather than merely adjacent — which is the whole scenario.
// A real ChatGPT access token is a fat JWT, so a long one is not a contrivance.
const TOKENS = [
  { access: `big.${"a".repeat(400_000)}.token`,  refresh: "rotated-refresh-big" },
  { access: `small.${"b".repeat(80_000)}.token`, refresh: "rotated-refresh-small" },
];

const writeAuth = (mode = 0o600) => {
  writeFileSync(AUTH, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: OLD_ACCESS, refresh_token: OLD_REFRESH, account_id: "acct_test" },
    last_refresh: "2026-01-01T00:00:00.000Z",
  }, null, 2), { mode });
  // writeFileSync honours `mode` only when it creates the file — the same rule
  // this whole file is about — so say it again rather than inherit whatever the
  // last write left.
  chmodSync(AUTH, mode);
};

// Nothing leaves the machine: the one endpoint codex-auth talks to answers from
// here, and any other URL is a bug in this file rather than a request to make.
// Each caller gets its own token pair, so the file on disk says which writer won.
let refreshCalls = 0;
vi.stubGlobal("fetch", async (url: string) => {
  if (!String(url).startsWith("https://auth.openai.com/oauth/token")) {
    throw new Error(`test: blocked request to ${String(url)}`);
  }
  const t = TOKENS[refreshCalls++ % TOKENS.length];
  return { ok: true, status: 200, json: async () => ({ access_token: t.access, refresh_token: t.refresh }) };
});

// Two instances of the module, each with its own refresh queue — two decks
// sharing one ~/.codex, which is what the pid in the temp name failed to tell
// apart. The query string is what makes the second one a separate instance.
// @ts-expect-error — .mjs server module, no types
const deckA = await import("../../server/codex-auth.mjs");
// @ts-expect-error — .mjs server module, no types
const deckB = await import("../../server/codex-auth.mjs?second-deck");

// Belt and braces. If either instance ever stopped honouring CODEX_HOME, this
// file would be spending and overwriting the developer's live Codex credentials
// — so prove both are reading the sandbox before a single test runs.
writeAuth();
for (const [name, deck] of [["A", deckA], ["B", deckB]] as const) {
  const probe = await deck.getCodexAuth({ allowRefresh: false });
  if (probe?.accessToken !== OLD_ACCESS) {
    throw new Error(`refusing to run: deck ${name} did not read auth.json inside ${FAKE_HOME}`);
  }
}

const onDisk = () => JSON.parse(readFileSync(AUTH, "utf8"));
const strays = () => readdirSync(CODEX_DIR).filter(name => name !== "auth.json");

// allSettled rather than all, and the rejection reason is carried into the
// assertion: forceCodexRefresh does not throw, it answers, and on the unfixed
// code the loser answers refresh_rejected/persist_failed after its rename hits
// ENOENT — a bare "rejected" in the diff would not say why.
const settle = async (promises: Promise<any>[]) =>
  (await Promise.allSettled(promises)).map(r =>
    r.status === "fulfilled"
      ? (r.value?.ok ? "ok" : `refused: ${r.value?.reason}/${r.value?.code ?? ""}`)
      : `threw: ${(r.reason as any)?.code ?? r.reason}`);

beforeEach(() => {
  rmSync(CODEX_DIR, { recursive: true, force: true });
  mkdirSync(CODEX_DIR, { recursive: true });
  writeAuth();
  fsCtl.temps.length = 0;
  fsCtl.plant = false;
  fsCtl.planted = "";
  refreshCalls = 0;
});

afterAll(() => {
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("two refreshes staging a rotated token at the same moment", () => {
  it("gives each of them a temp file of its own", async () => {
    await settle([deckA.forceCodexRefresh(), deckB.forceCodexRefresh()]);

    const used = fsCtl.temps.map(t => t.path);
    expect(used).toHaveLength(2);
    expect(new Set(used).size).toBe(2);
  });

  it("leaves auth.json parseable, carrying one of the two tokens whole", async () => {
    await settle([deckA.forceCodexRefresh(), deckB.forceCodexRefresh()]);

    // A spliced file throws right here — the shorter payload with the tail of
    // the longer one behind it is what the report reproduced.
    const written = readFileSync(AUTH, "utf8");
    const parsed = JSON.parse(written);
    expect(TOKENS.map(t => t.access)).toContain(parsed.tokens.access_token);
    // Round-tripped length rather than the string itself: a 400KB diff on
    // failure helps nobody, and a short payload wearing a long one's tail is
    // exactly a length mismatch.
    expect(written.length).toBe(JSON.stringify(parsed, null, 2).length);
    // The pair has to match, too. A refresh token spliced onto the other
    // writer's access token is a credential file that fails on first use.
    const pair = TOKENS.find(t => t.access === parsed.tokens.access_token)!;
    expect(parsed.tokens.refresh_token).toBe(pair.refresh);
  });

  it("reports both of them as done, neither as a login the user has to repair", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const done = await settle([deckA.forceCodexRefresh(), deckB.forceCodexRefresh()]);

    // refresh_rejected is the answer that tells the user to run `codex login`.
    // Reaching it because two writers shared a filename would be the deck
    // throwing away a credential that is perfectly good.
    expect(done).toEqual(["ok", "ok"]);
    expect(quiet).not.toHaveBeenCalled();
    expect(strays()).toEqual([]);
    quiet.mockRestore();
  });
});

describe("a leftover temp file at the name the write picked", () => {
  it("stages the token somewhere else instead of adopting it", async () => {
    fsCtl.plant = true;

    const res = await deckA.forceCodexRefresh();

    expect(res.ok).toBe(true);
    expect(fsCtl.planted).not.toBe("");
    // Adopting the leftover means writing the rotated token into a file created
    // by someone else, under whatever permissions they left on it.
    expect(fsCtl.temps.map(t => t.path)).not.toContain(fsCtl.planted);
    expect(onDisk().tokens.access_token).toBe(TOKENS[0].access);
    // And the leftover itself is swept, not left holding a stale token forever.
    expect(strays()).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("the permissions the token passes through", () => {
  it("never lets another account read the temp file it is staged in", async () => {
    await settle([deckA.forceCodexRefresh(), deckB.forceCodexRefresh()]);

    expect(fsCtl.temps.length).toBeGreaterThan(0);
    for (const t of fsCtl.temps) expect(t.mode & 0o077).toBe(0);
  });

  it("does the same when it lands on a name a leftover already had", async () => {
    fsCtl.plant = true;

    await deckA.forceCodexRefresh();

    expect(fsCtl.temps.length).toBeGreaterThan(0);
    for (const t of fsCtl.temps) expect(t.mode & 0o077).toBe(0);
  });

  it("leaves auth.json at 0600 even when the file it replaced was not", async () => {
    // The rename makes a fresh directory entry, so the mode comes from the temp
    // file rather than from what was there — a credential file that came out at
    // the umask default would be readable by every account on the machine.
    writeAuth(0o644);

    const res = await deckA.forceCodexRefresh();

    expect(res.ok).toBe(true);
    expect(statSync(AUTH).mode & 0o777).toBe(0o600);
  });
});
