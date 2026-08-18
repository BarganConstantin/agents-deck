// #480: `--version`, and the tokens the parser used to swallow.
//
// Two bugs from one loop with no `else`. `ccdeck --version` fell through to a
// full boot — a deck, a bound port, a browser, and a process that never exits —
// so the number had to be dug out of `npm ls -g` instead. And a mistyped flag
// was indistinguishable from a working one: `ccdeck --prot 4500` bound 4317 and
// said nothing, in a tool whose whole boot output exists so that nothing it did
// is a surprise.
//
// The risky half of the fix is the second one, and it is risky in exactly one
// place: `--port`, `--workspace` and `--history` take a value, consumed with
// `args[++i]`. If that value were ever re-examined as a token of its own, every
// correct `--port 4500` would report `4500` as an unknown option — a warning
// that fires on the right command line is the warning everyone learns to
// ignore. So the values are asserted, including values that look like flags and
// values that look like paths on the other operating system.
//
// The "nothing moved" half is a sweep, not a sample: the token list is read out
// of the parser's own source and checked against the table below, so a flag
// added or renamed later without a row here fails rather than quietly stops
// being covered.
//
// PLAIN NODE. parseArgs is strings in, a plain object out — no DOM, no React,
// no filesystem. The one spawn at the bottom runs the real bin/deck.js, which
// is the only way to prove `--version` exits instead of serving. No path
// assumptions anywhere: every path is derived from import.meta.url, and the
// path-shaped VALUES are opaque strings the parser never interprets.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../../server/args.mjs";

const ARGS_MJS = fileURLToPath(new URL("../../server/args.mjs", import.meta.url));
const DECK_JS = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const PKG_JSON = fileURLToPath(new URL("../../../package.json", import.meta.url));

// ── the fifteen tokens that already worked ──────────────────────────────────
//
// Token, the argv to hand the parser, and the whole object that must come back.
// `toEqual` on the whole object rather than one key, so a fix that quietly
// added a second key to some branch would fail here.
const KEPT: [token: string, argv: string[], parsed: Record<string, unknown>][] = [
  ["-h",           ["-h"],                        { help: true }],
  ["--help",       ["--help"],                    { help: true }],
  ["-p",           ["-p", "4500"],                { port: "4500" }],
  ["--port",       ["--port", "4500"],            { port: "4500" }],
  ["--no-open",    ["--no-open"],                 { noOpen: true }],
  ["--uninstall",  ["--uninstall"],               { uninstall: true }],
  ["--workspace",  ["--workspace", "some-dir"],   { workspace: "some-dir" }],
  ["--scope",      ["--scope"],                   { scope: true }],
  ["--all",        ["--all"],                     { all: true }],
  ["--no-persist", ["--no-persist"],              { noPersist: true }],
  ["--history",    ["--history", "events.jsonl"], { history: "events.jsonl" }],
  ["--codex",      ["--codex"],                   { codex: true }],
  ["--no-codex",   ["--no-codex"],                { noCodex: true }],
  ["--claude",     ["--claude"],                  { claude: true }],
  ["--no-claude",  ["--no-claude"],               { noClaude: true }],
];

// ── the two #480 added ──────────────────────────────────────────────────────
const ADDED: [token: string, argv: string[], parsed: Record<string, unknown>][] = [
  ["-v",        ["-v"],        { version: true }],
  ["--version", ["--version"], { version: true }],
];

describe("the flag list is swept whole, not sampled", () => {
  it("covers every token the parser matches on, and no token it does not", () => {
    // The parser's own source is the authority on what the list is. Every
    // branch is `a === "<token>"`, so this is the complete set — and comparing
    // it against the two tables is what makes the sweep below provably
    // exhaustive rather than however many rows somebody remembered to write.
    const source = readFileSync(ARGS_MJS, "utf8");
    const inSource = [...source.matchAll(/a === "([^"]+)"/g)].map(m => m[1]);
    expect(inSource.length, "a token is matched twice in args.mjs")
      .toBe(new Set(inSource).size);
    expect([...inSource].sort())
      .toEqual([...KEPT.map(r => r[0]), ...ADDED.map(r => r[0])].sort());
  });
});

