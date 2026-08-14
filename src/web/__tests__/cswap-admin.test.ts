// Adding an account from the UI means driving two CLIs that were written for a
// human at a terminal. Everything below is a place where "it looked right in
// the terminal" and "it parses correctly" are different things — the sign-in
// link is printed twice inside escape sequences, the removal prompt has no
// --yes flag and must be answered by matching it, and a shared account is a
// live credential that has to stop working on its own.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain JS module, no types
import { stripTerminalEscapes, extractLoginUrl, newSlot, wrapShare, unwrapShare, removePromptMatches, countCodePrompts, firstUseful, addFailureText, failureText, importAccount, startLogin, loginState, cancelLogin, submitLoginCode, withStoreLock, SHARE_TTL_MS } from "../../server/cswap-admin.mjs";
// @ts-expect-error — plain JS module, no types
import { looksMissing } from "../../server/exec.mjs";
// @ts-expect-error — plain JS module, no types
import { cswapCandidates } from "../../server/cswap-install.mjs";

// A stand-in for `claude auth login`, because the login tests need a child that
// prints its link on cue and then stays alive — a real one cannot be scripted
// that precisely. Nothing else is faked: `cswap import` and `cswap remove` go
// on reaching the real exec.mjs, since the test at the bottom of this file is
// about what the real one does when the binary is missing.
const fakeLogin = vi.hoisted(() => {
  type Sub = (line: string, partial: boolean) => void;
  const children: any[] = [];
  let waiting: ((c: any) => void) | null = null;

  function spawn() {
    let settle!: (r: any) => void;
    const subs: Sub[] = [];
    let pending = "";
    const child = {
      done: new Promise((r) => { settle = r; }),
      killed: false,
      onLine(cb: Sub) { subs.push(cb); },
      written: [] as string[],
      write(text: string) { child.written.push(text); },
      kill() { child.killed = true; },
      /**
       * Bytes out of the CLI, cut into lines exactly the way exec.mjs cuts
       * them — complete lines once, then the still-unterminated tail on every
       * chunk, which is what makes a prompt without a newline arrive again and
       * again as it grows.
       */
      out(text: string) {
        pending += text;
        let nl;
        while ((nl = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, nl).replace(/\r$/, "");
          pending = pending.slice(nl + 1);
          for (const cb of subs) cb(line, false);
        }
        if (pending) for (const cb of subs) cb(pending, true);
      },
      /** What the CLI writes, as a finished line. */
      say(line: string) { child.out(line + "\n"); },
      /** How the CLI ends. */
      end(r: unknown) { settle(r); },
    };
    children.push(child);
    waiting?.(child);
    waiting = null;
    return child;
  }

  /** The nth login child, resolved once startLogin has actually spawned it. */
  function child(i: number): Promise<any> {
    return children[i] ? Promise.resolve(children[i]) : new Promise((res) => { waiting = res; });
  }

  return { spawn, child, children };
});

// Every argument vector `run` was given, in order — the only way to see WHEN a
// `cswap switch` was reached, which is what the store-lock test is about. The
// command still runs for real; this only watches.
const ranArgs = vi.hoisted(() => [] as string[][]);

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, any>>();
  return {
    ...real,
    run: (cmd: string, args: string[], opts: unknown) => {
      ranArgs.push(args);
      return real.run(cmd, args, opts);
    },
    runInteractive: (cmd: string, args: string[], opts: unknown) =>
      args[0] === "auth" && args[1] === "login" ? fakeLogin.spawn() : real.runInteractive(cmd, args, opts),
  };
});

const AUTHORIZE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ipcF4hM7&state=dSuby3fi";

// Byte-for-byte what `claude auth login` writes: OSC-8 opener carrying the url
// as the link TARGET, the same url again as the visible text, then an empty
// closer. Both terminated by BEL, verified against a real capture.
const REAL_OUTPUT =
  "Opening browser to sign in…\n" +
  "If the browser didn't open, visit: " +
  `\x1b]8;;${AUTHORIZE}\x07${AUTHORIZE}\x1b]8;;\x07` +
  "\nPaste code here if prompted > ";

