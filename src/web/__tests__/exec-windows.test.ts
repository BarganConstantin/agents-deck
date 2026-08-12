// Since Node 20.12 (the CVE-2024-27980 fix) a .cmd or .bat cannot be spawned
// without a shell: execFile throws EINVAL, synchronously. The retry path ran
// inside the previous attempt's error handler, so that throw escaped and took
// the server down before it finished starting — on Windows only, which is
// exactly the platform this repo cannot execute. Hence tests.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { isBatch, viaCmd, tryNext } from "../../server/exec.mjs";

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
