// #457. #450/#456 fixed the `%~dp0` shim bug for ccusage's `npm.cmd` and
// `npx.cmd` and stopped there. The same shape was still live in the three
// general spawn helpers — `run`, `runInteractive`, `runDetached` — which is
// where `claude.cmd` (the quota poll, and the whole sign-in flow) and cswap's
// shim are launched from.
//
// The defect, restated once: a `.cmd` shim locates its own payload as
// `%~dp0\node_modules\…`, and `%~dp0` is the drive-and-path of the command token
// cmd.exe was handed. A BARE name carries no directory, so `%~dp0` came out as
// the deck's WORKING DIRECTORY. From the reporting machine, deck started in
// `C:\Users\vceban`:
//
//     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npm-prefix.js'
//
// Two things are pinned here, and the second is the one #456 called the reason
// it stopped short:
//
//   1. The command line every affected caller produces on Windows names an
//      ABSOLUTE `.cmd`, never a bare one — and falls back to exactly today's
//      bare name when no layout can be seen, so nothing that works can break.
//   2. `looksMissing` is told the spelling cmd.exe was ACTUALLY GIVEN. It
//      compares that against the name cmd.exe echoes back, so once the token
//      became a path a check against the bare candidate stops matching and a
//      genuinely absent CLI stops reporting as absent.
//
// Plain node, no jsdom, nothing rendered. The platform is a parameter
// throughout, so the Windows answers are checked from macOS; the two end-to-end
// runs stand cmd.exe up as a shell script, the way exec-windows.test.ts does.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs server module, no types
import { candidateSpec, candidates, looksMissing, run, runInteractive } from "../../server/exec.mjs";
// @ts-expect-error — .mjs server module, no types
import { quotaClaudeBin } from "../../server/quota.mjs";

// The reporting machine from #450/#456, as injectable values. Nothing below
// touches the disk of the machine running the suite: `exists` answers for a
// Windows volume that exists nowhere.
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const NODE_DIR = "C:\\Program Files\\nodejs";
const APPDATA_NPM = "C:\\Users\\vceban\\AppData\\Roaming\\npm";
const LOCAL_BIN = "C:\\Users\\vceban\\.local\\bin";
const WIN_PATH = `C:\\Windows\\system32;C:\\Windows;${NODE_DIR};${APPDATA_NPM};${LOCAL_BIN}`;

/** A Windows disk on which only the listed files exist. */
const disk = (...files: string[]) => (p: string) => files.includes(p);

const winDeps = (...files: string[]) => ({
  execPath: NODE_EXE, pathEnv: WIN_PATH, exists: disk(...files),
});

/** Nothing at all is installed — the fallback path. */
const blindWindows = { execPath: NODE_EXE, pathEnv: WIN_PATH, exists: () => false };

/**
 * The single command-line argument cmd.exe receives, back as the tokens the
 * shim will actually see. The whole line is wrapped in one more pair of quotes,
 * the way `cmd /c` wants it, so that pair comes off first.
 */