describe("stripTerminalEscapes", () => {
  it("removes the hyperlink escapes and the duplicate url they carry", () => {
    const clean = stripTerminalEscapes(REAL_OUTPUT);
    expect(clean).not.toMatch(/\x1b/);
    expect((clean.match(/oauth\/authorize/g) ?? []).length).toBe(1);
  });

  it("keeps the prompt, which is what tells us the CLI is waiting", () => {
    expect(stripTerminalEscapes(REAL_OUTPUT)).toMatch(/Paste code here if prompted/);
  });

  it("removes ordinary colour codes too", () => {
    expect(stripTerminalEscapes("\x1b[1;32mok\x1b[0m")).toBe("ok");
  });
});

describe("extractLoginUrl", () => {
  it("returns the url exactly once, not the doubled string", () => {
    // The bug this prevents: /https:\/\/\S+/ on the raw bytes matches the link
    // target and the visible text as one run, producing a url that 404s.
    expect(extractLoginUrl(REAL_OUTPUT)).toBe(AUTHORIZE);
  });

  it("is null when there is no link — a failed launch, not a silent hang", () => {
    expect(extractLoginUrl("Already logged in as someone@example.com\n")).toBeNull();
    expect(extractLoginUrl("")).toBeNull();
    expect(extractLoginUrl(null)).toBeNull();
  });

  it("ignores urls that are not an authorize link", () => {
    expect(extractLoginUrl("see https://docs.claude.com/help for details")).toBeNull();
  });
});

describe("newSlot", () => {
  // `cswap add --json` is rejected by argparse, so the store is the only
  // trustworthy answer to "which slot did that land in".
  const store = (slots: string[]) => ({ slots, emails: {}, activeNum: null });

  it("names the slot that appeared", () => {
    expect(newSlot(store(["2", "3"]), store(["2", "3", "4"]))).toBe("4");
  });

  it("is null when the account was already managed and got refreshed in place", () => {
    // cswap overwrites the existing slot and prints "Updated credentials" —
    // a success, but not a new account, and the UI has to say the difference.
    expect(newSlot(store(["2", "3"]), store(["2", "3"]))).toBeNull();
  });

  it("is null rather than a guess when several slots appeared at once", () => {
    expect(newSlot(store(["2"]), store(["2", "3", "4"]))).toBeNull();
  });
});