/** The flags a call set, with the new `unknown` list taken back off. */
function flagsOf(argv: string[]): Record<string, unknown> {
  const { unknown, ...rest } = parseArgs(argv) as Record<string, unknown>;
  void unknown;
  return rest;
}

describe("everything that parsed to something still parses to exactly that", () => {
  // Deliberately asked WITHOUT `unknown`, so these are the same assertions
  // against the parser before #480 and after it. A sweep that failed on the
  // old source would be pinning the new shape rather than the old answers, and
  // the old answers are the thing that must not have moved.
  for (const [token, argv, parsed] of KEPT) {
    it(`${token} is unchanged`, () => {
      expect(flagsOf(argv)).toEqual(parsed);
    });
  }

  it("parses all fifteen at once into the same fifteen answers", () => {
    // One at a time proves each branch; all at once proves the loop still
    // reaches every branch and that no value swallowed the flag after it.
    const argv = KEPT.flatMap(([, a]) => a);
    expect(flagsOf(argv)).toEqual(Object.assign({}, ...KEPT.map(([, , p]) => p)));
  });

  it("still leaves a value-taking flag with no value alone", () => {
    // `args[++i]` walks off the end here, exactly as it did before.
    expect(flagsOf(["--port"])).toEqual({ port: undefined });
    expect(flagsOf(["--workspace"])).toEqual({ workspace: undefined });
    expect(flagsOf(["--history"])).toEqual({ history: undefined });
  });
});

describe("no flag the deck knows is ever reported as unknown", () => {
  // The other half of the sweep, and the half that is new: every one of the
  // seventeen tokens, plus the trailing-flag case, has to leave the list empty.
  for (const [token, argv] of [...KEPT, ...ADDED]) {
    it(`${token} leaves nothing in unknown`, () => {
      expect(parseArgs(argv).unknown).toEqual([]);
    });
  }

  it("adds nothing for a value-taking flag that ran off the end", () => {
    // `args[++i]` is `undefined` here, and `undefined` must not be pushed onto
    // the list as a token of its own.
    for (const flag of ["-p", "--port", "--workspace", "--history"]) {
      expect(parseArgs([flag]).unknown, flag).toEqual([]);
    }
  });
});

describe("--version and -v", () => {
  for (const [token, argv, parsed] of ADDED) {
    it(`${token} sets the flag and nothing else`, () => {
      expect(parseArgs(argv)).toEqual({ ...parsed, unknown: [] });
    });
  }

  it("is listed in --help, where someone would look for it", () => {
    expect(readFileSync(DECK_JS, "utf8")).toMatch(/-v, --version\s+Print the version and exit/);
  });
});

describe("the value of a value-taking flag is never an unknown option", () => {
  // The one way this warning goes wrong, asserted five ways.
  it("says nothing about a port number", () => {
    expect(parseArgs(["--port", "4500"])).toEqual({ port: "4500", unknown: [] });
    expect(parseArgs(["-p", "4500"])).toEqual({ port: "4500", unknown: [] });
  });

  it("says nothing about a workspace path, on either operating system", () => {
    // Opaque strings: the parser does not interpret them, and this test must
    // not either — it runs on Linux, macOS and Windows alike.
    for (const path of ["/home/u/proj", "C:\\Users\\u\\proj", "~/proj", "./sub", "proj"]) {
      expect(parseArgs(["--workspace", path]), path)
        .toEqual({ workspace: path, unknown: [] });
    }
  });

  it("says nothing about a history path", () => {
    for (const path of ["/var/log/events.jsonl", "C:\\logs\\events.jsonl", "events.jsonl"]) {
      expect(parseArgs(["--history", path]), path)
        .toEqual({ history: path, unknown: [] });
    }
  });

  it("says nothing about a value that happens to look like a flag", () => {
    // A directory called `--scope` is absurd; a value beginning with a dash is
    // not (`--history -`, a Windows switch pasted by mistake). Either way the
    // token after a value-taking flag is its value and is never re-examined.
    expect(parseArgs(["--workspace", "--scope"])).toEqual({ workspace: "--scope", unknown: [] });
    expect(parseArgs(["--history", "--prot"])).toEqual({ history: "--prot", unknown: [] });
  });

  it("still reports what comes AFTER the value", () => {
    // The unquoted-path failure this repo already knew about and could not
    // report: `--workspace C:\Users\John Smith\proj` reaches the parser as two
    // arguments, the second one silently dropped. Now it is named.
    expect(parseArgs(["--workspace", "C:\\Users\\John", "Smith\\proj"]))
      .toEqual({ workspace: "C:\\Users\\John", unknown: ["Smith\\proj"] });
  });
});

