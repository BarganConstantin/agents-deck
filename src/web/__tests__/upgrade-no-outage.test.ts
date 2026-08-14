// What the supervisor does with an upgrade it cannot complete: nothing.
//
// The order used to be kill the working deck → attempt → fail → rebuild the
// deck. bin/deck.js exited 76 first, and only then did bin/agent-dag.js spawn
// npx and find out the fetch was impossible. So a failed update cost a real
// interruption every time — the SSE stream dropped, hook events fired into the
// gap were lost outright (hook/hook.js is fire-and-forget, 1s timeout, no
// retry), the canvas came back with tools stuck in flight — and it was paid in
// full even when the update never had a chance of working. Reported from an
// unattended terminal as the same version, the same ETARGET and the same
// teardown four times over.
//
// The rule is an ordering between two processes, so it can only be observed by
// running them. This builds the install layout npx produces in a temp
// directory, runs the SHIPPED bin/agent-dag.js inside it, and gives it a
// two-line worker that asks for an upgrade and then reports whether it is still
// alive. The technique is ccdeck-stub-exit.test.ts's.
//
// The two npx entry points are the only things stubbed, by shadowing them in a
// sandbox copy of src/server/npx.mjs: no npx runs, nothing is installed and
// nothing is downloaded. Everything else — the decision, the note, the reply,
// the handover — is the code that ships.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-no-outage-"));
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
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

// The layout npx unpacks into, because npxRestartSpec reads the deck's own
// `_npx/<hash>/package.json` to learn which of the three published names the
// user actually typed.
const ROOT = join(SANDBOX, "_npx", "deadbeef");
const SUPERVISOR = join(ROOT, "bin", "agent-dag.js");
const WORKER = join(ROOT, "bin", "deck.js");
const SERVER = join(ROOT, "src", "server");
const MARKERS = join(SANDBOX, ".agents-deck");
const FAKE_NPX = join(SANDBOX, "fake-npx.mjs");

// Belt and braces: every path here is derived, and a single wrong join would
// have this file spawning the developer's own deck against their own registry.
for (const p of [ROOT, SUPERVISOR, WORKER, SERVER, MARKERS, FAKE_NPX]) {
  if (!p.startsWith(SANDBOX)) throw new Error(`refusing to run: ${p} is outside ${SANDBOX}`);
}

mkdirSync(join(ROOT, "bin"), { recursive: true });
mkdirSync(SERVER, { recursive: true });
mkdirSync(MARKERS, { recursive: true });

writeFileSync(join(ROOT, "package.json"), JSON.stringify({
  name: "agents-deck",
  version: "1.33.88",
  type: "module",
  _npx: { packages: ["ccdeck@latest"] },
}));

// What the version check last heard from npm, which is the version the banner
// offered and therefore the target a failure is remembered against.
writeFileSync(join(MARKERS, ".self-update-check-ccdeck"), JSON.stringify({ at: Date.now(), version: "9.9.9" }));

copyFileSync(fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url)), SUPERVISOR);

// The server modules the supervisor imports, re-exported from the repo rather
// than copied, so what runs here is what ships…
for (const mod of ["brand.mjs", "exec.mjs", "self-update.mjs", "supervisor.mjs", "term.mjs"]) {
  const real = new URL(`../../server/${mod}`, import.meta.url).href;
  writeFileSync(join(SERVER, mod), `export * from ${JSON.stringify(real)};\n`);
}
// …except the two functions that would reach a registry. A local export shadows
// the same name coming from `export *`, so everything else in npx.mjs is still
// the real thing. Both record what they were asked for, in one file, because
// the ORDER of those two lines is the whole bug.
const realNpx = new URL("../../server/npx.mjs", import.meta.url).href;
writeFileSync(join(SERVER, "npx.mjs"), [
  `import { appendFileSync } from "node:fs";`,
  `export * from ${JSON.stringify(realNpx)};`,
  `const log = (line) => appendFileSync(process.env.STUB_LOG, line + "\\n");`,
  `export function npxPrefetch(spec) {`,
  `  log("prefetch " + spec);`,
  `  return Promise.resolve(process.env.STUB_FETCH_OK === "1"`,
  `    ? { ok: true, error: null, hint: null }`,
  `    : { ok: false, error: "notarget No matching version found for ccdeck@9.9.9.", hint: null });`,
  `}`,
  `export function npxLaunch(args) {`,
  `  log("launch " + args.join(" "));`,
  `  return { file: process.execPath, args: [${JSON.stringify(FAKE_NPX)}, ...args], opts: {}, via: "node", cli: null };`,
  `}`,
].join("\n"));

// Stands in for the npx that would start the replacement deck. It exits 1
// without binding anything, so the supervisor's own give-up path runs.
writeFileSync(FAKE_NPX, `process.exit(1);\n`);

