// The rename to ccdeck, and the line it is not allowed to cross.
//
// The client kept introducing itself as agents-deck long after the repo, the
// command, the README and the terminal banner had stopped (#216, and #213 for
// the terminal half). What makes that a pinned boundary rather than a
// find-and-replace is that the old spellings are still load-bearing everywhere
// they are IDENTIFIERS rather than a name: the browser store is the
// `agent-dag.*` namespace, the state on disk is ~/.claude/agent-dag and
// ~/.agents-deck, the settings entries carry an `__agent-dag` mark, the
// variables are AGENTS_DECK_*, and npm publishes `agents-deck`.
//
// Renaming any of those fails silently, which is why it gets a test rather than
// a comment. A renamed storage key throws nothing and logs nothing — it reads
// as an empty store, so the first load after the upgrade discards the layout,
// the viewport and the pins of every existing user, and pruneStaleState (whose
// entire purpose is that the arrangement survives a version change) never sees
// the key it was watching. A moved directory orphans running decks from the
// hook that feeds them. A renamed AGENTS_DECK_NO_INSTALL turns an opt-out back
// on. So: the display name is asserted to be the new one on every surface that
// shows it, and each identifier is asserted, by name, to be the old one.
//
// Source text only — nothing here imports a module that touches the filesystem,
// so no HOME needs redirecting and no real ~/.claude is ever in reach.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PRODUCT } from "../brand";
import { ambientSignal } from "../ambient";
import { SCHEMA_KEY, SHAPE_KEYS } from "../storage";
import { PRODUCT as SERVER_PRODUCT } from "../../server/brand.mjs";
import { wordmark } from "../../server/term.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

/** Every source file the bundle is built from. The suite's own files are not it. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}
const client = sources(web).map(p => [p, readFileSync(p, "utf8")] as const);

/** What is left once the prose is gone. The boundary is explained in comments
 *  all over this codebase — including the JSX `{/* … *\/}` kind — and a comment
 *  naming the old spelling is the whole point of it being there. */
function codeLines(text: string): string[] {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l));
}

describe("the product's display name", () => {
  it("is ccdeck, and the server calls it the same thing", () => {
    expect(PRODUCT).toBe("ccdeck");
    expect(SERVER_PRODUCT).toBe(PRODUCT);
  });

  it("names the browser tab, which is static markup no constant can reach", () => {
    // index.html is parsed before any module runs, so this literal is the one
    // copy of the name that cannot be derived — hence pinned here instead.
    expect(read("src/web/index.html")).toContain(`<title>${PRODUCT}</title>`);
  });

  it("still names it the same thing once the deck starts writing the title", () => {
    // #338 gave the tab a second author: index.html's markup is the title until
    // the bundle runs, and ambientSignal owns it from the first SSE frame on.
    // Two authors, so two chances to drift — and the drift would be invisible
    // to whoever caused it, since the static name is only on screen for the
    // moment before the effect replaces it. Both directions are checked: the
    // resting title has to be the markup's name exactly, and the counted form
    // has to be the same name with a prefix rather than a second spelling.
    expect(ambientSignal({ waiting: 0, running: 0 }).title).toBe(PRODUCT);
    expect(read("src/web/index.html")).toContain(`<title>${ambientSignal({ waiting: 0, running: 0 }).title}</title>`);
    expect(ambientSignal({ waiting: 2, running: 0 }).title).toBe(`(2) ${PRODUCT}`);
  });

  it("is the name the terminal banner draws, so the two surfaces cannot drift", () => {
    // A user who starts the deck in one window and reads it in another must be
    // told the same name twice. profile "none" is the escape-free form, which
    // is the only one with plain text to assert on.
    const plain = wordmark({ profile: "none", version: "1.2.3" }).lines.join("\n");
    expect(plain).toContain(PRODUCT);
    expect(plain).not.toContain("agents-deck");
  });

  it("has replaced every agents-deck the client could put in front of a user", () => {
    const left = client.flatMap(([path, text]) =>
      codeLines(text).filter(l => l.includes("agents-deck")).map(l => `${path}: ${l.trim()}`));
    // There is no survivor left. The last one was the update button's tooltip,
    // hardcoded to `npm install -g agents-deck@latest` on the reasoning that
    // the package and the product are different words — which was true, and
    // was still the wrong string: #358 made the deck install whichever of its
    // three names the running copy was reached under, so a `npm i -g ccdeck`
    // user was shown a command that installs a tree their deck never reads.
    // The tooltip takes the server's answer now, and the client no longer
    // spells any npm package name at all.
    expect(left, left.join("\n")).toHaveLength(0);
  });
});

