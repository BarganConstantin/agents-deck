// A `claude` that cannot be run at all is the one sign-in failure the deck
// diagnoses perfectly — and then threw away twice over.
//
// With AGENTS_DECK_CLAUDE pointing at nothing, or with no claude on PATH, the
// child is gone in milliseconds and exec.mjs reports it the same way on every
// platform: `{code:"ENOENT"}`, whether from a POSIX spawn error or from the last
// Windows candidate spelling after cmd.exe answered "is not recognized" for the
// .cmd shim. The flow's own done handler turns that into "the claude CLI could
// not be run: not on PATH. Set AGENTS_DECK_CLAUDE to its full path." — the only
// sentence in the whole sign-in that names a fix — within a beat of the start.
//
// startLogin never looked. It polled for a url that could not arrive, held the
// POST open for the full fifteen seconds, and then published "the claude CLI did
// not print a sign-in link" over the flow, destroying the diagnosis on the
// server. What reached the person watching the dialog was a fifteen-second
// spinner followed by a guess.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The sandbox, in place BEFORE the module under test is imported: it resolves
// the claude-swap store from $CLAUDE_SWAP_BACKUP or the home directory, and its
// neighbours resolve marker files out of the home directory at module load. A
// test that reached the real ones would be reading — and, on the cancel path,
// switching — the accounts of whoever is running it. $HOME and %USERPROFILE%
// are both set because os.homedir() reads one on POSIX and the other on Windows.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-nocli-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-nocli-store-"));
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
// The subject of the file, and the belt to the braces below: even if a mock
// failed to bind, these names reach no CLI rather than the real one.
process.env.AGENTS_DECK_CLAUDE = join(FAKE_HOME, "no-such-claude");
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

// A stand-in for `claude auth login`. A real one must not be run at all here: it
// opens a browser tab and starts an OAuth flow against the user's own account.
//
// Two shapes, because the fix has to tell them apart. `dies` is what an
// unrunnable binary leaves behind — exec.mjs's `finish(-1, {code:"ENOENT"})`,
// reached on POSIX from the spawn error and on Windows after every candidate
// spelling, including the .cmd one cmd.exe could not find. The other is a child
// that started fine and simply says nothing, which is the case the fifteen
// seconds were written for.
const fakeLogin = vi.hoisted(() => {
  const children: any[] = [];
  let dies = true;
  let waiting: ((c: any) => void) | null = null;

  function spawn() {
    let settle!: (r: unknown) => void;
    const child: any = {
      done: new Promise((r) => { settle = r; }),
      killed: false,
      onLine() { /* this child prints nothing, ever */ },
      write() { /* no code is ever pasted in these tests */ },
      end() { /* stdin is never closed on a prompting child */ },
      kill() { child.killed = true; },
      settle(r: unknown) { settle(r); },
    };
    children.push(child);
    if (dies) settle({ ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: "", stderr: "" });
    waiting?.(child);
    waiting = null;
    return child;
  }

  /** The nth login child, resolved once startLogin has actually spawned it. */
  function child(i: number): Promise<any> {
    return children[i] ? Promise.resolve(children[i]) : new Promise((res) => { waiting = res; });
  }

  return { spawn, child, children, runnable(v: boolean) { dies = !v; } };
});

// Nothing in this file may reach a real process. `claude auth login` is the fake
// above; `claude auth status` and every `cswap` call answer as a command that
// could not be run, which is what the missing binaries above would produce
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
// home directory. Prove it landed in the sandbox by putting an account there and
// reading it back, and fail before a single test gets to run.
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

const NOT_ON_PATH = "the claude CLI could not be run: not on PATH. Set AGENTS_DECK_CLAUDE to its full path.";

afterEach(async () => {
  fakeLogin.runnable(false);
  await cancelLogin();
  for (const c of fakeLogin.children) c.settle({ ok: false, code: -1, killed: true, timedOut: false, stdout: "", stderr: "" });
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

describe("a sign-in whose claude CLI cannot be run", () => {
  it("answers as soon as the child dies, not fifteen seconds later", async () => {
    const started = Date.now();
    const out = await startLogin();
    // The whole cost of the bug, measured: the child was dead and diagnosed
    // before the first poll, and the request went on waiting for a link anyway.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toMatchObject({ ok: false, reason: "no_url", state: "failed" });
  });

  it("keeps the sentence that names the fix instead of publishing a guess over it", async () => {
    await startLogin();

    expect(loginState().error).toBe(NOT_ON_PATH);
    // The sentence that used to land here instead. It is not wrong; it is just
    // the one thing the user cannot act on.
    expect(loginState().error).not.toMatch(/did not print a sign-in link/);
  });

  it("sends that sentence as the detail, which is what the dialog reads first", async () => {
    const out = await startLogin();

    // say() in AddAccountDialog is `detail || REASONS[reason] || error`, so a
    // reason of "no_url" — "is it installed?" — outranks `error` and would ask
    // the question this answer has already answered.
    expect(out.detail).toBe(NOT_ON_PATH);
  });
});

describe("a sign-in whose CLI runs but never prints a link", () => {
  it("still blames the missing link, after the full wait", async () => {
    fakeLogin.runnable(true);
    vi.useFakeTimers();
    try {
      const start = startLogin();
      await fakeLogin.child(0);
      expect(loginState().state).toBe("awaiting_url");

      await vi.advanceTimersByTimeAsync(15_000);
      const out = await start;

      expect(out).toMatchObject({ ok: false, reason: "no_url", state: "failed" });
      // Nothing diagnosed this one, so nothing outranks the dialog's own
      // sentence for it — which asks whether the CLI is installed, the right
      // question when the flow has no better answer.
      expect(out.detail).toBeUndefined();
      expect(loginState().error).toBe("the claude CLI did not print a sign-in link");
      expect(fakeLogin.children[0].killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
