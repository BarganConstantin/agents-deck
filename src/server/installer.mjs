// Idempotent hook installer. Supports two providers:
//  - "claude"  → $CLAUDE_CONFIG_DIR/settings.json (Claude Code, ~/.claude by default)
//  - "codex"   → $CODEX_HOME/hooks.json           (OpenAI Codex CLI, ~/.codex by default)
// Both providers share the discovery dir at <claude config dir>/agent-dag/ so a
// single running server can receive events from either CLI. Re-runs are safe;
// entries are tagged with __agent-dag and de-duped.
import { readFile, writeFile, mkdir, unlink, rename, open, stat, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./claude-dir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");

const HOME = homedir();
// Honours CLAUDE_CONFIG_DIR, exactly as CODEX_DIR honours CODEX_HOME below.
// Without it the hooks land in a settings.json Claude Code never opens.
const CLAUDE_DIR = claudeConfigDir();
const CODEX_DIR = process.env.CODEX_HOME
  ? resolve(process.env.CODEX_HOME)
  : join(HOME, ".codex");

// Single shared discovery dir — both providers' hook scripts post here so one
// running agent-dag server can match either ecosystem's events. It follows the
// Claude config dir, so hook/hook.js has to resolve that dir the same way: it
// reads what this writes, and a disagreement means the hooks find no server.
const AGENT_DAG_DIR = join(CLAUDE_DIR, "agent-dag");

const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
  "Notification",
];

// Codex CLI hook events. SubagentStart/Stop exist (multi-agent feature).
// PostToolUseFailure / SessionEnd / Notification have no Codex equivalent.
const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
];

const PROVIDERS = {
  claude: {
    settingsPath: join(CLAUDE_DIR, "settings.json"),
    hookInstallDir: join(CLAUDE_DIR, "agent-dag"),
    events: CLAUDE_EVENTS,
    ensureDir: CLAUDE_DIR,
  },
  codex: {
    settingsPath: join(CODEX_DIR, "hooks.json"),
    hookInstallDir: join(CODEX_DIR, "agent-dag"),
    events: CODEX_EVENTS,
    ensureDir: CODEX_DIR,
  },
};

const MARK_KEY = "__agent-dag";
// Legacy marks from earlier names — purged on every install/uninstall so
// duplicate forwarders don't pile up when the project gets renamed.
const LEGACY_MARKS = ["__ccgraph", "__agent-flow"];
const LEGACY_DIRS = ["ccgraph", "agent-flow", "agent-dag"];

function hookCommand(installedHookPath, provider) {
  const node = process.execPath;
  return `"${node}" "${installedHookPath}" --provider ${provider}`;
}

function isOurEntry(g) {
  if (!g || typeof g !== "object") return false;
  if (g[MARK_KEY] === true) return true;
  for (const k of LEGACY_MARKS) if (g[k] === true) return true;
  const cmds = Array.isArray(g.hooks) ? g.hooks : [];
  for (const h of cmds) {
    const c = typeof h?.command === "string" ? h.command : "";
    for (const dir of LEGACY_DIRS) {
      if (c.includes(`.claude/${dir}/hook.js`) || c.includes(`.claude\\${dir}\\hook.js`)) return true;
      if (c.includes(`.codex/${dir}/hook.js`) || c.includes(`.codex\\${dir}\\hook.js`)) return true;
    }
  }
  return false;
}

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

// Notepad and PowerShell's Set-Content write UTF-8 with a byte-order mark, and
// JSON.parse throws on it when the file is read as utf8. A BOM is not damage —
// the JSON behind it is fine — so it never gets to look like a corrupt file.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readJsonSafe(p) {
  try { return JSON.parse(stripBom(await readFile(p, "utf8"))); } catch { return null; }
}

function unreadableSettings(p, why) {
  const err = new Error(
    `${p} could not be read as JSON (${why}). Refusing to overwrite it — ` +
    `fix the file or move it aside, then run agents-deck again.`,
  );
  err.code = "SETTINGS_UNREADABLE";
  err.settingsPath = p;
  return err;
}

