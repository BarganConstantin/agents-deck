// Reported: persistAuth() moved the freshly refreshed ~/.codex/auth.json into
// place with a bare rename. On Windows that call fails with EPERM/EBUSY while
// any other process — a virus scanner, the search indexer, the Codex CLI —
// holds the target open, which it does for a few milliseconds at a time. The
// refresh token is single-use and was already rotated server-side by then, so
// one lost race deleted the only copy of the new credential: the deck reported
// refresh_rejected and the user had to run `codex login` again. These tests pin
// the fix — the move goes through the installer's retrying rename, the same one
// the uv download uses — and the two guarantees around it that must survive:
// the rotated token never lingers in a temp file, and auth.json stays 0600.
//
// The sharing violation is synthesized rather than provoked, so the Windows
// behaviour is exercised on every platform the suite runs on.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Windows paths differ only in case between APIs, so the sandbox check folds it.
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b);

// `root` is filled in below, before codex-auth.mjs is imported; until then the
// guard rejects everything, so a write that somehow ran earlier still cannot
// reach a real credential file. `faults` is the queue of rename failures the
// next attempts see, `renames` the record of every attempt made.
const { fsCtl } = vi.hoisted(() => ({
  fsCtl: { root: "", faults: [] as string[], renames: [] as string[] },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const guard = (p: unknown, what: string) => {
    const s = String(p);
    if (!fsCtl.root || !samePath(s, fsCtl.root)) {
      throw new Error(`test: refusing to ${what} ${s} outside ${fsCtl.root || "(sandbox not set up)"}`);
    }
  };
  const patched = {
    ...actual,
    writeFile: ((path: never, ...rest: never[]) => {
      guard(path, "write");
      return actual.writeFile(path, ...rest);
    }) as typeof actual.writeFile,
    rename: (async (from: string, to: string) => {
      guard(from, "rename");
      guard(to, "rename over");
      fsCtl.renames.push(String(to));
      const code = fsCtl.faults.shift();
      if (code) {
        // What Windows raises when the target is open in another process.
        const err = Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
        throw err;
      }
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
  return { ...patched, default: patched };
});

// codex-auth resolves ~/.codex at import time: CODEX_HOME when set, otherwise
// homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All of
// them — plus CLAUDE_CONFIG_DIR, which the installer module this now imports
// resolves the same way — point inside a temp dir BEFORE the module loads, so
// nothing here can read or replace the developer's own Codex credentials.
// realpathSync because persistAuth resolves symlinks and macOS hands out
// /var/folders temp dirs that really live under /private.
const FAKE_HOME = realpathSync(mkdtempSync(join(tmpdir(), "ccdeck-codex-auth-")));
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
const NEW_ACCESS = "new.access.token";
const NEW_REFRESH = "new-refresh-token";

const writeAuth = () => writeFileSync(AUTH, JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: OLD_ACCESS, refresh_token: OLD_REFRESH, account_id: "acct_test" },
  last_refresh: "2026-01-01T00:00:00.000Z",
}, null, 2), { mode: 0o600 });

// Nothing leaves the machine: the one endpoint codex-auth talks to answers from
// here, and any other URL is a bug in this file rather than a request to make.
let refreshCalls = 0;
vi.stubGlobal("fetch", async (url: string) => {
  if (!String(url).startsWith("https://auth.openai.com/oauth/token")) {
    throw new Error(`test: blocked request to ${String(url)}`);
  }
  refreshCalls++;
  return { ok: true, status: 200, json: async () => ({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH }) };
});

// @ts-expect-error — .mjs server module, no types
const { getCodexAuth, forceCodexRefresh } = await import("../../server/codex-auth.mjs");

// Belt and braces. If the module ever stopped honouring CODEX_HOME, this file
// would be spending and overwriting the developer's live Codex credentials —
// so prove it is reading the sandbox before a single test runs.
writeAuth();
const probe = await getCodexAuth({ allowRefresh: false });
if (probe?.accessToken !== OLD_ACCESS) {
  throw new Error(`refusing to run: codex-auth did not read auth.json inside ${FAKE_HOME}`);
}

const onDisk = () => JSON.parse(readFileSync(AUTH, "utf8"));
const strays = () => readdirSync(CODEX_DIR).filter(name => name !== "auth.json");

beforeEach(() => {
  rmSync(CODEX_DIR, { recursive: true, force: true });
  mkdirSync(CODEX_DIR, { recursive: true });
  writeAuth();
  fsCtl.faults.length = 0;
  fsCtl.renames.length = 0;
  refreshCalls = 0;
});

afterAll(() => {
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("a refresh whose rename hits a sharing violation", () => {
  it("retries until the rotated token reaches auth.json", async () => {
    fsCtl.faults.push("EPERM", "EBUSY");

    const res = await forceCodexRefresh();

    expect(res).toMatchObject({ ok: true, accessToken: NEW_ACCESS });
    expect(onDisk().tokens.refresh_token).toBe(NEW_REFRESH);
    expect(fsCtl.renames).toHaveLength(3);
    expect(refreshCalls).toBe(1);
  });

  it("leaves no temp file holding the rotated token in cleartext", async () => {
    fsCtl.faults.push("EACCES");

    const res = await forceCodexRefresh();

    expect(res.ok).toBe(true);
    expect(strays()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps auth.json readable only by its owner", async () => {
    fsCtl.faults.push("EBUSY");

    await forceCodexRefresh();

    expect(onDisk().tokens.access_token).toBe(NEW_ACCESS);
    expect(statSync(AUTH).mode & 0o777).toBe(0o600);
  });
});

describe("a rename that keeps failing", () => {
  it("reports the refresh as rejected rather than claiming success", async () => {
    // The credential is genuinely dead here — the old refresh token was spent to
    // get one that never landed — so the only honest answer is "re-login".
    fsCtl.faults.push("EPERM", "EPERM", "EPERM", "EPERM", "EPERM");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await forceCodexRefresh();

    expect(res).toMatchObject({ ok: false, reason: "refresh_rejected", code: "persist_failed" });
    expect(fsCtl.renames.length).toBeGreaterThan(1);
    expect(onDisk().tokens.access_token).toBe(OLD_ACCESS);
    expect(strays()).toEqual([]);
    quiet.mockRestore();
  });

  it("gives up at once on a failure retrying cannot clear", async () => {
    // A full disk or a read-only volume will still be full or read-only 200ms
    // later; burning the retries there only delays the report.
    fsCtl.faults.push("ENOSPC");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await forceCodexRefresh();

    expect(res).toMatchObject({ ok: false, reason: "refresh_rejected", code: "persist_failed" });
    expect(fsCtl.renames).toHaveLength(1);
    quiet.mockRestore();
  });
});
