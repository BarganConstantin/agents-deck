// The port opens before the startup report finishes, not after it (#483).
//
// bin/deck.js used to `await reportStartup(jobs)` and only then call
// startServer, so the listener was not opened until every startup job had
// settled — and a job that is merely slow, not blocking, still kept the socket
// shut. `ensureCswap` is the live example: on a machine with no Python tooling
// it runs a real `uv tool install` under a 180-second timeout, so the deck
// printed its rows and then answered nothing for up to three minutes, on the
// first run, which is the one boot a new user judges the tool by.
//
// #476 fixed the other half of this — the ccusage install ran a `spawnSync` on
// the event loop — but a responsive process is not an open port. The symptom
// (a browser that cannot connect while the terminal looks busy) came from the
// ordering, and survived that fix.
//
// The technique is restart-boot-window.test.ts's, which is upgrade-no-outage's:
// an install layout in a temp directory holding the real bin/ and a src/server/
// of one-line `export *` shims onto the repo, so what runs is what ships. Three
// functions are shadowed and none of them is the thing under test:
//
//   ensureCswap    the slow job — held open by a file this test creates, so the
//                  race is arithmetic rather than luck and no assertion here
//                  depends on how loaded the machine is
//   versionReport  so no registry is contacted
//   keepDiscovery  so nothing is registered for a hook to find
//
// The second half asks the question the reorder created: the listen is now a
// promise that lives across the whole report, so a bind that fails inside that
// window has to be carried to the end of it and said out loud — not left
// unhandled for Node to answer by killing the process over a port it could have
// named.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-listen-first-"));
const PKG = join(DIR, "pkg");
const SERVER_DIR = join(PKG, "src", "server");
const REAL_BIN = fileURLToPath(new URL("../../../bin/", import.meta.url));
const REAL_SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
// Creating this file is what lets the slow startup job finish. Until it exists
// the deck is inside reportStartup with nowhere to go, which is exactly the
// window every assertion below is about.
const RELEASE = join(DIR, "release-cswap");

for (const p of [PKG, SERVER_DIR, RELEASE]) {
  if (!resolve(p).startsWith(resolve(DIR))) throw new Error(`refusing to run: ${p} is outside ${DIR}`);
}

// @ts-expect-error — plain .mjs modules, no types
const { killTree } = await import("../../server/exec.mjs");

mkdirSync(join(PKG, "bin"), { recursive: true });
mkdirSync(SERVER_DIR, { recursive: true });
mkdirSync(join(PKG, "dist", "web"), { recursive: true });

// bin/deck.js refuses to boot without a built UI, and nothing here serves a
// page. The file only has to exist.
writeFileSync(join(PKG, "dist", "web", "index.html"), "<!doctype html>\n");
writeFileSync(join(PKG, "package.json"), JSON.stringify({
  name: "agents-deck", version: "1.36.1", type: "module",
}));
copyFileSync(join(REAL_BIN, "agent-dag.js"), join(PKG, "bin", "agent-dag.js"));
copyFileSync(join(REAL_BIN, "deck.js"), join(PKG, "bin", "deck.js"));

const real = (mod: string) => JSON.stringify(new URL(`../../server/${mod}`, import.meta.url).href);
for (const mod of readdirSync(REAL_SERVER).filter(f => f.endsWith(".mjs"))) {
  writeFileSync(join(SERVER_DIR, mod), `export * from ${real(mod)};\n`);
}

// The slow one. A local export shadows the same name arriving through
// `export *`, so cswapBin, cswapCandidates and the rest of the module are still
// the real ones. It announces itself on the way out, so "did the port answer
// before this settled" is read off the transcript rather than inferred from a
// clock.
writeFileSync(join(SERVER_DIR, "cswap-install.mjs"), [
  `export * from ${real("cswap-install.mjs")};`,
  `import { existsSync } from "node:fs";`,
  `const RELEASE = process.env.STUB_CSWAP_RELEASE;`,
  `export function ensureCswap() {`,
  `  return new Promise(done => {`,
  `    const tick = () => {`,
  `      if (existsSync(RELEASE)) {`,
  `        process.stdout.write("\\n__CSWAP_SETTLED\\n");`,
  `        done({ state: "unavailable", reason: "no_installer" });`,
  `      } else setTimeout(tick, 20);`,
  `    };`,
  `    tick();`,
  `  });`,
  `}`,
].join("\n"));

writeFileSync(join(SERVER_DIR, "self-update.mjs"), [
  `export * from ${real("self-update.mjs")};`,
  `export function versionReport() { return Promise.resolve(null); }`,
].join("\n"));

