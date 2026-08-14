// Idempotent hook installer. Supports two providers:
//  - "claude"  → $CLAUDE_CONFIG_DIR/settings.json (Claude Code, ~/.claude by default)
//  - "codex"   → $CODEX_HOME/hooks.json           (OpenAI Codex CLI, ~/.codex by default)
// Both providers share the discovery dir at <claude config dir>/agent-dag/ so a
// single running server can receive events from either CLI. Re-runs are safe;
// entries are tagged with __agent-dag and de-duped.
import { readFile, mkdir, unlink, rename, open, stat, chmod } from "node:fs/promises";
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

// Counts writes, not processes. The pid alone gave every call in one deck the
// same temp path, and there is more than one writer in a deck now: the sound
// toggle rewrites settings.json from a request handler, so two clients toggling
// within the same few milliseconds both opened that one path with O_TRUNC and
// both wrote their own JSON at offset zero. What got renamed over settings.json
// was the shorter payload with the tail of the longer one still behind it —
// unparseable, and readSettingsForWrite turns unparseable into a permanent
// SETTINGS_UNREADABLE refusal for every later toggle and install. The loser then
// found its temp file already renamed away and threw ENOENT on top of it.
let tmpSeq = 0;

/**
 * Create the temp file for one write, never sharing it with another writer.
 *
 * "wx" is the point of it: a name that already exists is an error here rather
 * than a silently truncated file two writers are both filling in. The only way
 * to meet a taken name is a deck killed between the write and the rename whose
 * pid the OS has since handed out again — that writer is gone by definition, so
 * the leftover is deleted and the next counter tried. Which is also the whole
 * story on litter: the names come from a small space, this pid crossed with the
 * first few counters, because a deck writes these files a handful of times per
 * run. Later runs walk the same names and sweep what they find instead of
 * piling fresh ones beside it. Digits and hyphens only — a legal filename
 * everywhere, Windows included.
 *
 * `mode` is the mode the file is created with, which matters when the bytes are
 * secret: codex-auth stages a rotated Codex refresh token here, and a temp file
 * that starts at the umask default is readable by every other account on the
 * box for as long as the write takes, whatever chmod follows it. O_EXCL is what
 * makes the mode binding — a create honours it only when it is the call that
 * makes the file, so adopting a leftover would keep the leftover's permissions.
 */
