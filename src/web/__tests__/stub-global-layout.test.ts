// `npm i -g ccdeck` was dead on arrival, and npx was the only shape anybody
// tested.
//
// The stub ships nothing but bin/, so it walks out of its own directory to find
// the deck. It walked exactly one way — `../../agents-deck` — which is right
// under npx, where npm installs the stub and its dependency as siblings in
// `_npx/<hash>/node_modules/`. It is wrong under a global install: npm stopped
// hoisting a global package's dependencies in v7, so the deck lands at
// `lib/node_modules/ccdeck/node_modules/agents-deck` while the stub looks at
// `lib/node_modules/agents-deck`, which does not exist. Installing the published
// 1.33.142 that way and running it gives ERR_MODULE_NOT_FOUND before the deck
// prints a single line — so the one command the README, the banner and every
// in-app surface tell people to run has never worked on a global install.
//
// This builds BOTH layouts on disk and runs the shipped file unmodified in each,
// because a test that builds only the layout the code already handled is what
// let this ship. The fake deck is two lines; nothing is installed and no npx
// runs.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "stub-global-layout-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
// The stub spawns a real Node process that inherits this environment, so every
// home the deck knows about points into the sandbox first — POSIX and Windows.
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

const SHIPPED = fileURLToPath(new URL("../../../ccdeck/bin/ccdeck.js", import.meta.url));

/**
 * Writes one npm layout under `root` and returns the stub to run.
 *
 * `sibling` is what npx produces — stub and deck side by side. `nested` is what
 * `npm i -g` produces on npm >= 7 — the deck inside the stub's own
 * node_modules. Same two packages either way; only where npm put them differs,
 * and that difference is the whole bug.
 */
function layout(root: string, shape: "sibling" | "nested"): string {
  const modules = join(root, "node_modules");
  const stubDir = join(modules, "ccdeck");
  const deckDir = shape === "sibling"
    ? join(modules, "agents-deck")
    : join(stubDir, "node_modules", "agents-deck");

  // Every path is derived, and one wrong join would have this file spawning
  // scripts out of the developer's own tree.
  for (const p of [stubDir, deckDir]) {
    if (!p.startsWith(SANDBOX)) throw new Error(`refusing to run: ${p} is outside ${SANDBOX}`);
  }

  for (const [dir, name] of [[stubDir, "ccdeck"], [deckDir, "agents-deck"]] as const) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    // Without `type: module` node reads the stub's .js as CommonJS and its
    // import statements are a syntax error — the published ccdeck declares it.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
  }
  mkdirSync(join(deckDir, "src", "server"), { recursive: true });

  const stub = join(stubDir, "bin", "ccdeck.js");
  copyFileSync(SHIPPED, stub);
  // Re-export rather than copy, so what runs is the supervisor that ships.
  writeFileSync(
    join(deckDir, "src", "server", "supervisor.mjs"),
    `export * from ${JSON.stringify(new URL("../../server/supervisor.mjs", import.meta.url).href)};\n`,
  );
  // Stands in for bin/agent-dag.js: prints where it was loaded from, then exits
  // with whatever it was asked for.
  writeFileSync(join(deckDir, "bin", "agent-dag.js"), [
    `console.log(import.meta.dirname);`,
    `process.exit(Number(process.argv[2] ?? 0));`,
  ].join("\n"));
  return stub;
}

const run = (stub: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [stub, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("exit", code => resolve({ code, out: out.trim(), err }));
  });

describe("the layouts npm actually produces", () => {
  it("finds the deck when npm nested it, which is every global install", async () => {
    // The reported failure: ERR_MODULE_NOT_FOUND before the deck prints a line.
    const stub = layout(mkdtempSync(join(SANDBOX, "nested-")), "nested");
    const got = await run(stub, "0");
    expect(got.err, "the stub could not reach the deck npm installed for it").not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(got.code).toBe(0);
    expect(got.out, "handed off to a deck outside its own node_modules")
      .toMatch(/[\\/]ccdeck[\\/]node_modules[\\/]agents-deck[\\/]bin$/);
  });

  it("still finds the deck when npm put it alongside, which is every npx run", async () => {
    // The layout that always worked. It has to keep working: npx is where the
    // installs are, and a fix that traded one layout for the other is no fix.
    const stub = layout(mkdtempSync(join(SANDBOX, "sibling-")), "sibling");
    const got = await run(stub, "0");
    expect(got.err).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(got.code).toBe(0);
    expect(got.out).toMatch(/[\\/]node_modules[\\/]agents-deck[\\/]bin$/);
    expect(got.out).not.toMatch(/ccdeck/);
  });

  it("hands the deck's own exit code back in either layout", async () => {
    // The handoff is the stub's whole job; finding the deck is only how it
    // starts. Checked in both shapes so a layout fix cannot quietly break it.
    for (const shape of ["nested", "sibling"] as const) {
      const stub = layout(mkdtempSync(join(SANDBOX, `${shape}-code-`)), shape);
      expect((await run(stub, "3")).code, `${shape} lost the deck's verdict`).toBe(3);
    }
  });
});

describe("the resolution rule itself", () => {
  const src = SHIPPED;
  it("prefers a path but does not depend on one, so a layout nobody predicted still boots", async () => {
    // pnpm's store, a workspace, and whatever npm does next are all layouts this
    // file cannot enumerate. Paths answer first — that keeps the guarantee the
    // header makes about never resolving to a second copy — and node's own
    // resolution is the floor under them rather than the first choice.
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(src, "utf8");
    expect(text).toMatch(/createRequire/);
    expect(text.indexOf("../node_modules/agents-deck"), "the nested layout must be tried")
      .toBeGreaterThan(-1);
    expect(text.indexOf("../../agents-deck"), "the sibling layout must be tried")
      .toBeGreaterThan(-1);
  });
});
