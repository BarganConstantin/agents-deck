// `npm i -g ccdeck` booted, and then could never update itself.
//
// #351 fixed the half everybody saw: the stub ships nothing but bin/, and it
// walked one way — `../../agents-deck` — which is right under npx and wrong
// under a global install, because npm stopped hoisting a global package's
// dependencies in v7. Teaching it the nested layout made the deck start.
//
// Nothing downstream learned about that layout. Every self-update surface went
// on naming `agents-deck`, which under the stub layout is a DIFFERENT
// directory: the process runs out of
// `<prefix>/lib/node_modules/ccdeck/node_modules/agents-deck` while
// `npm i -g agents-deck@latest` writes `<prefix>/lib/node_modules/agents-deck`
// — a tree it never reads, and one a `npm i -g ccdeck` user does not otherwise
// have. So the button installed a second unrelated copy, installedVersion never
// moved, the restart notice never came, and the same update was offered forever
// while the upgrade reported "done". The printed command underneath it was the
// same wrong line, so the manual escape hatch pointed at the same wrong tree.
//
// This file pins the name each install shape resolves to, and pins it at the
// two places it becomes an action: the command the user is shown, and the argv
// npm is actually spawned with. The layouts are built on disk the way
// stub-global-layout.test.ts builds them — nothing is installed, nothing is
// downloaded, and npm is a recording fake that never runs.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// npm is never executed: the install child is recorded and handed back as a
// fake, so no test in this file can install anything onto the machine running
// the suite. Same shape as self-update.test.ts's, which owns the timeout half
// of startUpgrade.
type FakeChild = { emit: (event: string, ...args: unknown[]) => void };
const { spawns } = vi.hoisted(() => ({
  spawns: [] as { cmd: string; args: string[]; child: FakeChild }[],
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  class Fake extends EventEmitter {
    pid = 4242;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill() { return true; }
    unref() { /* the real one is unref'd so it cannot hold the process open */ }
  }
  return {
    spawn: (cmd: string, args: string[] = []) => {
      const child = new Fake();
      spawns.push({ cmd, args, child: child as unknown as FakeChild });
      return child;
    },
    // exec.mjs names this import; nothing here should reach it.
    execFile: () => { throw new Error("test: execFile blocked"); },
  };
});

// @ts-expect-error — plain JS module, no types
import { COMMANDS } from "../../server/invoked-as.mjs";
import {
  // @ts-expect-error — plain JS module, no types
  ALIAS_PACKAGES, hostNameFromMeta, hostPackage, hostRoot, markerFileName, startUpgrade,
  // @ts-expect-error — plain JS module, no types
  upgradeBlock, upgradeCommand, upgradeMode, upgradeName, versionReport,
} from "../../server/self-update.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

const SANDBOX = mkdtempSync(join(tmpdir(), "stub-global-upgrade-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

// The registry is never asked: every assertion here is about a name and a
// command, and versionReport's local half answers without a lookup. The
// supervisor key is cleared for the same reason — a restart-failure note left
// by a real deck running on this machine is not this file's subject.
const prevEnv = {
  AGENTS_DECK_NO_UPDATE_CHECK: process.env.AGENTS_DECK_NO_UPDATE_CHECK,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  AGENTS_DECK_SUPERVISOR_PID: process.env.AGENTS_DECK_SUPERVISOR_PID,
};
process.env.AGENTS_DECK_NO_UPDATE_CHECK = "1";
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_SUPERVISOR_PID;
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const VERSION = "1.33.147";

/**
 * Writes one real install layout under a fresh sandbox directory and returns
 * the pkgRoot the deck would be running out of — the directory that holds the
 * package.json every one of these functions is asked about.
 *
 *   "stub"    — `npm i -g ccdeck`: the deck nested inside the stub's own
 *               node_modules, which is what npm >= 7 builds for a global
 *               install with a dependency.
 *   "global"  — `npm i -g agents-deck` / `agent-dag`: the deck itself directly
 *               under the global node_modules, with no host above it.
 *   "npx"     — `npx ccdeck`: stub and deck side by side in a content-addressed
 *               cache, with npm's own record of the typed spec beside them.
 *   "project" — a package that merely depends on the deck and runs it out of
 *               its own node_modules. Identical in shape to the stub layout,
 *               and the reason the rule cannot be "read the name above us".
 */
function layout(
  shape: "stub" | "global" | "npx" | "project",
  { host = "ccdeck", pkg = "agents-deck" }: { host?: string; pkg?: string } = {},
): string {
  const root = mkdtempSync(join(SANDBOX, `${shape}-`));
  // Every path is derived from mkdtemp's answer, and one wrong join would have
  // this file writing into the developer's own tree.
  if (!root.startsWith(SANDBOX)) throw new Error(`refusing to write: ${root} is outside ${SANDBOX}`);

  if (shape === "global") {
    const pkgRoot = join(root, "lib", "node_modules", pkg);
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: pkg, version: VERSION }));
    return pkgRoot;
  }

  if (shape === "npx") {
    // `_npx/<hash>/package.json` is npm's own record of the spec the user
    // typed, and the only place it survives an npx run.
    const cache = join(root, "_npx", "9a1c");
    const pkgRoot = join(cache, "node_modules", pkg);
    mkdirSync(pkgRoot, { recursive: true });
    mkdirSync(join(cache, "node_modules", host), { recursive: true });
    writeFileSync(join(cache, "package.json"), JSON.stringify({ _npx: { packages: [host] } }));
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: pkg, version: VERSION }));
    return pkgRoot;
  }

  // stub and project are the same shape on disk; only the manifest above
  // differs, which is the entire point of testing both.
  const outer = shape === "stub" ? join(root, "lib", "node_modules", host) : join(root, host);
  const pkgRoot = join(outer, "node_modules", pkg);
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(outer, "package.json"), JSON.stringify(shape === "stub"
    // What CI publishes: the stub pins the exact version it was built beside.
    ? { name: host, version: VERSION, bin: { [host]: "bin/ccdeck.js" }, dependencies: { [pkg]: VERSION } }
    : { name: host, version: "0.1.0", dependencies: { [pkg]: "^1.33.0" } }));
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: pkg, version: VERSION }));
  return pkgRoot;
}

