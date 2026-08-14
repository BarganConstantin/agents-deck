// The supervisor's upgrade path — worker exits 76, and it comes back through
// `npx -y <spec>@latest` carrying the user's original argv.
//
// On Windows npx is a .cmd, and the obvious way to launch one is `shell: true`.
// That is what this guards against: Node joins the argument array into a single
// cmd.exe command line with spaces and no quoting whatsoever, so the forwarded
// `--workspace C:\Users\John Smith\proj` reaches the new deck as two arguments
// and its parser silently ignores the orphan — the upgraded deck then watches
// the wrong directory and shows no sessions, for good. Windows is the platform
// this repo cannot execute, so the command line is asserted instead.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { spawnSpec } from "../../server/exec.mjs";

/** What launchNpx builds: its own flags around the user's forwarded argv. */
const relaunch = (forwarded: string[]) =>
  ["-y", "ccdeck@latest", ...forwarded, "--port", "4317", "--no-open"];

describe("the npx upgrade relaunch on Windows", () => {
  it("goes through cmd.exe verbatim, the same way Node's own shell does", () => {
    const { file, args, opts } = spawnSpec("npx.cmd", relaunch([]), "win32");
    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Verbatim, or Node quotes the already-quoted command line a second time.
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it("keeps a workspace path with spaces as one argument", () => {
    const { args } = spawnSpec(
      "npx.cmd",
      relaunch(["--workspace", "C:\\Users\\John Smith\\proj"]),
      "win32",
    );
    expect(args[3]).toBe(
      '""npx.cmd" "-y" "ccdeck@latest" "--workspace" "C:\\Users\\John Smith\\proj"' +
      ' "--port" "4317" "--no-open""',
    );
  });

  it("defuses the cmd metacharacters a real path can contain", () => {
    // Unquoted, `&` ends the command and runs the rest as a second one, `|` and
    // `>` redirect, `^` escapes the next character away. Quoted, all four are
    // just characters — and the path stays a single argument either way.
    for (const path of ["C:\\dev\\R&D", "C:\\dev\\a|b", "C:\\dev\\a>b", "C:\\dev\\a^b", "C:\\dev\\proj (1)"]) {
      const { args } = spawnSpec("npx.cmd", ["--workspace", path], "win32");
      expect(args[3]).toBe(`""npx.cmd" "--workspace" "${path}""`);
    }
  });

  it("doubles an embedded quote rather than letting it end the argument", () => {
    const { args } = spawnSpec("npx.cmd", ["--history", 'C:\\a"b'], "win32");
    expect(args[3]).toBe('""npx.cmd" "--history" "C:\\a""b""');
  });

  it("spawns npx directly everywhere else, argument vector untouched", () => {
    const forwarded = relaunch(["--workspace", "/home/john smith/proj (1)"]);
    for (const platform of ["linux", "darwin"]) {
      const { file, args, opts } = spawnSpec("npx", forwarded, platform);
      expect(file).toBe("npx");
      expect(args).toEqual(forwarded);
      expect(opts).toEqual({});
    }
  });
});
