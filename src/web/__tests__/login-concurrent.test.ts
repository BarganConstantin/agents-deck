// Starting a sign-in publishes nothing until its child exists, and getting
// there takes a store read plus `claude auth status` — a shell-out worth
// hundreds of milliseconds. Two requests that overlapped inside that window
// (two tabs, or one POST sent twice) both read the flow slot as empty, both
// walked past the already-running and yield-to-the-newer guards, and both
// spawned `claude auth login`. The later assignment won the slot, so the other
// child was unreachable: cancelLogin, the dialog's Escape, and the backdrop all
// stop `_login.child` and nothing else. What was left behind is not a stray
// object — it is an interactive process holding an open OAuth flow and an open
// stdin, invisible to the user, alive until its five-minute timeout.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The sandbox, in place BEFORE the module under test is imported: it resolves
// the claude-swap store from $CLAUDE_SWAP_BACKUP or the home directory, and its
// neighbours resolve marker files out of the home directory at module load. A
// test that reached the real ones would be reading — and, on the cancel path,
// switching — the accounts of whoever is running it. $HOME and %USERPROFILE%
// are both set because os.homedir() reads one on POSIX and the other on
// Windows.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-login-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-login-store-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
  AGENTS_DECK_CLAUDE: process.env.AGENTS_DECK_CLAUDE,
  AGENTS_DECK_CSWAP: process.env.AGENTS_DECK_CSWAP,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
process.env.CLAUDE_SWAP_BACKUP = FAKE_STORE;
// Names that cannot resolve to anything, so a mock that failed to bind reaches
// no CLI rather than the real one.
process.env.AGENTS_DECK_CLAUDE = join(FAKE_HOME, "no-such-claude");
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

// A stand-in for `claude auth login`. A real one cannot be scripted precisely
// enough — and must not be run at all, since it opens a browser tab and starts
// an OAuth flow against the user's own account.
//
// Every child prints its sign-in link as soon as it has a listener, which a
// real one does within a second. That matters here: a test about a race must
// not have to know in advance how many children the race produced in order to
// unblock them all, or the buggy path parks on a fifteen-second wait instead of
// failing an assertion.
const fakeLogin = vi.hoisted(() => {
  type Sub = (line: string, partial: boolean) => void;
  const LINK =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
    "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
    "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ipcF4hM7&state=dSuby3fi";
  const children: any[] = [];

  function spawn() {
    let settle!: (r: unknown) => void;
    const subs: Sub[] = [];
    const child = {
      done: new Promise((r) => { settle = r; }),
      killed: false,
      onLine(cb: Sub) { subs.push(cb); },
      write() { /* no code is ever pasted in these tests */ },
      kill() { child.killed = true; },
      say(line: string) { for (const cb of subs) cb(line, false); },
      end(r: unknown) { settle(r); },
    };
    children.push(child);
    // After the caller has attached its line listener, which it does in the
    // same synchronous run as the spawn.
    queueMicrotask(() => child.say(`If the browser didn't open, visit: ${LINK}`));
    return child;
  }

  return { spawn, children, LINK };
});

// Nothing in this file may reach a real process. `claude auth login` is the
// fake above; `claude auth status` and every `cswap` call answer as a command
// that could not be run, which is what the missing binaries above would produce
// anyway — without the spawn.
vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, any>>();
  return {
    ...real,
    run: async () => ({ ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: "", stderr: "" }),
    runDetached: () => {},
    runInteractive: (_cmd: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "login") return fakeLogin.spawn();
      throw new Error(`refusing to run \`${args.join(" ")}\` for real`);
    },
  };
});

// @ts-expect-error — plain JS module, no types
const { startLogin, cancelLogin, loginState, readStore } = await import("../../server/cswap-admin.mjs");

// Belt and braces. If any override above were ignored — or overridden again by
// a developer's own environment — the store would resolve somewhere in the real
// home directory. Prove it landed in the sandbox by putting an account there
// and reading it back, and fail before a single test gets to run.
writeFileSync(
  join(FAKE_STORE, "sequence.json"),
  JSON.stringify({ accounts: { 7: { email: "sandbox@example.invalid" } } }),
);
if (!homedir().startsWith(FAKE_HOME)) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${FAKE_HOME}`);
}
const sandboxed = await readStore();
if (sandboxed.slots.join(",") !== "7") {
  throw new Error(`refusing to run: the account store resolved outside ${FAKE_STORE}`);
}

afterEach(async () => {
  await cancelLogin();
  for (const c of fakeLogin.children) c.end({ ok: false, code: -1, killed: true, timedOut: false, stdout: "", stderr: "" });
  fakeLogin.children.length = 0;
});

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(FAKE_STORE, { recursive: true, force: true });
});

describe("two sign-in requests that overlap", () => {
  it("spawns one `claude auth login` between them, not one each", async () => {
    const [first, second] = await Promise.all([startLogin(), startLogin()]);

    expect(first).toMatchObject({ ok: true, state: "awaiting_code", url: fakeLogin.LINK });
    // The same sign-in, not a second one racing it: one browser tab to finish,
    // one child to cancel.
    expect(second).toMatchObject({ ok: true, state: "awaiting_code", url: fakeLogin.LINK });
    expect(fakeLogin.children).toHaveLength(1);
  });

  it("leaves nothing running once the sign-in is cancelled", async () => {
    await Promise.all([startLogin(), startLogin()]);
    await cancelLogin();

    // The orphan half of the bug: cancel reaches the flow the slot holds, so a
    // child the slot lost survived it — still on an open OAuth flow, still
    // holding stdin, with nowhere in the UI to see or stop it.
    expect(fakeLogin.children.every(c => c.killed)).toBe(true);
    expect(loginState()).toEqual({ state: "idle" });
  });
});

describe("a sign-in request that arrives after the last one is standing", () => {
  it("still gets a child of its own, and stops the one it took over from", async () => {
    expect(await startLogin()).toMatchObject({ ok: true, state: "awaiting_code" });
    // The page-reload path the panel depends on: a flow only waiting for a code
    // yields rather than blocking the next attempt for five minutes. Sharing
    // the in-flight start must not turn that into a no-op.
    expect(await startLogin()).toMatchObject({ ok: true, state: "awaiting_code" });

    expect(fakeLogin.children).toHaveLength(2);
    expect(fakeLogin.children[0].killed).toBe(true);
    expect(fakeLogin.children[1].killed).toBe(false);
  });
});
