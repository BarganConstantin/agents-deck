// Reported: `--workspace` meant two different things depending on which CLI
// produced the session. The hook sorted the decks whose workspace matched by how
// long that path was and delivered only to the longest — so a deck scoped to
// /Users/x/proj TOOK that tree's Claude sessions away from a machine-wide deck,
// which sat there empty while `--all` promised it captured every session on the
// machine. The Codex path had no such narrowing: every deck tails the rollout
// files itself and evaluates its own workspace, so a Codex session in the same
// directory appeared on both decks. One flag, one directory, opposite answers.
//
// Two smaller halves of the same flag were wrong with it. A relative
// `--workspace ./sub` went into the discovery file raw and was resolved inside
// the hook's process — which the host CLI runs with the AGENT's cwd — so Claude
// sessions were scoped to a different directory per agent, and none of them the
// one the user meant. And case was folded on every platform on the Codex side
// only, so on Linux a deck scoped to /srv/proj drew Codex sessions out of
// /srv/Proj and Claude sessions out of neither.
//
// The meaning kept is the documented one, and it is a property of ONE deck:
// a deck captures a session when the session's cwd is inside its workspace, and
// what any other deck is scoped to changes nothing. So the table below is walked
// through both implementations of it — hook.js's capturesSession and the
// server's codexCwdInWorkspace — and every row has one expected answer, because
// two answers is the bug.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Everything the modules below read at import time is pointed inside a temp
// tree, so nothing here can reach — or be answered by — the developer's own
// ~/.claude or ~/.codex. $HOME and %USERPROFILE% together cover POSIX and
// Windows.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-workspace-"));
const FAKE_HOME = join(SANDBOX, "home");
const FAKE_CONFIG = join(SANDBOX, "claude-config");
const FAKE_CODEX = join(SANDBOX, "codex-home");
for (const d of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX]) mkdirSync(d, { recursive: true });

const prevEnv: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
process.env.CODEX_HOME = FAKE_CODEX;

// @ts-expect-error — .mjs server module, no types
const { canonicalWorkspace } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const { codexCwdInWorkspace } = await import("../../server/log-writer.mjs");

// Refuse to run at all if the sandbox did not take, rather than assert against
// a developer's real configuration.
if (!String(claudeConfigDir()).startsWith(SANDBOX)) {
  throw new Error(`refusing to run: claude config dir resolved to ${claudeConfigDir()}, outside ${SANDBOX}`);
}

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself once outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. Requiring the copy
// exports the rules and starts nothing: main() is behind require.main.
const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const HOOK_COPY = join(SANDBOX, "hook.cjs");
copyFileSync(HOOK_SRC, HOOK_COPY);
const hook = createRequire(import.meta.url)(HOOK_COPY) as {
  capturesSession: (cwd: string | null, workspace: string, platform?: string) => boolean;
};

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

// ── the one rule, walked through both implementations of it ──────────────────

// hook.js is copied out of the package and run standalone, so it cannot import
// the server's copy of this rule and keeps its own — exactly as it does for the
// writer election. A disagreement between the two is not a style problem: it is
// the same `--workspace` capturing one set of sessions from Claude Code and a
// different set from Codex, which is what this file exists to make impossible to
// reach by accident.
type Row = [name: string, cwd: string | null, workspace: string, platform: string, want: boolean];

const TABLE: Row[] = [
  // The default. Nothing is excluded, including a session that never said where
  // it runs — Codex rollouts can omit cwd, and an unscoped deck is the only kind
  // that can honestly claim one.
  ["an unscoped deck captures everything", "/srv/proj", "", "linux", true],
  ["an unscoped deck captures a session with no cwd", null, "", "linux", true],
  ["a scoped deck captures no session with no cwd", null, "/srv", "linux", false],

  // The subtree rule itself.
  ["the workspace directory is inside itself", "/srv/proj", "/srv/proj", "linux", true],
  ["a directory below it is inside it", "/srv/proj/sub/deeper", "/srv/proj", "linux", true],
  ["a sibling sharing a prefix is not", "/srv/project-two", "/srv/proj", "linux", false],
  ["an unrelated tree is not", "/opt/other", "/srv/proj", "linux", false],
  ["the parent of the workspace is not", "/srv", "/srv/proj", "linux", false],

  // Spelling of the workspace itself: a trailing separator is the same
  // directory, and a root already ends in one.
  ["a trailing separator changes nothing", "/srv/proj/sub", "/srv/proj/", "linux", true],
  ["the filesystem root contains everything", "/srv/proj", "/", "linux", true],

  // Case. Linux keeps /srv/Proj and /srv/proj apart because they are two real
  // directories there, and a deck scoped to one must not be handed the other's
  // sessions.
  ["Linux keeps two spellings apart", "/srv/Proj/sub", "/srv/proj", "linux", false],
  ["Linux keeps the directory itself apart too", "/srv/Proj", "/srv/proj", "linux", false],
  // macOS folds, because APFS and HFS+ are case-insensitive unless deliberately
  // formatted otherwise.
  ["macOS folds case, as its filesystem does", "/Users/john/Proj/sub", "/Users/John/proj", "darwin", true],
  ["macOS still rejects a different tree", "/Users/john/other", "/Users/john/proj", "darwin", false],

  // Windows is its own answer, not a POSIX fallback: backslashes, drive letters,
  // and a filesystem that folds case everywhere.
  ["Windows folds a drive letter spelled the other way", "c:\\proj\\sub", "C:\\proj", "win32", true],
  ["Windows folds every other component too", "C:\\Users\\John\\proj\\sub", "C:\\users\\john\\proj", "win32", true],
  ["Windows rejects a sibling sharing a prefix", "C:\\project-two", "C:\\proj", "win32", false],
  ["Windows rejects another drive entirely", "D:\\other\\sub", "C:\\proj", "win32", false],
  ["Windows accepts forward slashes and a trailing one", "C:/proj/sub", "C:\\proj\\", "win32", true],
  ["a drive root contains everything on it", "C:\\proj\\sub", "c:\\", "win32", true],
];