async function createTemp(target, { mode = 0o666, attempts = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const tmp = `${target}.agent-dag-${process.pid}-${tmpSeq++}.tmp`;
    try {
      return { tmp, handle: await open(tmp, "wx", mode) };
    } catch (err) {
      if (attempt >= attempts || err?.code !== "EEXIST") throw err;
      await unlink(tmp).catch(() => {});
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
 * at blocks that were never flushed — the classic file-of-zero-bytes.
 */
async function writeFileAtomic(target, text) {
  const { tmp, handle } = await createTemp(target);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A rename creates a fresh directory entry, so the old file's mode does not
    // come with it. Carry it over — a settings.json the user chmod'ed to 600 has
    // to stay 600. No-op on Windows, where chmod only toggles the read-only bit.
    const mode = await stat(target).then(s => s.mode, () => null);
    if (mode !== null) await chmod(tmp, mode).catch(() => {});
    await renameWithRetry(tmp, target);
  } catch (err) {
    // Cleanup covers the write and the fsync as well as the rename: a full disk
    // used to leave the half-written temp file sitting beside the target.
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

/**
 * The events log as the record spells it: an absolute path, or null when this
 * deck writes none. Shared by the writer and by ensureDiscovery's comparison,
 * so a file this process wrote can never read back as somebody else's.
 */
function persistField(persist) {
  return typeof persist === "string" && persist !== "" ? persist : null;
}

// Every deck's token lives in this directory, and writeFileAtomic's temp file is
// created beside its target with whatever the umask allows — 0644 on most
// machines — so for the moment before the rename the token would sit in a
// world-readable file. 0700 on the directory closes that window from the outside:
// another user cannot traverse into it whatever the mode of a file inside says.
// The dir usually predates this code, so the mode is re-asserted rather than only
// set at creation, where it would be masked by the umask anyway. Windows ignores
// both — NTFS ACLs inherit from the per-user profile directory.
async function ensureDiscoveryDir() {
  if (!existsSync(AGENT_DAG_DIR)) await mkdir(AGENT_DAG_DIR, { recursive: true, mode: 0o700 });
  await chmod(AGENT_DAG_DIR, 0o700).catch(() => {});
}

/**
 * Register this deck, in one step no reader can land inside.
 *
 * The record used to go down with a plain writeFile, which truncates the target
 * and then fills it, so the file existed and was empty for a moment on every
 * rewrite. Everything that reads this directory parses each record whole —
 * electWriters in hook/hook.js, readLiveDecks and sweepStaleDiscovery in
 * index.mjs — and a record that fails to parse is a deck missing from that
 * cycle: the event it should have logged is either logged by nobody or logged
 * twice by the decks that remain, which is the exact failure the single-writer
 * election exists to prevent, reached through the file the election reads. A
 * rename is atomic on Linux, macOS and Windows alike, so a reader now sees the
 * previous record or the new one and never half of either.
 *
 * The token is the deck's proof of identity, so the file holding it is the
 * deck's key material: readable and writable by its owner, nobody else. The mode
 * is pinned after the write because writeFileAtomic can only carry over a mode
 * the target already had — a first registration, or one left by an earlier run
 * under a recycled pid, would otherwise keep whatever the umask handed it.
 */
export async function writeDiscovery({ port, workspace, token, persist = null, codex = true }) {
  await ensureDiscoveryDir();
  const file = discoveryPath();
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
    persist: persistField(persist),
    // Is this deck tailing Codex's rollout files? Those events never pass
    // through a hook, so the decks elect a writer for them among themselves —
    // and a deck running --no-codex must be left out of that election rather
    // than win it and record a rollout it is not even reading. See
    // writesCodexLog in src/server/log-writer.mjs.
    codex: codex !== false,
    startedAt: new Date().toISOString(),
  };
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeDiscovery(file) {
  try { await unlink(file); } catch {}
}

/** Where this process registers itself. One file per deck, named by pid. */
export function discoveryPath() {
  return join(AGENT_DAG_DIR, `${process.pid}.json`);
}

/**
 * Make sure this deck's discovery file is on disk and says what it should.
 *
 * Registration was a single write at boot, so anything that took the file away
 * afterwards — a sweep on another machine's clock, a half-finished restart, a
 * user tidying the directory — left a deck that was listening, serving and
 * completely invisible: hook.js enumerates this directory and nothing else, so
 * the deck received zero events while looking perfectly healthy. Re-asserting
 * is cheap (one small read), so the deck checks rather than assumes.
 *
 * A file this process wrote is left alone, mode included. Anything else — no
 * file, unreadable, another pid, a stale port, token, events log or Codex
 * setting — is replaced. Every field another deck decides by is compared, the
 * log path included: leave one out and a record missing it would pass as ours
 * forever, which for the log path means no deck can tell which of them share a
 * file and they all write their own copy of every event again.
 */
export async function ensureDiscovery({ port, workspace, token, persist = null, codex = true }) {
  const file = discoveryPath();
  try {
    const d = JSON.parse(stripBom(await readFile(file, "utf8")));
    if (d
      && d.pid === process.pid
      && d.port === port
      && (d.workspace ?? "") === (workspace ?? "")
      && (d.token ?? "") === (token ?? "")
      && (d.persist ?? null) === persistField(persist)
      && d.codex === (codex !== false)) {
      return { file, rewritten: false };
    }
  } catch { /* missing, unreadable or corrupt — rewritten below */ }
  await writeDiscovery({ port, workspace, token, persist, codex });
  return { file, rewritten: true };
}

/**
 * Keep this deck registered for as long as it runs, and tell the caller when
 * that stops being true.
 *
 * `onState` hears the first outcome, every change of health, and every
 * re-registration after the first — never a steady state. A deck that cannot
 * write the file has to say so: silently listening while no hook can find it
 * is the failure this exists to end, not a state worth hiding.
 *
 * The interval is unref'd, so it never keeps a finished process alive, and
 * `stop()` must be called before the file is removed on shutdown — otherwise
 * the next tick would put it straight back.
 */
export function keepDiscovery({ port, workspace, token, persist = null, codex = true, intervalMs = 5000, onState = null } = {}) {
  // null until the first outcome, which therefore always differs and is always
  // reported — the caller learns where it stands before anything else happens.
  let healthy = null;

  const run = async () => {
    let state;
    try {
      const { rewritten } = await ensureDiscovery({ port, workspace, token, persist, codex });
      state = { ok: true, rewritten, file: discoveryPath(), error: null };
    } catch (err) {
      state = { ok: false, rewritten: false, file: discoveryPath(), error: err };
    }
    const worthSaying = healthy !== state.ok || state.rewritten;
    healthy = state.ok;
    if (worthSaying && onState) { try { onState(state); } catch { /* not our problem */ } }
    return state;
  };

  // One check at a time. Registration is a write and a write is now a rename,
  // which costs an fsync — long enough that a tick can land inside the boot-time
  // check bin/deck.js runs by hand. That second check reads a file the first has
  // not renamed into place yet, concludes the deck is unregistered and writes it
  // again, and the two writes race over one record: the deck reports itself
  // unregistered on a machine where nothing whatsoever is wrong. A caller that
  // asks mid-check gets the answer the check already in flight is fetching.
  let inFlight = null;
  const check = () => (inFlight ??= run().finally(() => { inFlight = null; }));

  const timer = setInterval(() => { check(); }, intervalMs);
  timer.unref?.();

  return { file: discoveryPath(), check, stop: () => clearInterval(timer) };
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
// uv-bootstrap.mjs — which still need the Windows retry. createTemp goes out for
// the same reason one step lower: codex-auth.mjs needs the collision-free temp
// name but not writeFileAtomic's mode handling, which carries over the target's
// mode and so would leave a brand-new auth.json at whatever the umask allows.
export { readSettingsForWrite, writeFileAtomic, installScript, renameWithRetry, createTemp };
