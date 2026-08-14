// What `npx ccdeck` tells the shell about a deck that was killed.
//
// ccdeck is a stub package: nine lines that spawn the real agents-deck binary
// and report back whatever it did. The supervisor is careful here — a worker
// killed by a signal is answered by dying of that same signal, so the
// killed-by-a-signal bit is set for every wait(2)-based caller and `$?` comes
// out 143 (see supervisor.mjs and supervisor-exit.test.ts). The stub threw that
// away: it bound only the exit code, and a signal death carries code `null`, so
// `process.exit(code ?? 0)` reported a killed deck as a clean stop. A systemd
// unit or a wrapper script that ran the deck the way README.md recommends saw
// success where `npx agents-deck` on the same build reported 143. Ctrl+C hid it
// — that signals the whole process group, so the stub dies of SIGINT itself
// instead of ever reaching this handler.
//
// The stub is only itself inside a real install layout: it walks out of its own
// bin/ to find both the binary and the supervisor. So the layout is built in a
// temp directory and the shipped file is run unmodified. The fake agents-deck
// re-exports the repo's real supervisor.mjs rather than copying it, so what is
// pinned here is the rule that actually ships. Nothing is installed and no npx
// runs: the "deck" is a two-line script that kills itself on request.
//
// Signals are POSIX. Windows cannot die of one, and the stub has no
// platform-specific code of its own — the 128+n fallback lives in
// signalExitAction, where supervisor-exit.test.ts asserts it for win32 from any
// OS. Here the signal cases are skipped there and the exit-code cases are not.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Nothing under test reads the user's configuration, but a spawned child
// inherits this process's environment and the stub hands it to a real Node
// process — so point every home the deck knows about at the sandbox before
// anything runs, on POSIX (HOME) and on Windows (USERPROFILE) alike.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-stub-exit-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");

// The layout npm produces, because the stub's `../../agents-deck` depends on
// it: node_modules/ccdeck/bin/ccdeck.js next to node_modules/agents-deck.
const MODULES = join(SANDBOX, "node_modules");
const STUB = join(MODULES, "ccdeck", "bin", "ccdeck.js");
const DECK = join(MODULES, "agents-deck", "bin", "agent-dag.js");
const SUPERVISOR = join(MODULES, "agents-deck", "src", "server", "supervisor.mjs");

// Belt and braces: every path written below is derived, and a single wrong join
// would have this file spawning scripts from the developer's own tree.
for (const p of [STUB, DECK, SUPERVISOR]) {
  if (!p.startsWith(SANDBOX)) throw new Error(`refusing to run: ${p} is outside ${SANDBOX}`);
}

for (const [dir, name] of [["ccdeck", "ccdeck"], ["agents-deck", "agents-deck"]] as const) {
  mkdirSync(join(MODULES, dir), { recursive: true });
  // Without `type: module` Node reads the stub's .js as CommonJS and its import
  // statements are a syntax error — the published ccdeck declares it too.
  writeFileSync(join(MODULES, dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
}
mkdirSync(join(MODULES, "ccdeck", "bin"), { recursive: true });
mkdirSync(join(MODULES, "agents-deck", "bin"), { recursive: true });
mkdirSync(join(MODULES, "agents-deck", "src", "server"), { recursive: true });

copyFileSync(fileURLToPath(new URL("../../../ccdeck/bin/ccdeck.js", import.meta.url)), STUB);
const real = new URL("../../server/supervisor.mjs", import.meta.url).href;
writeFileSync(SUPERVISOR, `export * from ${JSON.stringify(real)};\n`);

// Stands in for bin/agent-dag.js. `signal` reproduces a supervisor that died of
// the signal its worker died of; `exit` is the ordinary path.
writeFileSync(DECK, [
  `const [how, what] = process.argv.slice(2);`,
  `if (how === "signal") process.kill(process.pid, what);`,
  `else process.exit(Number(what));`,
].join("\n"));

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

const runStub = (...args: string[]) =>
  new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const child = spawn(process.execPath, [STUB, ...args], { stdio: "ignore" });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

describe("npx ccdeck when the deck was killed", () => {
  it.skipIf(process.platform === "win32")(
    "dies of the signal the deck died of instead of reporting a clean stop",
    async () => {
      // The regression: this used to be { code: 0, signal: null }, so a
      // `kill` of the deck looked to systemd exactly like a graceful shutdown.
      expect(await runStub("signal", "SIGTERM")).toEqual({ code: null, signal: "SIGTERM" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "passes on every signal the deck can be killed with, not just SIGTERM",
    async () => {
      // SIGHUP is the everyday one — deck.js installs no handler for it at all
      // — and SIGINT arrives here whenever a single process, rather than the
      // whole foreground group, is the target.
      expect(await runStub("signal", "SIGHUP")).toEqual({ code: null, signal: "SIGHUP" });
      expect(await runStub("signal", "SIGINT")).toEqual({ code: null, signal: "SIGINT" });
    },
  );
});

describe("npx ccdeck when the deck exited on its own", () => {
  it("still reports a clean stop as success", async () => {
    expect(await runStub("exit", "0")).toEqual({ code: 0, signal: null });
  });

  it("still hands the deck's own verdict to the shell unchanged", async () => {
    // The supervisor has already folded its private restart codes into 0 by the
    // time anything reaches here, so whatever arrives is the deck's real answer.
    expect(await runStub("exit", "1")).toEqual({ code: 1, signal: null });
    expect(await runStub("exit", "7")).toEqual({ code: 7, signal: null });
  });
});
