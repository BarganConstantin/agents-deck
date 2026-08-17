// CODEX_HOME had five readers in three spellings, and they disagreed about two
// values a shell profile produces by accident (#375).
//
//   index.mjs        CODEX_HOME ? resolve(CODEX_HOME) : join(homedir(), ".codex")
//   installer.mjs    the same
//   codex-usage.mjs  CODEX_HOME ? CODEX_HOME         : join(homedir(), ".codex")
//   codex-auth.mjs   CODEX_HOME ?? join(homedir(), ".codex")
//   codex-quota.mjs  the same
//
// `??` falls back on null and undefined only, so the last two kept an empty
// CODEX_HOME — what `export CODEX_HOME=$SOME_UNSET_VAR` leaves behind — and then
// joined onto it. join("", "auth.json") is "auth.json", a CWD-RELATIVE path, and
// codex-auth.mjs is the module that writes OpenAI's single-use rotated refresh
// token back to disk: writing it to whatever directory the deck was started from
// does not lose a read, it burns the credential and costs the user a
// `codex login`. Meanwhile three of the five kept a relative CODEX_HOME
// verbatim, so it was re-resolved against the CWD at every readdir() instead of
// once at startup, and two modules read a different tree than the other three.
//
// THE TABLE IS THE POINT OF THIS FILE. Six shapes an environment variable can
// actually take — unset, empty, whitespace-only, relative, symlinked, trailing
// separator — crossed with every reader, all in one place, so a sixth reader
// added tomorrow with a spelling of its own has somewhere to fail.
//
// Each row's expected directory is written out here rather than obtained from
// the module under test: an expectation computed by calling codexHome() would
// agree with any rule at all, including the broken ones above.
//
// Everything runs against a temp sandbox — HOME, USERPROFILE, CLAUDE_CONFIG_DIR
// and CODEX_HOME all point inside it — so no assertion here can be satisfied, or
// contaminated, by the developer's own ~/.codex, and nothing can write a
// credential outside the temp directory.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-codex-home-"));
const FAKE_HOME = join(SANDBOX, "home");
// The fallback every "not really set" shape has to land on: $HOME/.codex.
const DEFAULT_CODEX = join(FAKE_HOME, ".codex");
// One directory per shape that names a real one, so a row cannot pass on
// fixtures another row seeded. The relative row's name carries a space on
// purpose: trimming the variable must not touch the inside of a path, and
// "Application Support"-style directories are the common case on macOS.
const RELATIVE_CODEX = join(SANDBOX, "relative codex home");
const TRAILING_CODEX = join(SANDBOX, "trailing-codex");
const LINK_TARGET = join(SANDBOX, "link-target");
const LINK_CODEX = join(SANDBOX, "linked-codex");

const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const PREV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) PREV[k] = process.env[k];
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, "claude-config");
delete process.env.CODEX_HOME;

mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(LINK_TARGET, { recursive: true });
// "junction" is ignored on POSIX and is the one link type Windows creates
// without elevation or Developer Mode, so the symlink row runs on all three.
symlinkSync(LINK_TARGET, LINK_CODEX, "junction");

// Refuse to run at all rather than write a credential into the developer's real
// home. node's homedir() reads $HOME on POSIX and %USERPROFILE% on Windows, and
// both were just pointed into the sandbox — if that did not take, every "falls
// back to ~/.codex" row below would be seeding and asserting against the real
// one.
if (homedir() !== FAKE_HOME) {
  throw new Error(`refusing to run: homedir() is ${homedir()}, outside ${SANDBOX}`);
}

// No test here has any business reaching the network. codex-quota's only path to
// fetch() is a config.toml it failed to find, so a request escaping this stub is
// itself the bug — it means the module read the wrong directory.
vi.stubGlobal("fetch", async (url: unknown) => {
  throw new Error(`refusing to make a network request to ${String(url)}`);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  vi.unstubAllGlobals();
  rmSync(SANDBOX, { recursive: true, force: true });
});

