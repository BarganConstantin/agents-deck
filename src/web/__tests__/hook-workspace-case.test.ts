// Reported: a deck started with `--workspace C:\proj` received nothing on
// Windows. The hook compared the session cwd to the workspace with a plain ===
// / startsWith, but neither path.resolve nor the JS fs.realpathSync
// canonicalizes character case — so `c:\proj\sub`, which is how a shell that
// spelled the drive letter in lowercase reports its cwd, failed to match
// `C:\proj` even though Windows considers them one directory. The hook then
// posted to no server and exited 0, leaving an empty deck and no error
// anywhere. macOS has the same problem: APFS is case-insensitive by default.
//
// Linux is the other half of the contract. There /srv/Proj and /srv/proj are
// two different directories, and folding case would hand a deck scoped to one
// the other's sessions — so the rule has to be per-platform, not blanket.
import { describe, it, expect, afterAll } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// hook.js is CommonJS living in a "type": "module" package, so it is only
// loadable as itself once outside that package tree — which is also the only
// way it ever runs, since the installer copies it into the Claude config dir.
// A .cjs copy reproduces that without an install. Requiring it exports the
// matching rule and starts nothing: the runtime is behind require.main.
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-hook-"));
const COPY = join(DIR, "hook.cjs");
copyFileSync(HOOK, COPY);

const { cwdInWorkspace, foldsCase } = createRequire(import.meta.url)(COPY) as {
  cwdInWorkspace: (cwd: string, workspace: string, platform?: string) => boolean;
  foldsCase: (platform?: string) => boolean;
};

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("which platforms compare paths case-insensitively", () => {
  it("folds case where the filesystem does, and nowhere else", () => {
    expect(foldsCase("win32")).toBe(true);
    // APFS and HFS+ are case-insensitive unless deliberately formatted otherwise.
    expect(foldsCase("darwin")).toBe(true);
    expect(foldsCase("linux")).toBe(false);
    expect(foldsCase("freebsd")).toBe(false);
  });
});

describe("workspace matching on Windows", () => {
  it("matches a cwd whose drive letter is spelled in the other case", () => {
    expect(cwdInWorkspace("c:\\proj\\sub", "C:\\proj", "win32")).toBe(true);
    expect(cwdInWorkspace("C:\\proj\\sub", "c:\\proj", "win32")).toBe(true);
  });

  it("matches a cwd whose components are spelled in another case", () => {
    expect(cwdInWorkspace("C:\\Users\\John\\proj\\sub", "C:\\users\\john\\proj", "win32")).toBe(true);
  });

  it("still matches the workspace directory itself", () => {
    expect(cwdInWorkspace("c:\\proj", "C:\\proj", "win32")).toBe(true);
  });

  it("does not match a sibling that merely starts with the same letters", () => {
    expect(cwdInWorkspace("C:\\project-two", "C:\\proj", "win32")).toBe(false);
  });

  it("does not match an unrelated tree", () => {
    expect(cwdInWorkspace("D:\\other\\sub", "C:\\proj", "win32")).toBe(false);
  });

  it("treats forward slashes and a trailing separator as the same path", () => {
    expect(cwdInWorkspace("C:/proj/sub", "C:\\proj\\", "win32")).toBe(true);
    expect(cwdInWorkspace("C:\\proj\\sub", "C:/proj/", "win32")).toBe(true);
  });

  it("matches anything under a drive root, which already ends in a separator", () => {
    expect(cwdInWorkspace("C:\\proj\\sub", "c:\\", "win32")).toBe(true);
  });
});

describe("workspace matching on macOS", () => {
  it("matches a cwd spelled in another case, since APFS is case-insensitive", () => {
    expect(cwdInWorkspace("/Users/john/Proj/sub", "/Users/John/proj", "darwin")).toBe(true);
  });

  it("still rejects a genuinely different tree", () => {
    expect(cwdInWorkspace("/Users/john/other", "/Users/john/proj", "darwin")).toBe(false);
  });
});

describe("workspace matching on Linux", () => {
  it("keeps two directories that differ only in case apart", () => {
    expect(cwdInWorkspace("/srv/Proj/sub", "/srv/proj", "linux")).toBe(false);
    expect(cwdInWorkspace("/srv/Proj", "/srv/proj", "linux")).toBe(false);
  });

  it("matches the workspace and everything genuinely inside it", () => {
    expect(cwdInWorkspace("/srv/proj", "/srv/proj", "linux")).toBe(true);
    expect(cwdInWorkspace("/srv/proj/sub/deeper", "/srv/proj", "linux")).toBe(true);
  });

  it("does not match a sibling sharing a prefix", () => {
    expect(cwdInWorkspace("/srv/project-two", "/srv/proj", "linux")).toBe(false);
  });

  it("ignores a trailing separator on the workspace", () => {
    expect(cwdInWorkspace("/srv/proj/sub", "/srv/proj/", "linux")).toBe(true);
  });

  it("matches anything under the filesystem root", () => {
    expect(cwdInWorkspace("/srv/proj", "/", "linux")).toBe(true);
  });
});