writeFileSync(join(SERVER_DIR, "installer.mjs"), [
  `export * from ${real("installer.mjs")};`,
  `export function keepDiscovery() {`,
  `  return {`,
  `    file: ${JSON.stringify(join(DIR, "never-written.json"))},`,
  `    check: () => Promise.resolve(),`,
  `    stop: () => {},`,
  `  };`,
  `}`,
].join("\n"));

afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(ok: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

/** A port nothing is on, taken by binding it and letting go. The deck is given
 *  this on --port so the test can knock on the door before the deck has said
 *  where the door is: the banner that names the port is printed AFTER the
 *  report, which is the very thing being measured. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => done(p));
    });
  });
}

/** GET /api/health, answering false for every way a closed port can say no.
 *  No Origin and no Sec-Fetch-Site: that is a hook, or a curl, and isTrustedRead
 *  lets it through. */
function health(port: number): Promise<boolean> {
  return new Promise(done => {
    const req = request({ host: "127.0.0.1", port, path: "/api/health", method: "GET", timeout: 1000 },
      res => { res.resume(); res.on("end", () => done(res.statusCode === 200)); });
    req.on("error", () => done(false));
    req.on("timeout", () => { req.destroy(); done(false); });
    req.end();
  });
}

function launch(port: number, out: { text: string }): ChildProcess {
  const child = spawn(process.execPath, [
    join(PKG, "bin", "deck.js"),
    "--port", String(port), "--no-open",
    // --claude, not the machine's answer: every job the report waits on is a
    // Claude Code job, and a runner without Claude Code installed would skip
    // the lot and leave nothing to be slow.
    "--claude", "--no-codex",
    "--history", join(DIR, "events.jsonl"),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: DIR, USERPROFILE: DIR,
      CLAUDE_CONFIG_DIR: join(DIR, "claude"),
      CODEX_HOME: join(DIR, "codex"),
      AGENTS_DECK_NO_INSTALL: "1",
      STUB_CSWAP_RELEASE: RELEASE,
      NO_COLOR: "1",
    },
  });
  child.stdout!.on("data", d => { out.text += String(d); });
  child.stderr!.on("data", d => { out.text += String(d); });
  return child;
}

describe("the port, on a boot whose startup jobs have not settled", () => {
  let child: ChildProcess | null = null;
  const out = { text: "" };
  let answered = false;
  let transcriptWhenAnswered = "";
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    // Never inside 4317–4400: those are the ports a developer's own decks are
    // on, and this test is going to sit on one for a few seconds.
    if (port >= 4300 && port <= 4410) throw new Error(`refusing port ${port}: inside the live-deck range`);

    child = launch(port, out);

    // The whole assertion, in one poll: keep knocking until the deck answers,
    // with the slow job still held open the entire time.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !answered) {
      answered = await health(port);
      if (!answered) await sleep(20);
    }
    transcriptWhenAnswered = out.text;

    // Let go, and let the boot finish so the rows can be read in order.
    writeFileSync(RELEASE, "go\n");
    await until(() => /server ready/.test(out.text), 30_000, "the startup report to finish");
  }, 90_000);

  afterAll(() => {
    if (child) killTree(child, "SIGKILL");
    child = null;
  });

  it("answers HTTP while the slow startup job is still running", () => {
    expect(answered).toBe(true);
    // The ordering, stated as an ordering rather than as a duration: the job
    // this boot is waiting on had not settled when the port answered, because
    // nothing had released it yet. Before #483 this could not happen at all —
    // the listen was queued behind exactly this await.
    expect(transcriptWhenAnswered).not.toContain("__CSWAP_SETTLED");
  });

  it("answers before it has told the terminal it is ready", () => {
    // "server ready" is printed after the report and names the port that was
    // actually bound, so it cannot move — the listen moved instead. Its absence
    // here is what proves the answer came from inside the window.
    expect(transcriptWhenAnswered).not.toContain("server ready");
  });

  it("keeps the report in the fixed order it is written in", () => {
    // The rows are a narration and the narration is deliberate: a boot whose
    // rows arrive in whatever order the network settled is a boot nobody can
    // scan twice. What moved is the listen, not the report.
    const at = (s: string) => out.text.indexOf(s);
    expect(at("workspace")).toBeGreaterThanOrEqual(0);
    expect(at("Claude hooks")).toBeGreaterThan(at("workspace"));
    expect(at("Codex sessions")).toBeGreaterThan(at("Claude hooks"));
    expect(at("claude-swap")).toBeGreaterThan(at("Codex sessions"));
    expect(at("server ready")).toBeGreaterThan(at("claude-swap"));
    expect(at("log")).toBeGreaterThan(at("server ready"));
  });

  it("reports the port it is actually on", () => {
    expect(out.text).toContain(`http://127.0.0.1:${port}`);
  });
});