/** The argv npm was handed, for the one install this file allows to start. */
function npmArgv(pkgRoot: string): string[] {
  spawns.length = 0;
  const out = startUpgrade({ pkgRoot });
  expect(out, "the install was refused, so there is no argv to read").toMatchObject({ ok: true });
  expect(spawns).toHaveLength(1);
  // startUpgrade allows one install at a time per process and answers every
  // later call with `already` until this one settles — so the fake reports the
  // clean exit npm would have, and the next test starts from an idle module.
  spawns[0].child.emit("close", 0);
  return spawns[0].args;
}

beforeEach(() => { spawns.length = 0; });

describe("npm i -g ccdeck — the install that could not update itself", () => {
  it("names the stub, because that is the package this copy came in", () => {
    const pkgRoot = layout("stub");
    // Reproduced against the shipped code before the fix: `agents-deck`, and
    // `npm i -g agents-deck@latest` — a directory this process never reads.
    expect(upgradeName(pkgRoot)).toBe("ccdeck");
    expect(upgradeCommand(pkgRoot)).toBe("npm i -g ccdeck@latest");
  });

  it("installs the stub, so npm replaces the tree this process runs out of", () => {
    // The half the printed command cannot cover. `npm i -g ccdeck@latest`
    // rewrites <prefix>/lib/node_modules/ccdeck, and the copy running out of
    // its nested node_modules goes with it — which is what finally makes
    // installedVersion move and the restart notice appear.
    expect(npmArgv(layout("stub")))
      .toEqual(["install", "-g", "ccdeck@latest", "--no-audit", "--no-fund", "--loglevel", "error"]);
  });

  it("still offers the in-app install, on the tree npm would actually rewrite", () => {
    // The writability question is asked of the host now, not of the nested
    // copy: the directory the command touches is the one that has to be ours.
    const pkgRoot = layout("stub");
    expect(upgradeBlock(pkgRoot)).toBeNull();
    expect(upgradeMode(upgradeBlock(pkgRoot))).toBe("install");
  });

  it("tells the browser the same name it tells npm", () => {
    // `name`, `command` and the argv above are three renderings of one answer:
    // the registry is asked about `name`, the banner offers `latest` for it,
    // and the copy button hands over `command`. They disagreed before this —
    // the version came from one package and the command installed another.
    const pkgRoot = layout("stub");
    return versionReport({ running: VERSION, pkgRoot }).then((report: Record<string, unknown>) => {
      expect(report.name).toBe("ccdeck");
      expect(report.command).toBe("npm i -g ccdeck@latest");
      expect(report.installed).toBe(VERSION);
      expect(report.upgradeMode).toBe("install");
    });
  });

  it("keeps the update marker under the stub's name too", () => {
    // One file per package name is what stops three decks on one machine
    // silencing each other; a marker written under the wrong name would put a
    // ccdeck deck back on agents-deck's hourly window.
    expect(markerFileName(upgradeName(layout("stub")))).toBe(".self-update-check-ccdeck");
  });

  it("answers on Windows, where nothing else can", () => {
    // The platform the layout rule exists for. npm's .cmd/.ps1/sh shims never
    // pass the typed name on, so invoked-as.mjs answers null for every global
    // install there — but npm nests the dependency exactly as it does on
    // POSIX, and the directory it built says so on every platform.
    expect(hostRoot("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\ccdeck\\node_modules\\agents-deck"))
      .toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\ccdeck");
    // Separator-agnostic in both directions, for the same reason isNpxInstall
    // is: a Windows path can reach a POSIX process through a test or a config
    // file, and this is the function that must not care.
    expect(hostRoot("/usr/local/lib/node_modules/ccdeck/node_modules/agents-deck"))
      .toBe("/usr/local/lib/node_modules/ccdeck");
  });
});

