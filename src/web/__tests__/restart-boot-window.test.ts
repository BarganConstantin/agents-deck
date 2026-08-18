// A restart asked for before the deck has finished starting up.
//
// The listener comes up from inside startServer, before that call has even
// returned to bin/deck.js — so POST /api/restart is answerable for the whole of
// the startup that follows it: the port report to the supervisor, the discovery
// file and its first fsynced write, and on a cold start the browser spawn.
//
// A restart landing in that window used to reach bin/deck.js's `shutdown`
// before the `const` holding it had been initialised and die of
// `ReferenceError: Cannot access 'shutdown' before initialization`. The throw
// itself was swallowed whole — the server's `catch` released its own half of
// the latch and said nothing — but bin/deck.js had already set `restarting`,
// and nothing in the process ever cleared it again. From then on the deck
// answered every restart, from every tab, with `200 {ok:true}` and did nothing
// at all: no restart, no update, no explanation, for the life of the process.
// Measured here at 65–261ms on a machine doing nothing else, wider on a cold
// boot and wider again on Windows, where `open` awaits a PowerShell lookup.
//
// Two halves, because the bug has two. The first drives the shipped server over
// a real socket and asks what it answers while the launcher has not reported
// ready. The second runs the real supervisor and the real bin/deck.js, with the
// one call the boot waits on — keepDiscovery().check() — held open long enough
// that the race is arithmetic rather than luck, and asks whether the deck comes
// back and can be restarted again afterwards.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Temp home, set before the dynamic import below: the server resolves its
// config directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-boot-window-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.AGENTS_DECK_NO_INSTALL = "1";
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs modules, no types
const { startServer, releaseRestart, markDeckReady } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs modules, no types
const { killTree } = await import("../../server/exec.mjs");

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTS_DECK_NO_INSTALL"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

type Answer = { status: number; body: any };

/** POST wearing the headers the deck's own page sends, which is what
 *  isAuthorizedMutation accepts without a token. */
