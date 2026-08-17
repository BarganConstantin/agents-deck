// #339: the deck ships under three npm names, every surface it draws says
// ccdeck, and 95% of the downloads are on the other two. So it says so — once
// in the terminal, once in the browser — and the whole risk of doing that lives
// in one question: which name did the USER type?
//
// Asking the package instead is the trap this file exists to keep shut.
// ccdeck/package.json depends on agents-deck and ccdeck/bin/ccdeck.js spawns
// ../../agents-deck/bin/agent-dag.js, so "is this build agents-deck?" is true
// inside every ccdeck run — a notice keyed on it would scold precisely the
// people who already did what it asks. That case is asserted here by name.
//
// The second half is that the answer does not exist everywhere. npx records the
// typed spec, a POSIX global install carries it in argv[1] because node does
// not resolve the bin symlink, a Windows global install loses it inside npm's
// .cmd/.ps1/sh shim, and a git checkout never had one. Four shapes, two of them
// unknowable, and unknowable must produce silence rather than the likeliest
// guess — a notice that fires at the wrong person is the one that teaches
// everyone to ignore the next one.
//
// Pure functions and source text only: plain node, no DOM, so the banner cannot
// be rendered and the terminal rows are rebuilt here out of the same term.mjs
// primitives bin/deck.js draws them with.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT } from "../brand";
import { PRODUCT as SERVER_PRODUCT } from "../../server/brand.mjs";
// @ts-expect-error — plain JS module, no types
import { COMMANDS, PREFERRED, invokedAs, invokedName, knownCommand, renameNotice } from "../../server/invoked-as.mjs";
// @ts-expect-error — plain JS module, no types
import { glyphs, labelColumn, palette, statusLine, stripAnsi } from "../../server/term.mjs";
// The pair the browser used to confuse with the question above: which install
// shape this is, versus whether this copy may `npm i -g` over itself (#363).
// @ts-expect-error — plain JS module, no types
import { upgradeBlock, upgradeMode } from "../../server/self-update.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