describe("a token the deck does not know is said out loud", () => {
  it("names a mistyped flag", () => {
    expect(parseArgs(["--prot", "4500"]).unknown).toEqual(["--prot", "4500"]);
    expect(parseArgs(["--workpace", "proj"]).unknown).toEqual(["--workpace", "proj"]);
  });

  it("names a bare positional argument", () => {
    // The deck takes none, so a bare word is an argument it read and did
    // nothing with — the same mistake as a mistyped flag, and worth the same
    // line.
    expect(parseArgs(["deck"]).unknown).toEqual(["deck"]);
    expect(parseArgs(["--no-open", "deck"])).toEqual({ noOpen: true, unknown: ["deck"] });
  });

  it("names a short flag it does not know", () => {
    expect(parseArgs(["-x"]).unknown).toEqual(["-x"]);
  });

  it("keeps them in the order they were typed, and keeps the real flags working", () => {
    expect(parseArgs(["--prot", "--no-open", "--workpace", "--scope"]))
      .toEqual({ noOpen: true, scope: true, unknown: ["--prot", "--workpace"] });
  });

  it("reports nothing at all for an empty command line", () => {
    expect(parseArgs([])).toEqual({ unknown: [] });
  });
});

describe("bin/deck.js reads the parser rather than carrying its own", () => {
  it("imports parseArgs and no longer declares one", () => {
    // The parser moved out of bin/deck.js so a test could reach it without
    // starting a deck — importing that file installs hooks, binds a port and
    // opens a browser at module scope. A copy re-inlined there would drift from
    // the one every assertion above is about.
    const deck = readFileSync(DECK_JS, "utf8");
    expect(deck).toMatch(/import \{ parseArgs \} from "\.\.\/src\/server\/args\.mjs";/);
    expect(deck).not.toMatch(/^function parseArgs\(/m);
  });
});

// ── the binary, end to end ──────────────────────────────────────────────────

/** Run bin/deck.js and report what it printed and how it ended. */
function runDeck(args: string[], timeoutMs = 20_000) {
  return new Promise<{ code: number | null; signal: string | null; out: string; err: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [DECK_JS, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        // NO_COLOR so nothing paints, and a home the deck cannot recognise so
        // nothing it might otherwise probe is on this machine's real paths.
        // Neither matters on the --version path, which exits before any of that
        // is read — which is the point being asserted.
        env: { ...process.env, NO_COLOR: "1", CI: "1" },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", d => { out += d; });
      child.stderr.on("data", d => { err += d; });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`bin/deck.js ${args.join(" ")} did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
    },
  );
}

describe("`node bin/deck.js --version` against the real file", () => {
  const version = JSON.parse(readFileSync(PKG_JSON, "utf8")).version as string;

  for (const flag of ["--version", "-v"]) {
    it(`${flag} prints the version and exits 0`, async () => {
      const { code, signal, out, err } = await runDeck([flag]);
      expect(signal).toBeNull();
      expect(code).toBe(0);
      // Exactly the number, nothing else. This is also the whole proof that no
      // deck was started: a boot writes a banner, a workspace row and a
      // `server ready` line before it would ever get to sit on a port, and none
      // of it is here.
      expect(out.trim()).toBe(version);
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(err).toBe("");
    }, 30_000);
  }
});
