// The detail panel's empty state told everyone the deck "is in `--all` mode and
// listens to every workspace". `--all` is parsed in bin/deck.js and never read
// again — the line that parses it calls it a legacy no-op — so the copy named a
// flag with no behaviour behind it; and for anyone who started the deck with
// `--workspace <path>` or `--scope` it was false, because that really does
// restrict capture. The one sentence a user sees when nothing shows up ruled
// out the actual cause and pointed them at settings.json and their hooks.
//
// It could not have done better: the scope was known to the launcher (printed
// at startup) and to the hook (read from the discovery file), and to no HTTP
// response at all, so the browser had nothing to be right with. Two halves are
// pinned here — that /api/health now reports the workspace it was started with,
// and that each of the three answers it can give produces copy that is true.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { get, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyScope } from "../scope";

// Set before the server module is imported: it resolves the Claude config dir
// on the way in, and a sandbox that arrived late would have this file sweeping
// discovery files out of the real ~/.claude.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-scope-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");

// Refuse to run at all if the sandbox did not take: startServer sweeps and
// writes inside whatever this resolves to.
const resolved = String(claudeConfigDir());
if (!resolved.startsWith(DIR)) {
  throw new Error(`refusing to run: claude config dir resolved to ${resolved}, outside ${DIR}`);
}

const servers: Server[] = [];

afterAll(async () => {
  for (const s of servers) {
    await new Promise<void>(done => { s.closeAllConnections?.(); s.close(() => done()); });
  }
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

/** Start a deck with the given scope and ask it what it thinks that scope is. */
async function healthWorkspace(workspace: string | undefined): Promise<unknown> {
  const server: Server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false, workspace });
  servers.push(server);
  const { port } = server.address() as { port: number };
  const body = await new Promise<string>((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/api/health" }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => resolve(out));
    }).on("error", reject);
  });
  return JSON.parse(body).workspace;
}

describe("the scope a deck was started with", () => {
  it("is reported by /api/health as an empty string when the deck watches the whole machine", async () => {
    expect(await healthWorkspace(undefined)).toBe("");
  });

  it("is reported by /api/health as the path when the deck was scoped to one tree", async () => {
    // A path shape both POSIX and Windows accept as a string; nothing here
    // touches the filesystem with it, and the server must not rewrite it.
    const scope = join(DIR, "projects", "one");
    expect(await healthWorkspace(scope)).toBe(scope);
  });
});

describe("the empty detail panel", () => {
  it("never mentions the dead --all flag again, whatever the scope turns out to be", () => {
    for (const workspace of [null, "", "/srv/work"]) {
      const scope = emptyScope(workspace);
      expect(scope.lead + scope.tail).not.toContain("--all");
    }
  });

  it("claims machine-wide coverage only when the deck really is unscoped", () => {
    const scope = emptyScope("");
    expect(scope.kind).toBe("machine");
    expect(scope.lead).toContain("anywhere on this machine");
    expect(scope.workspace).toBeNull();
  });

  it("names the tree a scoped deck is restricted to, and how to widen it", () => {
    const scope = emptyScope("/srv/work");
    expect(scope.kind).toBe("scoped");
    expect(scope.workspace).toBe("/srv/work");
    expect(scope.lead).toContain("only captures sessions running under");
    expect(scope.tail).toContain("--workspace/--scope");
  });

  it("keeps a Windows path intact rather than normalising it into something the user never typed", () => {
    expect(emptyScope("C:\\Users\\Ada\\proj").workspace).toBe("C:\\Users\\Ada\\proj");
  });

  it("says nothing about coverage while the scope is still unknown", () => {
    // What an older server — or the render before the health request lands —
    // produces. Guessing here is how the --all sentence got written.
    const scope = emptyScope(null);
    expect(scope.kind).toBe("unknown");
    expect(scope.workspace).toBeNull();
    expect(scope.lead).not.toContain("every workspace");
    expect(scope.lead).not.toContain("this machine");
  });

  it("treats a scope of whitespace as no scope, since it restricts nothing", () => {
    expect(emptyScope("   ").kind).toBe("machine");
  });
});