describe("the boundary the rename must not cross", () => {
  /** Every key the client hands a browser store, however it spells the call. */
  const storageKeys = new Set(client.flatMap(([, text]) => [
    ...text.matchAll(/(?:local|session)Storage\.(?:get|set|remove)Item\(\s*"([^"]+)"/g),
    ...text.matchAll(/readStored\(\s*"([^"]+)"/g),
    ...text.matchAll(/\bconst\s+[A-Z][A-Z0-9_]*KEY\s*=\s*"([^"]+)"/g),
    ...text.matchAll(/\bconst\s+[A-Z][A-Z0-9_]*KEYS\s*=\s*\[\s*"([^"]+)",\s*"([^"]+)"/g),
  ].flatMap(m => m.slice(1).filter(Boolean))));

  it("leaves every browser storage key in the agent-dag.* namespace", () => {
    expect(storageKeys.size).toBeGreaterThan(10);
    expect([...storageKeys].filter(k => !k.startsWith("agent-dag."))).toEqual([]);
  });

  it("still writes each key by the exact name a previous version wrote it under", () => {
    // Named one by one rather than by prefix: a key renamed WITHIN the
    // namespace loses just as much saved state as one moved out of it, and the
    // prefix check above would wave it through.
    for (const key of [
      "agent-dag.schema", "agent-dag.layout", "agent-dag.viewport",
      "agent-dag.theme", "agent-dag.autoRestart", "agent-dag.autoFitDisabled",
      "agent-dag.detailOpen", "agent-dag.sessionListOpen", "agent-dag.usagePanelOpen",
      "agent-dag.accountsPanelOpen", "agent-dag.summariesDismissed",
      "agent-dag.versionNoticeDismissed", "agent-dag.bundleReloadedFor",
      "agent-dag.restartPending",
    ]) expect([...storageKeys]).toContain(key);
  });

  it("keeps pruneStaleState watching the two keys that carry a shape", () => {
    expect(SCHEMA_KEY).toBe("agent-dag.schema");
    expect(SHAPE_KEYS).toEqual(["agent-dag.layout", "agent-dag.viewport"]);
  });

  it("leaves the on-disk state where a running deck and its installed hook look", () => {
    // hook.js is written into the Claude config dir once and then outlives
    // every upgrade, so the server moving this directory would leave events
    // being appended to a file nothing reads.
    expect(read("hook", "hook.js")).toContain(`path.join(CLAUDE_DIR, "agent-dag")`);
    expect(read("src", "server", "installer.mjs")).toContain(`join(CLAUDE_DIR, "agent-dag")`);
    expect(read("src", "server", "index.mjs")).toContain(`join(claudeConfigDir(), "agent-dag")`);
    expect(read("bin", "deck.js")).toContain(`join(claudeConfigDir(), "agent-dag", "events.jsonl")`);

    // ~/.agents-deck holds the update markers, the ccusage install and the
    // cswap state. A new root re-triggers every install and re-arms every
    // once-an-hour check on the first run after the upgrade.
    for (const file of ["self-update.mjs", "cswap-install.mjs", "cswap-auto.mjs", "sound-hook.mjs"]) {
      expect(read("src", "server", file)).toContain(`homedir(), ".agents-deck"`);
    }
    expect(read("src", "server", "ccusage.mjs")).toContain(`os.homedir(), ".agents-deck"`);
    expect(read("src", "server", "uv-bootstrap.mjs")).toContain(`homedir(), ".agents-deck"`);
  });

  it("keeps the settings mark that --uninstall matches its own entries on", () => {
    // The mark is how uninstall tells the deck's hook entries from the user's.
    // Changing it strands every entry already in settings.json, permanently.
    expect(read("src", "server", "installer.mjs")).toContain(`MARK_KEY = "__agent-dag"`);
    expect(read("src", "server", "sound-hook.mjs")).toContain(`MARK = "__agent-dag-sound"`);
  });

  it("renames none of the environment variables a user may already have set", () => {
    const serverDir = join(repo, "src", "server");
    const text = readdirSync(serverDir)
      .filter(n => n.endsWith(".mjs"))
      .map(n => readFileSync(join(serverDir, n), "utf8"))
      .concat(read("bin", "deck.js"), read("bin", "agent-dag.js"), read("hook", "hook.js"))
      .join("\n");
    const named = new Set([...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]));
    for (const v of [
      "AGENT_DAG_PORT", "AGENTS_DECK_CLAUDE", "AGENTS_DECK_CSWAP", "AGENTS_DECK_INTERNAL",
      "AGENTS_DECK_NO_DOWNLOAD", "AGENTS_DECK_NO_FRESHEN", "AGENTS_DECK_NO_INSTALL",
      "AGENTS_DECK_NO_UPDATE_CHECK", "AGENTS_DECK_RESPAWN", "CLAUDE_SWAP_BACKUP",
    ]) expect([...named]).toContain(v);
    expect([...named].filter(v => /^CCDECK/.test(v))).toEqual([]);
  });

  it("still asks npm about agents-deck, which is what the update installs", () => {
    // The upgrade path is the one place the package name is the truth and the
    // product name is wrong: a registry query or an `npm i -g` naming ccdeck
    // resolves a different package than the one this build publishes as.
    const selfUpdate = read("src", "server", "self-update.mjs");
    // The default is the fact; the line breaks are not (#378). Both of these
    // were exact signatures, so reformatting the parameter list failed them
    // while the package the upgrade installs stayed exactly the same.
    expect(selfUpdate, "upgradeName stopped defaulting to the published package")
      .toMatch(/export function upgradeName\(\s*pkgRoot,\s*name\s*=\s*"agents-deck",?\s*\)/);
    expect(selfUpdate, "upgradeCommand stopped defaulting to the published package")
      .toMatch(/export function upgradeCommand\(\s*pkgRoot,\s*name\s*=\s*"agents-deck",?\s*\)/);
    expect(JSON.parse(read("package.json")).name).toBe("agents-deck");
  });
});
