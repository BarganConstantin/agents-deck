// What a signal aimed at `npx ccdeck` does to the deck underneath it.
//
// The stub trapped nothing, so the tree it starts — ccdeck.js → agent-dag.js →
// deck.js — came apart at the top the moment anything signalled the launcher by
// pid: a systemd unit without KillMode=control-group, a supervisor that signals
// only the main pid, a hand-typed `kill`. Measured before the fix, the stub was
// gone in six milliseconds and the deck was still running seconds later, still
// serving on 4317 and still advertising a live pid in its discovery file. Hooks
// keep posting to a deck the user believes is stopped, and the next `npx ccdeck`
// finds the port taken.
//
// Ctrl+C is why it survived: that signals the whole foreground process group and
// the deck gets its own copy without the stub's help. Which is also why the
// obvious fix — forward every signal, always — is not one. Under Ctrl+C the
// forwarded copy lands about a millisecond behind the terminal's as a SECOND
// signal, and agent-dag.js reads a second signal as an impatient user and
// answers it by SIGKILLing deck.js: the discovery file it was partway through
// removing stays behind. So both directions are pinned here, and the group case
// is the one that fails against the naive patch.
//
// The stub is only itself inside a real install layout, so each test builds one
// in a temp directory and runs the shipped file unmodified. The fake deck
// re-exports the repo's real supervisor.mjs rather than copying it; the fake
// agent-dag.js is a few lines that log every signal they receive and then shut
// down a beat later on their own terms, the way deck.js does. Nothing is
// installed and no npx runs.
//
// Everything here waits on an event — the fake deck announcing itself, the stub
// exiting — and never on a sleep, because #343 is what a fixed sleep costs on a
// box running twenty other things. The one deadline that cannot be an event is
// the Windows case, which is an assertion that nothing happens; see it there.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-stub-signals-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
// The stub spawns a real Node process that inherits this environment, so every
// home the deck knows about points into the sandbox first — POSIX and Windows.
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");

const SHIPPED = fileURLToPath(new URL("../../../ccdeck/bin/ccdeck.js", import.meta.url));

// The stub's own constant. A forward it schedules lands two seconds after the
// signal, so every wait below has to be generously past that and none of them is
// allowed to be exactly it.
const FORWARD_AFTER_MS = 2000;

// Kept so a failed assertion cannot leave a deck — or a whole process group —
// running in the background of the rest of the suite.
const running = new Set<ChildProcess>();

