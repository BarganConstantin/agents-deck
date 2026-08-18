// #450. A Windows user started the deck with `npx ccdeck`, opened Usage history
// and was told that npm/npx on their machine was damaged and to reinstall Node.
// Their npm was not damaged: `npx ccdeck` had just succeeded, and `npm i -g
// ccdeck` installed twelve packages cleanly on the same machine minutes later.
// The remedy cost them an hour and could not have worked.
//
// The bug is in the discriminator #432 shipped. It asked whether the failing
// text mentions "npm" or "npx" ANYWHERE, which reads like a test for "this is
// about the user's npm installation" and is not one, because npx runs every
// package it fetches out of a directory named after npm:
//
//   Windows  C:\Users\u\AppData\Local\npm-cache\_npx\<hash>\node_modules\ccusage
//   POSIX    /Users/u/.npm/_npx/<hash>/node_modules/ccusage
//
// `\bnpm\b` matches the `npm` in `npm-cache` and the one in `.npm` exactly as
// well as the one in `node_modules\npm\bin`, because `-` and `.` are word
// boundaries. So on the npx fallback branch — the branch a machine with no
// managed install always takes — the predicate collapsed into "did Node fail to
// resolve a module", and every such failure was reported as a damaged npm.
//
// These pin the corrected discriminator (which FILE Node could not load, the
// same question npxFailureHint in npx.mjs already asks), and pin that no shape
// the deck itself created can be answered with a claim about the user's machine.
import { describe, it, expect } from "vitest";
import { CCUSAGE_REASONS, explainCcusageFailure } from "../admin-failure";

const said = (error: string) => explainCcusageFailure({ reason: "run_failed", error }, "fallback");

/** A Node stack for a file it could not load, in the CommonJS shape the npm and
 *  npx shims die in. Written with the real `\r\n` a Windows child emits. */
const cjsStack = (file: string) => [
  "node:internal/modules/cjs/loader:1573",
  "  throw err;",
  "  ^",
  "",
  `Error: Cannot find module '${file}'`,
  "    at Module._resolveFilename (node:internal/modules/cjs/loader:1569:15)",
  "    at Module._load (node:internal/modules/cjs/loader:1179:37)",
  "  code: 'MODULE_NOT_FOUND',",
  "  requireStack: []",
  "}",
  "",
  "Node.js v26.7.0",
].join("\r\n");

/** The ESM shape, which is how a package that unpacked incompletely fails —
 *  ccusage's entry point is ESM, so this is what its own dependencies produce. */
const esmStack = (pkg: string, from: string) =>
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${pkg}' imported from ${from}`;

// ── the shapes the deck itself created ──────────────────────────────────────
//
// None of these is evidence about the user's Node, and the deck must not spend
// somebody's afternoon pretending otherwise.

describe("a failure inside a copy of ccusage that npx fetched", () => {
  // Both are a working npx: it resolved the package, downloaded it and ran it.
  // Only the unpacked copy is incomplete.
  const WINDOWS_CACHE = esmStack("zod",
    "C:\\Users\\vceban\\AppData\\Local\\npm-cache\\_npx\\4f2a\\node_modules\\ccusage\\dist\\index.js");
  const POSIX_CACHE = esmStack("zod",
    "/Users/vceban/.npm/_npx/4f2a/node_modules/ccusage/dist/index.js");

  it("does not tell the user their npm is damaged, on either platform", () => {
    for (const text of [WINDOWS_CACHE, POSIX_CACHE]) {
      expect(said(text), text).not.toMatch(/damaged|broken/i);
    }
  });

  it("does not tell the user to reinstall Node, which cannot help here", () => {
    // The sentence #450 is named for. npx demonstrably works in this state —
    // it is the thing that produced the file Node is complaining about.
    for (const text of [WINDOWS_CACHE, POSIX_CACHE]) {
      expect(said(text), text).not.toMatch(/reinstall/i);
    }
  });

  it("names the cache as the thing to clear, since nothing here rewrites it", () => {
    // The managed install repairs itself on the next call; npx's cache does not,
    // so "try again" would re-run the identical broken copy for as long as the
    // cache survives.
    const out = said(WINDOWS_CACHE);
    expect(out).toMatch(/cache/i);
    expect(out).not.toBe(CCUSAGE_REASONS.run_failed);
    expect(out).not.toMatch(/try again/i);
  });
});

