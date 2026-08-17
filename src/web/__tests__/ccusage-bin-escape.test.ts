// ccusage's own package.json chose which file the deck executes.
//
// resolveEntry reads `bin` out of ~/.agents-deck/ccusage/node_modules/ccusage/
// package.json, joins it onto PKG_DIR and hands the result to
// `spawn(process.execPath, [entry, ...args])`. `path.join` walks `..` happily,
// so a `bin` of "../../../evil.js" names a file OUTSIDE the managed install —
// and existsSync, the only check there was, answers yes for exactly the case
// that matters, because whoever put the file there put it there.
//
// Narrow on its own: a package that can set `bin` can also ship an install
// script. What the containment check closes is the half where only the file is
// influenced — a tampered or half-written package.json in a cache directory the
// deck rewrites on a schedule — and it is one comparison.
//
// Nothing here downloads or runs anything: the package.json is written into a
// temp directory that stands in for the real cache dir.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// PKG_DIR is derived from os.homedir() at module load, so the home is moved
// before the import and every path below lives under it.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-bin-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
if (!resolve(DIR).startsWith(resolve(tmpdir()))) throw new Error("sandbox escaped");

const PKG_DIR = join(DIR, ".agents-deck", "ccusage", "node_modules", "ccusage");
mkdirSync(join(PKG_DIR, "src"), { recursive: true });
// The file a hostile `bin` would aim at: outside PKG_DIR, and present, so
// existsSync cannot be what saves us.
writeFileSync(join(DIR, ".agents-deck", "evil.js"), "// nothing runs this\n");

const pkg = (bin: unknown) =>
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ name: "ccusage", version: "1.2.3", bin }));

// Nothing may be spawned by importing or exercising this module.
vi.mock("node:child_process", () => ({
  spawn: () => { throw new Error("test: spawn blocked"); },
  spawnSync: () => { throw new Error("test: spawnSync blocked"); },
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// @ts-expect-error — plain JS module, no types
const { resolveEntry } = await import("../../server/ccusage.mjs");

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => { writeFileSync(join(PKG_DIR, "src", "cli.js"), "// stand-in\n"); });

describe("resolveEntry", () => {
  it("accepts the entry the real package declares", () => {
    pkg("./src/cli.js");
    expect(resolveEntry()).toEqual({ entry: join(PKG_DIR, "src", "cli.js"), version: "1.2.3" });
    // The map form npm also allows.
    pkg({ ccusage: "./src/cli.js" });
    expect(resolveEntry()?.entry).toBe(join(PKG_DIR, "src", "cli.js"));
  });

  it("refuses a bin that walks out of the install", () => {
    for (const bin of [
      "../../evil.js",
      "../../../.agents-deck/evil.js",
      "./src/../../../evil.js",
      "..",
      "../",
    ]) {
      pkg(bin);
      expect(resolveEntry(), bin).toBeNull();
    }
  });

  it("refuses an absolute bin, which join would have re-rooted and accepted", () => {
    // `path.join(PKG_DIR, "/x")` is `PKG_DIR/x` — the escape does not even look
    // like one. path.resolve measures the absolute path as the absolute path it
    // is, which is why the check uses it.
    pkg(join(DIR, ".agents-deck", "evil.js"));
    expect(resolveEntry()).toBeNull();
    pkg({ ccusage: "/etc/passwd" });
    expect(resolveEntry()).toBeNull();
  });

  it("refuses PKG_DIR itself, which is a directory and no kind of entry point", () => {
    pkg(".");
    expect(resolveEntry()).toBeNull();
  });

  it("still answers null for the ordinary reasons", () => {
    pkg(undefined);
    expect(resolveEntry()).toBeNull();
    pkg(42);
    expect(resolveEntry()).toBeNull();
    // Contained, but not there.
    pkg("./src/not-shipped.js");
    expect(resolveEntry()).toBeNull();
    writeFileSync(join(PKG_DIR, "package.json"), "{ not json");
    expect(resolveEntry()).toBeNull();
  });
});
