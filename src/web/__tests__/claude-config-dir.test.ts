// Reported: the hook installer hardcoded ~/.claude while Claude Code honours
// CLAUDE_CONFIG_DIR, which relocates that directory wholesale rather than
// overlaying it. A user with the variable set got a successful install into a
// settings.json Claude Code never opens: no hook ever fired, the deck stayed
// empty, and nothing anywhere said why. These tests pin the whole chain — the
// settings file, the installed forwarder, the discovery dir, and hook.js's own
// resolution of that dir, which has to agree with the installer or the events
// never find the server.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two separate temp directories: the home the process thinks it has, and the
// config dir the override points at. Keeping them apart is what lets the tests
// below tell "wrote to the right place" from "wrote to ~/.claude and got lucky".
// Both are set BEFORE the installer is imported, since it resolves the path once
// at module load, and $HOME / %USERPROFILE% cover POSIX and Windows alike — so
// nothing here can reach the developer's own config dir on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-config-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCodexHome = process.env.CODEX_HOME;
const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
delete process.env.CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const { installHooks, CLAUDE_DIR, AGENT_DAG_DIR } = await import("../../server/installer.mjs");

// Belt and braces: if the override were ignored the installer would resolve
// somewhere under FAKE_HOME, and on a machine where the developer has
// CLAUDE_CONFIG_DIR set for real, their own settings.json. Fail before a single
// test gets the chance to write.
if (!String(CLAUDE_DIR).startsWith(FAKE_CONFIG)) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${FAKE_CONFIG}`);
}

const SETTINGS = join(FAKE_CONFIG, "settings.json");

const restore = (
  key: "HOME" | "USERPROFILE" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
  was: string | undefined,
) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("CODEX_HOME", prevCodexHome);
  restore("CLAUDE_CONFIG_DIR", prevClaudeConfigDir);
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(FAKE_CONFIG, { recursive: true, force: true });
});

describe("installHooks with CLAUDE_CONFIG_DIR set", () => {
  it("registers the hooks in the settings.json Claude Code actually reads", async () => {
    const res = await installHooks({ provider: "claude" });
    expect(res.settingsPath).toBe(SETTINGS);
    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.hooks.SessionStart).toHaveLength(1);
  });

  it("writes nothing into ~/.claude, which on such a machine is not read at all", () => {
    expect(existsSync(join(FAKE_HOME, ".claude"))).toBe(false);
  });

  it("puts the forwarder and the discovery dir under the override too", () => {
    expect(String(AGENT_DAG_DIR)).toBe(join(FAKE_CONFIG, "agent-dag"));
    expect(existsSync(AGENT_DAG_DIR)).toBe(true);
    const command = JSON.parse(readFileSync(SETTINGS, "utf8")).hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain(join(FAKE_CONFIG, "agent-dag", "hook.js"));
  });
});

describe("hook.js discovery under CLAUDE_CONFIG_DIR", () => {
  // The other half of the contract. The installer registers the deck in
  // $CLAUDE_CONFIG_DIR/agent-dag; if hook.js still looked in ~/.claude/agent-dag
  // it would find no server and drop every event on the floor, silently — which
  // is exactly the failure this issue described.
  //
  // The copy under the config dir is the one that runs, not hook/hook.js in the
  // repo: the package is "type": "module", so the CommonJS forwarder is only a
  // CommonJS file once installed out of the package tree, which is how the host
  // CLI always invokes it.
  it("posts the event to the server registered under the override", async () => {
    const { hookPath } = await installHooks({ provider: "claude" });
    const received: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        try { received.push(JSON.parse(body)); } catch { /* ignore */ }
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;

    mkdirSync(AGENT_DAG_DIR, { recursive: true });
    // Our own pid, so hook.js's liveness check keeps the entry instead of
    // sweeping it. An empty workspace matches any cwd.
    writeFileSync(
      join(AGENT_DAG_DIR, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, port, workspace: "", startedAt: new Date().toISOString() }),
      "utf8",
    );

    try {
      const child = spawn(process.execPath, [hookPath, "--provider", "claude"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: FAKE_CONFIG, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.end(JSON.stringify({ cwd: process.cwd(), hook_event_name: "SessionStart" }));
      await new Promise<void>((done, fail) => {
        child.on("error", fail);
        child.on("exit", () => done());
      });
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ hook_event_name: "SessionStart", provider: "claude" });
  }, 10_000);
});
