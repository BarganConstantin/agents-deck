// Which npx the supervisor's upgrade path runs, and what it says when that run
// fails.
//
// Reported from Windows (Node 24, v1.33.76): clicking "Update & restart" printed
//
//   Error: Cannot find module 'C:\Users\dtriboi\node_modules\npm\bin\npx-cli.js'
//
// and came back on the old version. `npx.cmd` was found on PATH, and the shim
// resolves npm's own scripts relative to its own directory (`%~dp0`) — which
// there was the user's home, with no `node_modules\npm` under it. The deck had
// no defence against it and no way to report it.
//
// Windows is the platform this repo cannot execute, so the choice is asserted
// through injected `platform`/`execPath`/`exists` rather than run.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { npxCliCandidates, npxFailureHint, npxFailureSummary, npxLaunch } from "../../server/npx.mjs";

const slash = (p: string) => p.replace(/\\/g, "/");
const ARGS = ["-y", "ccdeck@latest", "--port", "4317", "--no-open"];

describe("resolving npx", () => {
  it("prefers npm's own npx-cli.js beside node.exe on Windows", () => {
    const exec = "C:\\Program Files\\nodejs\\node.exe";
    const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js";
    const out = npxLaunch(ARGS, {
      platform: "win32",
      execPath: exec,
      exists: (p: string) => slash(p) === slash(cli),
    });

    expect(out.via).toBe("node");
    // The Node binary, not a shim, and not cmd.exe: no PATH lookup happens at
    // all, so a broken shim earlier on PATH cannot be picked.
    expect(out.file).toBe(exec);
    expect(slash(out.args[0])).toBe(slash(cli));
    expect(out.args.slice(1)).toEqual(ARGS);
    expect(out.opts).toEqual({});
  });

  it("prefers the lib/ layout on POSIX, which is where npm actually is", () => {
    const exec = "/usr/local/bin/node";
    const cli = "/usr/local/lib/node_modules/npm/bin/npx-cli.js";
    for (const platform of ["linux", "darwin"]) {
      const out = npxLaunch(ARGS, { platform, execPath: exec, exists: (p: string) => p === cli });
      expect(out.via).toBe("node");
      expect(out.file).toBe(exec);
      expect(out.args).toEqual([cli, ...ARGS]);
    }
  });

  it("falls back to the PATH shim when node ships no npm it can find", () => {
    const out = npxLaunch(ARGS, {
      platform: "win32",
      execPath: "C:\\nodejs\\node.exe",
      exists: () => false,
    });

    expect(out.via).toBe("shim");
    // And the fallback keeps the quoting that made the shim path safe: cmd.exe,
    // verbatim arguments, every argument its own quoted token.
    expect(out.file.toLowerCase()).toContain("cmd");
    expect(out.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(out.opts.windowsVerbatimArguments).toBe(true);
    expect(out.args[3]).toContain('"ccdeck@latest"');
  });

  it("falls back to a plain npx everywhere else", () => {
    const out = npxLaunch(ARGS, { platform: "linux", execPath: "/opt/node", exists: () => false });
    expect(out.via).toBe("shim");
    expect(out.file).toBe("npx");
    expect(out.args).toEqual(ARGS);
    expect(out.opts).toEqual({});
  });

  it("survives an exists() that throws — a candidate it cannot stat is a miss", () => {
    const out = npxLaunch(ARGS, {
      platform: "linux",
      execPath: "/opt/node",
      exists: () => { throw new Error("EACCES"); },
    });
    expect(out.via).toBe("shim");
  });

  it("offers both layouts on both platforms, likeliest first", () => {
    const win = npxCliCandidates("C:\\Program Files\\nodejs\\node.exe", "win32");
    expect(win[0]).toBe("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js");
    // Backslashes throughout, from a suite running on POSIX.
    expect(win.every((p: string) => !p.includes("/"))).toBe(true);

    const posix = npxCliCandidates("/usr/local/bin/node", "linux");
    expect(posix[0]).toBe("/usr/local/lib/node_modules/npm/bin/npx-cli.js");
    expect(posix[posix.length - 1]).toBe("/usr/local/bin/node_modules/npm/bin/npx-cli.js");
  });

  it("finds the npm Homebrew leaves at the prefix, four levels above the bin", () => {
    // node in /usr/local/Cellar/node/<version>/bin, npm at /usr/local/lib —
    // the parent-only rule missed it, and this machine's own layout is it.
    const exec = "/usr/local/Cellar/node/26.5.0/bin/node";
    const cli = "/usr/local/lib/node_modules/npm/bin/npx-cli.js";
    expect(npxCliCandidates(exec, "darwin")).toContain(cli);

    const out = npxLaunch(ARGS, { platform: "darwin", execPath: exec, exists: (p: string) => p === cli });
    expect(out.via).toBe("node");
    expect(out.args[0]).toBe(cli);
  });

  it("stops at the root rather than walking off the top of the path", () => {
    for (const exec of ["/node", "node", ""]) {
      expect(() => npxCliCandidates(exec, "linux")).not.toThrow();
      // Nothing relative, which would resolve against the working directory.
      for (const p of npxCliCandidates(exec, "linux")) expect(p.startsWith("/")).toBe(true);
    }
  });
});

// The exact paste from the report, minus the frames' line numbers.
const CRASH = [
  "node:internal/modules/cjs/loader:1424",
  "  throw err;",
  "  ^",
  "",
  "Error: Cannot find module 'C:\\Users\\dtriboi\\node_modules\\npm\\bin\\npx-cli.js'",
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1421:15)",
  "    at Module._load (node:internal/modules/cjs/loader:1237:27)",
  "  code: 'MODULE_NOT_FOUND',",
  "  requireStack: []",
  "}",
  "",
  "Node.js v24.12.0",
].join("\n");