afterAll(() => {
  for (const child of running) {
    try { process.kill(-(child.pid as number), "SIGKILL"); } catch { /* not a leader, or gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

/**
 * Writes the npx layout — stub and deck side by side — and returns the stub to
 * run plus the file its fake deck records signals in.
 */
function layout(name: string): { stub: string; log: string } {
  const root = mkdtempSync(join(SANDBOX, `${name}-`));
  const modules = join(root, "node_modules");
  const stubDir = join(modules, "ccdeck");
  const deckDir = join(modules, "agents-deck");

  // Every path is derived, and one wrong join would have this file spawning
  // scripts out of the developer's own tree.
  for (const p of [stubDir, deckDir]) {
    if (!p.startsWith(SANDBOX)) throw new Error(`refusing to run: ${p} is outside ${SANDBOX}`);
  }

  for (const [dir, pkg] of [[stubDir, "ccdeck"], [deckDir, "agents-deck"]] as const) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    // Without `type: module` node reads the stub's .js as CommonJS and its
    // import statements are a syntax error — the published ccdeck declares it.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version: "0.0.0", type: "module" }));
  }
  mkdirSync(join(deckDir, "src", "server"), { recursive: true });

  const stub = join(stubDir, "bin", "ccdeck.js");
  copyFileSync(SHIPPED, stub);
  // Re-export rather than copy, so what runs is the supervisor that ships.
  writeFileSync(
    join(deckDir, "src", "server", "supervisor.mjs"),
    `export * from ${JSON.stringify(new URL("../../server/supervisor.mjs", import.meta.url).href)};\n`,
  );

  const log = join(root, "signals.log");
  // Stands in for bin/agent-dag.js: a server that stays up, records every signal
  // it is sent, and — like deck.js — does not die where the signal lands but
  // finishes and exits 0 a beat later. Its pid is announced on stdout, which the
  // stub inherits, so the harness can wait for a fact instead of for a clock.
  writeFileSync(join(deckDir, "bin", "agent-dag.js"), [
    `import { appendFileSync } from "node:fs";`,
    `const log = ${JSON.stringify(log)};`,
    `let n = 0;`,
    `for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => {`,
    `  appendFileSync(log, sig + "\\n");`,
    `  if (++n === 1) setTimeout(() => process.exit(0), 100);`,
    `});`,
    `setInterval(() => {}, 1000);`,
    `console.log("ready " + process.pid);`,
  ].join("\n"));
  return { stub, log };
}

/** Every signal the fake deck has been sent, in the order it got them. */
const received = (log: string) =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

/**
 * Runs the stub and settles once the fake deck has announced itself — a
 * handshake, not a sleep, so nothing here is a bet on how long a cold Node start
 * takes on a machine running the rest of the suite beside it.
 *
 * `detached` makes the stub a process group leader, which is the only way to
 * reproduce Ctrl+C honestly: the terminal signals a group, and `kill(-pid)`
 * against a leader is the same delivery to the same set of processes.
 */
function start(stub: string, opts: { detached?: boolean; preload?: string } = {}) {
  const argv = opts.preload ? ["--require", opts.preload, stub] : [stub];
  const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], detached: opts.detached });
  running.add(child);
  let out = "", err = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
  const deckPid = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the fake deck never announced itself. stdout: ${out} stderr: ${err}`)),
      20_000,
    );
    const look = () => {
      const found = out.match(/ready (\d+)/);
      if (!found) return;
      clearTimeout(timer);
      child.stdout!.off("data", look);
      resolve(Number(found[1]));
    };
    child.stdout!.on("data", look);
  });
  return { child, deckPid };
}

/**
 * Settles with how the stub ended.
 *
 * The exitCode/signalCode guard is load-bearing: node sets both in the same
 * breath as it emits 'exit', and `once("exit")` on a process that has already
 * exited never fires — waiting unguarded would trade a flake for a hang. The
 * ceiling is far past anything a healthy run pays and exists only so a forward
 * that never landed fails with a sentence rather than as a bare vitest timeout.
 */
const exited = (child: ChildProcess, ms = 25_000) =>
  new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve({ code: child.exitCode, signal: child.signalCode });
    }
    const done = (code: number | null, signal: string | null) => { clearTimeout(timer); resolve({ code, signal }); };
    const timer = setTimeout(() => {
      child.off("exit", done);
      reject(new Error(`the stub (pid ${child.pid}) was still running ${ms}ms after it was signalled`));
    }, ms);
    child.once("exit", done);
  });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Windows has no signal to send: `process.kill` there is a TerminateProcess that
// runs no handler at all, so a POSIX assertion would be measuring the emulation
// rather than the behaviour. Its own answer is the last describe in this file.
const posix = process.platform !== "win32";

describe("a signal that reaches only the stub", () => {
  it.skipIf(!posix)("comes down on the deck too, instead of orphaning it", async () => {
    // The reported failure. `kill <pid>` is targeted at one process: the deck is
    // in the same process group but the kernel delivers this to nobody else, so
    // before the fix the log below stayed empty and the deck outlived its
    // launcher.
    const { stub, log } = layout("targeted");
    const { child, deckPid } = start(stub);
    await deckPid;

    process.kill(child.pid as number, "SIGTERM");

    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect(received(log), "the deck was never told to stop").toEqual(["SIGTERM"]);
  }, 40_000);

  it.skipIf(!posix)("waits for the deck rather than dying first", async () => {
    // Half the fix is not dying. The default action for these signals is to
    // terminate, so the stub used to vanish while the deck was still shutting
    // down and hand the shell a status of its own; the code above is the fake
    // deck's, which is the whole point of a launcher.
    const { stub, log } = layout("verdict");
    const { child, deckPid } = start(stub);
    await deckPid;

    process.kill(child.pid as number, "SIGHUP");

    const how = await exited(child);
    expect(how.signal, "the stub died of the signal instead of passing it on").toBeNull();
    expect(how.code).toBe(0);
    expect(received(log)).toEqual(["SIGHUP"]);
  }, 40_000);
});

describe("a signal the terminal already delivered to the whole group", () => {
  it.skipIf(!posix)("is not sent again, so the deck keeps its own shutdown", async () => {
    // Ctrl+C, reproduced exactly: the stub leads its own process group and the
    // signal goes to the group, which is what a terminal does. The deck must see
    // ONE SIGINT. A second is what agent-dag.js reads as an impatient user, and
    // it answers that by SIGKILLing deck.js mid-shutdown — measured at three runs
    // out of three against the unconditional forward, one millisecond apart.
    const { stub, log } = layout("group");
    const { child, deckPid } = start(stub, { detached: true });
    await deckPid;

    process.kill(-(child.pid as number), "SIGINT");

    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect(received(log), "the deck was signalled twice for one Ctrl+C").toEqual(["SIGINT"]);
  }, 40_000);
});

describe("a second signal, from somebody who is done waiting", () => {
  it.skipIf(!posix)("goes through at once instead of waiting out the first", async () => {
    // Asserted by identity rather than by clock, because a clock on a loaded box
    // measures the box. The first signal only schedules a forward; if that were
    // the only path the deck would be sent SIGHUP two seconds later. It is sent
    // SIGTERM instead, which can only be the second signal cancelling the first
    // and going straight out.
    const { stub, log } = layout("impatient");
    const { child, deckPid } = start(stub);
    await deckPid;

    process.kill(child.pid as number, "SIGHUP");
    process.kill(child.pid as number, "SIGTERM");

    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect(received(log)).toEqual(["SIGTERM"]);
  }, 40_000);
});

describe("the same signal on Windows, which cannot forward one", () => {
  it.skipIf(!posix)("swallows it and waits, because a forward there is a kill", async () => {
    // Windows is the platform this repo cannot execute, so the branch is reached
    // by redefining the one thing it reads. path and child_process bind their
    // platform during node's own bootstrap, before this preload runs, so the host
    // keeps resolving and spawning as the POSIX box it is — only the stub's
    // decision changes.
    //
    // The behaviour being pinned is that nothing is sent. On Windows the only
    // thing that runs these handlers is a console event, which the console has
    // already delivered to every process attached to it; and `child.kill()` there
    // is TerminateProcess, which would take agent-dag.js out mid-shutdown and
    // orphan deck.js underneath it — this bug, caused by its own fix.
    const preload = join(SANDBOX, "as-windows.cjs");
    writeFileSync(preload, `Object.defineProperty(process, "platform", { value: "win32", configurable: true });\n`);

    const { stub, log } = layout("windows");
    const { child, deckPid } = start(stub, { preload });
    const pid = await deckPid;

    process.kill(child.pid as number, "SIGTERM");

    // The one deadline in this file, because "nothing happened" has no event to
    // wait for. It is well past the forward the POSIX branch would have made, and
    // a slow machine only makes it slower to arrive, never earlier — so load can
    // weaken this assertion but cannot turn it into a false failure.
    await sleep(FORWARD_AFTER_MS + 1500);
    expect(received(log), "Windows sent a signal it has no way to deliver").toEqual([]);
    expect(child.exitCode, "the stub died instead of waiting for its deck").toBeNull();
    expect(child.signalCode).toBeNull();

    // And it was waiting for a reason: the deck's verdict is still what the
    // caller gets once the deck has one.
    process.kill(pid, "SIGTERM");
    expect(await exited(child)).toEqual({ code: 0, signal: null });
    expect(received(log)).toEqual(["SIGTERM"]);
  }, 40_000);
});
