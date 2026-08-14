// Since Node 20.12 (the CVE-2024-27980 fix) a .cmd or .bat cannot be spawned
// without a shell: execFile throws EINVAL, synchronously. The retry path ran
// inside the previous attempt's error handler, so that throw escaped and took
// the server down before it finished starting — on Windows only, which is
// exactly the platform this repo cannot execute. Hence tests.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs server module, no types
import { isBatch, viaCmd, tryNext, run, runInteractive, killTree, looksMissing } from "../../server/exec.mjs";

describe("batch-file detection", () => {
  it("catches the extensions that cannot be spawned directly, on Windows only", () => {
    expect(isBatch("cswap.cmd", "win32")).toBe(true);
    expect(isBatch("npm.CMD", "win32")).toBe(true);
    expect(isBatch("thing.bat", "win32")).toBe(true);
    expect(isBatch("uv.exe", "win32")).toBe(false);
    expect(isBatch("cswap", "win32")).toBe(false);
    // A file called .cmd on a Mac is not a batch file and needs no shell.
    expect(isBatch("cswap.cmd", "darwin")).toBe(false);
  });
});

describe("cmd.exe invocation", () => {
  it("uses comspec with the flags Node itself uses for shell: true", () => {
    const { file, args, opts } = viaCmd("cswap.cmd", ["config"]);
    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Verbatim, or Node quotes the already-quoted command line a second time.
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it("quotes every part, so a path with spaces stays one argument", () => {
    const { args } = viaCmd("C:\\Program Files\\uv\\uv.cmd", ["tool", "install", "claude-swap"]);
    expect(args[3]).toBe('""C:\\Program Files\\uv\\uv.cmd" "tool" "install" "claude-swap""');
  });

  it("doubles embedded quotes rather than letting them end the string", () => {
    const { args } = viaCmd("x.cmd", ['a"b']);
    expect(args[3]).toBe('""x.cmd" "a""b""');
  });
});

describe("which failures mean 'try the next spelling'", () => {
  it("includes the Windows-only ones", () => {
    for (const code of ["ENOENT", "EACCES", "EINVAL", "UNKNOWN"]) {
      expect(tryNext({ code })).toBe(true);
    }
  });
  it("does not swallow a real failure of a command that ran", () => {
    expect(tryNext({ code: 1 })).toBe(false);
    expect(tryNext({ code: "ETIMEDOUT" })).toBe(false);
    expect(tryNext(null)).toBe(false);
  });
});

describe("an interactive run that has to retry a spelling", () => {
  // A spelling that cannot be spawned emits 'error' and then 'close' with code
  // -2. The abandoned child's 'close' used to settle the run, so on Windows —
  // where claude.exe is missing and claude.cmd is the real one — `claude auth
  // login` was reported as failed while the retry child was still driving the
  // login. The run must wait for the spelling that actually runs.
  it("reports the child that ran, not the one that could not be spawned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-exec-"));
    const base = join(dir, "ccdeck-fake-cli");
    // Windows stops at the .cmd candidate; elsewhere cmd.exe is missing too, so
    // it falls through to the extensionless one. Both spell the same tool.
    writeFileSync(`${base}.cmd`, "@echo off\r\necho ready\r\n");
    writeFileSync(base, "#!/bin/sh\necho ready\n");
    chmodSync(base, 0o755);
    // The multi-candidate path is Windows-only, and Windows is the platform
    // this repo cannot execute — so claim to be it. On a real Windows box this
    // is a no-op and the same test exercises the native path.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const lines: string[] = [];
      const h = runInteractive(base, [], { timeout: 20_000 });
      h.onLine((line: string, partial: boolean) => { if (!partial) lines.push(line.trim()); });
      const r = await h.done;
      expect(r.stdout).toContain("ready");
      expect(r.ok).toBe(true);
      expect(r.code).toBe(0);
      expect(lines).toContain("ready");
    } finally {
      Object.defineProperty(process, "platform", platform);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const waitFor = async (cond: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  return cond();
};

describe("killing a child", () => {
  it("stops one that has no wrapper, on every platform", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    await new Promise(r => child.once("spawn", r));
    expect(alive(child.pid!)).toBe(true);
    killTree(child);
    const end = await new Promise<unknown>(r => child.once("close", (code, signal) => r(signal ?? code)));
    // SIGTERM on POSIX, a non-zero exit where taskkill did it. Either way the
    // child did not choose to leave.
    expect(end === "SIGTERM" || end !== 0).toBe(true);
  }, 20_000);

  // On Windows a .cmd runs through cmd.exe, so the tool is a GRANDCHILD and
  // ChildProcess.kill() — one TerminateProcess against the wrapper — leaves it
  // running. Every cancelled or expired `claude auth login` leaked a node.exe
  // that way, still holding the stdin pipe the deck wrote to, and holding the
  // wrapper's 'close' open so the run never even settled. Windows is the
  // platform this repo cannot execute, so cmd.exe and taskkill are stood in for
  // and the real tree is built out of real processes.
  it.skipIf(process.platform === "win32")("stops the tool under the cmd.exe wrapper too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-kill-"));
    const base = join(dir, "ccdeck-hang-cli");
    const pidFile = join(dir, "grandchild.pid");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const was = { ComSpec: process.env.ComSpec, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    let grandchild = 0;
    try {
      // Stands in for cmd.exe: same /d /s /c convention, and it runs the batch
      // file as a child rather than replacing itself with it — which is the
      // whole point, since that is what makes the tool a grandchild.
      const shim = join(dir, "fake-cmd.sh");
      writeFileSync(shim, [
        "#!/bin/sh",
        `target=$(printf '%s' "$4" | tr -d '"')`,
        `sh "$target"`,
        "status=$?", // keeps the run above off the last line, so no shell execs it
        "exit $status",
      ].join("\n") + "\n");
      chmodSync(shim, 0o755);

      // Stands in for taskkill: same argument shape, and a real recursive walk,
      // so only a kill that asks for the tree gets one.
      const taskkill = join(dir, "taskkill");
      writeFileSync(taskkill, [
        "#!/bin/sh",
        'pid=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "/pid" ]; then shift; pid="$1"; fi',
        "  shift",
        "done",
        '[ -n "$pid" ] || exit 1',
        "kill_tree() {",
        '  for kid in $(ps -A -o pid=,ppid= | awk -v p="$1" \'$2 == p { print $1 }\'); do kill_tree "$kid"; done',
        '  kill -9 "$1" 2>/dev/null',
        "}",
        'kill_tree "$pid"',
        "exit 0",
      ].join("\n") + "\n");
      chmodSync(taskkill, 0o755);

      // The tool: announces its own pid, then hangs the way `claude auth login`
      // hangs on the code it is waiting for.
      writeFileSync(`${base}.cmd`, [
        "#!/bin/sh",
        `echo $$ > "${pidFile}"`,
        "echo ready",
        "sleep 60",
      ].join("\n") + "\n");

      process.env.ComSpec = shim;
      process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
      // Windows always has one and killTree prefers System32 over PATH there;
      // here there is none, so the stand-in on PATH is found instead.
      delete process.env.SystemRoot;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      const h = runInteractive(base, [], { timeout: 60_000 });
      expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true);
      grandchild = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(grandchild)).toBe(true);

      h.kill();
      // The tool itself, not just the wrapper the deck happened to spawn.
      expect(await waitFor(() => !alive(grandchild), 10_000)).toBe(true);
      // And with nothing left holding the stdout it inherited, the run settles
      // at last — killing only the wrapper left `done` pending forever.
      const r = await h.done;
      expect(r.killed).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", platform);
      for (const [key, value] of Object.entries(was)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (grandchild) { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// "The system cannot find the file specified" is Windows' generic ENOENT text,
// and cswap is a Python CLI whose tracebacks end in it. Read as cmd.exe's
// verdict, a tool that ran and failed was reported as "not on PATH" — real
// error discarded — and the candidate loop re-ran the whole command, which for
// `cswap remove 3` is a second deletion attempt.
const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "cswap/store.py", line 41, in remove',
  "    os.replace(src, dst)",
  "FileNotFoundError: [WinError 2] The system cannot find the file specified",
].join("\n");

describe("telling cmd.exe's 'no such command' from a tool's own words", () => {
  it("accepts cmd.exe's message when it names the candidate we asked for", () => {
    const said = "'cswap.cmd' is not recognized as an internal or external command,\noperable program or batch file.\n";
    expect(looksMissing(said, "cswap.cmd")).toBe(true);
    // A full path is echoed back whole, and matched whole.
    expect(looksMissing("'C:\\bin\\cswap.cmd' is not recognized as an internal or external command,", "C:\\bin\\cswap.cmd")).toBe(true);
    // The wording for a path whose directory is missing, alone in the output.
    expect(looksMissing("The system cannot find the path specified.", "C:\\gone\\cswap.cmd")).toBe(true);
  });

  it("rejects the same sentence inside the output of a tool that ran", () => {
    expect(looksMissing(TRACEBACK, "cswap.exe")).toBe(false);
    // Even alone on its line, a prefix means someone else is quoting Windows.
    expect(looksMissing("error: The system cannot find the file specified", "cswap.cmd")).toBe(false);
    // cmd.exe says this INSTEAD of running anything, so real output rules it out.
    expect(looksMissing("account-2 removed\nThe system cannot find the path specified.", "cswap.cmd")).toBe(false);
  });

  it("rejects cmd.exe's message when it names some other command", () => {
    // A tool that shells out itself forwards cmd.exe's verdict about ITS child.
    const forwarded = "'git' is not recognized as an internal or external command,\noperable program or batch file.\n";
    expect(looksMissing(forwarded, "claude.cmd")).toBe(false);
    // With no candidate to check against, the shape alone still has to hold.
    expect(looksMissing(forwarded)).toBe(true);
  });
});

describe("a tool that ran and failed with a Windows ENOENT message", () => {
  // Both halves of the bug, on the two entry points that had it.
  const stub = (dir: string, base: string, log: string) => {
    writeFileSync(`${base}.exe`, [
      "#!/bin/sh",
      `echo ran >> "${log}"`,
      `cat >&2 <<'EOF'`,
      TRACEBACK,
      "EOF",
      "exit 1",
    ].join("\n") + "\n");
    chmodSync(`${base}.exe`, 0o755);
    // The next candidate the loop would reach for, and must not: running it is
    // the whole command a second time.
    writeFileSync(`${base}.cmd`, [`#!/bin/sh`, `echo ran >> "${log}"`, "echo done"].join("\n") + "\n");
    const shim = join(dir, "fake-cmd.sh");
    writeFileSync(shim, [
      "#!/bin/sh",
      `target=$(printf '%s' "$4" | tr -d '"')`,
      `sh "$target"`,
    ].join("\n") + "\n");
    chmodSync(shim, 0o755);
    return shim;
  };

  it.skipIf(process.platform === "win32")("keeps its own error and runs once, in run()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-exec-"));
    const base = join(dir, "ccdeck-angry-cli");
    const log = join(dir, "runs.txt");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const comspec = process.env.ComSpec;
    try {
      process.env.ComSpec = stub(dir, base, log);
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      const r = await run(base, ["remove", "3"], { timeout: 20_000 });
      expect(r.ok).toBe(false);
      // Not "ENOENT": the caller turns that into "not on PATH", which is a lie
      // about a tool that just ran, and hides what it said.
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("FileNotFoundError");
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (comspec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = comspec;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("does not re-run the command, in runInteractive()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-exec-"));
    const base = join(dir, "ccdeck-angry-cli");
    const log = join(dir, "runs.txt");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const comspec = process.env.ComSpec;
    try {
      process.env.ComSpec = stub(dir, base, log);
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      const r = await runInteractive(base, ["remove", "3"], { timeout: 20_000 }).done;
      expect(r.ok).toBe(false);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("FileNotFoundError");
      // The one that matters: `cswap remove 3` must not be attempted twice,
      // and the second child's confirmation prompt would go unanswered anyway.
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (comspec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = comspec;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a .cmd spelling cmd.exe could not find", () => {
  // A batch candidate is launched THROUGH cmd.exe, and cmd.exe is always there:
  // it spawns happily for a batch file that is not, then says "is not
  // recognized" and exits 1. Remembering the spelling at spawn time therefore
  // recorded claude.bat on a machine with no claude at all, and the memo is the
  // only candidate afterwards — so installing claude (npm writes claude.cmd)
  // did not help. Every run still failed with "not on PATH" until the deck was
  // restarted.
  it("is not remembered, so the tool runs once it is installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-exec-"));
    const base = join(dir, "ccdeck-ghost-cli");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const comspec = process.env.ComSpec;
    try {
      if (process.platform !== "win32") {
        // Stand in for cmd.exe — same /d /s /c calling convention, same verdict
        // for a batch file that is not there. Windows uses the real one, and
        // this whole path is Windows-only, so claim to be it.
        const shim = join(dir, "fake-cmd.sh");
        writeFileSync(shim, [
          "#!/bin/sh",
          `target=$(printf '%s' "$4" | tr -d '"')`,
          `if [ -f "$target" ]; then sh "$target"; else`,
          `  echo "'$target' is not recognized as an internal or external command," >&2`,
          `  echo 'operable program or batch file.' >&2`,
          "  exit 1",
          "fi",
        ].join("\n") + "\n");
        chmodSync(shim, 0o755);
        process.env.ComSpec = shim;
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      }

      // Nothing installed yet: every spelling fails, including both batch ones.
      const first = await runInteractive(base, [], { timeout: 20_000 }).done;
      expect(first.ok).toBe(false);
      expect(first.code).toBe("ENOENT");

      // Now it gets installed, the way npm installs a CLI on Windows.
      writeFileSync(`${base}.cmd`, "echo ready\r\n");

      const second = await runInteractive(base, [], { timeout: 20_000 }).done;
      expect(second.ok).toBe(true);
      expect(second.stdout).toContain("ready");
    } finally {
      Object.defineProperty(process, "platform", platform);
      if (comspec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = comspec;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