describe("summarising a failed npx run", () => {
  it("quotes the error and none of the stack", () => {
    const summary = npxFailureSummary(CRASH);
    expect(summary).toBe(
      "Error: Cannot find module 'C:\\Users\\dtriboi\\node_modules\\npm\\bin\\npx-cli.js'",
    );
    // Nothing structural survives: no frames, no caret, no error-object dump,
    // no runtime version line.
    expect(summary).not.toContain("at Module");
    expect(summary).not.toContain("requireStack");
  });

  it("names the misconfigured npm prefix, which is the thing to check", () => {
    expect(npxFailureHint(CRASH)).toContain("npm config get prefix");
    // The npm-prefix.js variant of the same broken shim, reported in the same
    // session, has to reach the same hint.
    expect(npxFailureHint(CRASH.replace("npx-cli.js", "npm-prefix.js"))).toContain("prefix");
  });

  it("keeps npm's own complaint, without its ERR! decoration", () => {
    const out = npxFailureSummary([
      "npm WARN exec The following package was not found and will be installed: ccdeck",
      "npm ERR! code ETARGET",
      "npm ERR! notarget No matching version found for ccdeck@1.33.28.",
      "npm ERR! A complete log of this run can be found in: /home/u/.npm/_logs/x.log",
    ].join("\n"));
    // The warning above it names the package and reads like a cause; the line
    // that actually says what went wrong is the one that wins.
    expect(out).toBe("notarget No matching version found for ccdeck@1.33.28.");
  });

  it("says nothing rather than something invented", () => {
    expect(npxFailureSummary("")).toBe(null);
    expect(npxFailureSummary("   \n\n")).toBe(null);
    expect(npxFailureHint("connect ETIMEDOUT registry.npmjs.org")).toBe(null);
    // A network failure is not a broken prefix, but it is still worth quoting.
    expect(npxFailureSummary("npm ERR! network request to https://registry.npmjs.org failed"))
      .toContain("network request");
  });
});