describe("a failure inside the deck's own managed install", () => {
  // ~/.agents-deck/ccusage, which ccusage.mjs discards and rebuilds by itself.
  const OURS = esmStack("zod",
    "C:\\Users\\vceban\\.agents-deck\\ccusage\\node_modules\\ccusage\\dist\\index.js");

  it("still says nothing about the user's npm", () => {
    expect(said(OURS)).not.toMatch(/damaged|broken/i);
    expect(said(OURS)).not.toMatch(/reinstall/i);
  });

  it("is left to the reason map, because trying again is what triggers the repair", () => {
    // Not a shrug: discardDamagedInstall throws the copy away on this very
    // failure, so the next call builds a fresh one. This is the one place where
    // "try again" is the instruction rather than an absence of one.
    expect(said(OURS)).toBe(CCUSAGE_REASONS.run_failed);
  });
});

describe("a package under a global prefix that happens to be called npm", () => {
  // %APPDATA%\npm is the default global prefix on Windows, so a globally
  // installed ccusage lives at a path containing `npm` while npm itself is fine.
  const GLOBAL = cjsStack("C:\\Users\\vceban\\AppData\\Roaming\\npm\\node_modules\\ccusage\\src\\cli.js");

  it("is not read as a damaged npm just because the path spells npm", () => {
    expect(said(GLOBAL)).not.toMatch(/damaged|broken/i);
    expect(said(GLOBAL)).not.toMatch(/reinstall/i);
  });
});

// ── the shape that really is about npm's own installation ───────────────────

describe("Node unable to load one of npm's own program files", () => {
  // #432's machine: `%~dp0` inside the shims resolved to the user's home root,
  // so both shims launched and both died on npm's own CLI script.
  const NPX_CLI = cjsStack("C:\\Users\\vceban\\node_modules\\npm\\bin\\npx-cli.js");
  const NPM_PREFIX = cjsStack("C:\\Users\\vceban\\node_modules\\npm\\bin\\npm-prefix.js");
  const POSIX_CLI = cjsStack("/usr/local/lib/node_modules/npm/bin/npx-cli.js");

  it("is still separated from every shape above", () => {
    for (const text of [NPX_CLI, NPM_PREFIX, POSIX_CLI]) {
      expect(said(text), text).not.toBe(CCUSAGE_REASONS.run_failed);
      expect(said(text), text).not.toMatch(/try again/i);
      // And not confused with a machine that has no npx at all, which is a
      // different remedy — this npx was found and it ran.
      expect(said(text), text).not.toMatch(/not on this deck's PATH/);
    }
  });

  it("names what the deck ran and what came back, not a verdict on the machine", () => {
    // The correction #450 asks for. The deck cannot tell a damaged npm from its
    // own spawn reaching the wrong npx — `npx ccdeck` prepends a
    // `node_modules\.bin` for every ancestor of the cwd onto PATH, and
    // fallbackSpec asks cmd.exe for a bare `npx.cmd` — so it must not assert
    // either one.
    const out = said(NPX_CLI);
    expect(out).toMatch(/\bnpx\b/);
    expect(out).toMatch(/could not load/i);
    expect(out).not.toMatch(/reinstall/i);
  });

  it("hands over the check that actually separates the two causes", () => {
    // Something the user can run in thirty seconds, instead of an hour of
    // reinstalling a Node that was never the problem.
    const out = said(NPX_CLI);
    expect(out).toMatch(/where npx|npm config get prefix/);
  });

  it("reads the same whether the shim spelled itself .cmd or not", () => {
    // A shim-relative path can carry the `.cmd` name into the file it names.
    expect(said(cjsStack("C:\\Users\\vceban\\node_modules\\npm\\bin\\npx.cmd-cli.js")))
      .toBe(said(NPX_CLI));
  });
});

// ── the older shapes, which must not be swept up ────────────────────────────

describe("a machine with no npx at all", () => {
  it("keeps the PATH remedy rather than any module-resolution sentence", () => {
    const ABSENT = [
      "/bin/sh: 1: npx: not found",
      "sh: npx: command not found",
      "zsh: command not found: npx",
      "'npx.cmd' is not recognized as an internal or external command,\r\noperable program or batch file.",
      "spawn npx ENOENT",
    ];
    for (const text of ABSENT) {
      expect(said(text), text).toMatch(/PATH/);
      expect(said(text), text).not.toMatch(/cache/i);
      expect(said(text), text).not.toMatch(/reinstall/i);
    }
  });
});

describe("a ccusage that simply exited non-zero", () => {
  it("is not a module-resolution failure and gets none of these sentences", () => {
    expect(said("ccusage exited 3")).toBe(CCUSAGE_REASONS.run_failed);
  });
});
