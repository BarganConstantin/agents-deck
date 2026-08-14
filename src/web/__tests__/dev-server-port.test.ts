// `node src/server/index.mjs` — the dev entry point behind `npm run dev:server`
// — took its port from CCGRAPH_PORT, a name left over from the project's first
// identity two renames ago (ccgraph → agent-dag → agents-deck). It is written
// down nowhere, so the one port variable that is documented, AGENT_DAG_PORT,
// was silently ignored on exactly the path a contributor reaches for first
// (#256). Nothing shipped is affected: the binaries go through bin/deck.js.
//
// The check has to be a real launch. The port is read inside the
// `import.meta.url === argv[1]` guard, which by construction never runs when
// the module is imported, so importing it would test nothing at all.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../server/index.mjs", import.meta.url));

// The child is a whole server: it sweeps a discovery dir, watches for Codex
// rollout files and reads the claude-swap store. Every one of those paths is
// pointed at a temp directory, and the install/update switches are off, so it
// touches nothing of the user's and reaches no network.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-dev-home-"));
const children: ChildProcess[] = [];

afterAll(() => {
  for (const child of children) child.kill();
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

/** A port nothing is listening on, found by listening on it and stopping. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(res => probe.listen(0, "127.0.0.1", res));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(res => probe.close(() => res()));
  return port;
}

/** Start the dev entry point and answer with the port it says it bound. */
function devServerPort(env: Record<string, string>): Promise<number> {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      HOME: FAKE_HOME,
      USERPROFILE: FAKE_HOME,
      CLAUDE_CONFIG_DIR: join(FAKE_HOME, ".claude"),
      CODEX_HOME: join(FAKE_HOME, ".codex"),
      CLAUDE_SWAP_BACKUP: join(FAKE_HOME, "swap-store"),
      AGENTS_DECK_NO_INSTALL: "1",
      AGENTS_DECK_NO_UPDATE_CHECK: "1",
      AGENTS_DECK_NO_DOWNLOAD: "1",
      AGENTS_DECK_NO_FRESHEN: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  return new Promise<number>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk; });
    child.on("exit", code => reject(new Error(`dev server exited ${code}: ${err || out}`)));
    child.on("error", reject);
  });
}

describe("the dev entry point's port", () => {
  it("comes from AGENT_DAG_PORT, the variable the CLI and the README use", async () => {
    const wanted = await freePort();
    expect(await devServerPort({ AGENT_DAG_PORT: String(wanted) })).toBe(wanted);
  }, 30_000);

  it("ignores CCGRAPH_PORT, which nothing has documented for two renames", async () => {
    const wanted = await freePort();
    const stale = await freePort();
    const bound = await devServerPort({
      AGENT_DAG_PORT: String(wanted),
      CCGRAPH_PORT: String(stale),
    });
    expect(bound).not.toBe(stale);
    expect(bound).toBe(wanted);
  }, 30_000);
});
