// `npm i -g agent-dag` had the same defect #358 fixed for `npm i -g ccdeck`,
// reached by a different route — and was explicitly left out of that change.
//
// #358 taught the deck to read the name it was REACHED under out of the layout
// npm built, which is the only place the stub's name survives: `npm i -g ccdeck`
// nests the deck at `<prefix>/lib/node_modules/ccdeck/node_modules/agents-deck`,
// so the package one directory up is the one an upgrade replaces. `agent-dag`
// has no such layout. It is this tarball republished with its manifest renamed
// (publish.yml: `npm pkg set name=agent-dag`), so the deck IS the whole package
// and sits directly under the global node_modules with nothing above it —
// hostPackage correctly finds no host, and the answer fell through to `name`'s
// default of `agents-deck`. Nothing in the deck ever passes that parameter, so
// the default WAS the answer: an `agent-dag` user was told to run
// `npm i -g agents-deck@latest`, which installs a second, unrelated global
// package and leaves their `agent-dag` binary exactly where it was, while the
// version check cached its answer in a marker named after a package this
// install is not.
//
// What both renamed republishes carry is their own package.json, which the
// rename made authoritative. This file pins that it is read — for all three
// global names in one table, at the two places a name becomes an act (the
// command the user is shown and the argv npm is spawned with), and in the
// marker the answer is cached under. #358's two layouts, npx under each of the
// three typed names, and a git checkout are pinned alongside them, because the
// whole risk of reading a new source of truth is that it outranks one that was
// already right.
//
// The layouts are built on disk in a temp sandbox, the way
// stub-global-upgrade.test.ts builds them — nothing is installed, nothing is
// downloaded, and npm is a recording fake that never runs.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The marker lives under homedir(), and one test here is about which file gets
// written there. The real ~/.agents-deck/ is shared with every deck on the
// machine running the suite, so homedir() answers with a temp directory for as
// long as one is set and with the real one otherwise — same shape as
// self-update.test.ts's, re-declared rather than imported.
const { homeRef } = vi.hoisted(() => ({ homeRef: { dir: null as string | null } }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => homeRef.dir ?? actual.homedir() };
  return { ...patched, default: patched };
});

// npm is never executed: the install child is recorded and handed back as a
// fake, so no test in this file can install anything onto the machine running
// the suite.
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

import {
  // @ts-expect-error — plain JS module, no types
  ALIAS_PACKAGES, hostPackage, installedName, markerFileName, startUpgrade,
  // @ts-expect-error — plain JS module, no types
  upgradeBlock, upgradeCommand, upgradeMode, upgradeName,
} from "../../server/self-update.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

