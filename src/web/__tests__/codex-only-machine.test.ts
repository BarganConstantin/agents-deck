// A machine with only Codex was treated as a Claude machine at every lifecycle
// step (#402). It had claude-swap — a Python tool that switches Claude Code
// accounts — installed for it, fetching a `uv` binary first if it had to. It got
// the accounts panel open on first run, whose empty state reads "claude-swap is
// installed but has nothing in its store. Use the + above to sign one in", and
// following that reaches `claude auth login` against a CLI that is not there and
// dead-ends at "the claude CLI could not be run: not on PATH". And the boot
// banner told it to "sign in to Claude Code, then run cswap add".
//
// Nothing anywhere asked whether Claude Code was on the machine. The mirror was
// true too: a Claude-only machine permanently carried "Quota unavailable. / Run
// codex login to authenticate." in the usage panel.
//
// So there is now one answer — hasClaudeInstalled() — and everything the deck
// installs or opens on the Claude side hangs off it, with /api/health carrying
// it to the browser beside the Codex flag that was already computed.
//
// The presence test is the whole risk of the fix and most of what is pinned
// here. A false yes is today's bug, visible and overridable. A FALSE NO takes
// the hooks away from somebody who has Claude Code, which is a deck that never
// shows a single session and says nothing about why. So the cases below are
// mostly about the ways it must still answer yes.
//
// Everything runs against a temp sandbox: HOME, USERPROFILE, CLAUDE_CONFIG_DIR,
// CODEX_HOME and PATH all point inside it, so no assertion here can be satisfied
// — or contaminated — by the developer's own machine, and nothing is installed.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX   = mkdtempSync(join(tmpdir(), "ccdeck-codex-only-"));
const FAKE_HOME = join(SANDBOX, "home");
// The deck's own view of the Claude config dir while the server runs. Separate
// from the per-case directories below so starting a server cannot write into a
// tree a presence assertion is about to read.
const SERVER_CLAUDE = join(SANDBOX, "server-claude");
const SERVER_CODEX  = join(SANDBOX, "server-codex");
// Stands in for PATH everywhere below. Empty, so a presence test that fell back
// to the host's PATH would find the developer's real `claude` and pass for the
// wrong reason — it must fail instead.
const EMPTY_PATH = join(SANDBOX, "no-bin");
// A PATH entry that does contain a `claude`, for the cases that need one.
const BIN_PATH = join(SANDBOX, "some-bin");
for (const d of [FAKE_HOME, SERVER_CLAUDE, SERVER_CODEX, EMPTY_PATH, BIN_PATH]) {
  mkdirSync(d, { recursive: true });
}

// Read at module load by index.mjs, so the sandbox has to be in place before the
// first import — and $HOME / %USERPROFILE% are both set because node's homedir()
// reads whichever one this platform has.
const prevEnv: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  PATH: process.env.PATH,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = SERVER_CLAUDE;
process.env.CODEX_HOME = SERVER_CODEX;
process.env.PATH = EMPTY_PATH;

// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir, hasClaudeInstalled, claudeCliCandidates } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");
const { ASSUMED, readProviders } = await import("../providers");

// Refuse to run at all if the sandbox did not take, rather than write into a
// real ~/.claude. Would fire on a machine where the developer has
// CLAUDE_CONFIG_DIR set for real and this file failed to override it.
for (const p of [String(claudeConfigDir()), FAKE_HOME]) {
  if (!resolve(p).startsWith(resolve(SANDBOX))) {
    throw new Error(`refusing to run: ${p} is outside ${SANDBOX}`);
  }
}