// Stands in for bin/deck.js: asks to be upgraded the way a clicked "Update &
// restart" does, then says out loud what it was told and whether it is still
// here. A relaunched worker asks for nothing — otherwise a give-up would loop.
writeFileSync(WORKER, [
  `const say = (s) => process.stdout.write(s + "\\n");`,
  `if (process.env.AGENTS_DECK_RESPAWN === "1") { say("RESPAWNED"); process.exit(0); }`,
  `let again = process.env.STUB_PLAN === "twice";`,
  `process.send({ type: "listening", port: Number(process.env.STUB_PORT) });`,
  `process.send({ type: "upgrade" });`,
  `process.on("message", (m) => {`,
  `  say("REPLY " + m.type + " " + (m.error ?? ""));`,
  `  if (m.type === "upgrade-ready") { process.exit(76); return; }`,
  `  if (again) { again = false; setTimeout(() => process.send({ type: "upgrade" }), 50); return; }`,
  `  setTimeout(() => { say("STILL-ALIVE"); process.exit(0); }, 150);`,
  `});`,
  // Only a floor under a run that has already gone wrong: every reply arrives
  // in milliseconds, and a supervisor that never answers must not hang the suite.
  `setTimeout(() => { say("WORKER-TIMEOUT"); process.exit(3); }, 4000);`,
].join("\n"));

type Run = { code: number | null; out: string; log: string[]; note: any };

/** One whole supervisor lifetime, from launch to exit. */
const runDeck = (env: Record<string, string>) =>
  new Promise<Run>((resolve) => {
    const logFile = join(SANDBOX, `log-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(logFile, "");
    for (const f of readdirSync(MARKERS)) {
      if (f.startsWith(".restart-failed-")) rmSync(join(MARKERS, f), { force: true });
    }
    const child = spawn(process.execPath, [SUPERVISOR, "--no-persist"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STUB_LOG: logFile, STUB_PORT: "47713", ...env },
    });
    let out = "";
    child.stdout.on("data", d => { out += String(d); });
    child.stderr.on("data", d => { out += String(d); });
    child.on("exit", (code) => {
      const notes = readdirSync(MARKERS).filter(f => f.startsWith(".restart-failed-"));
      resolve({
        code,
        out,
        log: readFileSync(logFile, "utf8").split("\n").filter(Boolean),
        note: notes.length ? JSON.parse(readFileSync(join(MARKERS, notes[0]), "utf8")) : null,
      });
    });
  });

describe("an upgrade whose fetch cannot work", () => {
  it("leaves the deck serving instead of taking it down to find out", async () => {
    const run = await runDeck({ STUB_FETCH_OK: "0" });
    // The regression: the worker used to be gone by now, and the terminal's
    // next line was `restarted → v1.33.88` after a gap nobody asked for.
    expect(run.out).toContain("REPLY upgrade-refused");
    expect(run.out).toContain("STILL-ALIVE");
    expect(run.out).not.toContain("RESPAWNED");
  });

  it("never spawns the replacement, so no second deck goes near the port", async () => {
    const run = await runDeck({ STUB_FETCH_OK: "0" });
    expect(run.log).toEqual(["prefetch ccdeck@latest"]);
  });

  it("tells the browser why, through the note it already reads", async () => {
    const run = await runDeck({ STUB_FETCH_OK: "0" });
    expect(run.note.error).toContain("No matching version found");
    // Named by the version that failed to arrive, not only by the one that
    // stayed — that is what makes "this exact target already failed" askable.
    expect(run.note.target).toBe("9.9.9");
    expect(run.note.attempts).toBe(1);
    expect(run.note.version).toBe("1.33.88");
  });

  it("refuses the identical retry rather than fetching it again", async () => {
    const run = await runDeck({ STUB_FETCH_OK: "0", STUB_PLAN: "twice" });
    // Two asks, one fetch: the second is answered from what the first left
    // behind. This is the loop from the report, terminating.
    expect(run.log).toEqual(["prefetch ccdeck@latest"]);
    const refusals = run.out.split("\n").filter(l => l.startsWith("REPLY upgrade-refused"));
    expect(refusals).toHaveLength(2);
    expect(refusals[1]).toContain("v9.9.9");
    expect(refusals[1]).toContain("waiting");
    // Still one attempt: being asked again is not another attempt, and the
    // stamp moves only so the tab can tell this answer from the last one.
    expect(run.note.attempts).toBe(1);
    expect(run.note.at).toBeGreaterThan(run.note.failedAt);
  });
});

describe("an upgrade whose fetch works", () => {
  it("hands the port over only once the replacement is on the machine", async () => {
    const run = await runDeck({ STUB_FETCH_OK: "1" });
    expect(run.out).toContain("REPLY upgrade-ready");
    // The fetch first, and the launch after it — with the port the worker
    // reported, and --no-open, since the tab that asked is already open.
    expect(run.log[0]).toBe("prefetch ccdeck@latest");
    expect(run.log[1]).toMatch(/^launch -y ccdeck@latest .*--port 47713 --no-open$/);
  });

  it("still brings the old copy back when the replacement never serves", async () => {
    // The one outage a pre-flight cannot spare anyone: the fetch worked, the
    // port was given up, and the new process died anyway.
    const run = await runDeck({ STUB_FETCH_OK: "1" });
    expect(run.out).toContain("RESPAWNED");
    expect(run.note.error).toBeTruthy();
    expect(run.note.target).toBe("9.9.9");
  });
});