describe("the install shapes that were already right, and stay untouched", () => {
  it("leaves a plain global install on the name it was published under", () => {
    for (const pkg of ["agents-deck", "agent-dag"]) {
      const pkgRoot = layout("global", { pkg });
      // No host above it — `lib` holds no package.json — so the published name
      // is still the answer, and the command is byte-for-byte what it was.
      expect(hostPackage(pkgRoot), pkg).toBeNull();
      expect(upgradeName(pkgRoot), pkg).toBe("agents-deck");
      expect(upgradeCommand(pkgRoot), pkg).toBe("npm i -g agents-deck@latest");
      expect(npmArgv(pkgRoot)[2], pkg).toBe("agents-deck@latest");
    }
  });

  it("still re-runs npx rather than installing anything, and reads the typed spec", () => {
    // npx unpacks each spec into its own content-addressed directory, so there
    // is nothing here to install over: the update IS the relaunch, and the
    // supervisor fetches a fresh copy before this deck gives up its port. The
    // stub is a sibling in that layout, not a host — so the metadata answers,
    // exactly as it did before.
    const pkgRoot = layout("npx");
    expect(upgradeName(pkgRoot)).toBe("ccdeck");
    expect(upgradeCommand(pkgRoot)).toBe("npx -y ccdeck@latest");
    expect(upgradeMode(upgradeBlock(pkgRoot))).toBe("npx");
    expect(startUpgrade({ pkgRoot })).toMatchObject({ ok: false, reason: "npx" });
    expect(spawns, "npx must never reach npm i -g").toHaveLength(0);
  });

  it("still tells a checkout to pull, and installs nothing over the working copy", () => {
    const pkgRoot = layout("global");
    mkdirSync(join(pkgRoot, ".git"), { recursive: true });
    expect(upgradeName(pkgRoot)).toBe("agents-deck");
    expect(upgradeCommand(pkgRoot)).toBe("git pull && npm run build");
    expect(startUpgrade({ pkgRoot })).toMatchObject({ ok: false, reason: "git_checkout" });
    expect(spawns).toHaveLength(0);
  });

  it("says the same about a checkout that happens to sit inside a node_modules", () => {
    // A checkout linked into a project — `npm link`, or a workspace — is still
    // the maintainer's own tree, and the git test has to outrank the layout
    // one or the deck would offer to publish over their working copy.
    const pkgRoot = layout("stub");
    mkdirSync(join(pkgRoot, ".git"), { recursive: true });
    expect(upgradeName(pkgRoot)).toBe("agents-deck");
    expect(upgradeCommand(pkgRoot)).toBe("git pull && npm run build");
  });
});