// codex-dir.mjs is the module this issue adds, and it is imported defensively so
// that against the pre-fix source this file still reports one named failure per
// broken reader instead of collapsing into a single "cannot resolve module"
// collection error — which is the difference between knowing what regressed and
// knowing only that something did.
let codexDir: {
  codexHome: (env?: NodeJS.ProcessEnv, home?: string, platform?: string) => string;
  codexSessionsDir: (env?: NodeJS.ProcessEnv, home?: string, platform?: string) => string;
  walkRolloutDays: (
    onDay: (dir: string, files: string[]) => unknown,
    opts?: { sessionsDir?: string; onYear?: (year: string) => unknown },
  ) => Promise<void>;
  STOP: symbol;
} | null = null;
try {
  // @ts-expect-error — .mjs server module, no types
  codexDir = await import("../../server/codex-dir.mjs");
} catch {
  codexDir = null;
}
/** The shared module, or a failed assertion naming it. Never a thrown TypeError. */
function dir() {
  expect(codexDir, "src/server/codex-dir.mjs does not exist — nothing owns the rule").not.toBeNull();
  return codexDir!;
}

// ── the fixtures every reader is given ─────────────────────────────────────
// One set per shape, planted in the directory that shape is supposed to resolve
// to. A reader that resolves anywhere else finds nothing, which is exactly the
// production failure: the file is there, and the module is looking elsewhere.

const ISO = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

// The fixtures are stamped with a marker taken from the DIRECTORY, not from the
// shape — so the three shapes that must all fall back to ~/.codex produce rows
// that are byte-identical, which is the claim, while a reader that strayed into
// another shape's directory still reads back somebody else's marker.
const markerFor = (home: string) => basename(home).replace(/\W+/g, "") || "root";

function seed(target: string, marker: string) {
  // Cleared rather than added to: three shapes share ~/.codex, and a rollout
  // left behind by the previous one would be counted a second time.
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  // No refresh_token: getCodexAuth() must not be tempted to spend one, and the
  // account id is per-shape so a stale module instance cannot pass by accident.
  writeFileSync(
    join(target, "auth.json"),
    JSON.stringify({ tokens: { access_token: `token-${marker}`, account_id: `acct-${marker}` } }),
  );
  // A base URL that is not OpenAI's. codex-quota refuses it before the first
  // byte goes out, so "did it read THIS config.toml" is answerable without a
  // network request: found → untrusted_base_url, not found → the default base,
  // which is trusted, and the fetch stub above turns that into a loud failure.
  writeFileSync(join(target, "config.toml"), 'chatgpt_base_url = "http://relay.invalid/x"\n');

  // One rollout, one minute old, in the tree codex-usage aggregates from.
  const at = new Date(Date.now() - 60_000);
  const [y, m, d] = ISO(at).slice(0, 10).split("-");
  const dayDir = join(target, "sessions", y, m, d);
  mkdirSync(dayDir, { recursive: true });
  const stamp = ISO(at).replace(/:/g, "-").replace("Z", "");
  writeFileSync(
    join(dayDir, `rollout-${stamp}-0000dead-beef-4000-8000-000000000001.jsonl`),
    JSON.stringify({
      timestamp: ISO(at),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, total_tokens: 150 } },
      },
    }) + "\n",
  );
}

type Shape = {
  name: string;
  /** What the variable literally holds; `undefined` means it is not set at all. */
  value: string | undefined;
  /** The directory every reader must land on, spelled independently of the fix. */
  home: string;
  /** Where the fixtures physically live, when the link and its target differ. */
  fixtures?: string;
};

// `relative()` returns an absolute path when the two paths are on different
// Windows drives, which is the one machine where this row degenerates into a
// second absolute case rather than testing a relative one. The win32 half of the
// rule table below covers the lexical rule there instead.
const RELATIVE_VALUE = relative(process.cwd(), RELATIVE_CODEX);

