// A command run() killed at its deadline used to be reported as whatever the
// dying child happened to say. execFile calls a signalled exit `code: null` and
// `?? 0` turned that into 0, so the accounts panel showed "cswap export exited
// 0" — a success code for a command that never finished. A tool that handles
// the signal by exiting 0 was worse: no error reached the callback at all, so
// the run we cut short came back ok:true and its spelling was cached as one
// that works. And a .cmd candidate's tool is a grandchild under the cmd.exe
// wrapper holding the stdio pipes, so when the tree kill could not reach it the
// callback never came and the run never settled. The deadline states the
// outcome itself now, and only then kills; these pin that.
import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// cswap-admin.mjs resolves the claude-swap store out of the home directory, and
// nothing in this file may touch the real one — so every home-shaped variable
// points into a temp directory BEFORE the modules load, and the resolution is
// checked rather than assumed.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-exec-timeout-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");
process.env.CLAUDE_SWAP_BACKUP = join(SANDBOX, ".claude-swap-backup");
if (!homedir().startsWith(SANDBOX)) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${SANDBOX}`);
}

// @ts-expect-error — .mjs server module, no types
const { run } = await import("../../server/exec.mjs");
// @ts-expect-error — .mjs server module, no types
const { failureText } = await import("../../server/cswap-admin.mjs");

afterAll(() => {
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

const asWindows = () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Several candidate spellings, and a tool that runs under a wrapper, are
  // Windows-only shapes — and Windows is the platform this repo cannot execute.
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  return () => Object.defineProperty(process, "platform", platform);
};

describe("a run its own deadline stopped", () => {
  it("says it timed out rather than quoting the killed child's exit status", async () => {
    const r = await run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 500 });

    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.killed).toBe(true);
    // The regression exactly: a signalled child has no exit code, and 0 is what
    // the user was shown for it.
    expect(r.code).toBe("ETIMEDOUT");
    expect(r.code).not.toBe(0);
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "is no success, and no spelling worth remembering, when the child exits 0 on the way out", async () => {
      const dir = mkdtempSync(join(SANDBOX, "graceful-"));
      const base = join(dir, "ccdeck-graceful-cli");
      const restore = asWindows();
      try {
        // Handles the deadline's signal and leaves with a success code, the way
        // a tool that shuts down cleanly does — execFile hands that to the
        // callback with no error at all. The loop is bounded so a trap that
        // never fires cannot leave a process behind.
        writeFileSync(`${base}.exe`, [
          "#!/bin/sh",
          "trap 'exit 0' TERM",
          "echo working",
          "i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done",
        ].join("\n") + "\n");
        chmodSync(`${base}.exe`, 0o755);

        // Generous, because the deadline has to outlast the child's STARTUP on
        // a loaded machine, not just its first write: at 700ms this asserted an
        // empty stdout whenever the whole suite ran in parallel, since /bin/sh
        // had not reached `echo` before the clock ran out. The child sleeps 30s,
        // so a larger deadline still times out — it only stops the test from
        // measuring how busy the machine is.
        const first = await run(base, [], { timeout: 3_000 });
        expect(first.ok).toBe(false);
        expect(first.timedOut).toBe(true);
        // What it printed before it hung survives the deadline: the callback
        // that owns the full buffers is never waited for, and that line is all
        // a caller has to go on.
        expect(first.stdout).toContain("working");

        // A remembered spelling is the ONLY one tried afterwards, so if the run
        // above had counted as the clean exit that confirms a spelling, this
        // would look for the .exe that is now gone instead of the tool that is
        // there.
        rmSync(`${base}.exe`);
        writeFileSync(base, "#!/bin/sh\necho ready\n");
        chmodSync(base, 0o755);

        const second = await run(base, [], { timeout: 20_000 });
        expect(second.ok).toBe(true);
        expect(second.timedOut).toBe(false);
        expect(second.stdout).toContain("ready");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 40_000);

  it.skipIf(process.platform === "win32")(
    "settles when the tool under the cmd.exe wrapper keeps the stdio pipes open", async () => {
      const dir = mkdtempSync(join(SANDBOX, "wrapped-"));
      const base = join(dir, "ccdeck-wrapped-cli");
      const pidFile = join(dir, "grandchild.pid");
      const was = { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot };
      const restore = asWindows();
      let grandchild = 0;
      try {
        // Stands in for cmd.exe: same /d /s /c convention, and it runs the
        // batch file as a child rather than replacing itself with it — which is
        // what makes the tool a grandchild.
        const shim = join(dir, "fake-cmd.sh");
        writeFileSync(shim, [
          "#!/bin/sh",
          `target=$(printf '%s' "$4" | tr -d '"')`,
          `sh "$target"`,
          "status=$?", // keeps the run above off the last line, so no shell execs it
          "exit $status",
        ].join("\n") + "\n");
        chmodSync(shim, 0o755);

        // The tool: `exec` keeps the pid it just recorded, so the process left
        // holding the inherited stdout is the one the cleanup below can find.
        writeFileSync(`${base}.cmd`, [
          "#!/bin/sh",
          `echo $$ > "${pidFile}"`,
          "echo starting",
          `exec "${process.execPath}" -e "setTimeout(() => {}, 20000)"`,
        ].join("\n") + "\n");

        process.env.ComSpec = shim;
        // killTree takes taskkill from System32 rather than PATH, and there is
        // no taskkill here at all: the kill reaches the wrapper only, which is
        // the Windows case where the tool keeps the pipes open after it.
        delete process.env.SystemRoot;

        const settled = await Promise.race([
          run(base, [], { timeout: 700 }),
          new Promise(res => setTimeout(() => res("never settled"), 8_000)),
        ]);

        // Left to execFile's callback, this waited on pipes nobody would ever
        // close: the accounts panel sat on a request that had already expired.
        expect(settled).not.toBe("never settled");
        expect(settled.timedOut).toBe(true);
        expect(settled.code).toBe("ETIMEDOUT");
      } finally {
        restore();
        for (const [key, value] of Object.entries(was)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (existsSync(pidFile)) grandchild = Number(readFileSync(pidFile, "utf8").trim());
        if (grandchild) { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 40_000);
});

describe("what the accounts panel says about a command that timed out", () => {
  const stopped = (extra: Record<string, unknown> = {}) =>
    ({ ok: false, code: "ETIMEDOUT", killed: true, timedOut: true, stdout: "", stderr: "", ...extra });

  it("names the deadline instead of an exit code that reads as success", () => {
    expect(failureText(stopped(), "cswap export")).toBe("cswap export took too long and was stopped");
    expect(failureText(stopped(), "cswap add")).toBe("cswap add took too long and was stopped");
  });

  it("prefers the deadline to the half-finished line the tool had printed", () => {
    expect(failureText(stopped({ stdout: "collecting credentials" }), "cswap export"))
      .toBe("cswap export took too long and was stopped");
  });

  it("still lets a command that ran and failed speak for itself", () => {
    const failed = { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "no account 7" };
    expect(failureText(failed, "cswap move")).toBe("no account 7");
    const missing = { ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: "", stderr: "" };
    expect(failureText(missing, "cswap alias")).toContain("not on PATH");
  });
});