function cmdTokens(line: string) {
  const inner = line.replace(/^"/, "").replace(/"$/, "");
  return [...inner.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

/**
 * What the deck would hand cmd.exe for one caller, start to finish: the name
 * the caller passes, through the candidate list, to the spec for the first
 * BATCH candidate in it. That is the candidate this bug lives in, and going
 * through `candidates()` rather than assuming `name + ".cmd"` is what keeps the
 * reconstruction honest if the candidate list ever changes.
 */
function windowsLineFor(name: string, args: string[], deps: unknown) {
  const batch = candidates(name, "win32").find((c: string) => /\.(cmd|bat)$/i.test(c));
  expect(batch, `no batch candidate for ${name}`).toBeTruthy();
  const spec = candidateSpec(batch, args, "win32", deps);
  return { ...spec, tokens: cmdTokens(spec.args[3]) };
}

// ── (1) every affected caller names an absolute .cmd ────────────────────────

describe("the Windows command line each run/runInteractive/runDetached caller produces", () => {
  // The two callers that are certainly hitting this on the reporting machine.
  // claudeBin() in cswap-admin.mjs is `AGENTS_DECK_CLAUDE ?? "claude"`, so the
  // name that reaches the helpers is the bare word.
  const CLAUDE_SHIM = `${APPDATA_NPM}\\claude.cmd`;

  it("names claude.cmd by its full path for the quota poll — #360's 3s call", () => {
    // quota.mjs:438, `run(bin, ["--print", "/usage"])`. The bin comes from
    // quotaClaudeBin, whose LAST candidate is the bare name — reached on every
    // machine whose claude is not in one of the two directories it knows, which
    // is nvm-windows, volta, a moved npm prefix or a corporate wrapper.
    const bin = quotaClaudeBin("win32", {}, "C:\\Users\\vceban", () => false);
    expect(bin).toBe("claude");

    const { file, args, opts, launch, tokens } =
      windowsLineFor(bin, ["--print", "/usage"], winDeps(CLAUDE_SHIM));

    // #362's guarantees, untouched: cmd.exe, verbatim arguments, no shell.
    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    expect(opts.shell).toBeUndefined();

    // The regression, in two lines. A bare token leaves `%0` with no directory.
    expect(tokens[0]).not.toBe("claude.cmd");
    expect(tokens[0]).toBe(CLAUDE_SHIM);
    // And the spelling looksMissing will be judged against is that same one.
    expect(launch).toBe(CLAUDE_SHIM);
    // The arguments are still their own tokens, which is the whole of #362.
    expect(tokens.slice(1)).toEqual(["--print", "/usage"]);
  });

  it("names it for the accounts panel's identity read too", () => {
    // cswap-admin.mjs:115, `run(await claudeBin(), ["auth","status","--json"])`.
    const { tokens } = windowsLineFor("claude", ["auth", "status", "--json"], winDeps(CLAUDE_SHIM));
    expect(tokens[0]).toBe(CLAUDE_SHIM);
    expect(tokens.slice(1)).toEqual(["auth", "status", "--json"]);
  });

  it("names it for the interactive sign-in, which is the longest-lived child", () => {
    // cswap-admin.mjs:270, `runInteractive(await claudeBin(), args)`. This one
    // blocks reading a pasted OAuth code, so a shim that dies on `%~dp0` costs
    // the user a whole sign-in rather than one poll.
    const { tokens } = windowsLineFor("claude", ["auth", "login"], winDeps(CLAUDE_SHIM));
    expect(tokens[0]).toBe(CLAUDE_SHIM);
  });

  it("names a cswap shim by its full path wherever one exists", () => {
    // cswapBin() answers the bare word whenever `cswap --version` worked, and
    // every mutation in cswap-admin.mjs plus the polls in cswap-auto.mjs and
    // claude-accounts.mjs go through it. uv and pipx normally leave a
    // `cswap.exe`, which is not a batch file and never had this bug — but the
    // candidate loop reaches `cswap.cmd` whenever the .exe is absent, which is
    // what an older pipx or a scoop shim leaves, and that spelling must not be
    // bare either.
    const shim = `${LOCAL_BIN}\\cswap.cmd`;
    for (const args of [["list"], ["remove", "3"], ["import", "-"], ["switch", "2"]]) {
      const { tokens } = windowsLineFor("cswap", args, winDeps(shim));
      expect(tokens[0]).toBe(shim);
      expect(tokens.slice(1)).toEqual(args);
    }
  });

  it("names the installer shims the same way", () => {
    // cswap-install.mjs:206/207/294 — `uv`, `pipx` and `python -m pipx` are all
    // bare names reaching run() and runDetached(). Both normally resolve to a
    // .exe; a .cmd layout exists (npm-shipped wrappers, MSYS) and gets the same
    // treatment rather than a second rule.
    const uv = `${NODE_DIR}\\uv.cmd`;
    const { tokens } = windowsLineFor("uv", ["tool", "install", "claude-swap"], winDeps(uv));
    expect(tokens).toEqual([uv, "tool", "install", "claude-swap"]);
  });

  it("keeps a path with a space in one token, which is what quoting is for", () => {
    const shim = `${NODE_DIR}\\claude.cmd`;   // "C:\Program Files\nodejs"
    const { args, tokens } = windowsLineFor("claude", ["--print", "/usage"], winDeps(shim));
    expect(tokens[0]).toContain(" ");
    expect(args[3]).toContain(`"${shim}"`);
    expect(tokens).toHaveLength(3);
  });
});

// ── (2) the candidate loop and the bare-name fallback survive ───────────────

describe("what happens when the lookup can see nothing", () => {
  it("falls back to the bare name, so a layout it cannot see is no worse off", () => {
    // The `?? name` rule ccusage.mjs and npx.mjs already spell. Without it this
    // fix would be a regression on every machine whose install lives somewhere
    // neither node's directory nor PATH mentions.
    for (const name of ["claude.cmd", "cswap.cmd", "uv.bat"]) {
      const spec = candidateSpec(name, ["x"], "win32", blindWindows);
      expect(cmdTokens(spec.args[3])[0]).toBe(name);
      expect(spec.launch).toBe(name);
    }
  });

  it("still offers every spelling, so the loop keeps trying install locations", () => {
    // Resolution must not collapse the candidate list: `claude.exe` from the
    // native installer and `claude.cmd` from npm both have to stay reachable.
    expect(candidates("claude", "win32")).toEqual(["claude.exe", "claude.cmd", "claude.bat", "claude"]);
    // POSIX has exactly one spelling and always did.
    expect(candidates("claude", "linux")).toEqual(["claude"]);
  });

  it("leaves a candidate that already carries a directory exactly as given", () => {
    // quotaClaudeBin's `%APPDATA%\npm\claude.cmd` and cswapCandidates' absolute
    // entries arrive here already resolved. Re-rooting one would be a way to
    // run something else entirely, so shimPath refuses names with a separator.
    const own = `${APPDATA_NPM}\\claude.cmd`;
    const spec = candidateSpec(own, ["--print", "/usage"], "win32", winDeps(`${NODE_DIR}\\claude.cmd`));
    expect(spec.launch).toBe(own);
    expect(cmdTokens(spec.args[3])[0]).toBe(own);
  });

  it("does not touch a non-batch candidate at all", () => {
    // `claude.exe`, `powershell.exe`, `where` — spawned directly, no cmd.exe, no
    // `%~dp0` anywhere, so there is nothing to resolve and nothing to quote.
    for (const name of ["claude.exe", "powershell.exe", "where", "uv"]) {
      const spec = candidateSpec(name, ["a b"], "win32", winDeps(`${NODE_DIR}\\${name}`));
      expect(spec).toEqual({ file: name, args: ["a b"], opts: {}, launch: name });
    }
  });
});

// ── (3) POSIX is byte-identical ─────────────────────────────────────────────

describe("POSIX, which is not a batch platform and must not change", () => {
  it("produces the bare name, an untouched argv and no options, on both", () => {
    const args = ["--print", "/usage"];
    for (const platform of ["linux", "darwin"]) {
      for (const name of ["claude", "cswap", "uv", "python3", "claude.cmd", "thing.bat"]) {
        const spec = candidateSpec(name, args, platform, blindWindows);
        expect(spec).toEqual({ file: name, args, opts: {}, launch: name });
        // Not merely equal — the SAME array object the caller passed, which is
        // what "no shell, argument vector intact" has always meant here.
        expect(spec.args).toBe(args);
      }
    }
  });

  it("never performs a lookup on POSIX, so there is nothing to be slow or wrong", () => {
    // An `exists` that throws proves the branch is not entered rather than
    // merely returning the same answer.
    const explode = {
      execPath: NODE_EXE, pathEnv: WIN_PATH,
      exists: () => { throw new Error("shimPath must not run on POSIX"); },
    };
    for (const platform of ["linux", "darwin"]) {
      expect(() => candidateSpec("claude.cmd", [], platform, explode)).not.toThrow();
    }
    // And on Windows it very much is entered, or the assertion above is vacuous.
    expect(() => candidateSpec("claude.cmd", [], "win32", explode)).not.toThrow();
    expect(candidateSpec("claude.cmd", [], "win32", explode).launch).toBe("claude.cmd");
  });
});

// ── (4) looksMissing stays honest about an absolute spelling ────────────────

describe("telling 'this CLI is not installed' from 'this CLI failed'", () => {
  const ABS = `${APPDATA_NPM}\\claude.cmd`;
  const notRecognized = (token: string) =>
    `'${token}' is not recognized as an internal or external command,\noperable program or batch file.\n`;

  it("recognises cmd.exe's verdict about the full path it was handed", () => {
    // cmd.exe echoes the command token back exactly as it received it, so once
    // the token is a path the comparison has to be against that path.
    expect(looksMissing(notRecognized(ABS), ABS)).toBe(true);
    // The other wording, for a path whose directory is gone.
    expect(looksMissing("The system cannot find the path specified.", ABS)).toBe(true);
  });

  it("would NOT have recognised it against the bare candidate — the coupling #456 named", () => {
    // This is the failure mode the fix has to avoid, spelled out: judged against
    // `claude.cmd` while cmd.exe was handed a path, a genuinely absent CLI comes
    // back as an ordinary exit 1 whose stderr is half a sentence about batch
    // files, instead of the ENOENT the panels turn into "not installed".
    expect(looksMissing(notRecognized(ABS), "claude.cmd")).toBe(false);
  });

  it("still refuses to read one tool's report about another as the tool's absence", () => {
    // The protection that stops `cswap remove 3` being run a second time: the
    // comparison stays EXACT, it is only fed the right spelling.
    const forwarded = notRecognized("git");
    expect(looksMissing(forwarded, ABS)).toBe(false);
    expect(looksMissing(`${ABS} ran fine\n${notRecognized(ABS)}`, ABS)).toBe(false);
  });
});

// ── (5) end to end, with cmd.exe stood up as a shell script ─────────────────
//
// shimPath joins with a backslash, which on POSIX is an ordinary filename
// character — so a directory on `%PATH%` holding a file literally named
// `<dir>\name.cmd` is a Windows layout this suite can actually build and run
// against. That is what makes these two real `run()` calls rather than spec
// arithmetic.

// `printf`, never `echo`: the paths under test contain a backslash, and the
// `sh` on a Mac is bash, whose echo reads `\c` as "stop output" — which is
// exactly what `bin\ccdeck…` looks like. /bin/sh is spelled in full for the
// same class of reason: PATH is narrowed to the one fake Windows directory
// below, so nothing is resolvable through it.
const CMD_STUB = [
  "#!/bin/sh",
  // Record the whole command line cmd.exe was given; the assertions read it.
  'printf "%s\\n" "$4" >> "$CCDECK_LOG"',
  // Peel the wrapper quotes, then take the first quoted token — cmd.exe's `%0`.
  'inner=${4#\\"}',
  'inner=${inner%\\"}',
  'target=${inner#\\"}',
  'target=${target%%\\"*}',
  // cmd.exe echoes the token back exactly as it received it. So does this.
  "missing() {",
  `  printf "'%s' is not recognized as an internal or external command,\\n" "$target" >&2`,
  '  printf "operable program or batch file.\\n" >&2',
  "  exit 1",
  "}",
];

const foundStub = [
  ...CMD_STUB,
  'if [ -f "$target" ]; then /bin/sh "$target"; else missing; fi',
].join("\n") + "\n";

// cmd.exe cannot find it whatever we hand over — the shim that was there when
// the lookup ran and gone by the time cmd.exe looked. Deliberately independent
// of whether the file exists, so the honesty of the answer is what is measured.
const goneStub = [...CMD_STUB, "missing"].join("\n") + "\n";

/** Run `body` with the process claiming to be Windows, one PATH entry, and
 *  cmd.exe replaced by a shell script. Everything is restored afterwards. */
function onFakeWindows(stub: string, body: (dir: string, log: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-457-"));
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const log = join(dir, "cmdline.txt");
    const comspecFile = join(dir, "fake-cmd.sh");
    writeFileSync(comspecFile, stub);
    chmodSync(comspecFile, 0o755);

    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const saved = { ComSpec: process.env.ComSpec, PATH: process.env.PATH, LOG: process.env.CCDECK_LOG };
    try {
      process.env.ComSpec = comspecFile;
      process.env.CCDECK_LOG = log;
      // The one directory shimPath is allowed to find anything in. PATH is
      // split on `;`, which a POSIX temp path never contains.
      process.env.PATH = binDir;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      await body(binDir, log);
    } finally {
      Object.defineProperty(process, "platform", platform);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("a real run() on a machine claiming to be Windows", () => {
  // Each test uses a name of its own: exec.mjs memoises the spelling that
  // worked, per command name, for the life of the process.
  it.skipIf(process.platform === "win32")(
    "hands cmd.exe the shim's full path, never the bare name",
    onFakeWindows(foundStub, async (binDir, log) => {
      const name = "ccdeck457-found";
      // The Windows layout, built with a backslash in the filename.
      const shim = `${binDir}\\${name}.cmd`;
      writeFileSync(shim, "#!/bin/sh\necho quota-ok\n");

      const r = await run(name, ["--print", "/usage"], { timeout: 20_000 });
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("quota-ok");

      // What cmd.exe was actually given. Pre-#457 this was `""<name>.cmd"
      // "--print" "/usage""` and the shim's `%~dp0` was the deck's cwd.
      const tokens = cmdTokens(readFileSync(log, "utf8").trim());
      expect(tokens[0]).not.toBe(`${name}.cmd`);
      expect(tokens[0]).toBe(shim);
      expect(tokens.slice(1)).toEqual(["--print", "/usage"]);
    }),
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "still answers ENOENT for a CLI that is genuinely not installed",
    onFakeWindows(foundStub, async () => {
      // Nothing on PATH, so shimPath finds nothing and every batch candidate
      // falls back to the bare name — exactly today's behaviour.
      const r = await run("ccdeck457-absent", ["auth", "status"], { timeout: 20_000 });
      expect(r.ok).toBe(false);
      // Not "exited 1": the panels turn this code into "not installed", and
      // anything else puts "operable program or batch file." on screen.
      expect(r.code).toBe("ENOENT");
    }),
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "answers ENOENT when the shim it resolved is gone by the time cmd.exe looks",
    onFakeWindows(goneStub, async (binDir) => {
      // The lookup succeeds — the file is right there — and cmd.exe reports it
      // as missing anyway, naming the ABSOLUTE path. Judged against the bare
      // candidate this reads as a tool that ran and failed, and the run comes
      // back `code: 1` with cmd.exe's two lines as its stderr.
      const name = "ccdeck457-vanished";
      writeFileSync(`${binDir}\\${name}.cmd`, "#!/bin/sh\necho never\n");

      const r = await run(name, ["list"], { timeout: 20_000 });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("ENOENT");
      expect(r.code).not.toBe(1);
    }),
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "answers ENOENT for a vanished shim in runInteractive too, and runs it once",
    onFakeWindows(goneStub, async (binDir, log) => {
      // runInteractive has its own looksMissing call, and it is the one whose
      // "not missing" branch falls through to a retry — for `cswap remove 3`
      // that is asking to delete an account a second time. Both halves are
      // checked: the verdict, and that only the candidates that could not run
      // were attempted.
      const name = "ccdeck457-vanished-i";
      writeFileSync(`${binDir}\\${name}.cmd`, "#!/bin/sh\necho never\n");

      const r = await runInteractive(name, ["remove", "3"], { timeout: 20_000 }).done;
      expect(r.ok).toBe(false);
      expect(r.code).toBe("ENOENT");
      // One line per cmd.exe invocation: the .cmd candidate and the .bat one.
      // Never a third, and never a repeat of the same spelling.
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(cmdTokens(lines[0])[0]).toBe(`${binDir}\\${name}.cmd`);
      expect(cmdTokens(lines[1])[0]).toBe(`${name}.bat`);
    }),
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "does the same for runInteractive, which is where the sign-in lives",
    onFakeWindows(foundStub, async (binDir, log) => {
      const name = "ccdeck457-interactive";
      const shim = `${binDir}\\${name}.cmd`;
      writeFileSync(shim, "#!/bin/sh\necho login-ok\n");

      const r = await runInteractive(name, ["auth", "login"], { timeout: 20_000 }).done;
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain("login-ok");

      const tokens = cmdTokens(readFileSync(log, "utf8").trim());
      expect(tokens[0]).toBe(shim);
      expect(tokens.slice(1)).toEqual(["auth", "login"]);
    }),
    30_000,
  );
});