/**
 * Read settings we are about to rewrite. Only ENOENT means "nothing there yet";
 * every other failure is a file whose contents we cannot reproduce — a stray
 * comma, a half-written file from another process, a permission error — and
 * writing our hooks over it would destroy every setting the user has. So the
 * install refuses instead, loudly, and leaves the file exactly as it found it.
 */
async function readSettingsForWrite(p) {
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { settings: {}, raw: null };
    throw unreadableSettings(p, err?.message ?? String(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    throw unreadableSettings(p, err?.message ?? String(err));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unreadableSettings(p, "top level is not a JSON object");
  }
  return { settings: parsed, raw };
}

// Rename over an open file is the one thing Windows does differently here. The
// call itself is atomic (MoveFileEx with MOVEFILE_REPLACE_EXISTING), but it
// fails outright while another process holds the target open — and a virus
// scanner or the search indexer opens files the instant they are written, for a
// few milliseconds at a time. Retrying a sharing violation a handful of times
// turns that into a successful install. POSIX never hits this path, and a real
// permission error just costs an extra fraction of a second before it surfaces.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts || !RENAME_RETRY_CODES.has(err?.code)) throw err;
      await delay(20 * attempt);
    }
  }
}

/**
 * Replace a file in a single step readers cannot land inside.
 *
 * The temp file is created beside the target rather than in $TMPDIR, because
 * rename is only atomic within one filesystem and the two are routinely on
 * different ones. It is fsync'd before the rename so that a crash or power loss
 * just after a successful install cannot leave the new directory entry pointing
 * at blocks that were never flushed — the classic file-of-zero-bytes. The pid in
 * the name keeps two decks starting at once off each other's temp file.
 */
