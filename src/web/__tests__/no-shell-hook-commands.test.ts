// Three command strings were built out of environment paths with only `"` around
// them, and POSIX double quotes suppress none of `$(…)`, a backtick or `\`.
//
//   installer.mjs   `"<node>" "<hookPath>" --provider claude` — written into the
//                   user's settings.json as a type:"command" hook, which Claude
//                   Code runs THROUGH A SHELL on every tool call.
//   sound-hook.mjs  `"<node>" "<notifyPath>"` — the same, at the end of a turn.
//   quota.mjs       `"<bin>" --print /usage < /dev/null` — straight into exec().
//
// Every ingredient comes from outside: $CLAUDE_CONFIG_DIR (resolve()d, never
// validated), homedir(), process.execPath, %APPDATA%. A config directory called
// `/tmp/a$(id)b` therefore became shell code — and for the two hook commands,
// shell code PERSISTED into the user's settings file and executed on every hook
// fire. The quieter half cost only the feature: a bare `$` expands to nothing,
// so the hook path silently became wrong and hooks stopped firing with no error.
//
// quota.mjs stopped building a string at all (see quota-source.test.ts —
// quotaClaudeBin answers with the binary and exec.mjs spawns the vector). The
// two hook commands cannot: the settings.json format is a string and has no argv
// form, so they are escaped with a real escaper instead. These pin that escaper
// against a real /bin/sh, which is the only authority worth citing.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain JS module, no types
import { shellQuoteArg } from "../../server/exec.mjs";
// @ts-expect-error — plain JS module, no types
import { hookCommand } from "../../server/installer.mjs";
// @ts-expect-error — plain JS module, no types
import { soundHookCommand } from "../../server/sound-hook.mjs";

// Paths a real machine can have. The first two are the attack, the rest are the
// ordinary characters that a naive escaper breaks instead.
const NASTY = [
  "/home/a$(id)b/.claude/agent-dag/hook.js",
  "/home/a`id`b/.claude/agent-dag/hook.js",
  "/home/$USER/.claude/agent-dag/hook.js",
  "/home/it's mine/.claude/agent-dag/hook.js",
  '/home/say "hi"/.claude/agent-dag/hook.js',
  "/home/a\\b/.claude/agent-dag/hook.js",
  "/home/a b;rm -rf x/.claude/agent-dag/hook.js",
  "/home/a&b|c>d/.claude/agent-dag/hook.js",
  "/home/a\nb/.claude/agent-dag/hook.js",
  "/home/plain/.claude/agent-dag/hook.js",
];

const posix = process.platform !== "win32";

/** What /bin/sh decides the arguments of `line` are, with `printf` standing in
 *  for the program. The NUL separator is what lets a path with a newline in it
 *  be compared as the single argument it is. */
function shellArgv(line: string): string[] {
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${line}`], {
    encoding: "utf8",
    // A stripped environment with one obvious tripwire in it: if `$USER` ever
    // reaches the shell unquoted, the value below is what comes back.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", USER: "SUBSTITUTED" },
  });
  return out.split("\0").slice(0, -1);
}

describe("shellQuoteArg on POSIX", () => {
  it.runIf(posix)("survives a real /bin/sh byte for byte", () => {
    for (const path of NASTY) {
      // `printf %s` writes its argument and nothing else, so what comes back is
      // exactly what the shell decided the argument was. If any of the quoting
      // leaks, this is where the substitution shows up.
      const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuoteArg(path, "linux")}`], {
        encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", USER: "SUBSTITUTED" },
      });
      expect(out, path).toBe(path);
    }
  });

  it("leaves nothing live inside the quotes", () => {
    // Single quotes, and the one escape that form has: close, backslash-quote,
    // reopen. Spelled out because it is the whole mechanism.
    expect(shellQuoteArg("plain", "linux")).toBe("'plain'");
    expect(shellQuoteArg("$(id)", "linux")).toBe("'$(id)'");
    expect(shellQuoteArg("it's", "linux")).toBe(`'it'\\''s'`);
    expect(shellQuoteArg("", "linux")).toBe("''");
  });

  it("uses cmd.exe's rule on Windows, the same one viaCmd applies", () => {
    expect(shellQuoteArg("C:\\Program Files\\node.exe", "win32")).toBe('"C:\\Program Files\\node.exe"');
    expect(shellQuoteArg('say "hi"', "win32")).toBe('"say ""hi"""');
    // Everything cmd.exe treats as syntax is inert once quoted…
    expect(shellQuoteArg("a&b|c>d", "win32")).toBe('"a&b|c>d"');
    // …except `%VAR%`, which has no escape on a command line at all. Pinned as
    // a known limit of the platform rather than left as a surprise.
    expect(shellQuoteArg("%USERNAME%", "win32")).toBe('"%USERNAME%"');
  });
});

describe("the hook command written into settings.json", () => {
  const NODE = "/usr/local/bin/node";

  it.runIf(posix)("is one command with three arguments, whatever the path contains", () => {
    for (const path of NASTY) {
      const cmd = hookCommand(path, "claude", NODE);
      // Read back through a shell the way the host CLI will read it: `printf
      // '%s\0'` writes one NUL-terminated field per argument, so this is the
      // argv the hook would actually receive. NUL rather than newline because
      // one of the paths below contains a newline, and splitting on that would
      // report the shell's correct answer as a failure.
      const argv = shellArgv(cmd.replace(shellQuoteArg(NODE), "printf-args"));
      expect(argv, path).toEqual(["printf-args", path, "--provider", "claude"]);
    }
  });

  it("no longer wraps a path in double quotes and calls it escaped", () => {
    const cmd = hookCommand("/home/a$(id)b/hook.js", "claude", NODE);
    expect(cmd).not.toContain('"/home/a$(id)b/hook.js"');
    expect(cmd).toContain("'/home/a$(id)b/hook.js'");
    // The provider was not quoted at all. It is a PROVIDERS key rather than
    // anything a caller chose, so this is belt and braces — and belt and braces
    // is what stops the next argument added here being the loose one.
    expect(cmd).toContain("--provider 'claude'");
  });
});

describe("the sound hook command", () => {
  const NODE = "/usr/local/bin/node";

  it.runIf(posix)("is one command with one argument, whatever the path contains", () => {
    for (const path of NASTY) {
      const cmd = soundHookCommand(path, NODE);
      const argv = shellArgv(cmd.replace(shellQuoteArg(NODE), "printf-args"));
      expect(argv, path).toEqual(["printf-args", path]);
    }
  });

  it("no longer wraps a path in double quotes and calls it escaped", () => {
    const cmd = soundHookCommand("/home/a`id`b/notify.js", NODE);
    expect(cmd).not.toContain('"/home/a`id`b/notify.js"');
    expect(cmd).toContain("'/home/a`id`b/notify.js'");
  });
});
