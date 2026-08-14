// Since Node 20.12 (the CVE-2024-27980 fix) a .cmd or .bat cannot be spawned
// without a shell: execFile throws EINVAL, synchronously. The retry path ran
// inside the previous attempt's error handler, so that throw escaped and took
// the server down before it finished starting — on Windows only, which is
// exactly the platform this repo cannot execute. Hence tests.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs server module, no types
import { isBatch, viaCmd, tryNext, runInteractive } from "../../server/exec.mjs";

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