describe("a package that merely depends on the deck is not one of its names", () => {
  it("refuses to name somebody else's project, whatever the layout looks like", () => {
    // The failure mode a rule of "read the name one directory up" would have
    // shipped. A workspace, a CI job or a tool that embeds the deck puts it in
    // exactly the stub's shape on disk, and `npm i -g their-app@latest` is a
    // package the deck has no business installing — on a private name, one
    // that does not exist at all.
    const pkgRoot = layout("project", { host: "my-app" });
    expect(hostPackage(pkgRoot)).toBeNull();
    expect(upgradeName(pkgRoot)).toBe("agents-deck");
    expect(upgradeCommand(pkgRoot)).toBe("npm i -g agents-deck@latest");
    expect(npmArgv(pkgRoot)[2]).toBe("agents-deck@latest");
  });

  it("wants both halves: one of our names, and a dependency on us", () => {
    // Read as a manifest so the two conditions can be separated. A host named
    // ccdeck that does not depend on the deck is not the stub — it is a
    // coincidence, or a directory somebody renamed by hand.
    expect(hostNameFromMeta({ name: "ccdeck", dependencies: { "agents-deck": "1.33.147" } })).toBe("ccdeck");
    expect(hostNameFromMeta({ name: "ccdeck", dependencies: { lodash: "^4" } })).toBeNull();
    expect(hostNameFromMeta({ name: "ccdeck" })).toBeNull();
    expect(hostNameFromMeta({ name: "my-app", dependencies: { "agents-deck": "^1.33.0" } })).toBeNull();
    expect(hostNameFromMeta({ dependencies: { "agents-deck": "1.0.0" } })).toBeNull();
    expect(hostNameFromMeta(null)).toBeNull();
  });

  it("splits the path and asks the manifest, rather than trusting the shape", () => {
    // hostRoot is only the arithmetic, and it says yes to every global install:
    // `<prefix>/lib/node_modules/agents-deck` really does have a directory
    // above its node_modules. What it does NOT have is a package.json naming
    // one of us — which is why the manifest is the half that decides.
    expect(hostRoot("/usr/local/lib/node_modules/agents-deck")).toBe("/usr/local/lib");
    expect(hostPackage("/usr/local/lib/node_modules/agents-deck")).toBeNull();
    // And no arithmetic at all where there is nothing above the deck: a
    // checkout, a package at the filesystem root, or an input that is not a
    // path. None of those may become a name.
    expect(hostRoot("/home/me/src/ccdeck")).toBeNull();
    expect(hostRoot("/node_modules/agents-deck")).toBeNull();
    expect(hostRoot("")).toBeNull();
    expect(hostRoot(null)).toBeNull();
    expect(hostRoot(undefined)).toBeNull();
  });

  it("survives a host manifest that is missing, unreadable or not an object", () => {
    const pkgRoot = layout("project", { host: "ccdeck" });
    const manifest = resolve(pkgRoot, "..", "..", "package.json");
    for (const body of ["", "{", "null", '"ccdeck"', "[]"]) {
      writeFileSync(manifest, body);
      expect(upgradeName(pkgRoot), body).toBe("agents-deck");
    }
    rmSync(manifest);
    expect(upgradeName(pkgRoot)).toBe("agents-deck");
  });
});

describe("both layouts #351 taught the stub to find", () => {
  it("resolves to a deck directory in each, and names the stub for each", () => {
    // The two shapes npm produces, and the two answers that have to come out of
    // them: a global install updates itself with `npm i -g ccdeck`, and an npx
    // run re-runs `npx -y ccdeck`. Same package, two entirely different acts.
    const nested = layout("stub");
    expect(existsSync(join(nested, "package.json"))).toBe(true);
    expect(nested).toMatch(/[\\/]ccdeck[\\/]node_modules[\\/]agents-deck$/);
    expect(upgradeCommand(nested)).toBe("npm i -g ccdeck@latest");

    const sibling = layout("npx");
    expect(existsSync(join(sibling, "package.json"))).toBe(true);
    expect(sibling).toMatch(/[\\/]_npx[\\/]9a1c[\\/]node_modules[\\/]agents-deck$/);
    expect(upgradeCommand(sibling)).toBe("npx -y ccdeck@latest");
  });

  it("is still looking in both, which is the half this file cannot run", () => {
    // stub-global-layout.test.ts spawns the shipped stub in each layout; this
    // file mocks child_process, so it pins the two paths as text instead. Both
    // have to stay: a fix that traded one layout for the other would leave one
    // of the two answers above describing a deck that cannot start.
    const stub = read("ccdeck", "bin", "ccdeck.js");
    expect(stub).toContain("'../node_modules/agents-deck'");
    expect(stub).toContain("'../../agents-deck'");
  });
});

describe("the three names, in the two lists that must not drift apart", () => {
  it("holds exactly the names this repo publishes", () => {
    // ALIAS_PACKAGES is what a `npm i -g` may name; COMMANDS is what a user may
    // type. Two different questions with the same three answers, and nothing
    // but this keeps them that way — a fourth alias added to one and not the
    // other is either a name that cannot update itself or one the deck would
    // install over somebody else's package.
    expect([...ALIAS_PACKAGES].sort()).toEqual([...COMMANDS].sort());
    expect([...ALIAS_PACKAGES].sort()).toEqual(Object.keys(JSON.parse(read("package.json")).bin).sort());
  });

  it("matches the stub CI actually publishes, which is what the rule reads", () => {
    // The layout test above builds a manifest; this reads the real one. If the
    // stub stopped being called ccdeck, or stopped declaring the dependency,
    // hostPackage would find nothing and `npm i -g ccdeck` would quietly go
    // back to updating the wrong tree.
    const stub = JSON.parse(read("ccdeck", "package.json"));
    expect(ALIAS_PACKAGES).toContain(stub.name);
    expect(typeof stub.dependencies["agents-deck"]).toBe("string");
    // And CI pins that dependency to the exact version it publishes beside it,
    // so the nested copy is never a different release from the stub around it.
    expect(read(".github", "workflows", "publish.yml"))
      .toContain('npm pkg set dependencies.agents-deck="$VERSION"');
  });
});