const openServers: Server[] = [];
afterAll(async () => {
  for (const s of openServers) {
    await new Promise<void>(done => { s.closeAllConnections?.(); s.close(() => done()); });
  }
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

/** A fresh, empty config directory for one case, so no case can see another's. */
function caseDir(name: string): string {
  const dir = join(SANDBOX, "cases", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** hasClaudeInstalled with the whole machine injected — no host state reaches it. */
function present(opts: {
  configDir: string;
  path?: string;
  home?: string;
  platform?: string;
  env?: Record<string, string>;
}): boolean {
  return hasClaudeInstalled({
    platform: opts.platform ?? process.platform,
    env: { PATH: opts.path ?? EMPTY_PATH, ...(opts.env ?? {}) },
    home: opts.home ?? FAKE_HOME,
    configDir: opts.configDir,
  });
}

describe("whether this machine has Claude Code at all", () => {
  it("says no for a Codex-only machine: no binary anywhere, nothing in the config dir", () => {
    expect(present({ configDir: caseDir("codex-only") })).toBe(false);
  });

  it("still says no after the deck has already run there once", () => {
    // The trap the whole marker list exists for. installHooks creates the config
    // dir and writes settings.json into it, and keepDiscovery creates
    // agent-dag/ — so on every Codex-only machine that ever started an earlier
    // ccdeck, "does ~/.claude exist" answers YES about a directory the deck made
    // for itself. A presence test built on the directory would confirm its own
    // side effect forever.
    const dir = caseDir("deck-residue");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: {} }), "utf8");
    mkdirSync(join(dir, "agent-dag"), { recursive: true });
    writeFileSync(join(dir, "agent-dag", "hook.js"), "// forwarder\n", "utf8");
    expect(present({ configDir: dir })).toBe(false);
  });

  it("says yes when the CLI is on PATH but has never been launched", () => {
    // Somebody who installed both CLIs this morning and started the deck before
    // running either. There is nothing in the config dir to find — the binary is
    // the only evidence, and it is enough.
    writeFileSync(join(BIN_PATH, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(present({ configDir: caseDir("never-launched"), path: BIN_PATH })).toBe(true);
  });

  it("says yes on a machine where Claude Code has run but its binary cannot be found", () => {
    // The opposite failure, and the reason the binary cannot be the only test:
    // a deck launched from a desktop shortcut inherits a PATH that never sourced
    // the user's shell rc, so a `claude` under nvm/mise/volta is invisible. The
    // config dir proves months of use anyway.
    const dir = caseDir("used-no-binary");
    mkdirSync(join(dir, "projects"), { recursive: true });
    expect(present({ configDir: dir })).toBe(true);
  });

  it("says yes on macOS, where there is no credentials file to find", () => {
    // Claude Code keeps the OAuth token in the Keychain on macOS and writes no
    // .credentials.json at all (#360). A credentials-file test would read every
    // Mac — signed in, in daily use — as a Codex-only machine.
    const dir = caseDir("macos-keychain");
    mkdirSync(join(dir, "statsig"), { recursive: true });
    mkdirSync(join(dir, "todos"), { recursive: true });
    expect(present({ configDir: dir, platform: "darwin" })).toBe(true);
  });

  it("follows CLAUDE_CONFIG_DIR, and does not consult ~/.claude when it is set", () => {
    // CLAUDE_CONFIG_DIR replaces ~/.claude rather than overlaying it. A user who
    // runs Claude Code under it has a ~/.claude that is empty or absent, and
    // reading that one would call them a Codex-only machine.
    const moved = caseDir("relocated");
    mkdirSync(join(moved, "projects"), { recursive: true });
    const home = join(SANDBOX, "cases", "relocated-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(hasClaudeInstalled({
      env: { PATH: EMPTY_PATH, CLAUDE_CONFIG_DIR: moved },
      home,
    })).toBe(true);
    // And the untouched ~/.claude beside it is not what answered: on its own it
    // is an empty directory, which is exactly the deck-residue case above.
    expect(present({ configDir: join(home, ".claude"), home })).toBe(false);
  });

  it("counts ~/.claude.json, which sits beside the home dir rather than inside the config dir", () => {
    const home = join(SANDBOX, "cases", "dotjson-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{}", "utf8");
    expect(present({ configDir: caseDir("dotjson"), home })).toBe(true);
  });
});

describe("finding the Windows spellings of the CLI, from any platform", () => {
  // Every one of these runs on the host this suite happens to be on. The
  // platform is a parameter precisely because these installs are the ones the
  // author is never sitting at.
  const WIN_HOME = "C:\\Users\\dev";
  /** A stand-in for NTFS, which is case-insensitive — PATHEXT is conventionally
   *  upper case while the file on disk is not, and only the real filesystem
   *  reconciles the two. A case-sensitive fake here would fail the code for a
   *  difference Windows does not have. */
  const onlyOn = (...paths: string[]) => {
    const want = paths.map(p => p.toLowerCase());
    return (p: string) => want.includes(String(p).toLowerCase());
  };

  it("finds the npm .cmd shim through PATHEXT, which is how cmd.exe finds it", () => {
    // `npm i -g @anthropic-ai/claude-code` leaves claude.cmd and no claude.exe.
    // A lookup that only ever tries the bare name finds nothing on that machine.
    expect(hasClaudeInstalled({
      platform: "win32",
      env: { Path: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      home: WIN_HOME,
      configDir: "C:\\Users\\dev\\.claude",
      exists: onlyOn("C:\\tools\\claude.cmd"),
    })).toBe(true);
  });

  it("finds the native installer's bare claude.exe in %USERPROFILE%\\.local\\bin", () => {
    const exe = "C:\\Users\\dev\\.local\\bin\\claude.exe";
    expect(claudeCliCandidates("win32", {}, WIN_HOME)).toContain(exe);
    expect(hasClaudeInstalled({
      platform: "win32",
      env: { Path: "C:\\nowhere" },
      home: WIN_HOME,
      configDir: "C:\\Users\\dev\\.claude",
      exists: onlyOn(exe),
    })).toBe(true);
  });

  it("reads %Path% and strips the quotes Windows PATH entries carry", () => {
    expect(hasClaudeInstalled({
      platform: "win32",
      env: { Path: '"C:\\Program Files";C:\\other', PATHEXT: ".EXE" },
      home: WIN_HOME,
      configDir: "C:\\Users\\dev\\.claude",
      exists: onlyOn("C:\\Program Files\\claude.exe"),
    })).toBe(true);
  });

  it("still says no on a Windows machine with neither spelling nor any config", () => {
    expect(hasClaudeInstalled({
      platform: "win32",
      env: { Path: "C:\\nowhere", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      home: WIN_HOME,
      configDir: "C:\\Users\\dev\\.claude",
      exists: () => false,
    })).toBe(false);
  });

  it("does not treat a POSIX-shaped PATH as one entry on Windows, or vice versa", () => {
    // The delimiter follows the platform argument: `;` on Windows, `:` on POSIX.
    // Getting it wrong makes the whole PATH one unusable directory name, which
    // reads as "no Claude Code" on every machine.
    const hit = "/opt/tools/claude";
    expect(hasClaudeInstalled({
      platform: "linux",
      env: { PATH: "/opt/nope:/opt/tools" },
      home: "/home/dev",
      configDir: "/home/dev/.claude",
      exists: (p: string) => String(p) === hit,
    })).toBe(true);
  });
});

describe("what /api/health tells the browser about which CLIs are watched", () => {
  async function health(opts: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server: Server = await startServer({ port: 0, host: "127.0.0.1", persist: null, ...opts });
    openServers.push(server);
    const port = (server.address() as AddressInfo).port;
    const body = await new Promise<string>((done, fail) => {
      get({ host: "127.0.0.1", port, path: "/api/health" }, res => {
        let text = "";
        res.on("data", d => { text += d; });
        res.on("end", () => done(text));
      }).on("error", fail);
    });
    return JSON.parse(body);
  }

  it("reports both flags, so the UI can stop drawing panels for a CLI that is absent", async () => {
    const codexOnly = await health({ claude: false, codex: true });
    expect(codexOnly.providers).toEqual({ claude: false, codex: true });

    const claudeOnly = await health({ claude: true, codex: false });
    expect(claudeOnly.providers).toEqual({ claude: true, codex: false });
  });

  it("defaults both to true for a caller that passes neither", async () => {
    // Which is what every deck before this field effectively reported by saying
    // nothing, and what the browser assumes when the field is missing — so an
    // embedder that never learned about the option keeps its whole UI.
    const both = await health({});
    expect(both.providers).toEqual({ claude: true, codex: true });
  });

  it("still reports the workspace it always did", async () => {
    // The providers field went in beside `workspace`, which the empty-state
    // sentence reads. Adding one must not cost the other.
    const scoped = await health({ workspace: "/tmp/somewhere", claude: false, codex: true });
    expect(scoped.workspace).toBe("/tmp/somewhere");
    expect(scoped.ok).toBe(true);
  });
});

describe("what the browser believes when the server does not say", () => {
  it("shows both when there is no answer at all", () => {
    // A deck older than the field, or a health request that failed. Hiding a
    // panel on a guess is the one outcome worse than showing a spare one.
    expect(readProviders(null)).toEqual(ASSUMED);
    expect(readProviders(undefined)).toEqual(ASSUMED);
    expect(readProviders({ ok: true, workspace: "" })).toEqual(ASSUMED);
    expect(readProviders({ ok: true, providers: "yes" })).toEqual(ASSUMED);
    expect(ASSUMED).toEqual({ kind: "assumed", claude: true, codex: true });
  });

  it("hides only on an explicit false", () => {
    expect(readProviders({ providers: { claude: false, codex: true } }))
      .toEqual({ kind: "reported", claude: false, codex: true });
    expect(readProviders({ providers: { claude: true, codex: false } }))
      .toEqual({ kind: "reported", claude: true, codex: false });
    // A field of the wrong type is not a `false`, and must not be read as one.
    expect(readProviders({ providers: { claude: 0, codex: "no" } }))
      .toEqual({ kind: "reported", claude: true, codex: true });
    // One field known, the other absent — the known one still counts.
    expect(readProviders({ providers: { claude: false } }))
      .toEqual({ kind: "reported", claude: false, codex: true });
  });
});

// The boot sequence cannot be executed from here — bin/deck.js starts a server,
// writes a discovery file and refuses to run without a built UI — so what is
// checkable is the same thing the bug was: whether the work is reached at all on
// a machine with no Claude Code.
const deckSrc = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");

describe("what a Codex-only boot does on the user's behalf", () => {
  /** The body of startupWork, which is where all three jobs are created. */
  function startupWorkBody(): string {
    const from = deckSrc.indexOf("function startupWork()");
    expect(from, "startupWork is gone or renamed").toBeGreaterThan(-1);
    const to = deckSrc.indexOf("\n}", from);
    return deckSrc.slice(from, to);
  }

  it("decides once, from hasClaudeInstalled, with flags able to override it", () => {
    expect(deckSrc).toContain("hasClaudeInstalled");
    expect(deckSrc).toMatch(/wantClaude\s*=\s*flags\.noClaude/);
    // The escape hatches, which the Claude side did not have at all: --claude is
    // the recovery for a presence test that guessed wrong, and --no-claude is
    // the mirror of --no-codex.
    expect(deckSrc).toContain('a === "--claude"');
    expect(deckSrc).toContain('a === "--no-claude"');
    expect(deckSrc).toContain("--no-claude          Skip Claude");
  });

  for (const [what, needle] of [
    ["the Claude hook install", 'installHooks({ provider: "claude" })'],
    ["the claude-swap install", "src/server/cswap-install.mjs"],
    ["the ccusage install", "src/server/ccusage.mjs"],
  ] as const) {
    it(`does not reach ${what} without wantClaude`, () => {
      const body = startupWorkBody();
      const at = body.indexOf(needle);
      expect(at, `${needle} is no longer created in startupWork`).toBeGreaterThan(-1);
      const guard = body.indexOf("wantClaude");
      expect(guard, "startupWork asks nothing about Claude Code being here").toBeGreaterThan(-1);
      expect(guard, `${what} is started before anything checks for Claude Code`).toBeLessThan(at);
    });
  }

  it("hands the decision to the server so the browser can read it back", () => {
    expect(deckSrc).toMatch(/startServer\(\{[^}]*claude: wantClaude/s);
  });

  it("says out loud which way it went, in both rows", () => {
    // The banner is the only place a wrong answer can be noticed, and the only
    // place the missing accounts panel is explained.
    expect(deckSrc).toContain("no Claude Code found, or --no-claude");
    expect(deckSrc).toContain("accounts are Claude-only");
  });

  it("never prints 'sign in to Claude Code' on a deck that skipped claude-swap", () => {
    // That line is reached only through swap?.seed, and the whole cswap job
    // resolves to null when wantClaude is false — so there is no seed to report.
    expect(deckSrc).toContain("sign in to Claude Code");
    const body = startupWorkBody();
    expect(body).toMatch(/if\s*\(!wantClaude\)\s*return null;/);
  });
});

describe("which panels the UI draws for each machine", () => {
  const appSrc   = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const usageSrc = readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");

  /** The source immediately before `needle`, which is where a JSX gate lives. */
  function leadUpTo(src: string, needle: string, chars = 400): string {
    const at = src.indexOf(needle);
    expect(at, `${needle} is gone`).toBeGreaterThan(-1);
    return src.slice(Math.max(0, at - chars), at);
  }

  it("mounts the accounts panel only where Claude Code is", () => {
    // It is open on first run, so on a Codex-only machine this was the first
    // thing on screen, and every route out of it ends at the claude CLI.
    expect(leadUpTo(appSrc, "<AccountsPanel onClose=")).toContain("providers.claude");
  });

  it("hides the topbar accounts button too, rather than opening onto nothing", () => {
    expect(leadUpTo(appSrc, 'aria-label="Toggle accounts panel"')).toContain("providers.claude");
  });

  it("does not let the A shortcut toggle a panel that is not there", () => {
    expect(appSrc).toMatch(/providersRef\.current\.claude\) toggleAccountsPanel/);
  });

  it("renders each quota section only for the CLI it is about", () => {
    // The mirror of the accounts panel: a Claude-only machine carried "Quota
    // unavailable. / Run codex login to authenticate." permanently.
    //
    // Anchored on the two <section> tags rather than the headings, because
    // "Claude quota" and "Codex quota" both also appear in prose above them.
    // There are exactly two, in render order, and each one's gate is the JSX
    // immediately before it.
    const SECTION = '<section className="up-section up-quota-section">';
    const first  = usageSrc.indexOf(SECTION);
    const second = usageSrc.indexOf(SECTION, first + 1);
    expect(first, "the quota sections are gone or renamed").toBeGreaterThan(-1);
    expect(second, "there is no longer a second quota section").toBeGreaterThan(first);
    expect(usageSrc.slice(first + SECTION.length, second)).toContain("Claude quota");
    expect(usageSrc.slice(second)).toContain("Codex quota");
    expect(usageSrc.slice(Math.max(0, first - 400), first)).toContain("providers.claude");
    expect(usageSrc.slice(second - 400, second)).toContain("providers.codex");
  });

  it("stops polling the absent CLI rather than only hiding its output", () => {
    // /api/quota can spawn `claude --print /usage`, and the Codex poll refreshes
    // an OAuth token against OpenAI. Neither is work to do once a minute for a
    // section nobody is going to see.
    expect(usageSrc).toContain("useQuota(providers.claude)");
    expect(usageSrc).toContain("useCodexQuota(providers.codex)");
    expect(usageSrc).toContain("useCodexUsage(providers.codex)");
  });
});