// A real directory, because npxRestartSpec reads `_npx/<hash>/package.json` off
// the disk — that file is npm's own record of the spec the user typed and the
// only place it survives an npx run.
const SANDBOX = mkdtempSync(join(tmpdir(), "invoked-as-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** The layout npx unpacks into: `_npx/<hash>/node_modules/<pkg>` under a
 *  `<hash>/package.json` carrying `_npx.packages`. Returns the pkgRoot the deck
 *  would see. `meta` of null writes no metadata file at all, which is the
 *  unreadable case. */
function npxCache(hash: string, meta: unknown, pkg = "agents-deck"): string {
  const root = join(SANDBOX, "_npx", hash);
  const pkgRoot = join(root, "node_modules", pkg);
  mkdirSync(pkgRoot, { recursive: true });
  if (meta !== null) writeFileSync(join(root, "package.json"), JSON.stringify(meta));
  return pkgRoot;
}

describe("npx — the one shape that is knowable on every platform", () => {
  it("answers with the name the user typed, not the package it resolved to", () => {
    // All three land in a directory whose node_modules holds agents-deck: the
    // legacy names because they are the same tarball republished, ccdeck
    // because its package is a stub that depends on it.
    for (const [hash, spec, typed] of [
      ["a1", "agent-dag@latest", "agent-dag"],
      ["a2", "ccdeck", "ccdeck"],
      ["a3", "agents-deck@1.2.3", "agents-deck"],
    ]) {
      const pkgRoot = npxCache(hash, { _npx: { packages: [spec] } });
      expect(invokedAs({ pkgRoot, argv1: join(pkgRoot, "bin", "agent-dag.js"), platform: "linux" }), spec)
        .toBe(typed);
    }
  });

  it("answers the same on Windows, where nothing else can", () => {
    // The npx path never reads argv[1], so the platform that has no other
    // carrier still gets a real answer here.
    const pkgRoot = npxCache("w1", { _npx: { packages: ["agent-dag"] } });
    expect(invokedAs({ pkgRoot, argv1: "C:\\x\\bin\\agent-dag.js", platform: "win32" })).toBe("agent-dag");
  });

  it("says nothing when the metadata is missing, unreadable or not a name", () => {
    // npxRestartSpec's own fallback is the package name, which is the right
    // answer to "what would a restart re-run" and a fabricated one here.
    for (const [hash, meta] of [
      ["b1", null],
      ["b2", {}],
      ["b3", { _npx: { packages: [] } }],
      ["b4", { _npx: { packages: ["file:../local"] } }],
      ["b5", { _npx: { packages: ["https://example.com/pkg.tgz"] } }],
    ] as const) {
      const pkgRoot = npxCache(hash, meta);
      expect(invokedAs({ pkgRoot, argv1: join(pkgRoot, "bin", "agent-dag.js"), platform: "linux" }), hash)
        .toBeNull();
    }
  });

  it("says nothing when the spec names some other package entirely", () => {
    const pkgRoot = npxCache("b6", { _npx: { packages: ["cowsay"] } });
    expect(invokedAs({ pkgRoot, argv1: "/x", platform: "linux" })).toBeNull();
  });
});

describe("a global install on macOS and Linux", () => {
  it("reads the typed command out of argv[1], which keeps the symlink's name", () => {
    // npm links <prefix>/bin/<name> at the package's bin/agent-dag.js and node
    // does not resolve that symlink for argv[1] — verified against npm's own
    // layout, where `ccdeck` and `agent-dag` reach one file with two argv[1]s.
    expect(invokedAs({ pkgRoot: "/usr/local/lib/node_modules/agents-deck", argv1: "/usr/local/bin/agent-dag", platform: "linux" }))
      .toBe("agent-dag");
    expect(invokedAs({ pkgRoot: "/usr/local/lib/node_modules/agents-deck", argv1: "/usr/local/bin/ccdeck", platform: "darwin" }))
      .toBe("ccdeck");
    expect(invokedAs({ pkgRoot: "/home/me/.npm-global/lib/node_modules/agents-deck", argv1: "/home/me/.npm-global/bin/agents-deck", platform: "linux" }))
      .toBe("agents-deck");
  });

  it("is not fooled by the package the bin lives in", () => {
    // THE regression. A globally installed `ccdeck` is a stub whose bin spawns
    // ../../agents-deck/bin/agent-dag.js, so the child's argv[1] is the real
    // path inside agents-deck — and the package that path names is the answer a
    // check on the package name would have given. It is the wrong answer: the
    // user typed ccdeck and must hear nothing at all.
    expect(invokedAs({
      pkgRoot: "/usr/local/lib/node_modules/agents-deck",
      argv1: "/usr/local/lib/node_modules/agents-deck/bin/agent-dag.js",
      platform: "darwin",
    })).toBeNull();
  });
});

describe("a global install on Windows — not knowable, so not guessed", () => {
  it("says nothing under every one of the three commands", () => {
    // npm writes <name>.cmd, <name>.ps1 and an extensionless sh shim, each
    // running `node "…\node_modules\agents-deck\bin\agent-dag.js" %*`. The
    // typed name is the shim's filename and never becomes an argument, so all
    // three commands arrive with byte-identical argv.
    const argv1 = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agents-deck\\bin\\agent-dag.js";
    const pkgRoot = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agents-deck";
    expect(invokedAs({ pkgRoot, argv1, platform: "win32" })).toBeNull();
  });

  it("refuses even an argv[1] that looks like a bare command there", () => {
    // Decided on the platform rather than on the shape of the path: there is no
    // arrangement of npm's shims that puts a typed name in argv[1] on Windows,
    // so one that looks like it did is something else, not evidence.
    expect(invokedAs({ pkgRoot: "C:\\npm\\node_modules\\agents-deck", argv1: "C:\\npm\\agent-dag", platform: "win32" }))
      .toBeNull();
  });
});

describe("a git checkout — nothing was typed", () => {
  it("says nothing for either entry point", () => {
    for (const argv1 of ["/home/me/src/ccdeck/bin/agent-dag.js", "/home/me/src/ccdeck/bin/deck.js"]) {
      expect(invokedAs({ pkgRoot: "/home/me/src/ccdeck", argv1, platform: "linux" }), argv1).toBeNull();
    }
  });
});

describe("knownCommand is the only thing that decides what counts as evidence", () => {
  it("takes the three published commands and nothing else", () => {
    for (const name of COMMANDS) expect(knownCommand(name)).toBe(name);
    for (const junk of ["agent-dag.js", "ccdeck.cmd", "deck.js", "node", "", "  ccdeck", null, undefined, 7, {}]) {
      expect(knownCommand(junk as never), String(junk)).toBeNull();
    }
  });

  it("lists exactly the commands an install of this package provides", () => {
    const bin = Object.keys(JSON.parse(read("package.json")).bin);
    expect([...COMMANDS].sort()).toEqual(bin.sort());
  });
});

describe("invokedName — the answer for a process that cannot ask", () => {
  const pkgRoot = "/usr/local/lib/node_modules/agents-deck";
  const worker = "/usr/local/lib/node_modules/agents-deck/bin/deck.js";

  it("takes the supervisor's answer out of the environment", () => {
    // bin/deck.js is spawned BY bin/agent-dag.js, so its own argv[1] is this
    // file under all three commands. The typed name reached the supervisor and
    // is handed down; without that the terminal row could never appear for a
    // global install.
    expect(invokedName({
      env: { AGENTS_DECK_INVOKED_AS: "agent-dag" }, pkgRoot, argv1: worker, platform: "linux",
    })).toBe("agent-dag");
  });

  it("treats the variable as the user input it is", () => {
    for (const value of ["", "yes", "1", "cowsay", "agent-dag.js"]) {
      expect(invokedName({ env: { AGENTS_DECK_INVOKED_AS: value }, pkgRoot, argv1: worker, platform: "linux" }), value)
        .toBeNull();
    }
  });

  it("still answers the npx half with no supervisor above it", () => {
    const root = npxCache("c1", { _npx: { packages: ["agent-dag"] } });
    expect(invokedName({ env: {}, pkgRoot: root, argv1: join(root, "bin", "deck.js"), platform: "linux" }))
      .toBe("agent-dag");
  });
});

describe("what gets said, and to whom", () => {
  it("says nothing at all to somebody who already types ccdeck", () => {
    // Asserted explicitly: this is the regression that would make the whole
    // feature actively harmful, since it fires at the users who migrated.
    expect(renameNotice({ invoked: "ccdeck", pkgRoot: "/usr/local/lib/node_modules/ccdeck" })).toBeNull();
    expect(renameNotice({ invoked: null, pkgRoot: "/home/me/src/ccdeck" })).toBeNull();
    expect(renameNotice({ invoked: undefined, pkgRoot: undefined })).toBeNull();
    expect(renameNotice({ invoked: "cowsay", pkgRoot: "/usr/local" })).toBeNull();
    expect(renameNotice()).toBeNull();
  });

  it("tells a global install that the command it wants is already there", () => {
    const notice = renameNotice({ invoked: "agents-deck", pkgRoot: "/usr/local/lib/node_modules/agents-deck" });
    expect(notice.said).toBe(`agents-deck still works — the deck is called ${PREFERRED} now`);
    // The line the whole notice is for: no reinstall, no download, six
    // different characters. Handing them an install command they do not need
    // would be work we invented for them.
    expect(notice.fix).toBe(`${PREFERRED} already works here — same install, no download`);
    expect(notice.fix).not.toMatch(/npm i|npm install|npx/);
  });

  it("tells an npx run the command instead, because there is no install to point at", () => {
    const notice = renameNotice({ invoked: "agent-dag", pkgRoot: "/home/me/.npm/_npx/9a1c/node_modules/agents-deck" });
    expect(notice.fix).toBe(`next time: npx ${PREFERRED}`);
  });

  it("leads with the reassurance, in both surfaces, and never raises its voice", () => {
    // Nothing is breaking, no command is being taken away, and the notice has
    // to read that way or it is a lie about severity. The browser half is
    // written in App.tsx (React cannot be rendered here) so it is read as text.
    const app = read("src", "web", "App.tsx");
    for (const name of ["agents-deck", "agent-dag"]) {
      const notice = renameNotice({ invoked: name, pkgRoot: "/usr/local/lib/node_modules/agents-deck" });
      expect(notice.said.startsWith(`${name} still works`), name).toBe(true);
      expect(`${notice.said} ${notice.fix}`).not.toMatch(/[!]/);
    }
    expect(app).toContain("{oldName} still works — the deck is called {PRODUCT} now.");
    // Only the first line is written in App.tsx. The second one is renameNotice's
    // `fix`, handed over by /api/version — see "one fact, one place" below for
    // why it stopped being written twice.
    expect(app).toContain("{version.renameFix}");
    expect(app).not.toMatch(/deprecated/i);
  });

  it("takes its dash from the caller's glyph tier", () => {
    // An em dash is as absent from a legacy Windows console as a check mark is,
    // which is why bin/deck.js passes G.dash rather than typing one.
    const ascii = renameNotice({ invoked: "agent-dag", pkgRoot: "/usr/local", dash: glyphs(false).dash });
    expect(ascii.said).toContain(" - ");
    expect(`${ascii.said} ${ascii.fix}`).toBe(stripAnsi(`${ascii.said} ${ascii.fix}`));
    expect(`${ascii.said} ${ascii.fix}`).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("the terminal row it becomes", () => {
  // bin/deck.js's own list and its own row(), rebuilt from the same term.mjs
  // primitives — the file is a script that starts a server, so it cannot be
  // imported here, and term-layout.test.ts keeps its copy of LABELS the same
  // way.
  const LABELS = [
    "workspace", "Claude hooks", "Codex sessions", "claude-swap", "accounts",
    "ccusage", "update", "name", "server ready", "log",
  ];
  const width = labelColumn(LABELS);

  it("moves no other row, because `name` is shorter than every existing label", () => {
    // The order matters and the line breaks do not (#378). This used to be the
    // array literal byte for byte, so reflowing it across two lines — which
    // moves no row anywhere — failed a test named for the rows not moving.
    expect(read("bin", "deck.js"), "the `name` row left its place in deck.js' label list")
      .toMatch(/"ccusage",\s*"update",\s*"name",\s*"server ready",\s*"log",/);
    expect(width).toBe("Codex sessions".length);
  });

  it("fits an 80-column terminal without losing a word to the ellipsis", () => {
    const G = glyphs(true);
    for (const pkgRoot of ["/usr/local/lib/node_modules/agents-deck", "/home/me/.npm/_npx/9a1c/node_modules/agents-deck"]) {
      const notice = renameNotice({ invoked: "agents-deck", pkgRoot, dash: G.dash });
      for (const [label, detail] of [["name", notice.said], ["", notice.fix]]) {
        const line = statusLine({ mark: label ? G.warn : " ", label, detail, labelWidth: width, columns: 80 });
        expect(line, detail).toContain(detail);
        expect(line).not.toContain(G.ellipsis);
      }
    }
  });

  it("writes not one escape into a pipe, at either glyph tier", () => {
    for (const unicode of [true, false]) {
      const G = glyphs(unicode);
      const P = palette("none");
      const notice = renameNotice({ invoked: "agent-dag", pkgRoot: "/usr/local", dash: G.dash });
      const line = statusLine({
        mark: G.warn, label: "name", detail: notice.said, labelWidth: width, columns: 80,
        paint: { mark: (s: string) => `${P.warn}${s}${P.reset}`, detail: (s: string) => `${P.muted}${s}${P.reset}` },
      });
      expect(line).toBe(stripAnsi(line));
    }
  });
});

describe("the wiring, which is the half no pure function can hold", () => {
  const supervisor = read("bin", "agent-dag.js");
  const worker = read("bin", "deck.js");
  const server = read("src", "server", "index.mjs");
  const app = read("src", "web", "App.tsx");

  it("resolves the name in the only process whose argv[1] carries it", () => {
    // Matched as a shape rather than as 78 characters of argument list (#378):
    // the three arguments and where they come from are the fact, and a call
    // broken across four lines by a formatter is the same call. Still fails if
    // any argument changes or the call moves out of the supervisor.
    expect(supervisor, "the supervisor stopped resolving the invoked name from its own argv")
      .toMatch(/invokedAs\(\{\s*pkgRoot:\s*PKG_ROOT,\s*argv1:\s*process\.argv\[1\],\s*platform:\s*process\.platform,?\s*\}\)/);
    expect(supervisor, "the resolved name no longer reaches the worker's environment")
      .toMatch(/AGENTS_DECK_INVOKED_AS:\s*INVOKED_AS\s*\?\?\s*""/);
    // AGENTS_DECK_*, like every other variable the deck reads — display-name
    // .test.ts owns that boundary and this is the new one it applies to.
    expect(worker).toContain("invokedName({ pkgRoot: PKG_ROOT })");
    expect(worker).not.toContain("process.argv[1]");
  });

  it("warns and returns, rather than refusing to run", () => {
    // The catastrophic version of this feature: a user on agents-deck clicks
    // "Update & restart", the copy that arrives declines to boot, and the deck
    // is dead on the machine where the deck is what would have explained why.
    // So the block that prints it writes rows and does nothing else.
    const block = worker.slice(worker.indexOf("const rename = renameNotice("));
    const stanza = block.slice(0, block.indexOf("\n}"));
    expect(stanza).toContain("write(row(");
    expect(stanza).not.toMatch(/process\.exit|throw |exitCode/);
  });

  it("reports it beside the version rather than inside `name`", () => {
    // `name` is the package an upgrade installs and the update flow hangs off
    // it; for a global install that is the published package whichever bin was
    // typed, so the two answers are genuinely different questions.
    expect(server).toContain("const invoked = invokedName({ pkgRoot: PKG_ROOT });");
    expect(server).toContain("invokedAs: invoked");
    expect(read("src", "server", "self-update.mjs")).toContain("name: target,");
  });

  it("dismisses the browser notice per name, not with a flag", () => {
    // Somebody who dismisses it under agent-dag and later starts a second
    // install as agents-deck has not heard this yet.
    //
    // Four fragments, matched as patterns (#378). What each one owns: the key
    // string, which every other version of the deck also wrote and so may not
    // be renamed; that the NAME is what gets stored, not a boolean; that the
    // comparison is against that name; and that the banner is gated on the
    // invoked name differing from the product. None of that moves when the
    // surrounding code is reformatted, and all of it fails if the per-name
    // dismissal goes back to being a flag.
    expect(app, "the dismissal key was renamed, which silently un-dismisses everyone")
      .toMatch(/const OLD_NAME_DISMISSED_KEY\s*=\s*"agent-dag\.oldNameNoticeDismissed"/);
    expect(app, "the dismissal stores something other than the name it dismissed")
      .toMatch(/localStorage\.setItem\(\s*OLD_NAME_DISMISSED_KEY\s*,\s*oldName\s*\)/);
    expect(app, "the notice no longer compares the dismissal against the current name")
      .toMatch(/oldNameDismissed\s*!==\s*oldName/);
    expect(app, "the notice no longer keys off the name the deck was invoked as")
      .toMatch(/version\.invokedAs\s*!==\s*PRODUCT/);
  });
});

// #363. The notice ends on one of two sentences — "type ccdeck, it is already
// there" for an install that put all three commands on the PATH, and "next
// time: npx ccdeck" where no such install exists — and the browser used to
// pick between them itself, off `upgradeMode`. That field sounds like the same
// question and is a different one: it answers whether an in-app `npm i -g` is
// allowed, and upgradeBlockedReason tests the opt-out FIRST, so
// `AGENTS_DECK_NO_INSTALL=1` flattens it to null for an npx run exactly as it
// does for a global one. Every npx user with that variable set was therefore
// told the global-install line and sent to a command their machine does not
// have — while the terminal row, which asks isNpxInstall directly, printed the
// right one a few lines above. Two surfaces, one fact, opposite answers.
describe("one fact, one place: which line the rename notice ends with", () => {
  const app = read("src", "web", "App.tsx");
  const server = read("src", "server", "index.mjs");

  // The JSX comments carry the reasoning, including the name of the field this
  // must no longer branch on, so the assertion below reads the code only.
  const withoutComments = (jsx: string) => jsx.replace(/\{\/\*[^]*?\*\/\}/g, "");
  const bannerJsx = () => {
    const start = app.indexOf("oldNameOpen && oldName ? (");
    expect(start, "the rename banner moved — this test needs a new anchor").toBeGreaterThan(-1);
    return app.slice(start, app.indexOf("dismissOldName}", start));
  };

  /** Runs `body` with one AGENTS_DECK_* variable set, and puts it back. These
   *  are read through process.env at call time by design — display-name.test.ts
   *  owns that boundary — so the only way to ask the question is to set it. */
  function withEnv(key: string, value: string | undefined, body: () => void) {
    const was = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try { body(); } finally {
      if (was === undefined) delete process.env[key];
      else process.env[key] = was;
    }
  }

  it("still says npx under the opt-out that flattens upgradeMode to null", () => {
    // THE regression, in the two functions that disagreed. An npx cache
    // directory, a user who has turned installs off, and the two answers side
    // by side: `upgradeMode` goes null — correctly, it is being asked whether
    // it may install — while the sentence the user reads stays npx.
    const pkgRoot = npxCache("d1", { _npx: { packages: ["agents-deck"] } });
    withEnv("AGENTS_DECK_NO_INSTALL", "1", () => {
      expect(upgradeBlock(pkgRoot)).toBe("opted_out");
      expect(upgradeMode(upgradeBlock(pkgRoot))).toBeNull();
      expect(renameNotice({ invoked: "agents-deck", pkgRoot }).fix).toBe(`next time: npx ${PREFERRED}`);
    });
  });

  it("is not affected by AGENTS_DECK_NO_UPDATE_CHECK, which only silences npm", () => {
    // Worth pinning because the two variables read like a pair and are not:
    // versionReport checks both before asking the registry, but upgradeBlock
    // reads only NO_INSTALL, so the update-check opt-out never reached this bug.
    const pkgRoot = npxCache("d2", { _npx: { packages: ["agent-dag"] } });
    withEnv("AGENTS_DECK_NO_UPDATE_CHECK", "1", () => {
      expect(upgradeMode(upgradeBlock(pkgRoot))).toBe("npx");
    });
  });

  it("follows the directory this copy runs from, whatever the environment says", () => {
    // The whole matrix: the advice is a fact about the install, so no variable
    // may move it. `_npx` in the path or not — that is the entire question.
    const cache = npxCache("d3", { _npx: { packages: ["agent-dag"] } });
    const shapes: [string, string, string][] = [
      ["npx", cache, `next time: npx ${PREFERRED}`],
      ["global", "/usr/local/lib/node_modules/agents-deck", `${PREFERRED} already works here — same install, no download`],
      ["global (windows)", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\agents-deck", `${PREFERRED} already works here — same install, no download`],
    ];
    for (const value of [undefined, "1"]) {
      withEnv("AGENTS_DECK_NO_INSTALL", value, () => {
        for (const [label, pkgRoot, fix] of shapes) {
          expect(renameNotice({ invoked: "agent-dag", pkgRoot }).fix, `${label} / ${value}`).toBe(fix);
        }
      });
    }
  });

  it("exists for every shape that shows the banner at all", () => {
    // The browser now renders the server's sentence or nothing, so a shape that
    // reaches the banner with no sentence to end it would be a half-drawn
    // notice. There is none: both sides answer off the same `invoked`.
    const cache = npxCache("d4", { _npx: { packages: ["ccdeck"] } });
    const shapes: [string, string | null][] = [
      [cache, invokedAs({ pkgRoot: cache, argv1: join(cache, "bin", "agent-dag.js"), platform: "linux" })],
      ["/usr/local/lib/node_modules/agents-deck", "agents-deck"],
      ["/usr/local/lib/node_modules/agents-deck", "agent-dag"],
      ["/usr/local/lib/node_modules/agents-deck", null],
      ["/home/me/src/ccdeck", null],
    ];
    for (const [pkgRoot, invoked] of shapes) {
      const banner = invoked !== null && invoked !== PRODUCT;
      expect(renameNotice({ invoked, pkgRoot }) !== null, `${pkgRoot} / ${invoked}`).toBe(banner);
    }
  });

  it("is computed once, on the server, by the function the terminal already calls", () => {
    expect(server).toContain('import { invokedName, renameNotice } from "./invoked-as.mjs";');
    expect(server).toContain("const rename = renameNotice({ invoked, pkgRoot: PKG_ROOT });");
    expect(server).toContain("renameFix: rename?.fix ?? null");
    // No `dash`: the glyph tier is a terminal concern and the default is the em
    // dash a browser should get. bin/deck.js is the only caller that passes one.
    expect(server).not.toMatch(/renameNotice\(\{[^}]*dash/);
  });

  it("is rendered by the browser, not decided there", () => {
    const jsx = bannerJsx();
    expect(jsx).toContain('{version?.renameFix ? <span className="ver-sub">{version.renameFix}</span> : null}');
    expect(app).toContain("renameFix?: string | null;");
    // The branch itself is gone, not merely corrected — this is the assertion
    // that stops the next person deriving the same fact from the same field.
    expect(withoutComments(jsx)).not.toContain("upgradeMode");
    // …and with it both sentences, which now exist once, in invoked-as.mjs.
    expect(app).not.toContain("already works here");
    expect(app).not.toMatch(/Run npx|npx \$\{PRODUCT\}/);
  });
});

describe("the name the deck asks people to type", () => {
  it("is the same string the product calls itself, on both sides", () => {
    // They are one word by design (#324) and nothing but a test keeps them
    // there: App.tsx compares `invokedAs` against PRODUCT, so a PREFERRED that
    // drifted would leave the browser silently telling ccdeck users to run
    // ccdeck.
    expect(PREFERRED).toBe(PRODUCT);
    expect(PREFERRED).toBe(SERVER_PRODUCT);
  });

  it("is not the package the upgrade installs, which is still agents-deck", () => {
    // The line brand.ts draws: this one is a command a human types, and the
    // registry query and `npm i -g` beside it name a package.
    //
    // The DEFAULT is the fact — it is what the update flow installs when
    // nothing overrides it — not the signature's line breaks (#378). Reflowing
    // the parameters across three lines used to fail this and display-name
    // .test.ts, which asserts the same default, at once.
    expect(read("src", "server", "self-update.mjs"), "the upgrade stopped defaulting to the published package")
      .toMatch(/export function upgradeName\(\s*pkgRoot,\s*name\s*=\s*"agents-deck",?\s*\)/);
    expect(JSON.parse(read("package.json")).name).toBe("agents-deck");
  });
});