// ── the hazard the reorder created ───────────────────────────────────────────
// The listen is no longer awaited on the line that starts it, so its promise is
// live for the whole report with nothing attached — and a promise that rejects
// in that state is an unhandledRejection, which Node answers by killing the
// process and printing a stack. That would turn "the port was taken" into a
// crash, in the file whose own startupWork already says every job must carry its
// handler at the moment it is created.
const FAIL_PKG = join(DIR, "fail-pkg");
const FAIL_SERVER = join(FAIL_PKG, "src", "server");
if (!resolve(FAIL_PKG).startsWith(resolve(DIR))) throw new Error(`refusing to run: ${FAIL_PKG}`);

mkdirSync(join(FAIL_PKG, "bin"), { recursive: true });
mkdirSync(FAIL_SERVER, { recursive: true });
mkdirSync(join(FAIL_PKG, "dist", "web"), { recursive: true });
writeFileSync(join(FAIL_PKG, "dist", "web", "index.html"), "<!doctype html>\n");
writeFileSync(join(FAIL_PKG, "package.json"), JSON.stringify({
  name: "agents-deck", version: "1.36.1", type: "module",
}));
copyFileSync(join(REAL_BIN, "deck.js"), join(FAIL_PKG, "bin", "deck.js"));
for (const mod of readdirSync(SERVER_DIR)) {
  copyFileSync(join(SERVER_DIR, mod), join(FAIL_SERVER, mod));
}
// A bind that fails a beat AFTER it was started — which is the only shape that
// tells the two handlings apart. A rejection on the same tick is caught by
// either, because either handler is attached before the microtask queue drains.
writeFileSync(join(FAIL_SERVER, "index.mjs"), [
  `export * from ${real("index.mjs")};`,
  `export function startServer() {`,
  `  return new Promise((_, no) => setTimeout(() => {`,
  `    process.stdout.write("\\n__BIND_REJECTED\\n");`,
  `    no(Object.assign(new Error("all ports tried — none available"), { code: "EADDRINUSE" }));`,
  `  }, 150));`,
  `}`,
].join("\n"));

describe("a bind that fails while the startup report is still running", () => {
  let child: ChildProcess | null = null;
  const out = { text: "" };
  let code: number | null = null;

  beforeAll(async () => {
    const port = await freePort();
    if (port >= 4300 && port <= 4410) throw new Error(`refusing port ${port}: inside the live-deck range`);
    child = spawn(process.execPath, [
      join(FAIL_PKG, "bin", "deck.js"),
      "--port", String(port), "--no-open", "--claude", "--no-codex",
      "--history", join(DIR, "fail-events.jsonl"),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: DIR, USERPROFILE: DIR,
        CLAUDE_CONFIG_DIR: join(DIR, "claude"),
        CODEX_HOME: join(DIR, "codex"),
        AGENTS_DECK_NO_INSTALL: "1",
        // Its own release file, so releasing the first deck cannot free this one
        // early: the rejection has to land while the report is still blocked.
        STUB_CSWAP_RELEASE: join(DIR, "release-cswap-fail"),
        NO_COLOR: "1",
      },
    });
    child.stdout!.on("data", d => { out.text += String(d); });
    child.stderr!.on("data", d => { out.text += String(d); });
    const exited = new Promise<number | null>(done => child!.on("exit", c => done(c)));

    await until(() => out.text.includes("__BIND_REJECTED"), 30_000, "the bind to fail");
    // Only now: the deck has a dead listen promise in hand and is still inside
    // the report. If that rejection went unhandled the process is already gone,
    // and none of the assertions below can pass.
    writeFileSync(join(DIR, "release-cswap-fail"), "go\n");
    code = await exited;
  }, 90_000);

  afterAll(() => {
    if (child) killTree(child, "SIGKILL");
    child = null;
  });

  it("finishes the report it was in the middle of", () => {
    // A process killed by an unhandled rejection never reaches this row.
    expect(out.text).toContain("claude-swap");
  });

  it("says what happened, in its own words", () => {
    expect(out.text).toMatch(/server failed: all ports tried/);
    expect(code).toBe(1);
  });

  it("never writes a stack into the terminal it repaints", () => {
    // #432's rule, and the tell for the failure mode this guards: Node's answer
    // to an unhandled rejection is the stack this must not contain.
    expect(out.text).not.toContain("UnhandledPromiseRejection");
    expect(out.text).not.toContain("ERR_UNHANDLED_REJECTION");
    expect(out.text).not.toMatch(/^\s+at .+:\d+:\d+/m);
  });
});
