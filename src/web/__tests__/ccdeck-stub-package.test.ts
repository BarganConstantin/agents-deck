// What the npm page for `ccdeck` shows, pinned from the repo.
//
// `ccdeck` is the name the README tells people to run, and the most installed
// of the three the same build goes out under — so its npm page is the front
// door. It was blank: the registry answered "ERROR: No README data found!" and
// the tarball held two entries — package.json and bin/ccdeck.js — so a package
// declaring `"license": "MIT"` shipped without the licence it grants.
//
// The cause was absence, not the `files` allowlist: npm includes README and
// LICENSE in every tarball whatever `files` says, and ccdeck/ simply had
// neither file. Listing them anyway is a statement of intent — the allowlist is
// what keeps the stub to bin/ (#294: it ships no src/ and cannot import from
// it), and a reader of that list should not have to know npm's special cases to
// see that the page has content.
//
// The README here is deliberately the stub's own short page — what the package
// is, how to run it, where the real project is — and not a copy of the root
// README, which is written for the repo and would drift out of sync the first
// time either side was edited alone. The LICENCE is the opposite call: it is
// the same text by definition, so it is copied and pinned byte-for-byte below.
//
// `npm pack --dry-run` is the honest reading of what would ship — the same code
// path npm publish takes to build the tarball. It writes nothing, and
// --offline --ignore-scripts keep it that way: no registry, no build.
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const STUB = join(REPO, "ccdeck");

// Line endings are the one thing a Windows checkout changes under us — every
// comparison here is on text, so normalise once at the door.
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8").replace(/\r\n/g, "\n");

const stubPkg = JSON.parse(read(STUB, "package.json"));

let shipped: string[] = [];

// Awaited rather than run with spawnSync: vitest's workers are threads of one
// process, so a synchronous wait here blocks that process's child-process
// bookkeeping for as long as npm takes — and the files that build and kill real
// process trees (exec-windows.test.ts) started missing their children's deaths
// and failing on a timeout, in one full-suite run out of three.
const packedFiles = () => new Promise<string[]>((resolve, reject) => {
  // npm on Windows is a .cmd shim that spawn cannot launch directly; the
  // arguments are all literals, and the directory travels as cwd rather than on
  // the command line, so shell mode has nothing to mis-split.
  const win = process.platform === "win32";
  const npm = spawn(win ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--offline", "--ignore-scripts"],
    { cwd: STUB, shell: win });
  let out = "", err = "";
  npm.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
  npm.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
  npm.on("error", reject);
  npm.on("close", (code) => {
    if (code !== 0) return reject(new Error(`npm pack failed (${code}): ${err}`));
    // npm can print notices before the JSON on stdout, and the payload is
    // always an array of one entry per packed directory.
    const report = JSON.parse(out.slice(out.indexOf("[")));
    resolve(report[0].files.map((f: { path: string }) => f.path.replace(/\\/g, "/")).sort());
  });
});

beforeAll(async () => {
  shipped = await packedFiles();
  // Packing four small files takes well under a second on its own, but this
  // runs beside ninety-nine other files on whatever machine the suite is on:
  // a busy box waiting on npm's own startup must read as slow, not as broken.
}, 60_000);

describe("the tarball npm would publish as ccdeck", () => {
  it("carries the README that fills the package page", () => {
    expect(shipped).toContain("README.md");
  });

  it("carries the licence text for the licence it declares", () => {
    expect(stubPkg.license).toBe("MIT");
    expect(shipped).toContain("LICENSE");
  });

  it("still ships the launcher and nothing else from the repo", () => {
    // The stub reaches the deck through node_modules, never through this
    // tarball, so anything beyond these four entries is either dead weight or a
    // second copy of code that already ships under agents-deck.
    expect(shipped).toEqual(["LICENSE", "README.md", "bin/ccdeck.js", "package.json"]);
  });
});

describe("the stub's package.json", () => {
  it("names the added files in the allowlist rather than leaning on npm", () => {
    expect(stubPkg.files).toEqual(["bin", "README.md", "LICENSE"]);
  });

  it("still declares the two fields the publish workflow stamps", () => {
    // The workflow rewrites both with `npm pkg set` from the root version, so
    // the committed values are stale by design — what matters is that the keys
    // are here, and that the pin is on agents-deck and nothing else.
    expect(typeof stubPkg.version).toBe("string");
    expect(Object.keys(stubPkg.dependencies)).toEqual(["agents-deck"]);
  });
});

describe("the files behind the npm page", () => {
  it("licences the stub with the repo's own licence, word for word", () => {
    expect(read(STUB, "LICENSE")).toBe(read(REPO, "LICENSE"));
  });

  it("gives the page its own text instead of the repo README", () => {
    const stubReadme = read(STUB, "README.md");
    expect(stubReadme).not.toBe(read(REPO, "README.md"));
    // Whatever it says, a reader landing here has to be able to run it and to
    // find the project the stub forwards to.
    expect(stubReadme).toMatch(/npx ccdeck/);
    expect(stubReadme).toMatch(/agents-deck/);
    expect(stubReadme).toMatch(/github\.com\/BarganConstantin\/ccdeck/);
  });
});
