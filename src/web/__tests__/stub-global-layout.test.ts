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
// This builds ALL THREE layouts on disk and runs the shipped file unmodified in
// each, because a test that builds only the layout the code already handled is
// what let this ship. The fake deck is four lines; nothing is installed and no
// npx runs.
//
// The third one is #378's. The stub tries two relative joins and then falls
// back to node's own resolution, and the two npm layouts each make a join win —
// so the fallback, which is the branch pnpm and workspace users reach and the
// only one they reach, had never executed. It was covered by
// `expect(text).toMatch(/createRequire/)`: a grep proving the line exists. It
// runs here now, in a layout built so neither join can answer, and the fixture
// asserts that premise about itself rather than trusting it.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** A package directory with a `package.json` and a `bin/`. Without
 *  `type: module` node reads the stub's .js as CommonJS and its import
 *  statements are a syntax error — the published ccdeck declares it. */
function pkg(dir: string, name: string): string {
  // Every path is derived, and one wrong join would have this file spawning
  // scripts out of the developer's own tree.
  if (!dir.startsWith(SANDBOX)) throw new Error(`refusing to run: ${dir} is outside ${SANDBOX}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
  return dir;
}

/** A fake agents-deck at `dir`: the shipped supervisor, re-exported so what
 *  runs is the one that ships, and a bin that prints where it was loaded from
 *  and exits with whatever it was asked for. */
function plantDeck(dir: string): string {
  pkg(dir, "agents-deck");
  mkdirSync(join(dir, "src", "server"), { recursive: true });
  writeFileSync(
    join(dir, "src", "server", "supervisor.mjs"),
    `export * from ${JSON.stringify(new URL("../../server/supervisor.mjs", import.meta.url).href)};\n`,
  );
  // `dirname(fileURLToPath(import.meta.url))`, not `import.meta.dirname`
  // (#378). The latter landed in node 20.11 / 21.2 and both package.json files
  // in this repo declare `"node": ">=18"`, where it is `undefined` — so on a
  // supported runtime this fixture printed the string "undefined" and both
  // path assertions below failed for a reason that has nothing to do with the
  // bug under test. It was also the only use of that API anywhere in the repo.
  writeFileSync(join(dir, "bin", "agent-dag.js"), [
    `import { fileURLToPath } from "node:url";`,
    `import { dirname } from "node:path";`,
    `console.log(dirname(fileURLToPath(import.meta.url)));`,
    `process.exit(Number(process.argv[2] ?? 0));`,
  ].join("\n"));
  return dir;
}

/** The shipped stub, copied unmodified into `dir`. Returns the file to run. */
function plantStub(dir: string): string {
  const stub = join(pkg(dir, "ccdeck"), "bin", "ccdeck.js");
  copyFileSync(SHIPPED, stub);
  return stub;
}

/** The deck's bin directory as the deck itself will report it. Through
 *  realpathSync because a temp dir is a symlink on macOS — /var is /private/var
 *  — and the child prints the path node resolved the module at, not the one
 *  this file joined. */
const binOf = (deckDir: string) => join(realpathSync(deckDir), "bin");

/** The two paths the stub joins before it falls back to node's own resolution,
 *  computed here the same way ccdeck.js computes them — so a test can assert
 *  that a fixture really does defeat both rather than merely intending to. */
function probes(stub: string): { nested: string; sibling: string } {
  const dir = dirname(stub);
  return {
    nested: resolve(dir, "../node_modules/agents-deck"),
    sibling: resolve(dir, "../../agents-deck"),
  };
}

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
  const stub = plantStub(join(modules, "ccdeck"));
  plantDeck(shape === "sibling"
    ? join(modules, "agents-deck")
    : join(modules, "ccdeck", "node_modules", "agents-deck"));
  return stub;
}

const run = (stub: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(process.execPath, [stub, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    // `close`, not `exit` (#378). `exit` fires when the process ends; node's
    // own documentation says the stdio streams may still be open at that
    // moment, and `close` is the event that waits for them. It matters more
    // here than in the usual case: the stub spawns agent-dag.js with
    // `stdio: 'inherit'`, so the line these assertions read is written by a
    // GRANDCHILD into a pipe two processes share — the exact shape the docs
    // name. Resolving on `exit` risks an empty `got.out` and a failure whose
    // message points at path resolution rather than at the harness, which is
    // the worst kind of flake because the natural response is to "fix" the
    // stub. Not reproduced on this machine in 400 runs; changed on the
    // documented contract rather than on a reproduction, and it costs nothing.
    child.on("close", code => done({ code, out: out.trim(), err }));
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
  // #378: this whole describe used to be `expect(text).toMatch(/createRequire/)`
  // over the shipped source. Both layouts above make a path probe win, so the
  // third branch — node's own resolution, the ONLY one pnpm and workspace users
  // ever reach (see #359) — had never executed. Measured: pointing that branch
  // at `agents-deck-TYPO/package.json` left all 1849 tests green, because the
  // word `createRequire` was still in the file. A grep proves a line exists; it
  // says nothing about whether the line works.

  it("falls back to node's own resolution for the layouts nobody predicted", async () => {
    // pnpm's store, a workspace, a linked monorepo package: layouts this file
    // cannot enumerate, all of which put the deck somewhere neither relative
    // join reaches. The stub goes at <root>/stub and the deck is reachable only
    // through node's resolution, which starts at the stub's own directory —
    // so `<stub>/bin/node_modules` answers where `../node_modules` and
    // `../../` do not.
    //
    // A real directory rather than a symlink into <root>/store, deliberately.
    // A junction is the privilege-free way to do this on Windows and it would
    // read closer to what pnpm builds, but it is an assumption about an OS
    // nothing in this repo can currently exercise (#376: the suite has no CI
    // job), and the property under test — neither path probe resolves, node's
    // does — is identical either way.
    const root = mkdtempSync(join(SANDBOX, "resolved-"));
    const stub = plantStub(join(root, "stub"));
    const deck = plantDeck(join(root, "stub", "bin", "node_modules", "agents-deck"));

    // The fixture asserts its own premise. Without this, a later refactor of
    // the helpers could quietly move the deck back under a probe and this case
    // would go on passing while testing the branch it was written to escape —
    // which is exactly how the grep it replaces came to mean nothing.
    const probe = probes(stub);
    expect(existsSync(join(probe.nested, "package.json")), "the nested probe answers, so the fallback never runs").toBe(false);
    expect(existsSync(join(probe.sibling, "package.json")), "the sibling probe answers, so the fallback never runs").toBe(false);

    const got = await run(stub, "0");
    expect(got.err, "the stub could not reach a deck only node's resolution can find").not.toMatch(/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/);
    expect(got.err, "the stub gave up and printed its could-not-find message").not.toMatch(/could not find/);
    expect(got.code).toBe(0);
    expect(got.out).toBe(binOf(deck));
  });

  it("hands that deck's exit code back too, like the other two layouts", async () => {
    const root = mkdtempSync(join(SANDBOX, "resolved-code-"));
    const stub = plantStub(join(root, "stub"));
    plantDeck(join(root, "stub", "bin", "node_modules", "agents-deck"));
    expect((await run(stub, "3")).code, "the fallback layout lost the deck's verdict").toBe(3);
  });

  it("still prefers a path when one answers, which is what stops a second copy", async () => {
    // The header's guarantee: the binary to hand off to and the rule for
    // reporting a killed worker must never come out of two different installs.
    // Paths answer first and node's resolution is the floor under them, not the
    // first choice — so with a deck at BOTH the sibling path and a
    // node-resolvable location, the sibling has to win. Asserted by running it,
    // because source order is a claim about a ternary and this is the fact.
    const root = mkdtempSync(join(SANDBOX, "both-"));
    const modules = join(root, "node_modules");
    const stub = plantStub(join(modules, "ccdeck"));
    const wanted = plantDeck(join(modules, "agents-deck"));
    const decoy = plantDeck(join(modules, "ccdeck", "bin", "node_modules", "agents-deck"));

    const got = await run(stub, "0");
    expect(got.code).toBe(0);
    expect(got.out, "node's resolution beat the sibling path the stub joins first").toBe(binOf(wanted));
    expect(got.out).not.toBe(binOf(decoy));
  });
});