const SANDBOX = mkdtempSync(join(tmpdir(), "global-alias-name-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

// The registry is not asked by anything except the one marker test below, which
// stubs fetch and clears this for its own duration. Everything else here is
// about a name and a command, which need no lookup.
const prevEnv = {
  AGENTS_DECK_NO_UPDATE_CHECK: process.env.AGENTS_DECK_NO_UPDATE_CHECK,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
};
process.env.AGENTS_DECK_NO_UPDATE_CHECK = "1";
delete process.env.AGENTS_DECK_NO_INSTALL;
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const VERSION = "1.33.152";
const NEXT = "1.33.153";

/**
 * Writes one real install layout under a fresh sandbox directory and returns
 * the pkgRoot the deck would be running out of — the directory holding the
 * package.json every one of these functions is asked about.
 *
 *   "global"   — `npm i -g <pkg>`: the deck itself directly under the global
 *                node_modules, with no host above it. `pkg` is the name in its
 *                own manifest, which is what CI's rename decides.
 *   "stub"     — `npm i -g ccdeck`: the deck nested inside the stub's own
 *                node_modules, which is what npm >= 7 builds for a global
 *                install with a dependency.
 *   "npx"      — `npx <typed>`: the deck in a content-addressed cache with
 *                npm's own record of the typed spec one level up.
 *   "project"  — a package that merely depends on the deck. Identical in shape
 *                to the stub layout, and not one of this deck's names.
 *   "checkout" — the maintainer's own tree: a manifest and a .git beside it.
 *
 * Re-declared here rather than imported from stub-global-upgrade.test.ts on
 * purpose — a helper shared between two test files is a place a fix can hide.
 */
function layout(
  shape: "global" | "stub" | "npx" | "project" | "checkout",
  { host = "ccdeck", pkg = "agents-deck" }: { host?: string; pkg?: string } = {},
): string {
  const root = mkdtempSync(join(SANDBOX, `${shape}-`));
  // Every path is derived from mkdtemp's answer, and one wrong join would have
  // this file writing into the developer's own tree.
  if (!root.startsWith(SANDBOX)) throw new Error(`refusing to write: ${root} is outside ${SANDBOX}`);
  const manifest = (dir: string, body: Record<string, unknown>) =>
    writeFileSync(join(dir, "package.json"), JSON.stringify(body));

  if (shape === "checkout") {
    mkdirSync(join(root, ".git"), { recursive: true });
    manifest(root, { name: pkg, version: VERSION });
    return root;
  }

  if (shape === "global") {
    const pkgRoot = join(root, "lib", "node_modules", pkg);
    mkdirSync(pkgRoot, { recursive: true });
    manifest(pkgRoot, { name: pkg, version: VERSION });
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
    manifest(pkgRoot, { name: pkg, version: VERSION });
    return pkgRoot;
  }

  // stub and project are the same shape on disk; only the manifest above
  // differs, which is the entire point of testing both.
  const outer = shape === "stub" ? join(root, "lib", "node_modules", host) : join(root, host);
  const pkgRoot = join(outer, "node_modules", pkg);
  mkdirSync(pkgRoot, { recursive: true });
  manifest(outer, shape === "stub"
    // What CI publishes: the stub pins the exact version it was built beside.
    ? { name: host, version: VERSION, bin: { [host]: "bin/ccdeck.js" }, dependencies: { [pkg]: VERSION } }
    : { name: host, version: "0.1.0", dependencies: { [pkg]: "^1.33.0" } });
  manifest(pkgRoot, { name: pkg, version: VERSION });
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

// The three names, and the one command each of them must produce. `agent-dag`
// is the row that was wrong; the other two are here so the row that was wrong
// cannot be fixed by breaking them.
const GLOBAL_NAMES = [
  {
    typed: "npm i -g agents-deck",
    // The primary name: the tarball as it is built, and the only one where the
    // published name and the installed name were never in question.
    pkgRoot: () => layout("global", { pkg: "agents-deck" }),
    name: "agents-deck",
  },
  {
    typed: "npm i -g agent-dag",
    // The legacy name: the same tarball with `npm pkg set name=agent-dag`
    // applied before publishing, so the manifest on disk says so.
    pkgRoot: () => layout("global", { pkg: "agent-dag" }),
    name: "agent-dag",
  },
  {
    typed: "npm i -g ccdeck",
    // The stub: a different package that depends on this one, so the deck runs
    // out of a nested directory whose own manifest says `agents-deck` — the one
    // row where the installed name is NOT the name to upgrade with.
    pkgRoot: () => layout("stub"),
    name: "ccdeck",
  },
] as const;

describe("npm i -g, under each of the three names it can be typed with", () => {
  it("upgrades the package that was installed, and only that one", () => {
    for (const { typed, pkgRoot: build, name } of GLOBAL_NAMES) {
      const pkgRoot = build();
      // Three renderings of one answer, and they have to be the same answer:
      // the registry is asked about `upgradeName`, the user is shown
      // `upgradeCommand`, and npm is spawned with the argv. Before this, the
      // `agent-dag` row read `agents-deck` in all three.
      expect(upgradeName(pkgRoot), typed).toBe(name);
      expect(upgradeCommand(pkgRoot), typed).toBe(`npm i -g ${name}@latest`);
      expect(npmArgv(pkgRoot), typed)
        .toEqual(["install", "-g", `${name}@latest`, "--no-audit", "--no-fund", "--loglevel", "error"]);
      // And the in-app button stays offered in every one of them: this fix
      // changes which package is named, not whether an install is allowed.
      expect(upgradeBlock(pkgRoot), typed).toBeNull();
      expect(upgradeMode(upgradeBlock(pkgRoot)), typed).toBe("install");
    }
  });

  it("caches the version check under that same name, not under a package it is not", () => {
    for (const { typed, pkgRoot: build, name } of GLOBAL_NAMES) {
      // One file per package name is what stops three decks on one machine
      // silencing each other. An `agent-dag` deck writing agents-deck's marker
      // put itself on another package's hourly window AND stored another
      // package's dist-tag as its own idea of `latest`.
      expect(markerFileName(upgradeName(build())), typed).toBe(`.self-update-check-${name}`);
    }
  });

  it("reaches the answer the same way on every platform", () => {
    // The mechanism is a manifest read and path arithmetic, and neither knows
    // what platform it is on — which is the point. The name the user TYPED is
    // unreadable on Windows, where npm's .cmd/.ps1 shims never pass it on (see
    // invoked-as.mjs), so an answer that depended on the platform would be an
    // answer Windows does not get.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      for (const os of ["win32", "linux", "darwin"]) {
        Object.defineProperty(process, "platform", { value: os, configurable: true });
        for (const { typed, pkgRoot: build, name } of GLOBAL_NAMES) {
          expect(upgradeName(build()), `${typed} on ${os}`).toBe(name);
        }
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("writes a marker name Windows will accept for each of them", () => {
    // The marker is a real path under the user's home, and `/`, `\` and `:` are
    // a separator or outright illegal in a Windows file name. All three names
    // are plain today; this is the assertion that notices if a fourth one is
    // not, before it becomes a marker that silently fails to be written.
    for (const name of ALIAS_PACKAGES) {
      expect(markerFileName(name), name).toMatch(/^\.self-update-check-[a-z0-9._-]+$/);
    }
  });

  it("finds no host above a Windows global prefix, so it cannot invent one", () => {
    // Where npm puts a global package on Windows. The directory above its
    // node_modules is the prefix itself, which holds no manifest — so a plain
    // global install can never be mistaken for the nested stub layout, and the
    // manifest below is the only thing left to read.
    expect(hostPackage("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agent-dag")).toBeNull();
    expect(hostPackage("/usr/local/lib/node_modules/agent-dag")).toBeNull();
  });
});

describe("the marker on disk, for the install that was writing the wrong one", () => {
  it("is named after agent-dag, and agents-deck's is never touched", async () => {
    // The half markerFileName cannot show: this runs a real versionReport and
    // looks at what appeared under the home directory. The registry is a stub —
    // nothing here reaches the network — and the module is imported fresh
    // because MARKER_DIR is resolved from homedir() at import time.
    const home = mkdtempSync(join(SANDBOX, "home-"));
    homeRef.dir = home;
    const was = process.env.AGENTS_DECK_NO_UPDATE_CHECK;
    delete process.env.AGENTS_DECK_NO_UPDATE_CHECK;
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(String(url));
      if (String(url).endsWith("/dist-tags")) {
        return { ok: true, status: 200, json: async () => ({ latest: NEXT }) };
      }
      return { ok: true, status: 200, json: async () => ({ name: "agent-dag", version: NEXT }) };
    }));
    try {
      vi.resetModules();
      const mod = await import("../../server/self-update.mjs") as unknown as {
        versionReport: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const pkgRoot = layout("global", { pkg: "agent-dag" });
      const report = await mod.versionReport({ running: VERSION, pkgRoot });

      // The report names the package the command installs, so the browser, the
      // registry and the marker are all talking about one thing.
      expect(report.name).toBe("agent-dag");
      expect(report.command).toBe("npm i -g agent-dag@latest");
      expect(report.latest).toBe(NEXT);
      expect(asked).toContain("https://registry.npmjs.org/-/package/agent-dag/dist-tags");
      expect(asked.some(u => u.includes("agents-deck"))).toBe(false);

      expect(existsSync(join(home, ".agents-deck", ".self-update-check-agent-dag"))).toBe(true);
      expect(existsSync(join(home, ".agents-deck", ".self-update-check-agents-deck"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      homeRef.dir = null;
      if (was === undefined) delete process.env.AGENTS_DECK_NO_UPDATE_CHECK;
      else process.env.AGENTS_DECK_NO_UPDATE_CHECK = was;
    }
  });
});

describe("what #358 fixed, and what was already right, is untouched", () => {
  it("still names the stub for the nested layout npm builds for ccdeck", () => {
    // The whole of #358, restated against a source of truth it did not have.
    // The nested manifest says `agents-deck`, and if that outranked the layout
    // this fix would have undone the last one — a `npm i -g ccdeck` user sent
    // back to installing a tree their deck never reads.
    const pkgRoot = layout("stub");
    expect(installedName(pkgRoot)).toBe("agents-deck");
    expect(upgradeName(pkgRoot)).toBe("ccdeck");
    expect(upgradeCommand(pkgRoot)).toBe("npm i -g ccdeck@latest");
    expect(markerFileName(upgradeName(pkgRoot))).toBe(".self-update-check-ccdeck");
  });

  it("still re-runs the spec npx recorded, under every name it can be typed with", () => {
    // npx unpacks each spec into its own content-addressed directory, so there
    // is nothing to install over: the update IS the relaunch. The typed spec
    // outranks the manifest here for the same reason the layout does above —
    // `npx ccdeck` unpacks a deck whose manifest says `agents-deck`, and
    // re-running that name would move the user off the stub they asked for.
    for (const typed of ["agents-deck", "agent-dag", "ccdeck"]) {
      const pkg = typed === "ccdeck" ? "agents-deck" : typed;
      const pkgRoot = layout("npx", { host: typed, pkg });
      expect(upgradeName(pkgRoot), typed).toBe(typed);
      expect(upgradeCommand(pkgRoot), typed).toBe(`npx -y ${typed}@latest`);
      expect(upgradeMode(upgradeBlock(pkgRoot)), typed).toBe("npx");
      expect(startUpgrade({ pkgRoot }), typed).toMatchObject({ ok: false, reason: "npx" });
      expect(spawns, "npx must never reach npm i -g").toHaveLength(0);
    }
  });

  it("falls back to this build's own name when the npx cache has no spec to read", () => {
    // The metadata is the better answer and is missing here, so what is left is
    // the manifest — which for a renamed republish is still the right package,
    // where the old default was right for only one of the two.
    const cache = mkdtempSync(join(SANDBOX, "npx-bare-"));
    const bare = join(cache, "_npx", "9a1c", "node_modules", "agent-dag");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "agent-dag", version: VERSION }));
    expect(upgradeName(bare)).toBe("agent-dag");
    expect(upgradeCommand(bare)).toBe("npx -y agent-dag@latest");
  });

  it("still tells a checkout to pull, and installs nothing over the working copy", () => {
    const pkgRoot = layout("checkout");
    expect(upgradeName(pkgRoot)).toBe("agents-deck");
    expect(upgradeCommand(pkgRoot)).toBe("git pull && npm run build");
    expect(startUpgrade({ pkgRoot })).toMatchObject({ ok: false, reason: "git_checkout" });
    expect(spawns).toHaveLength(0);
  });

  it("says the same about a checkout that happens to sit inside a node_modules", () => {
    // A checkout linked into a project — `npm link`, or a workspace — is still
    // the maintainer's own tree, and the git test has to outrank both the
    // layout rule and the manifest one.
    const pkgRoot = layout("stub");
    mkdirSync(join(pkgRoot, ".git"), { recursive: true });
    expect(upgradeName(pkgRoot)).toBe("agents-deck");
    expect(upgradeCommand(pkgRoot)).toBe("git pull && npm run build");
  });

  it("refuses to name somebody else's project, whatever the layout looks like", () => {
    // A workspace, a CI job or a tool that embeds the deck puts it in exactly
    // the stub's shape on disk, and `npm i -g their-app@latest` is a package
    // the deck has no business installing.
    const pkgRoot = layout("project", { host: "my-app" });
    expect(upgradeName(pkgRoot)).toBe("agents-deck");
    expect(npmArgv(pkgRoot)[2]).toBe("agents-deck@latest");
  });
});

describe("the manifest this all now reads", () => {
  it("answers with the name in it, when that is one of ours", () => {
    for (const name of ALIAS_PACKAGES) {
      expect(installedName(layout("global", { pkg: name })), name).toBe(name);
    }
  });

  it("falls back rather than handing npm a name nothing vouched for", () => {
    // The answer becomes an argument in the `npm i -g` this process spawns, so
    // it is confined to the three names the repo publishes — a directory on
    // disk must not be able to name a fourth package for npm to fetch. A fork
    // that republishes under its own name adds it to ALIAS_PACKAGES.
    const foreign = layout("global", { pkg: "evil-package" });
    expect(installedName(foreign)).toBe("agents-deck");
    expect(upgradeName(foreign)).toBe("agents-deck");
    expect(upgradeCommand(foreign)).toBe("npm i -g agents-deck@latest");
    // And the caller's own fallback is what it falls back TO, so a caller that
    // knows better than the disk still wins.
    expect(installedName(foreign, "ccdeck")).toBe("ccdeck");
  });

  it("survives a manifest that is missing, unreadable or not an object", () => {
    const pkgRoot = layout("global", { pkg: "agent-dag" });
    const manifest = join(pkgRoot, "package.json");
    for (const body of ["", "{", "null", '"agent-dag"', "[]", '{"name":42}', '{"version":"1.0.0"}']) {
      writeFileSync(manifest, body);
      expect(installedName(pkgRoot), body).toBe("agents-deck");
      expect(upgradeName(pkgRoot), body).toBe("agents-deck");
    }
    rmSync(manifest);
    expect(installedName(pkgRoot)).toBe("agents-deck");
    // And a directory that is not a path at all is not a name either.
    expect(installedName(null)).toBe("agents-deck");
    expect(installedName(undefined)).toBe("agents-deck");
    expect(installedName("")).toBe("agents-deck");
  });

  it("matches what this repo actually ships, which is what makes the rule true", () => {
    // The premise the whole mechanism rests on: the name in the manifest is one
    // of the three, and CI renames it rather than building a different tarball.
    // If the rename ever stopped happening, `agent-dag` would go back to being
    // `agents-deck` on disk and this fix would silently do nothing.
    expect(ALIAS_PACKAGES).toContain(JSON.parse(read("package.json")).name);
    expect(installedName(resolve(repo))).toBe("agents-deck");
    const publish = read(".github", "workflows", "publish.yml");
    expect(publish).toContain("npm pkg set name=agent-dag");
    expect(publish).toContain("npm pkg set name=agents-deck");
  });
});