function post(port: number, path: string, body = "{}"): Promise<Answer> {
  return new Promise((done, fail) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
    }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch { parsed = out; }
        done({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", fail);
    req.end(body);
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Wait for a condition that a timer or a subprocess will make true. Polled
 *  rather than awaited on an event, because the things being waited for here
 *  are a 120ms handoff and another process's stdout. */
async function until(ok: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

describe("the answer /api/restart gives while the deck is still booting", () => {
  let server: Server;
  let port = 0;
  let asked: (string | null)[] = [];
  let onRestart: (mode: string | null) => void;

  beforeEach(async () => {
    asked = [];
    onRestart = (mode) => { asked.push(mode); };
    // The latch is process-wide and the real deck only ever clears it by
    // exiting, so each of these starts from the state a fresh boot has.
    releaseRestart();
    server = await startServer({
      port: 0, host: "127.0.0.1", codex: false, claude: false,
      // A restart needs both: something able to bring the deck back, and an
      // event log to replay into the canvas afterwards.
      persist: join(DIR, "events.jsonl"),
      onRestart: (mode: string | null) => onRestart(mode),
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    // The handoff to the launcher is 120ms behind the response, so a test that
    // ends the moment it has been answered leaves a timer behind — and that
    // timer lands in the next test's collector and makes its arithmetic a race.
    // Drained here rather than guessed at in each assertion.
    await sleep(250);
    await new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    });
  });

  it("answers, and names the state it is answering from", async () => {
    // startServer has run and markDeckReady has not, which is exactly the
    // window: the socket is up and the launcher around it is not finished.
    const answer = await post(port, "/api/restart");
    // 202, not 200: accepted, not done. The regression this pins is not the
    // status but the fact that there IS one — the ask used to be answered
    // `200 {ok:true}` and then thrown away in silence.
    expect(answer.status).toBe(202);
    expect(answer.body.ok).toBe(true);
    expect(answer.body.booting).toBe(true);
    // A caller reading this should not have to know what `booting` means.
    expect(String(answer.body.detail)).toMatch(/starting up/);
  });

  it("hands the ask to the launcher anyway, rather than refusing it", async () => {
    // The window is bounded and short and the user asked for something the
    // deck can genuinely give a moment later, so nothing is dropped here. The
    // launcher is the half that decides to hold it — see requestRestart.
    await post(port, "/api/restart");
    await until(() => asked.length >= 1, 3000, "the launcher to be asked");
    expect(asked).toEqual([null]);
  });

  it("answers plainly once the launcher reports it is up", async () => {
    markDeckReady();
    const answer = await post(port, "/api/restart");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, mode: null });
    await until(() => asked.length >= 1, 3000, "the launcher to be asked");
  });

  it("lets a second tab know a restart is already running", async () => {
    markDeckReady();
    expect((await post(port, "/api/restart")).status).toBe(200);
    // The pre-existing latch, unchanged: several tabs watching one deck each
    // ask, and the second ask must not re-enter the shutdown.
    const second = await post(port, "/api/restart");
    expect(second.status).toBe(202);
    expect(second.body.already).toBe(true);
    expect(second.body.booting).toBeUndefined();
  });

  it("does not let one failed ask poison the next", async () => {
    // The shape of #448 at this layer: a launcher that throws must cost its own
    // request and nothing else. What made the original permanent was a latch
    // left set by a throw nobody saw.
    markDeckReady();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      onRestart = () => { asked.push(null); throw new Error("boom"); };
      expect((await post(port, "/api/restart")).status).toBe(200);
      await until(() => asked.length >= 1, 3000, "the first ask");
      await until(() => errors.mock.calls.length >= 1, 3000, "the failure to be said out loud");

      // And the next click works, rather than being answered "already
      // restarting" for the rest of the process's life.
      onRestart = (mode) => { asked.push(mode); };
      const again = await post(port, "/api/restart");
      expect(again.status).toBe(200);
      expect(again.body.already).toBeUndefined();
      await until(() => asked.length >= 2, 3000, "the second ask");

      // One line, message only. The terminal underneath is repainted every
      // 800ms by the pulse indicator, and a stack dumped into that is a stack
      // nobody can read (#432).
      const said = errors.mock.calls[0].join(" ");
      expect(said).toContain("boom");
      expect(said).not.toContain("\n");
    } finally {
      errors.mockRestore();
    }
  });
});

// ── the whole thing, in the processes that ship ──────────────────────────────
// The technique is upgrade-no-outage.test.ts's: an install layout in a temp
// directory holding the real supervisor and the real worker, with every
// src/server module re-exported from the repo rather than copied, so what runs
// is what ships. Exactly two functions are shadowed, and neither is on the path
// under test: keepDiscovery, so the boot window has a width this test can
// reason about instead of a width the machine decides, and versionReport, so no
// registry is contacted.
const PKG = join(DIR, "pkg");
const SERVER_DIR = join(PKG, "src", "server");
const REAL_BIN = fileURLToPath(new URL("../../../bin/", import.meta.url));
const REAL_SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
// How long keepDiscovery().check() holds the boot open. Everything the deck
// does after the socket is accepting happens under it.
const BOOT_MS = 1200;

for (const p of [PKG, SERVER_DIR]) {
  if (!p.startsWith(DIR)) throw new Error(`refusing to run: ${p} is outside ${DIR}`);
}

mkdirSync(join(PKG, "bin"), { recursive: true });
mkdirSync(SERVER_DIR, { recursive: true });
mkdirSync(join(PKG, "dist", "web"), { recursive: true });

// bin/deck.js refuses to boot without a built UI, and nothing here serves a
// page. The file only has to exist.
writeFileSync(join(PKG, "dist", "web", "index.html"), "<!doctype html>\n");
writeFileSync(join(PKG, "package.json"), JSON.stringify({
  name: "agents-deck", version: "1.35.17", type: "module",
}));
copyFileSync(join(REAL_BIN, "agent-dag.js"), join(PKG, "bin", "agent-dag.js"));
copyFileSync(join(REAL_BIN, "deck.js"), join(PKG, "bin", "deck.js"));

for (const mod of readdirSync(REAL_SERVER).filter(f => f.endsWith(".mjs"))) {
  const real = new URL(`../../server/${mod}`, import.meta.url).href;
  writeFileSync(join(SERVER_DIR, mod), `export * from ${JSON.stringify(real)};\n`);
}

// The one await the deck's boot spends its time in, given a duration. A local
// export shadows the same name arriving through `export *`, so every other
// thing in installer.mjs — removeDiscovery included — is still the real one.
// Nothing is registered: no hook is going to look for this deck.
writeFileSync(join(SERVER_DIR, "installer.mjs"), [
  `export * from ${JSON.stringify(new URL("../../server/installer.mjs", import.meta.url).href)};`,
  `const HELD = Number(process.env.STUB_BOOT_MS ?? 0);`,
  `export function keepDiscovery() {`,
  `  return {`,
  `    file: ${JSON.stringify(join(DIR, "never-written.json"))},`,
  `    check: () => new Promise(r => setTimeout(r, HELD)),`,
  `    stop: () => {},`,
  `  };`,
  `}`,
].join("\n"));

// No registry, from either process. The real one is raced against a 1200ms
// timeout and swallowed, so a network this test cannot rely on would only make
// the boot's width a lottery again.
writeFileSync(join(SERVER_DIR, "self-update.mjs"), [
  `export * from ${JSON.stringify(new URL("../../server/self-update.mjs", import.meta.url).href)};`,
  `export function versionReport() { return Promise.resolve(null); }`,
].join("\n"));

type Lifetime = { first: Answer; second: Answer; out: () => string; restarts: () => number };

describe("a restart clicked while the deck is still coming up", () => {
  let child: ChildProcess | null = null;
  let out = "";
  const restarts = () => (out.match(/restarted/g) ?? []).length;
  let life: Lifetime;

  beforeAll(async () => {
    child = spawn(process.execPath, [
      join(PKG, "bin", "agent-dag.js"),
      // Port 0 so nothing can collide with a developer's own deck; the port
      // that was actually bound is read back off the banner, and the
      // supervisor re-launches the respawn onto the same one.
      "--port", "0", "--no-open", "--no-claude", "--no-codex",
      "--history", join(DIR, "deck-events.jsonl"),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: DIR, USERPROFILE: DIR,
        CLAUDE_CONFIG_DIR: join(DIR, "claude"),
        CODEX_HOME: join(DIR, "codex"),
        AGENTS_DECK_NO_INSTALL: "1",
        STUB_BOOT_MS: String(BOOT_MS),
        NO_COLOR: "1",
      },
    });
    child.stdout!.on("data", d => { out += String(d); });
    child.stderr!.on("data", d => { out += String(d); });

    // The banner prints the bound URL the moment the socket is up — which is
    // the top of the window, with the whole of BOOT_MS still to run.
    await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(out), 20_000, "the deck to bind");
    const port = Number(out.match(/http:\/\/127\.0\.0\.1:(\d+)/)![1]);

    const first = await post(port, "/api/restart");
    // It has to actually happen, not merely be accepted: this is the assertion
    // the old code could not pass, because the ReferenceError killed the
    // restart and the latch it left made every later one impossible too.
    await until(() => restarts() >= 1, 20_000, "the deck to come back");

    // The respawn is a boot of its own and holds its discovery check open for
    // just as long, so this waits it out — the point of the second ask is the
    // ordinary path, after the window has closed.
    await sleep(BOOT_MS + 800);
    const second = await post(port, "/api/restart");
    await until(() => restarts() >= 2, 20_000, "the deck to come back a second time");

    life = { first, second, out: () => out, restarts };
  }, 60_000);

  afterAll(() => {
    if (child) killTree(child, "SIGKILL");
    child = null;
  });

  it("is answered, and told the deck is still starting up", () => {
    expect(life.first.status).toBe(202);
    expect(life.first.body.ok).toBe(true);
    expect(life.first.body.booting).toBe(true);
  });

  it("restarts the deck once it can, rather than dropping the ask", () => {
    expect(life.restarts()).toBeGreaterThanOrEqual(2);
  });

  it("still restarts on the next ask, which is what the latch used to eat", () => {
    // Answered 200 rather than 202: the deck that came back reported itself
    // ready, so this one is an ordinary restart and is run on the spot.
    expect(life.second.status).toBe(200);
    expect(life.second.body).toEqual({ ok: true, mode: null });
  });

  it("never writes a stack into the terminal it repaints", () => {
    // #432's rule, and the reason the original was invisible for as long as it
    // was: the only trace it left was a line that said `restarting…` and a deck
    // that did not.
    expect(life.out()).not.toContain("ReferenceError");
    expect(life.out()).not.toMatch(/^\s+at .+:\d+:\d+/m);
  });
});