const SHAPES: Shape[] = [
  { name: "unset",                  value: undefined,             home: DEFAULT_CODEX },
  { name: "empty string",           value: "",                    home: DEFAULT_CODEX },
  { name: "whitespace only",        value: "   ",                 home: DEFAULT_CODEX },
  { name: "relative path",          value: RELATIVE_VALUE,        home: RELATIVE_CODEX },
  { name: "symlinked path",         value: LINK_CODEX,            home: LINK_CODEX, fixtures: LINK_TARGET },
  { name: "trailing separator",     value: TRAILING_CODEX + sep,  home: TRAILING_CODEX },
];

type Row = {
  /** $CODEX_HOME/sessions as the rollout watcher in index.mjs tails it. */
  watcher: string;
  /** $CODEX_HOME as installer.mjs takes hooks.json out of it. */
  installer: string;
  /** The account id codex-auth.mjs read, proving which auth.json it opened. */
  authAccount: string | null;
  /** codex-quota.mjs's verdict, proving which config.toml it opened. */
  quotaReason: string | null;
  /** Sessions codex-usage.mjs counted, proving which rollout tree it walked. */
  usageSessions: number;
};

/** Load all five readers fresh under one shape and record what each resolved. */
async function probe(shape: Shape): Promise<Row> {
  seed(shape.fixtures ?? shape.home, markerFor(shape.home));

  if (shape.value === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = shape.value;
  // Every reader resolves its directory once, at module load — which is why the
  // module registry has to be dropped between shapes rather than the variable
  // merely reassigned.
  vi.resetModules();

  // @ts-expect-error — .mjs server module, no types
  const index = await import("../../server/index.mjs");
  // @ts-expect-error — .mjs server module, no types
  const installer = await import("../../server/installer.mjs");
  // @ts-expect-error — .mjs server module, no types
  const auth = await import("../../server/codex-auth.mjs");
  // @ts-expect-error — .mjs server module, no types
  const quota = await import("../../server/codex-quota.mjs");
  // @ts-expect-error — .mjs server module, no types
  const usage = await import("../../server/codex-usage.mjs");

  const seen = await auth.getCodexAuth({ allowRefresh: false });
  const q = await quota.fetchCodexQuota({ force: true });
  const u = await usage.fetchCodexUsage({ force: true });

  return {
    watcher: String(index.CODEX_SESSIONS_DIR),
    installer: String(installer.CODEX_DIR),
    authAccount: seen?.accountId ?? null,
    quotaReason: q?.reason ?? null,
    usageSessions: u?.window7d?.sessionCount ?? 0,
  };
}

const rows = new Map<string, Row>();
for (const shape of SHAPES) rows.set(shape.name, await probe(shape));

describe("every CODEX_HOME reader, against every shape the variable can take", () => {
  for (const shape of SHAPES) {
    describe(`CODEX_HOME = ${shape.value === undefined ? "(unset)" : JSON.stringify(shape.value)}`, () => {
      const marker = markerFor(shape.home);

      it("the rollout watcher in index.mjs tails $CODEX_HOME/sessions", () => {
        expect(rows.get(shape.name)!.watcher).toBe(join(shape.home, "sessions"));
      });

      it("the hook installer takes hooks.json out of the same $CODEX_HOME", () => {
        expect(rows.get(shape.name)!.installer).toBe(shape.home);
      });

      it("codex-auth reads the auth.json that is there, not a CWD-relative one", () => {
        // The row that used to fail. Under `??` an empty CODEX_HOME survived as
        // "", and this module opened "auth.json" in whatever directory the deck
        // was launched from — then WROTE the rotated refresh token back to it.
        expect(rows.get(shape.name)!.authAccount).toBe(`acct-${marker}`);
      });

      it("codex-quota reads the config.toml that is there, and refuses its base URL", () => {
        // Proof of which config.toml was opened, taken without a network
        // request: the seeded base URL is not an OpenAI host, so the module
        // reports the refusal instead of sending a live ChatGPT token anywhere.
        // Any other verdict means it read a config.toml this test did not write.
        expect(rows.get(shape.name)!.quotaReason).toBe("untrusted_base_url");
      });

      it("codex-usage aggregates the rollout tree under the same $CODEX_HOME", () => {
        expect(rows.get(shape.name)!.usageSessions).toBe(1);
      });
    });
  }

  it("resolves all five readers to one directory per shape", () => {
    // The consolidated statement of the table: whatever else changes, the five
    // readers may not disagree with each other on any row.
    for (const shape of SHAPES) {
      const row = rows.get(shape.name)!;
      expect(row.watcher, shape.name).toBe(join(shape.home, "sessions"));
      expect(row.installer, shape.name).toBe(shape.home);
      expect(row.authAccount, shape.name).toBe(`acct-${markerFor(shape.home)}`);
      expect(row.quotaReason, shape.name).toBe("untrusted_base_url");
      expect(row.usageSessions, shape.name).toBe(1);
    }
  });
});

describe("an empty CODEX_HOME is not a path", () => {
  it("falls back to ~/.codex rather than naming the current directory", () => {
    // `export CODEX_HOME=$SOME_UNSET_VAR` in a profile produces exactly this,
    // and there is no user who means "keep my Codex credentials in $PWD" and
    // spells it by leaving the variable empty.
    expect(rows.get("empty string")!.installer).toBe(DEFAULT_CODEX);
    expect(rows.get("empty string")!.watcher).toBe(join(DEFAULT_CODEX, "sessions"));
  });

  it("agrees with an unset CODEX_HOME on every reader", () => {
    expect(rows.get("empty string")).toEqual(rows.get("unset"));
  });

  it("treats a whitespace-only value the same way", () => {
    // The same accident with a stray space in the profile line.
    expect(rows.get("whitespace only")).toEqual(rows.get("unset"));
  });
});

describe("a relative CODEX_HOME is resolved once, not at every read", () => {
  it("becomes an absolute path before any reader touches the disk", () => {
    expect(isAbsolute(rows.get("relative path")!.installer)).toBe(true);
    expect(rows.get("relative path")!.installer).toBe(RELATIVE_CODEX);
  });

  it("survives a space inside the path", () => {
    // Trimming the variable must not reach inside it. `~/Library/Application
    // Support/...` is the ordinary case on macOS, and `C:\Program Files\...` on
    // Windows.
    expect(RELATIVE_CODEX).toContain(" ");
    expect(rows.get("relative path")!.usageSessions).toBe(1);
  });
});

describe("a symlinked CODEX_HOME", () => {
  it("stays spelled the way the user spelled it", () => {
    // resolve() deliberately does not canonicalise. ~/.codex is often a link
    // into a dotfiles repo or an encrypted volume, and renaming onto the link's
    // TARGET instead of through the link is the failure codex-auth resolves
    // symlinks at write time to avoid.
    expect(rows.get("symlinked path")!.installer).toBe(LINK_CODEX);
    expect(rows.get("symlinked path")!.installer).not.toBe(LINK_TARGET);
  });

  it("still reads the files on the other side of the link", () => {
    expect(rows.get("symlinked path")!.authAccount).toBe(`acct-${markerFor(LINK_CODEX)}`);
    expect(rows.get("symlinked path")!.usageSessions).toBe(1);
  });
});

describe("a trailing separator on CODEX_HOME", () => {
  it("is dropped, so no path is built with a doubled separator", () => {
    expect(rows.get("trailing separator")!.installer).toBe(TRAILING_CODEX);
    expect(rows.get("trailing separator")!.watcher).toBe(join(TRAILING_CODEX, "sessions"));
    expect(rows.get("trailing separator")!.watcher).not.toContain(sep + sep);
  });
});

// ── the rule itself, on machines this developer is not sitting at ──────────
// Path resolution is the one kind of rule whose Windows answer cannot be
// inferred from its POSIX answer: separators, drive letters and case all differ.
// The platform is a parameter for exactly that reason, the same way exec.mjs and
// claudeCliCandidates() take one.

describe("codexHome() as a pure rule, per platform", () => {
  const POSIX_HOME = "/home/u";
  const WIN_HOME = "C:\\Users\\u";

  const posix = (v?: string) =>
    dir().codexHome(v === undefined ? {} : { CODEX_HOME: v }, POSIX_HOME, "linux");
  const win = (v?: string) =>
    dir().codexHome(v === undefined ? {} : { CODEX_HOME: v }, WIN_HOME, "win32");

  it("falls back to ~/.codex for every shape that is not really a path", () => {
    for (const v of [undefined, "", "   ", "\t", "\n "]) {
      expect(posix(v), JSON.stringify(v)).toBe("/home/u/.codex");
      expect(win(v), JSON.stringify(v)).toBe("C:\\Users\\u\\.codex");
    }
  });

  it("builds the fallback with the target platform's separator, not the host's", () => {
    // The whole reason the platform is a parameter: node's own `join` would emit
    // forward slashes for the Windows answer when this runs on a Mac.
    expect(win()).toBe("C:\\Users\\u\\.codex");
    expect(win()).not.toContain("/");
    expect(posix()).not.toContain("\\");
  });

  it("drops a trailing separator on both platforms", () => {
    expect(posix("/srv/codex/")).toBe("/srv/codex");
    expect(win("D:\\codex\\")).toBe("D:\\codex");
  });

  it("keeps a Windows drive letter, and its case", () => {
    // Windows compares paths case-insensitively but STORES the case it was
    // given, and a reader that lowercased would make every path it printed
    // wrong-looking to the user who typed it.
    expect(win("D:\\Codex\\Home")).toBe("D:\\Codex\\Home");
    expect(win("D:/Codex/Home")).toBe("D:\\Codex\\Home");
  });

  it("does not follow symlinks on either platform", () => {
    expect(posix("/srv/link-to-codex")).toBe("/srv/link-to-codex");
    expect(win("D:\\link-to-codex")).toBe("D:\\link-to-codex");
  });

  it("makes a relative value absolute", () => {
    const got = posix("codex-rel");
    expect(got.startsWith("/")).toBe(true);
    expect(got.endsWith("/codex-rel")).toBe(true);
  });

  it("leaves whitespace inside a path alone", () => {
    expect(posix("/srv/my codex")).toBe("/srv/my codex");
    expect(win("C:\\Program Files\\codex")).toBe("C:\\Program Files\\codex");
    // Only the ends are trimmed, and only because the ends are where a profile
    // line puts an accident.
    expect(posix("  /srv/my codex  ")).toBe("/srv/my codex");
  });

  it("hangs sessions/ off whatever it answered", () => {
    expect(dir().codexSessionsDir({ CODEX_HOME: "/srv/codex/" }, POSIX_HOME, "linux")).toBe("/srv/codex/sessions");
    expect(dir().codexSessionsDir({}, WIN_HOME, "win32")).toBe("C:\\Users\\u\\.codex\\sessions");
  });

  it("reads the real machine's environment when given no arguments", () => {
    // The default arguments are what every caller in the deck uses; a rule that
    // only worked when injected would be a rule nothing runs.
    delete process.env.CODEX_HOME;
    expect(dir().codexHome()).toBe(DEFAULT_CODEX);
  });
});

// ── one reader, and nothing keeping a private spelling ─────────────────────

describe("where CODEX_HOME is allowed to be read", () => {
  const SERVER = fileURLToPath(new URL("../../server", import.meta.url));
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

  /** Source lines with `//`- and `*`-prefixed comment lines removed. */
  const codeLines = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(l => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      });

  const shipped = () => {
    const files = readdirSync(SERVER).filter(f => f.endsWith(".mjs")).map(f => join(SERVER, f));
    for (const rel of ["bin/deck.js", "bin/agent-dag.js", "hook/hook.js"]) {
      try { readFileSync(join(ROOT, rel), "utf8"); files.push(join(ROOT, rel)); }
      catch { /* renamed or gone; the directory scan above is the load-bearing half */ }
    }
    return files;
  };

  it("is codex-dir.mjs, and nowhere else in the shipped source", () => {
    // Five modules answering the same question for themselves is what produced
    // three spellings of it; one module answering it is what stops the sixth.
    const offenders = shipped()
      .filter(f => !f.endsWith(`${sep}codex-dir.mjs`))
      .filter(f => codeLines(f).some(l => l.includes("process.env.CODEX_HOME")))
      .map(f => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("is never spelled with ??, which keeps an empty value", () => {
    const offenders = shipped()
      .filter(f => codeLines(f).some(l => /CODEX_HOME\s*\?\?/.test(l)))
      .map(f => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("is imported from codex-dir.mjs by every module that needs it", () => {
    for (const name of ["index.mjs", "installer.mjs", "codex-auth.mjs", "codex-quota.mjs", "codex-usage.mjs"]) {
      const src = readFileSync(join(SERVER, name), "utf8");
      expect(src, `${name} does not import from codex-dir.mjs`).toMatch(/from "\.\/codex-dir\.mjs"/);
    }
  });
});

// ── the walk the three entry points share ──────────────────────────────────

describe("walkRolloutDays", () => {
  const TREE = join(SANDBOX, "walk", "sessions");
  const day = (y: string, m: string, d: string, files: string[]) => {
    mkdirSync(join(TREE, y, m, d), { recursive: true });
    for (const f of files) writeFileSync(join(TREE, y, m, d, f), "");
  };
  day("2025", "12", "31", ["rollout-a.jsonl"]);
  day("2026", "01", "02", ["rollout-b.jsonl"]);
  day("2026", "08", "14", ["rollout-c.jsonl", "notes.txt"]);
  mkdirSync(join(TREE, "latest"), { recursive: true });

  it("visits day directories newest first", async () => {
    const seen: string[] = [];
    await dir().walkRolloutDays(d => { seen.push(relative(TREE, d)); }, { sessionsDir: TREE });
    expect(seen).toEqual([join("2026", "08", "14"), join("2026", "01", "02"), join("2025", "12", "31")]);
  });

  it("hands over every entry in the day, filtering nothing", async () => {
    // The three callers keep different files — by session id, by extension, by
    // filename timestamp — so the walk must not decide for them.
    const seen: string[] = [];
    await dir().walkRolloutDays((_d, files) => { seen.push(...files); }, { sessionsDir: TREE });
    expect(seen.sort()).toEqual(["notes.txt", "rollout-a.jsonl", "rollout-b.jsonl", "rollout-c.jsonl"]);
  });

  it("stops the moment a visitor says so", async () => {
    const seen: string[] = [];
    await dir().walkRolloutDays(
      d => { seen.push(relative(TREE, d)); return dir().STOP; },
      { sessionsDir: TREE },
    );
    expect(seen).toEqual([join("2026", "08", "14")]);
  });

  it("stops on a year the caller has ruled out, without opening it", async () => {
    const seen: string[] = [];
    await dir().walkRolloutDays(
      d => { seen.push(relative(TREE, d)); },
      { sessionsDir: TREE, onYear: y => (Number(y) < 2026 ? dir().STOP : undefined) },
    );
    expect(seen).toEqual([join("2026", "08", "14"), join("2026", "01", "02")]);
  });

  it("ignores names that are not a four-digit year", async () => {
    const seen: string[] = [];
    await dir().walkRolloutDays(d => { seen.push(d); }, { sessionsDir: TREE });
    expect(seen.some(d => d.includes("latest"))).toBe(false);
  });

  it("is silent on a machine where Codex has never run", async () => {
    // No sessions/ directory at all is not an error — it is a fresh install.
    const seen: string[] = [];
    await expect(
      dir().walkRolloutDays(d => { seen.push(d); }, { sessionsDir: join(SANDBOX, "no-such-tree") }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });
});