async function writeFileAtomic(target, text) {
  const tmp = `${target}.agent-dag-${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(tmp, "w");
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    // A rename creates a fresh directory entry, so the old file's mode does not
    // come with it. Carry it over — a settings.json the user chmod'ed to 600 has
    // to stay 600. No-op on Windows, where chmod only toggles the read-only bit.
    const mode = await stat(target).then(s => s.mode, () => null);
    if (mode !== null) await chmod(tmp, mode).catch(() => {});
    await renameWithRetry(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Install one of the packaged hook scripts without ever exposing a partial one.
 *
 * copyFile truncates the destination and then fills it, and the destination here
 * is a script every live Claude Code session runs on each tool call. Starting the
 * deck while sessions are open — the normal way this is used — puts a hook
 * invocation inside that window sooner or later, and what it executes is an
 * empty or half-written program: a dropped event at best, a SyntaxError in the
 * user's session at worst. Renaming a finished copy over the name closes it, so
 * a session opens either the old script or the new one and both are whole.
 *
 * Re-installs are the common case and almost always produce the same bytes, so
 * identical content skips the write and the file is not replaced at all.
 */
async function installScript(src, dst) {
  const text = await readFile(src, "utf8");
  const current = await readFile(dst, "utf8").catch(() => null);
  if (current === text) return false;
  await writeFileAtomic(dst, text);
  return true;
}

async function installHookScript(installDir) {
  await ensureDir(installDir);
  const src = join(PKG_ROOT, "hook", "hook.js");
  const dst = join(installDir, "hook.js");
  await installScript(src, dst);
  return dst;
}

function buildHookEntry(command) {
  return {
    [MARK_KEY]: true,
    hooks: [{ type: "command", command, timeout: 2 }],
  };
}

function dedupeOurEntries(group) {
  if (!Array.isArray(group)) return [];
  return group.filter(g => !isOurEntry(g));
}

/** Install hooks for a single provider. Returns {settingsPath, hookPath, events, changed}. */
export async function installHooks({ provider = "claude" } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);

  // Read before writing anything, so a settings file we cannot parse aborts
  // the install without leaving half of it behind.
  const { settings: current, raw: before } = await readSettingsForWrite(cfg.settingsPath);

  const hookPath = await installHookScript(cfg.hookInstallDir);
  const command = hookCommand(hookPath, provider);
  await ensureDir(cfg.ensureDir);
  // Discovery dir is shared across providers — always make sure it exists.
  await ensureDir(AGENT_DAG_DIR);

  current.hooks = current.hooks ?? {};

  for (const evt of cfg.events) {
    const cleaned = dedupeOurEntries(current.hooks[evt]);
    cleaned.push(buildHookEntry(command));
    current.hooks[evt] = cleaned;
  }

  // Every launch reinstalls, and on all but the first the entries are already
  // there and identical. Writing anyway is pure downside: it is one more chance
  // to be interrupted mid-write, and one more window in which a change Claude
  // Code made to the file between our read and our write gets discarded. So
  // compare against the exact bytes we read and, when they match, do nothing.
  const next = JSON.stringify(current, null, 2) + "\n";
  const changed = next !== before;
  if (changed) await writeFileAtomic(cfg.settingsPath, next);
  return { settingsPath: cfg.settingsPath, hookPath, events: cfg.events, provider, changed };
}

export async function uninstallHooks({ provider = "claude" } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  const current = await readJsonSafe(cfg.settingsPath);
  if (!current?.hooks) return { changed: false, provider };
  let changed = false;
  for (const evt of Object.keys(current.hooks)) {
    const cleaned = dedupeOurEntries(current.hooks[evt]);
    if (cleaned.length !== (current.hooks[evt]?.length ?? 0)) changed = true;
    if (cleaned.length === 0) delete current.hooks[evt];
    else current.hooks[evt] = cleaned;
  }
  if (changed) await writeFileAtomic(cfg.settingsPath, JSON.stringify(current, null, 2) + "\n");
  return { changed, provider, settingsPath: cfg.settingsPath };
}

/** True when ~/.codex/ exists — used by CLI to default-enable Codex hooks. */
export function hasCodexInstalled() {
  return existsSync(CODEX_DIR);
}

// The token is the deck's proof of identity, so the file holding it is the
// deck's key material: readable and writable by its owner, nobody else. Windows
// ignores the mode (NTFS ACLs inherit from the profile directory, which is
// already per-user), and a file left over from an earlier run under a recycled
// pid keeps its old mode through writeFile, hence the explicit chmod.
export async function writeDiscovery({ port, workspace, token, persist = null }) {
  await ensureDir(AGENT_DAG_DIR);
  const file = join(AGENT_DAG_DIR, `${process.pid}.json`);
  const data = {
    pid: process.pid,
    port,
    workspace: workspace ?? "",
    // Without this the hooks refuse to post: a file naming a port it cannot
    // authenticate is exactly the stale-file case they now decline to trust.
    token: token ?? "",
    // Absolute path of the events log this deck appends to, or null under
    // --no-persist. The hook reads it to elect a single writer per file:
    // several decks receive the same event by design, and without this they
    // each appended their own copy to the one log they share. See
    // electWriters in hook/hook.js.
    persist: typeof persist === "string" && persist !== "" ? persist : null,
    startedAt: new Date().toISOString(),
  };
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeDiscovery(file) {
  try { await unlink(file); } catch {}
}

export const HOOK_EVENTS = CLAUDE_EVENTS;
export { AGENT_DAG_DIR, CLAUDE_DIR, CODEX_DIR, CLAUDE_EVENTS, CODEX_EVENTS };
// Exported for the other modules that rewrite settings.json — the sound toggle
// today. Every one of them needs the same two guarantees: a file we cannot
// parse is never treated as an empty one, and the replacement is a single
// rename rather than a truncate a reader can land inside. installScript carries
// the same guarantee to the hook scripts themselves, which are the files live
// sessions are actually executing, and renameWithRetry goes out on its own for
// the files writeFileAtomic cannot write — the fetched uv binary in
// uv-bootstrap.mjs — which still need the Windows retry.
export { readSettingsForWrite, writeFileAtomic, installScript, renameWithRetry };