describe("what --workspace means", () => {
  for (const [name, cwd, workspace, platform, want] of TABLE) {
    it(`${name} (${platform})`, () => {
      expect(hook.capturesSession(cwd, workspace, platform), "the Claude hook's answer").toBe(want);
      expect(codexCwdInWorkspace(cwd, workspace, platform), "the Codex watcher's answer").toBe(want);
    });
  }
});

// The demonstration in the report, as a decision each deck makes about itself:
// one machine-wide deck on 4317, one scoped deck on 4318, one session inside the
// scoped tree. Both decks capture it — on both paths. The Claude half used to
// answer [4318] alone.
describe("which decks a session inside a scoped tree reaches", () => {
  const decks = [
    { port: 4317, workspace: "" },
    { port: 4318, workspace: "/Users/x/proj" },
    { port: 4319, workspace: "/Users/x/other" },
  ];
  const reached = (decide: (cwd: string, ws: string) => boolean) =>
    decks.filter(d => decide("/Users/x/proj/sub", d.workspace)).map(d => d.port);

  it("reaches the machine-wide deck and the scoped one, on both paths", () => {
    const claude = reached((cwd, ws) => hook.capturesSession(cwd, ws, "linux"));
    const codex = reached((cwd, ws) => codexCwdInWorkspace(cwd, ws, "linux"));
    expect(claude).toEqual([4317, 4318]);
    expect(codex).toEqual(claude);
  });
});

// ── the path the user typed ──────────────────────────────────────────────────

describe("the canonical spelling of the flag", () => {
  it("leaves an unscoped deck unscoped, whitespace and all", () => {
    // Every reader of this value spells machine-wide as the empty string, and
    // resolve(" ") is a real directory name — a deck that asked for no scope
    // must not come back scoped to one.
    expect(canonicalWorkspace("")).toBe("");
    expect(canonicalWorkspace("   ")).toBe("");
    expect(canonicalWorkspace(undefined)).toBe("");
    expect(canonicalWorkspace(null)).toBe("");
  });

  it("resolves a relative path against the process the flag was typed in", () => {
    // The whole point of resolving it here: this is the only process whose cwd
    // is the shell the user ran the deck from. The hook's is the agent's.
    const relative = "ccdeck-relative-workspace-that-does-not-exist";
    expect(canonicalWorkspace(relative)).toBe(join(process.cwd(), relative));
    expect(canonicalWorkspace(join(".", relative))).toBe(join(process.cwd(), relative));
  });

  it("drops a trailing separator, so one directory has one spelling", () => {
    const dir = join(SANDBOX, "trailing");
    mkdirSync(dir, { recursive: true });
    expect(canonicalWorkspace(dir + sep)).toBe(realpathSync(dir));
  });

  it("resolves symlinks, because the cwd a session reports has none", () => {
    // Both providers report a cwd that came from getcwd(), which is fully
    // resolved. On a Mac /tmp is a symlink to /private/tmp, so a workspace left
    // unresolved matches nothing that runs inside it.
    const real = join(SANDBOX, "real-tree");
    mkdirSync(join(real, "proj"), { recursive: true });
    const link = join(SANDBOX, "linked-tree");
    // "junction" is the one directory link Windows creates without elevation;
    // POSIX ignores the type argument entirely.
    symlinkSync(real, link, "junction");

    const viaLink = canonicalWorkspace(join(link, "proj"));
    expect(viaLink).toBe(realpathSync(join(real, "proj")));
    // And the session running inside it is captured by both paths.
    const cwd = realpathSync(join(real, "proj"));
    expect(hook.capturesSession(cwd, viaLink)).toBe(true);
    expect(codexCwdInWorkspace(cwd, viaLink)).toBe(true);
  });

  it("keeps a directory that does not exist yet", () => {
    // Scoping a deck to a tree you are about to create is not an error, and the
    // resolved form is still the right thing to compare against.
    const missing = join(SANDBOX, "not-created", "sub");
    expect(canonicalWorkspace(missing)).toBe(missing);
  });

  it("is idempotent, so a second pass over it changes nothing", () => {
    const once = canonicalWorkspace(join(SANDBOX, "real-tree"));
    expect(canonicalWorkspace(once)).toBe(once);
  });
});