describe("share envelope", () => {
  const NOW = 1_800_000_000_000;

  it("round-trips the payload", () => {
    const blob = wrapShare("{\"version\":1}", NOW);
    expect(blob.startsWith("ccdeck1:")).toBe(true);
    expect(unwrapShare(blob, NOW + 1000)).toEqual({ ok: true, payload: "{\"version\":1}" });
  });

  it("refuses a blob past its expiry", () => {
    // The whole point of the wrapper: a copy left in clipboard history stops
    // being an account.
    const blob = wrapShare("x", NOW);
    expect(unwrapShare(blob, NOW + SHARE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
    expect(unwrapShare(blob, NOW + SHARE_TTL_MS - 1).ok).toBe(true);
  });

  it("refuses anything that is not one of ours", () => {
    expect(unwrapShare("{\"version\":1}").reason).toBe("not_a_share");
    expect(unwrapShare("").reason).toBe("not_a_share");
    expect(unwrapShare(null).reason).toBe("not_a_share");
  });

  it("refuses a truncated paste rather than handing fragments to cswap", () => {
    const blob = wrapShare("payload", NOW);
    expect(unwrapShare(blob.slice(0, blob.length - 20), NOW).reason).toBe("corrupt");
  });

  it("refuses a version it does not know", () => {
    const future = "ccdeck1:" + btoa(JSON.stringify({ v: 2, exp: NOW + 1000, payload: "x" }));
    expect(unwrapShare(future, NOW).reason).toBe("wrong_version");
  });

  it("tolerates the whitespace a paste picks up", () => {
    const blob = wrapShare("payload", NOW);
    expect(unwrapShare(`  ${blob}\n`, NOW).ok).toBe(true);
  });
});

describe("removePromptMatches", () => {
  const prompt = (n: number) =>
    `Are you sure you want to permanently remove Account-${n} (a@b.c)? [y/N] `;

  it("answers the exact question cswap asked", () => {
    expect(removePromptMatches(prompt(4), 4)).toBe(true);
    expect(removePromptMatches(prompt(4), "4")).toBe(true);
  });

  it("refuses to confirm the removal of a different account", () => {
    // A blind "y" here deletes the wrong credentials, irrecoverably.
    expect(removePromptMatches(prompt(3), 4)).toBe(false);
  });

  it("refuses anything that is not that prompt", () => {
    expect(removePromptMatches("Warning: Account-4 (a@b.c) is currently active", 4)).toBe(false);
    expect(removePromptMatches("Enter account number to remove: ", 4)).toBe(false);
    expect(removePromptMatches("", 4)).toBe(false);
  });

  it("sees through colour codes", () => {
    expect(removePromptMatches(`\x1b[33m${prompt(4)}\x1b[0m`, 4)).toBe(true);
  });
});

describe("countCodePrompts", () => {
  const PROMPT = "Paste code here if prompted > ";

  it("counts one ask however much the CLI adds to its line", () => {
    // exec.mjs re-offers the unterminated prompt line on every chunk, so all
    // three of these are the SAME ask, one delivery later.
    expect(countCodePrompts(PROMPT)).toBe(1);
    expect(countCodePrompts(PROMPT + ".")).toBe(1);
    expect(countCodePrompts(PROMPT + "\x1b[2K\r⠙ verifying…")).toBe(1);
  });

  it("counts a genuine re-ask, including a carriage-return redraw", () => {
    expect(countCodePrompts(`${PROMPT}wrong\rInvalid code. ${PROMPT}`)).toBe(2);
  });

  it("is zero for output that is not the prompt", () => {
    expect(countCodePrompts("Opening browser to sign in…")).toBe(0);
    expect(countCodePrompts("")).toBe(0);
  });
});

describe("firstUseful / addFailureText", () => {
  it("takes the last real line, which is where a CLI puts its verdict", () => {
    expect(firstUseful("checking…\nError: No active Claude account found. Please log in first.\n"))
      .toBe("No active Claude account found. Please log in first.");
  });

  it("is empty rather than misleading when there is nothing to say", () => {
    expect(firstUseful("")).toBe("");
    expect(firstUseful("\n  \n---\n")).toBe("");
  });

  it("tells a Keychain failure what to actually do about it", () => {
    // The one failure a server hits that a terminal does not: without a GUI
    // session macOS refuses the credential read, and claude-swap's own message
    // stops short of naming the fix.
    const out = addFailureText({ stderr: "Error: The macOS Keychain is unreadable right now (locked).", code: 1 });
    expect(out).toMatch(/Keychain is unreadable/);
    expect(out).toMatch(/start ccdeck from a Terminal/i);
  });

  it("falls back to the exit code when the CLI said nothing at all", () => {
    expect(addFailureText({ stderr: "", stdout: "", code: 2 })).toBe("cswap add exited 2");
  });
});

// Reported from Windows on 2026-08-14: pressing "share…" showed one line —
// "operable program or batch file." — and nothing else. Two separate faults met
// there. The panel's mutations asked for the bare name `cswap`, which is on
// PATH on a Mac and usually is not on Windows; and cmd.exe reports a missing
// command as a healthy exit 1 over two lines, of which the LAST — the one a
// "show the final line" helper picks — carries no information at all.
const NOT_RECOGNIZED =
  "'cswap' is not recognized as an internal or external command,\noperable program or batch file.\n";

describe("looksMissing", () => {
  it("recognises cmd.exe's version of ENOENT", () => {
    expect(looksMissing(NOT_RECOGNIZED)).toBe(true);
    expect(looksMissing("The system cannot find the path specified.")).toBe(true);
  });

  it("does not fire on a real failure from the tool itself", () => {
    // The distinction that matters: this one must keep its own message.
    expect(looksMissing("Error: No active Claude account found.")).toBe(false);
    expect(looksMissing("")).toBe(false);
    expect(looksMissing(null)).toBe(false);
  });
});

describe("failureText", () => {
  it("replaces the Windows fragment with something actionable", () => {
    const out = failureText({ ok: false, code: 1, stderr: NOT_RECOGNIZED, stdout: "" }, "cswap export");
    expect(out).toMatch(/not on PATH/);
    expect(out).toMatch(/AGENTS_DECK_CSWAP/);
    expect(out).not.toMatch(/operable program/);
  });

  it("says so about the claude CLI when that is what went missing", () => {
    const out = failureText({ ok: false, code: "ENOENT", stderr: "", stdout: "" }, "claude auth login");
    expect(out).toMatch(/claude CLI/);
    expect(out).toMatch(/AGENTS_DECK_CLAUDE/);
  });

  it("keeps the tool's own message when the tool did run", () => {
    const out = failureText({ ok: false, code: 1, stderr: "Error: Account-9 does not exist\n" }, "cswap remove");
    expect(out).toBe("Account-9 does not exist");
  });

  it("falls back to the exit code rather than an empty banner", () => {
    expect(failureText({ ok: false, code: 2, stderr: "", stdout: "" }, "cswap move")).toBe("cswap move exited 2");
  });
});

describe("cswapCandidates", () => {
  const HOME_WIN = "C:\\Users\\dorin";
  const HOME_NIX = "/home/dorin";

  it("looks where uv and pipx put it on Windows", () => {
    const list = cswapCandidates("win32", {}, HOME_WIN);
    expect(list.every((p: string) => p.endsWith("cswap.exe"))).toBe(true);
    expect(list.some((p: string) => p.includes("\\.local\\bin\\"))).toBe(true);
    expect(list.some((p: string) => p.includes("Python\\Scripts"))).toBe(true);
  });

  it("respects a roaming profile's APPDATA rather than assuming the home dir", () => {
    const list = cswapCandidates("win32", { APPDATA: "\\\\server\\profiles\\dorin\\AppData\\Roaming" }, HOME_WIN);
    expect(list.some((p: string) => p.startsWith("\\\\server\\profiles\\"))).toBe(true);
  });

  it("puts explicit configuration first, on every platform", () => {
    expect(cswapCandidates("linux", { UV_TOOL_BIN_DIR: "/opt/uvbin" }, HOME_NIX)[0]).toBe("/opt/uvbin/cswap");
    expect(cswapCandidates("win32", { UV_TOOL_BIN_DIR: "D:\\bin" }, HOME_WIN)[0]).toBe("D:\\bin\\cswap.exe");
  });

  it("includes uv's own tool venv, which exists even when the symlink was never made", () => {
    expect(cswapCandidates("darwin", {}, HOME_NIX))
      .toContain("/home/dorin/.local/share/uv/tools/claude-swap/bin/cswap");
  });
});

// Two sign-ins overlap more easily than it sounds: the CLI is slow to print its
// link, the user reloads the page, and the second request takes over — which
// kills the first child, so that first request's link can never arrive and its
// fifteen-second wait always runs to the end. Announcing its own failure then
// used to publish over a live login: the dialog flipped to "failed" while the
// newer child sat waiting for a code nothing could deliver any more, and the
// only handle to it was gone, so it ran on for its full five minutes with the
// next attempt spawning a second one beside it.
describe("a startLogin that gives up after a newer one took over", () => {
  it("leaves the newer login standing, handle and all", async () => {
    const claude = process.env.AGENTS_DECK_CLAUDE;
    const backup = process.env.CLAUDE_SWAP_BACKUP;
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-login-"));
    // An empty store, so nothing in here can decide to switch the active
    // account of the machine running the tests; and a claude that is not
    // there, so the identity read answers "nobody" without running the real
    // one.
    process.env.CLAUDE_SWAP_BACKUP = dir;
    process.env.AGENTS_DECK_CLAUDE = join(dir, "no-such-claude");
    vi.useFakeTimers();
    try {
      const first = startLogin();
      const childA = await fakeLogin.child(0);
      expect(loginState().state).toBe("awaiting_url");

      // The reload: a second request, which yields the first one out of the way.
      const second = startLogin();
      const childB = await fakeLogin.child(1);
      expect(childA.killed).toBe(true);
      childB.say(`If the browser didn't open, visit: ${AUTHORIZE}`);
      await vi.advanceTimersByTimeAsync(200);
      expect(await second).toMatchObject({ ok: true, state: "awaiting_code" });

      // Now the first request's wait expires, with the second one live.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await first).toMatchObject({ ok: false, reason: "no_url" });

      expect(loginState().state).toBe("awaiting_code");
      expect(loginState().url).toBe(AUTHORIZE);
      // And the child is still reachable, which is the orphan half of the bug.
      await cancelLogin();
      expect(childB.killed).toBe(true);
    } finally {
      vi.useRealTimers();
      await cancelLogin();
      for (const c of fakeLogin.children) c.end({ ok: false, killed: true });
      if (claude === undefined) delete process.env.AGENTS_DECK_CLAUDE;
      else process.env.AGENTS_DECK_CLAUDE = claude;
      if (backup === undefined) delete process.env.CLAUDE_SWAP_BACKUP;
      else process.env.CLAUDE_SWAP_BACKUP = backup;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A rejected code announces itself by the CLI asking a second time — the
// process does not exit on a typo, it just re-prompts. That signal used to fire
// on any byte written after the prompt instead: the ask has no newline, so
// exec.mjs re-offers it as its line grows, and a progress dot or a spinner
// frame made the text differ from the one already counted. A login the CLI was
// busy completing came back as "that code was not accepted" — with the account
// never registered and the live credentials left on it.
describe("submitLoginCode and the second prompt", () => {
  /** An empty store and CLIs that are not there, so no test can switch the
   *  account of the machine running it. Returns the teardown. */
  function sandbox(name: string) {
    const claude = process.env.AGENTS_DECK_CLAUDE;
    const cswap = process.env.AGENTS_DECK_CSWAP;
    const backup = process.env.CLAUDE_SWAP_BACKUP;
    const dir = mkdtempSync(join(tmpdir(), name));
    process.env.CLAUDE_SWAP_BACKUP = dir;
    process.env.AGENTS_DECK_CLAUDE = join(dir, "no-such-claude");
    process.env.AGENTS_DECK_CSWAP = join(dir, "no-such-cswap");
    return async () => {
      await cancelLogin();
      for (const c of fakeLogin.children) c.end({ ok: false, killed: true });
      if (claude === undefined) delete process.env.AGENTS_DECK_CLAUDE;
      else process.env.AGENTS_DECK_CLAUDE = claude;
      if (cswap === undefined) delete process.env.AGENTS_DECK_CSWAP;
      else process.env.AGENTS_DECK_CSWAP = cswap;
      if (backup === undefined) delete process.env.CLAUDE_SWAP_BACKUP;
      else process.env.CLAUDE_SWAP_BACKUP = backup;
      rmSync(dir, { recursive: true, force: true });
    };
  }

  /** A login that has printed its link and is sitting on the prompt. */
  async function waiting() {
    const nth = fakeLogin.children.length;
    const start = startLogin();
    const child = await fakeLogin.child(nth);
    child.out(`If the browser didn't open, visit: ${AUTHORIZE}\nPaste code here if prompted > `);
    expect(await start).toMatchObject({ ok: true, state: "awaiting_code" });
    return child;
  }

  it("does not read progress on the prompt's own line as a rejection", async () => {
    const teardown = sandbox("ccdeck-accepted-");
    try {
      const child = await waiting();
      const verdict = submitLoginCode("ABC-123");
      expect(child.written).toEqual(["ABC-123\n"]);
      // The CLI verifies the code and says so where it stands — no newline, so
      // exec.mjs hands back the prompt's line again, longer each time. A dot,
      // then a spinner frame redrawn with \r on the shared stderr buffer.
      child.out(".");
      child.out("\x1b[2K\r⠙ verifying…");
      // Past the first poll of the verdict race, which is where the phantom
      // second prompt used to win it.
      await new Promise((r) => setTimeout(r, 250));
      child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" });

      // The fake claude cannot answer the identity check that comes next, so
      // the login stops there. The point is that it got that far at all:
      // the code was taken as accepted rather than reported rejected.
      const out = await verdict;
      expect(out.reason).toBe("no_identity");
      expect(out.reason).not.toBe("code_rejected");
    } finally {
      await teardown();
    }
  }, 10_000);

  it("still hears a real re-ask, on the line after — CRLF included", async () => {
    const teardown = sandbox("ccdeck-rejected-");
    try {
      const child = await waiting();
      const verdict = submitLoginCode("ABC-123");
      // What a typo gets: the CLI ends the prompt's line, says why, and asks
      // again. Windows line endings, since the child's are whatever it uses.
      child.out("\r\nInvalid code.\r\nPaste code here if prompted > ");

      const out = await verdict;
      expect(out).toMatchObject({ ok: false, reason: "code_rejected", state: "awaiting_code" });
      // And the flow stays usable, so the user can retype instead of starting
      // the whole sign-in over.
      expect(loginState().url).toBe(AUTHORIZE);
    } finally {
      await teardown();
    }
  }, 10_000);
});

// The import path used to call a helper that did not exist. Nothing caught it:
// every unit test stopped at the envelope, and the route's 500 reached the
// dialog as its generic fallback — "the import failed" — which is exactly what
// a genuinely refused import says. This one runs the whole function, with cswap
// pointed at a path that cannot exist, so a ReferenceError anywhere between the
// envelope and the child fails the test instead of shipping.
// Cancelling used to reach the store without the mutex. `cswap add` runs inside
// the lock and takes no file lock of its own, so a cancel arriving during the
// registration — which the dialog fires on Escape — put `cswap switch` in the
// middle of add's read-modify-write of sequence.json, and whichever write landed
// second dropped the other's record: the account that had just been added could
// simply vanish.
describe("cancelLogin and the store lock", () => {
  it("switches back only once the in-flight mutation has finished", async () => {
    const claude = process.env.AGENTS_DECK_CLAUDE;
    const cswap = process.env.AGENTS_DECK_CSWAP;
    const backup = process.env.CLAUDE_SWAP_BACKUP;
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-cancel-"));
    const seq = join(dir, "sequence.json");
    const store = (active: number) =>
      writeFileSync(seq, JSON.stringify({ activeAccountNumber: active, accounts: { 1: { email: "a@b.c" }, 2: { email: "d@e.f" } } }));
    const switches = () => ranArgs.filter(a => a[0] === "switch");
    // A store of our own, and two CLIs that are not there — nothing in here may
    // touch the account the machine running the tests is signed in as.
    store(1);
    process.env.CLAUDE_SWAP_BACKUP = dir;
    process.env.AGENTS_DECK_CLAUDE = join(dir, "no-such-claude");
    process.env.AGENTS_DECK_CSWAP = join(dir, "no-such-cswap");
    const nth = fakeLogin.children.length;
    try {
      const start = startLogin();
      const child = await fakeLogin.child(nth);
      child.say(`If the browser didn't open, visit: ${AUTHORIZE}`);
      expect(await start).toMatchObject({ ok: true, state: "awaiting_code" });
      const before = switches().length;

      // The lock, held the way submitLoginCode holds it while `cswap add` runs.
      let release!: () => void;
      const busy = withStoreLock(() => new Promise<void>((r) => { release = r; }));
      // And the active account has moved meanwhile — by the add itself, or by
      // the deck's own auto-switch tick. That is what gives cancel something to
      // undo, and what makes the two writes collide.
      store(2);

      const cancelled = cancelLogin();
      await new Promise((r) => setTimeout(r, 50));
      // The child is gone immediately: nothing about killing it touches a file.
      expect(child.killed).toBe(true);
      // The store is not: the switch waits its turn.
      expect(switches().length).toBe(before);

      release();
      await busy;
      expect(await cancelled).toMatchObject({ ok: true, state: "idle" });
      expect(switches().slice(before)).toEqual([["switch", "1"]]);
    } finally {
      await cancelLogin();
      for (const c of fakeLogin.children) c.end({ ok: false, killed: true });
      if (claude === undefined) delete process.env.AGENTS_DECK_CLAUDE;
      else process.env.AGENTS_DECK_CLAUDE = claude;
      if (cswap === undefined) delete process.env.AGENTS_DECK_CSWAP;
      else process.env.AGENTS_DECK_CSWAP = cswap;
      if (backup === undefined) delete process.env.CLAUDE_SWAP_BACKUP;
      else process.env.CLAUDE_SWAP_BACKUP = backup;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is re-entrant, so a mutation can be queued from inside one", async () => {
    // The other half of queueing cancel: a caller that already holds the lock
    // would otherwise wait for itself — the chain cannot advance past the link
    // it is inside — and every later mutation would wait behind it forever.
    expect(await withStoreLock(async () => withStoreLock(async () => "inner"))).toBe("inner");
    // And the lock still works afterwards.
    expect(await withStoreLock(async () => "after")).toBe("after");
  });
});

describe("importAccount reaches the CLI", () => {
  it("returns a refusal, not a crash, when cswap cannot be run", async () => {
    const before = process.env.AGENTS_DECK_CSWAP;
    process.env.AGENTS_DECK_CSWAP = "/nonexistent/definitely/not/cswap";
    try {
      const blob = wrapShare(JSON.stringify({ version: 1, accounts: [] }));
      const out = await importAccount(blob);
      expect(out.ok).toBe(false);
      expect(out.reason).toBe("import_failed");
      expect(out.detail).toMatch(/not on PATH/);
    } finally {
      if (before === undefined) delete process.env.AGENTS_DECK_CSWAP;
      else process.env.AGENTS_DECK_CSWAP = before;
    }
  });
});
