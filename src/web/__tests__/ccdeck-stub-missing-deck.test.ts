// What `npx ccdeck` says when it cannot find the deck it exists to launch.
//
// The stub probes two paths and then falls back to node's own resolution, and
// that last line was unguarded. When nothing answers — a half-removed install, a
// linked workspace, Yarn PnP without agents-deck in scope — MODULE_NOT_FOUND
// escaped as an uncaught error and the user got eight frames of node's CJS
// loader before a single line of the deck. Measured before the fix: exit 1,
// eight `at ` frames, and the word "ccdeck" appearing only as a file path inside
// the stack. That is the same failure shape 0075d57 was written to eliminate,
// arriving through a different API.
//
// A launcher that cannot find its own deck knows exactly what is wrong and can
// say it in a sentence, so what is pinned here is the sentence, the absence of a
// stack — and the line between the two failures that look alike from the outside.
// "There is no deck here" is a sentence. "The deck is here and it threw" is a bug
// in the deck, and swallowing its stack would be hiding the only thing that could
// explain it.
//
// Each case builds its own layout in a temp directory and runs the shipped file
// unmodified. Nothing is installed and no npx runs.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-stub-missing-deck-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
// The environment travels into the spawned stub, and HOME matters twice over
// here: node's last-resort resolution also looks in $HOME/.node_modules and
// $HOME/.node_libraries, and a developer with agents-deck in either would
// otherwise watch this file find a deck it is trying to do without.
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
 * Writes a layout the stub cannot get a deck out of, and returns the stub.
 *
 * `none` is the install that lost its dependency: the stub, alone, with nothing
 * named agents-deck anywhere above it. `gutted` is the half-written one — the
 * package is there and its package.json answers the probe, but the file the stub
 * imports out of it is not. `broken` is neither: the deck is whole and its
 * supervisor throws while it evaluates, which is a bug rather than an absence.
 */
function layout(shape: "none" | "gutted" | "broken"): string {
  const root = mkdtempSync(join(SANDBOX, `${shape}-`));
  const modules = join(root, "node_modules");
  const stubDir = join(modules, "ccdeck");
  const deckDir = join(modules, "agents-deck");

  // Every path is derived, and one wrong join would have this file writing into
  // the developer's own tree.
  for (const p of [stubDir, deckDir]) {
    if (!p.startsWith(SANDBOX)) throw new Error(`refusing to run: ${p} is outside ${SANDBOX}`);
  }

  mkdirSync(join(stubDir, "bin"), { recursive: true });
  // Without `type: module` node reads the stub's .js as CommonJS and its import
  // statements are a syntax error — the published ccdeck declares it.
  writeFileSync(join(stubDir, "package.json"), JSON.stringify({ name: "ccdeck", version: "0.0.0", type: "module" }));

  if (shape !== "none") {
    mkdirSync(join(deckDir, "src", "server"), { recursive: true });
    writeFileSync(join(deckDir, "package.json"), JSON.stringify({ name: "agents-deck", version: "0.0.0", type: "module" }));
    if (shape === "broken") {
      writeFileSync(join(deckDir, "src", "server", "supervisor.mjs"), `throw new Error("the deck itself is broken");\n`);
    }
  }

  const stub = join(stubDir, "bin", "ccdeck.js");
  copyFileSync(SHIPPED, stub);
  return stub;
}

const run = (stub: string) =>
  new Promise<{ code: number | null; err: string }>((resolve) => {
    const child = spawn(process.execPath, [stub], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => resolve({ code, err }));
  });

describe("a ccdeck with no agents-deck to launch", () => {
  it("says what is wrong instead of throwing node's resolution stack", async () => {
    const got = await run(layout("none"));
    expect(got.code, "a launcher that never launched must not report success").toBe(1);
    expect(got.err).toMatch(/could not find the agents-deck install/);
    // The regression, stated the way a user meets it: a stack frame is the shape
    // of an unhandled crash, and this is a handled, explainable failure.
    expect(got.err, "the user is reading a stack trace again").not.toMatch(/^\s+at /m);
    expect(got.err).not.toMatch(/MODULE_NOT_FOUND/);
  }, 30_000);

  it("names both places it looked, so the reply to a bug report is already there", async () => {
    const got = await run(layout("none"));
    // The two layouts npm produces are the whole of the stub's search, and which
    // one a broken install was supposed to be is the first thing anybody asks.
    expect(got.err).toMatch(/ccdeck[\\/]node_modules[\\/]agents-deck/);
    expect(got.err).toMatch(/node_modules[\\/]agents-deck/);
    // And what to do about it, in the two forms the deck is ever started.
    expect(got.err).toMatch(/npm i -g ccdeck/);
    expect(got.err).toMatch(/npx agents-deck/);
  }, 30_000);

  it("answers the same way when the package is there but its supervisor is not", async () => {
    // A truncated or partly written install resolves the path probe and then
    // fails on the import, which used to be its own uncaught stack a line later.
    const got = await run(layout("gutted"));
    expect(got.code).toBe(1);
    expect(got.err).toMatch(/could not find the agents-deck install/);
    expect(got.err).not.toMatch(/^\s+at /m);
  }, 30_000);
});

describe("a ccdeck whose agents-deck is present and broken", () => {
  it("keeps the stack, because that failure is not a missing install", async () => {
    // The guard is by error code, not by position, so a supervisor that throws
    // while it evaluates still arrives whole. Reporting it as "reinstall ccdeck"
    // would send somebody after an install that is already correct.
    const got = await run(layout("broken"));
    expect(got.code).not.toBe(0);
    expect(got.err).toMatch(/the deck itself is broken/);
    expect(got.err, "a real crash lost its stack to the friendly message").toMatch(/^\s+at /m);
    expect(got.err).not.toMatch(/could not find the agents-deck install/);
  }, 30_000);
});