// bin/deck.js boots a server and refuses to start without a built UI, so it
// cannot be run from here; what is checkable — and what the bug actually was —
// is whether the flag reaches the discovery file as the user typed it or as the
// one spelling both capture paths compare against.
describe("the flag as bin/deck.js publishes it", () => {
  const deck = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
  const code = deck.split("\n").filter(l => !l.trimStart().startsWith("//"));

  it("hands startServer and the discovery file the canonical path", () => {
    expect(code.some(l => /const workspace = canonicalWorkspace\(/.test(l))).toBe(true);
  });

  it("never binds the raw flag to the name the rest of the file uses", () => {
    // The exact shape that shipped: `const workspace = flags.workspace ...`,
    // which put a relative path into the discovery file for the hook to resolve
    // in the wrong process.
    expect(code.filter(l => /const workspace\b/.test(l) && /flags\./.test(l))).toEqual([]);
  });
});

// ── the whole thing, running ─────────────────────────────────────────────────

type Seen = { method: string; path: string; body: string };

/** A listener standing in for a deck, plus a log of everything it was told. */
async function deckListener() {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", body: "" };
    seen.push(entry);
    req.on("data", c => { entry.body += c; });
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  return { seen, port, close };
}

/** Run the installed-shape hook against a discovery dir of our own. */
async function runHook(decks: Array<Record<string, unknown>>, event: Record<string, unknown>) {
  const home = mkdtempSync(join(SANDBOX, "hook-home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  // No token in any of these records, so the hook posts without the challenge
  // round trip — the handshake is pinned in hook-handshake.test.ts and what is
  // under test here is which decks are posted to at all.
  decks.forEach((d, i) => writeFileSync(join(dir, `deck-${i}.json`), JSON.stringify(d), "utf8"));

  const child = spawn(process.execPath, [HOOK_COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify(event));
  await new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("exit", () => done());
  });
}

describe("a Claude session inside a tree one of the running decks is scoped to", () => {
  it("is delivered to that deck AND to the machine-wide one, logged once", async () => {
    // The reported shape: two decks that both match, sharing one events log.
    // Before the fix the machine-wide deck was handed nothing at all, because
    // the scoped deck's workspace was the longer string.
    const proj = join(SANDBOX, "delivered", "proj");
    mkdirSync(join(proj, "sub"), { recursive: true });
    const log = join(SANDBOX, "delivered", "events.jsonl");

    const wide = await deckListener();
    const scoped = await deckListener();
    const elsewhere = await deckListener();
    try {
      await runHook([
        { pid: process.pid, port: wide.port, workspace: "", persist: log },
        { pid: process.pid, port: scoped.port, workspace: canonicalWorkspace(proj), persist: log },
        { pid: process.pid, port: elsewhere.port, workspace: canonicalWorkspace(join(SANDBOX, "delivered", "other")), persist: log },
      ], {
        hook_event_name: "UserPromptSubmit",
        prompt: "hello from inside the scoped tree",
        cwd: join(proj, "sub"),
      });
    } finally {
      await Promise.all([wide.close(), scoped.close(), elsewhere.close()]);
    }

    const posts = (d: { seen: Seen[] }) => d.seen.filter(s => s.method === "POST");
    expect(posts(wide), "the machine-wide deck never saw the session").toHaveLength(1);
    expect(posts(scoped), "the scoped deck never saw the session").toHaveLength(1);
    expect(posts(elsewhere), "a deck scoped elsewhere was posted to anyway").toHaveLength(0);

    // Both drew it; exactly one of them was asked to record it. The election is
    // by lowest port, and these are whatever the OS handed out.
    const writer = wide.port < scoped.port ? wide : scoped;
    const reader = wide.port < scoped.port ? scoped : wide;
    expect(posts(writer)[0].path).toBe("/api/event");
    expect(posts(reader)[0].path).toBe("/api/event?persist=0");

    // And it is the session's own event that arrived, tagged with its provider.
    expect(JSON.parse(posts(wide)[0].body)).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "hello from inside the scoped tree",
      provider: "claude",
    });
  }, 20_000);

  it("reaches a deck scoped to it through a relative path, from the deck's own cwd", async () => {
    // `ccdeck --workspace ./proj`, started in a directory that is not the
    // agent's. The canonical form is what goes in the discovery file, so the
    // hook compares against the tree the user meant rather than resolving the
    // string a second time in the agent's process.
    const root = join(SANDBOX, "relative");
    mkdirSync(join(root, "proj", "sub"), { recursive: true });
    const asTyped = join(root, ".", "proj");

    const deck = await deckListener();
    try {
      await runHook(
        [{ pid: process.pid, port: deck.port, workspace: canonicalWorkspace(asTyped), persist: null }],
        { hook_event_name: "UserPromptSubmit", prompt: "relative", cwd: join(root, "proj", "sub") },
      );
    } finally {
      await deck.close();
    }

    expect(deck.seen.filter(s => s.method === "POST")).toHaveLength(1);
  }, 20_000);
});
