// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// Single-file pure Node HTTP server, zero deps.
import { createServer } from "node:http";
import { readFile, stat, mkdir, appendFile, open, truncate, readdir, unlink } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, dirname as pdirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { claudeConfigDir } from "./claude-dir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");
const WEB_DIST = resolve(PKG_ROOT, "dist", "web");

// Read at import — i.e. at boot, before an upgrade can overwrite these files.
// Reading it later would report whatever npm has since installed and hide the
// exact drift /api/version exists to expose. See src/server/self-update.mjs.
const RUNNING_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"))?.version ?? null; }
  catch { return null; }
})();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".woff2": "font/woff2",
  ".map":  "application/json",
};

const MAX_BUFFER = 2000;            // recent events kept for late SSE subscribers
const events = [];                  // ring buffer
let nextSeq = 1;
// Identity of *this* process's seq numbering. nextSeq restarts at 1 on every
// boot and is re-derived by replaying events.jsonl, so it is monotonic only
// within one process: rotation (50MB) or /api/clear shortens that log and the
// next boot starts numbering well below what an already-open tab saw. Stamped
// on every envelope so a client can tell "counter restarted" apart from "old
// duplicate" instead of silently dropping the live stream.
const SEQ_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const sseClients = new Set();       // res handles

let persistPath = null;             // absolute path to events.jsonl, or null

// ─── Which deck records which session ─────────────────────────────────────
// The hook posts an event to every deck whose workspace matches, and by
// default all of them append to one events.jsonl — so each event landed in
// that file once per running deck, and every later replay of it ingested each
// tool call that many times. The hook now elects one writer per log file and
// marks the request to the rest `?persist=0`. That flag covers the hook event
// itself; this map carries it to the ModelObserved/UsageObserved/
// ContextObserved events a deck derives from the same session's transcript,
// which every deck reads for itself and would otherwise duplicate exactly the
// same way. A session is recorded unless we have been told someone else owns
// it, so a lone deck — and a deck the hook is too old to flag — still writes
// everything.
const foreignSessions = new Set();  // session ids another deck is logging
const MAX_FOREIGN_SESSIONS = 512;   // bound: insertion order = oldest first

function noteLogWriter(payload, mine) {
  const sid = payload && typeof payload === "object" ? payload.session_id : null;
  if (typeof sid !== "string" || sid === "") return;
  // Delete either way: on re-add it moves the id back to the young end, so the
  // eviction below drops sessions that stopped being posted, not busy ones.
  foreignSessions.delete(sid);
  if (mine) return;
  foreignSessions.add(sid);
  if (foreignSessions.size > MAX_FOREIGN_SESSIONS) {
    foreignSessions.delete(foreignSessions.values().next().value);
  }
}

/**
 * Is this deck the one that writes this payload's session to the log? Every
 * event goes through here on its way to disk, including the ones this deck
 * derives from a transcript on its own — that is the point of remembering the
 * session rather than only honouring the flag on the event that carried it.
 */
export function writesLogFor(payload) {
  const sid = payload && typeof payload === "object" ? payload.session_id : null;
  return typeof sid !== "string" || sid === "" || !foreignSessions.has(sid);
}

// ─── Persistence rotation ─────────────────────────────────────────────────
// 24/7 dev servers used to grow events.jsonl unbounded — saw it hit GBs
// across weeks. We rotate when the file passes ROTATE_AT_BYTES, archiving
// the previous file to .1 and starting fresh. Last-event-id replay still
// covers the in-memory ring buffer of MAX_BUFFER events.
const ROTATE_AT_BYTES = 50 * 1024 * 1024;
let lastRotateCheckAt = 0;
let rotateInProgress = false;
async function maybeRotatePersistFile() {
  if (!persistPath) return;
  const now = Date.now();
  // Throttle disk-stat checks to once per 30s.
  if (now - lastRotateCheckAt < 30_000) return;
  lastRotateCheckAt = now;
  if (rotateInProgress) return;
  rotateInProgress = true;
  try {
    const s = await stat(persistPath).catch(() => null);
    if (!s || s.size < ROTATE_AT_BYTES) return;
    // Roll events.jsonl → events.jsonl.1 (replacing any previous .1).
    const oldPath = persistPath + ".1";
    try { await unlink(oldPath); } catch {}
    const { rename } = await import("node:fs/promises");
    await rename(persistPath, oldPath);
    console.log(`agents-deck: rotated ${persistPath} (${(s.size / 1024 / 1024).toFixed(0)}MB → ${oldPath})`);
  } catch (err) {
    console.error("agents-deck: persist rotation failed:", err && err.message ? err.message : err);
  } finally {
    rotateInProgress = false;
  }
}

// ─── Incremental transcript scanning ─────────────────────────────────────
// Model, usage and context enrichment all derive from the same append-only
// transcript JSONL, and each one used to re-read and re-parse the whole file
// on every throttled pass. A session's transcript grows to tens of MB, so
// that cost O(n) per pass, O(n²) over the session, and — because the parse
// loop is one synchronous block — it stalled SSE broadcasts and /api/event
// ingest for as long as it ran.
//
// Instead we keep one cursor per file plus the running totals derived so
// far, read only the bytes appended since the last pass, and fold them into
// that state. The three scanners share it, so the first one to run in a
// cycle pays for the read and the other two reuse the result. This mirrors
// the offset tailing the Codex rollout watcher already does further down.
const transcriptScans = new Map();        // path -> scan state
const transcriptScanInFlight = new Map(); // path -> in-progress scan promise
const MAX_TRANSCRIPT_SCANS = 256;         // bound the per-path state

const MODEL_ID_RE = /^claude[-_]/i;
const USAGE_BLOCK_RE = /"usage"\s*:\s*\{([^}]+)\}/g;
// CC `/clear` and `/compact` write a marker into the transcript and reset the
// context window to ~0 while the JSONL keeps growing — everything before the
// last marker is stale.
const CONTEXT_RESET_RE = /<command-name>\s*\/(?:clear|compact)\s*<\/command-name>/g;
const TYPE_USER_RE = /"type"\s*:\s*"user"/g;
const TYPE_ASSISTANT_RE = /"type"\s*:\s*"assistant"/g;
const TYPE_TOOL_USE_RE = /"type"\s*:\s*"tool_use"/g;
const TYPE_TOOL_RESULT_RE = /"type"\s*:\s*"tool_result"/g;
const SYSTEM_REMINDER_RE = /<system-reminder>/g;
const USAGE_FIELD_RE = {
  input_tokens: /"input_tokens"\s*:\s*(\d+)/,
  output_tokens: /"output_tokens"\s*:\s*(\d+)/,
  cache_read_input_tokens: /"cache_read_input_tokens"\s*:\s*(\d+)/,
  cache_creation_input_tokens: /"cache_creation_input_tokens"\s*:\s*(\d+)/,
};

function grabUsageField(blob, key) {
  const m = blob.match(USAGE_FIELD_RE[key]);
  return m ? Number(m[1]) : 0;
}

function newContextBreakdown() {
  return {
    msgsUser: 0,
    msgsAssistant: 0,
    toolUses: 0,
    toolResults: 0,
    systemReminders: 0,
    currentContextTokens: 0,
  };
}

function newTranscriptState() {
  return {
    offset: 0,          // bytes already folded in
    touchedAt: 0,
    rootModel: null,
    lastModel: null,    // last claude-* model on any line, sidechain included
    subagentModels: {},
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    },
    ctx: newContextBreakdown(),
  };
}

async function readByteRange(path, from, to) {
  const fh = await open(path, "r");
  try {
    const len = to - from;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, from);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Fold one transcript line into the running state. Every fact the three
 *  scanners need lives on a single line, so line-at-a-time folding sees
 *  exactly what a whole-file pass would. */
function foldTranscriptLine(state, line) {
  if (!line) return;

  // Model. Only a line that mentions a model can change it, and parsing the
  // rest is what made the full rescan expensive.
  if (line.includes('"model"')) {
    let obj = null;
    try { obj = JSON.parse(line); } catch {}
    const msg = obj && obj.message;
    const model = (msg && typeof msg.model === "string" && MODEL_ID_RE.test(msg.model)) ? msg.model
                : (obj && typeof obj.model === "string" && MODEL_ID_RE.test(obj.model)) ? obj.model
                : null;
    if (model) {
      state.lastModel = model;
      const isSide = obj.isSidechain === true || obj.is_sidechain === true;
      const ptid = obj.parentToolUseID || obj.parent_tool_use_id || obj.parentToolUseId || null;
      if (isSide && ptid) state.subagentModels[ptid] = model;
      else if (!isSide) state.rootModel = model;
    }
  }

  // Usage totals sum every block in the file, resets included.
  for (const m of line.matchAll(USAGE_BLOCK_RE)) {
    const blob = m[1];
    state.usage.input_tokens += grabUsageField(blob, "input_tokens");
    state.usage.output_tokens += grabUsageField(blob, "output_tokens");
    state.usage.cache_read_input_tokens += grabUsageField(blob, "cache_read_input_tokens");
    state.usage.cache_creation_input_tokens += grabUsageField(blob, "cache_creation_input_tokens");
  }

  // Context counts only what follows the most recent /clear or /compact.
  let ctxText = line;
  let resetEnd = -1;
  for (const m of line.matchAll(CONTEXT_RESET_RE)) resetEnd = (m.index ?? -1) + m[0].length;
  if (resetEnd >= 0) {
    state.ctx = newContextBreakdown();
    ctxText = line.slice(resetEnd);
  }
  const ctx = state.ctx;
  ctx.msgsUser += (ctxText.match(TYPE_USER_RE) ?? []).length;
  ctx.msgsAssistant += (ctxText.match(TYPE_ASSISTANT_RE) ?? []).length;
  ctx.toolUses += (ctxText.match(TYPE_TOOL_USE_RE) ?? []).length;
  ctx.toolResults += (ctxText.match(TYPE_TOOL_RESULT_RE) ?? []).length;
  ctx.systemReminders += (ctxText.match(SYSTEM_REMINDER_RE) ?? []).length;
  // Current context size = the LAST usage block after the reset. Stays 0
  // right after a /clear, which is what CC's own /context reports.
  let lastBlob = null;
  for (const m of ctxText.matchAll(USAGE_BLOCK_RE)) lastBlob = m[1];
  if (lastBlob) {
    ctx.currentContextTokens =
      grabUsageField(lastBlob, "input_tokens") +
      grabUsageField(lastBlob, "cache_read_input_tokens") +
      grabUsageField(lastBlob, "cache_creation_input_tokens");
  }
}

function pruneTranscriptScans() {
  if (transcriptScans.size <= MAX_TRANSCRIPT_SCANS) return;
  let oldestPath = null;
  let oldestAt = Infinity;
  for (const [p, st] of transcriptScans) {
    if (st.touchedAt < oldestAt) { oldestAt = st.touchedAt; oldestPath = p; }
  }
  if (oldestPath !== null) transcriptScans.delete(oldestPath);
}

/** Bring a transcript's scan state up to date and return it. Concurrent
 *  callers share one read — folding the same appended bytes twice would
 *  double the usage totals. Never throws; an unreadable file just leaves
 *  the state where it was. */
function scanTranscript(path) {
  if (!path || typeof path !== "string") return Promise.resolve(null);
  const inFlight = transcriptScanInFlight.get(path);
  if (inFlight) return inFlight;
  const run = (async () => {
    let state = transcriptScans.get(path);
    if (!state) {
      state = newTranscriptState();
      transcriptScans.set(path, state);
      pruneTranscriptScans();
    }
    state.touchedAt = Date.now();
    try {
      const s = await stat(path);
      // Shorter than the cursor means the file was truncated, rotated or
      // replaced — the offset now points at unrelated bytes, so start over.
      if (s.size < state.offset) {
        state = newTranscriptState();
        state.touchedAt = Date.now();
        transcriptScans.set(path, state);
      }
      if (s.size <= state.offset) return state;
      const text = await readByteRange(path, state.offset, s.size);
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) return state;   // no complete line appended yet
      const consumed = text.slice(0, lastNl);
      // Advance before folding: a fold that throws half-way must not leave
      // the cursor where the next pass would count those lines again.
      state.offset += Buffer.byteLength(consumed, "utf8") + 1; // +1 for the \n
      for (const line of consumed.split("\n")) foldTranscriptLine(state, line);
    } catch { /* keep whatever we already folded */ }
    return state;
  })();
  transcriptScanInFlight.set(path, run);
  return run.finally(() => {
    if (transcriptScanInFlight.get(path) === run) transcriptScanInFlight.delete(path);
  });
}

// ─── Model enrichment ────────────────────────────────────────────────────
// CC's hook payloads never carry the `model` field — but every hook
// references a `transcript_path` JSONL that contains lines like
// `"model":"claude-opus-4-7"`. We read the tail of that file once per
// session, cache the result, and (a) inject `model` into subsequent
// payloads for that session before broadcasting, (b) emit a synthetic
// `ModelObserved` event so the client backfills agents created before
// the model was resolved.
const modelBySession = new Map();         // sessionId -> { rootModel, subsSig }
const pendingTranscriptReads = new Set(); // sessionId currently being read
const modelLastReadAt = new Map();        // sessionId -> ms timestamp (re-read throttle)
const MODEL_READ_THROTTLE_MS = 2500;

/** The cache entry is `{ rootModel, subsSig }`, but `payload.model` is a
 *  model *string* — that is the only shape the client's recursive scanner
 *  reads. Returns the root model id, or null when the session resolved
 *  only subagent models and has no root model yet. */
export function cachedModelId(cached) {
  const rootModel = cached?.rootModel;
  return typeof rootModel === "string" && rootModel ? rootModel : null;
}

/** Read the main session JSONL. Returns the root model and any
 *  legacy-schema subagent models (older CC versions kept subagent blocks
 *  inline with `isSidechain:true` + `parentToolUseID`). Current CC versions
 *  store subagents in `<sessionDir>/subagents/agent-<id>.jsonl` — those are
 *  handled by `readSubagentModelsFromDir` below. */
export async function readModelFromTranscript(path) {
  const state = await scanTranscript(path);
  if (!state) return null;
  const rootModel = state.rootModel ?? state.lastModel;
  const subagentModels = { ...state.subagentModels };
  if (!rootModel && Object.keys(subagentModels).length === 0) return null;
  return { rootModel, subagentModels };
}

/** Newer CC schema (~2026-06): each subagent turn writes its OWN file at
 *  `<projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` with a
 *  sidecar `.meta.json` carrying `{agentType, description}`. The hook
 *  payload's `agent_id` matches the file's <agentId>, so the reducer can
 *  attribute via the existing `subagentModels` map (it keys by parentToolUseId
 *  but the reducer looks up `${sessionId}::${key}` and the subagent node id
 *  is built from `agent_id` — identical lookup either way).
 *
 *  Returns { [agentId]: model } scanning every agent-*.jsonl file in dir. */
async function readSubagentModelsFromDir(transcriptPath) {
  // Subagent dir sits next to the main jsonl: <dir>/<sessionId>/subagents/
  // Derive from transcript_path by stripping the .jsonl suffix.
  if (!transcriptPath || typeof transcriptPath !== "string") return null;
  const sessionDir = transcriptPath.replace(/\.jsonl$/i, "");
  const subDir = join(sessionDir, "subagents");
  let entries;
  try { entries = await readdir(subDir); } catch { return null; }
  const models = {};
  for (const f of entries) {
    if (!/^agent-([0-9a-f]+)\.jsonl$/i.test(f)) continue;
    const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/i, "");
    const full = join(subDir, f);
    try {
      // Same incremental cursor as the main transcript. Last-seen claude-*
      // model wins — subagents may switch model mid-turn (Sonnet → Haiku for
      // tool-call fallback etc.).
      const state = await scanTranscript(full);
      const last = state ? state.lastModel : null;
      if (last) models[agentId] = last;
    } catch { /* skip unreadable file */ }
  }
  return Object.keys(models).length ? models : null;
}

function maybeResolveModel(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  if (!sid || !tp) return;
  // Re-read on every event for this session — the cache was preventing us
  // from picking up subagent models that arrive after the root is known.
  // Throttle so we don't thrash the filesystem.
  if (pendingTranscriptReads.has(sid)) return;
  const now = Date.now();
  const last = modelLastReadAt.get(sid) ?? 0;
  if (now - last < MODEL_READ_THROTTLE_MS) return;
  modelLastReadAt.set(sid, now);
  pendingTranscriptReads.add(sid);
  Promise.all([readModelFromTranscript(tp), readSubagentModelsFromDir(tp)])
    .then(([result, dirSubs]) => {
      const rootModel = result?.rootModel ?? null;
      // Merge legacy (inline isSidechain) + new (subagents/ dir) maps. Dir
      // wins on conflict since current CC only writes to the dir.
      const subagentModels = { ...(result?.subagentModels ?? {}), ...(dirSubs ?? {}) };
      if (!rootModel && Object.keys(subagentModels).length === 0) return;
      const prev = modelBySession.get(sid);
      const subsSig = JSON.stringify(subagentModels);
      if (prev && prev.rootModel === rootModel && prev.subsSig === subsSig) return;
      modelBySession.set(sid, { rootModel, subsSig });
      pushEvent({
        hook_event_name: "ModelObserved",
        session_id: sid,
        model: rootModel,
        subagentModels,
      }, "internal");
    })
    .catch(() => {})
    .finally(() => pendingTranscriptReads.delete(sid));
}

// ─── Usage enrichment ────────────────────────────────────────────────────
// Same story as the model: token counts (input/output/cache) are missing
// from every CC hook payload but present on every assistant message in
// the transcript JSONL as a `"usage":{…}` block. We sum them across the
// whole transcript and ship a synthetic UsageObserved event so the
// session's root agent gets accurate cumulative usage (and therefore the
// cost columns actually have something to multiply by).
const lastUsageReadAt = new Map();      // sid -> ms timestamp
const pendingUsageReads = new Set();    // sid currently being read
const USAGE_READ_THROTTLE_MS = 2500;

// Every entry carries its own usage object and we sum every occurrence, so
// the totals are cumulative over the whole transcript — the running state
// keeps them across passes and each pass only adds the newly appended blocks.
export async function readUsageFromTranscript(path) {
  const state = await scanTranscript(path);
  if (!state) return null;
  const totals = { ...state.usage };
  if (totals.input_tokens === 0 && totals.output_tokens === 0
      && totals.cache_read_input_tokens === 0 && totals.cache_creation_input_tokens === 0) return null;
  return totals;
}

function maybeResolveUsage(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  if (!sid || !tp) return;
  if (pendingUsageReads.has(sid)) return;
  const now = Date.now();
  const last = lastUsageReadAt.get(sid) ?? 0;
  if (now - last < USAGE_READ_THROTTLE_MS) return;
  lastUsageReadAt.set(sid, now);
  pendingUsageReads.add(sid);
  readUsageFromTranscript(tp)
    .then(usage => {
      if (!usage) return;
      pushEvent({ hook_event_name: "UsageObserved", session_id: sid, usage }, "internal");
    })
    .catch(() => {})
    .finally(() => pendingUsageReads.delete(sid));
}

// ─── Context enrichment ──────────────────────────────────────────────────
// Approximation of `/context` since CC doesn't expose its breakdown via
// hooks. We scan the transcript JSONL for message counts (user / assistant
// / tool_use / tool_result / system-reminders) and walk up from cwd for
// any CLAUDE.md files in scope. Token totals come from UsageObserved; this
// scan is purely structural ("what does the context contain").
const lastContextReadAt = new Map();
const pendingContextReads = new Set();
const CONTEXT_READ_THROTTLE_MS = 4000;

// The counts reset at every `/clear` or `/compact` marker (see
// foldTranscriptLine): CC resets its in-memory window there while the JSONL
// keeps growing, and reading the pre-reset blocks made the donut report ~100%
// on an empty context.
export async function readContextFromTranscript(path) {
  const state = await scanTranscript(path);
  // Nothing folded yet — the file is empty, unreadable, or has no complete
  // line. Callers treat that as "no breakdown", same as before.
  if (!state || state.offset === 0) return null;
  return { ...state.ctx };
}

/** Encode an absolute path the way CC stores it under
 *  ~/.claude/projects/<slug>/. Drive letters, colons, and path separators
 *  are flattened to "-" so the slug survives as a single directory name. */
function ccProjectSlug(cwd) {
  if (!cwd) return "";
  // Replace path separators and the Windows drive colon. Match CC's own
  // encoding: every \\ /  :  →  -  (no collapsing of adjacent dashes).
  return resolve(cwd).replace(/[\\/:]/g, "-");
}

async function scanClaudeMdFiles(cwd) {
  if (!cwd || typeof cwd !== "string") return [];
  const found = [];
  const seen = new Set();
  const home = homedir();
  const push = async (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    try {
      const s = await stat(p);
      if (s.isFile() && s.size > 0) found.push({ path: p, bytes: s.size });
    } catch {}
  };
  // Walk up from cwd to filesystem root. At each dir, check for the
  // canonical CC memory filenames plus CLAUDE.local.md (user-private).
  let dir = resolve(cwd);
  for (let depth = 0; depth < 16; depth++) {
    for (const rel of [
      "CLAUDE.md",
      "CLAUDE.local.md",
      join(".claude", "CLAUDE.md"),
      join(".claude", "CLAUDE.local.md"),
    ]) {
      await push(join(dir, rel));
    }
    const parent = pdirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // User-global memory.
  await push(join(home, ".claude", "CLAUDE.md"));
  await push(join(home, ".claude", "CLAUDE.local.md"));
  // Per-project auto-memory: ~/.claude/projects/<slug>/memory/*.md
  // (plus MEMORY.md index). CC injects these into context for sessions
  // whose cwd matches the slug.
  const slug = ccProjectSlug(cwd);
  if (slug) {
    const memDir = join(home, ".claude", "projects", slug, "memory");
    try {
      const entries = await readdir(memDir);
      for (const f of entries) {
        if (f.toLowerCase().endsWith(".md")) await push(join(memDir, f));
      }
    } catch {}
  }
  return found;
}

function maybeResolveContext(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  const cwd = payload.cwd;
  if (!sid || !tp) return;
  if (pendingContextReads.has(sid)) return;
  const now = Date.now();
  const last = lastContextReadAt.get(sid) ?? 0;
  if (now - last < CONTEXT_READ_THROTTLE_MS) return;
  lastContextReadAt.set(sid, now);
  pendingContextReads.add(sid);
  Promise.all([readContextFromTranscript(tp), scanClaudeMdFiles(cwd)])
    .then(([breakdown, claudeMdFiles]) => {
      if (!breakdown && (!claudeMdFiles || claudeMdFiles.length === 0)) return;
      pushEvent({
        hook_event_name: "ContextObserved",
        session_id: sid,
        context: {
          ...(breakdown ?? {}),
          claudeMdFiles: claudeMdFiles ?? [],
        },
      }, "internal");
    })
    .catch(() => {})
    .finally(() => pendingContextReads.delete(sid));
}

// ─── Codex transcript enrichment ──────────────────────────────────────────
// Codex CLI hook payloads carry `session_id` but no transcript path. Sessions
// are persisted to ~/.codex/sessions/YYYY/MM/DD/rollout-<sid>.jsonl with one
// JSON object per line: {type, payload}. Token usage shows up in
//   {type:"event_msg", payload:{type:"token_count",
//     info:{total_token_usage:{input_tokens, cached_input_tokens,
//                              output_tokens, reasoning_output_tokens,
//                              total_tokens}}}}
// We resolve the rollout path lazily (cache sid→path), then read the tail
// for usage + model. CODEX_HOME overrides ~/.codex.
const CODEX_HOME = process.env.CODEX_HOME
  ? resolve(process.env.CODEX_HOME)
  : join(homedir(), ".codex");
const CODEX_SESSIONS_DIR = join(CODEX_HOME, "sessions");
const codexRolloutPathBySid = new Map();
const lastCodexUsageReadAt = new Map();
const pendingCodexUsageReads = new Set();
const CODEX_READ_THROTTLE_MS = 2500;

async function findCodexRolloutPath(sid) {
  const cached = codexRolloutPathBySid.get(sid);
  if (cached) return cached;
  // Walk year → month → day → files. Codex includes the sid in the filename
  // (rollout-...-<sid>.jsonl) so a directory-scoped match is enough.
  const tryYears = async () => {
    try { return await readdir(CODEX_SESSIONS_DIR); } catch { return []; }
  };
  const years = (await tryYears()).sort().reverse(); // newest first
  for (const y of years) {
    let months;
    try { months = (await readdir(join(CODEX_SESSIONS_DIR, y))).sort().reverse(); }
    catch { continue; }
    for (const m of months) {
      let days;
      try { days = (await readdir(join(CODEX_SESSIONS_DIR, y, m))).sort().reverse(); }
      catch { continue; }
      for (const d of days) {
        const dayDir = join(CODEX_SESSIONS_DIR, y, m, d);
        let files;
        try { files = await readdir(dayDir); } catch { continue; }
        const hit = files.find(f => f.includes(sid) && f.endsWith(".jsonl"));
        if (hit) {
          const full = join(dayDir, hit);
          codexRolloutPathBySid.set(sid, full);
          return full;
        }
      }
    }
  }
  return null;
}

/** Tail-read a Codex rollout JSONL. Returns the last token_count info block
 *  plus the most recent observed model + the session's model_context_window
 *  (set once from task_started). */
async function readCodexRollout(path) {
  try {
    const s = await stat(path);
    if (s.size === 0) return null;
    const fh = await open(path, "r");
    let text;
    try {
      const buf = Buffer.alloc(s.size);
      await fh.read(buf, 0, s.size, 0);
      text = buf.toString("utf8");
    } finally {
      await fh.close();
    }
    let lastUsage = null;
    let model = null;
    let contextWindow = null;
    let cwd = null;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const type = obj && obj.type;
      const pl = obj && obj.payload;
      if (type === "session_meta" && pl) {
        if (typeof pl.cwd === "string") cwd = pl.cwd;
        // session_meta sometimes carries the model in newer Codex versions.
        if (typeof pl.model === "string") model = pl.model;
      } else if (type === "event_msg" && pl) {
        if (pl.type === "token_count" && pl.info && pl.info.total_token_usage) {
          lastUsage = pl.info.total_token_usage;
        } else if (pl.type === "task_started" && typeof pl.model_context_window === "number") {
          contextWindow = pl.model_context_window;
        }
      } else if (type === "response_item" && pl && typeof pl.model === "string") {
        // Fallback model source — response items carry the model id.
        model = pl.model;
      }
    }
    if (!lastUsage && !model && !contextWindow) return null;
    return { usage: lastUsage, model, contextWindow, cwd };
  } catch {
    return null;
  }
}

function maybeResolveCodex(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.provider !== "codex") return;
  const sid = payload.session_id;
  if (!sid) return;
  if (pendingCodexUsageReads.has(sid)) return;
  const now = Date.now();
  const last = lastCodexUsageReadAt.get(sid) ?? 0;
  if (now - last < CODEX_READ_THROTTLE_MS) return;
  lastCodexUsageReadAt.set(sid, now);
  pendingCodexUsageReads.add(sid);
  (async () => {
    const path = await findCodexRolloutPath(sid);
    if (!path) return;
    const r = await readCodexRollout(path);
    if (!r) return;
    if (r.usage) {
      pushEvent({
        hook_event_name: "UsageObserved",
        session_id: sid,
        usage: r.usage,
      }, "internal");
    }
    if (r.model) {
      pushEvent({
        hook_event_name: "ModelObserved",
        session_id: sid,
        model: r.model,
      }, "internal");
    }
    if (r.contextWindow) {
      // Piggy-back on the model event with the window — reducer reads
      // model_context_window directly off any payload.
      pushEvent({
        hook_event_name: "ModelObserved",
        session_id: sid,
        model: r.model ?? undefined,
        model_context_window: r.contextWindow,
      }, "internal");
    }
  })()
    .catch(() => {})
    .finally(() => pendingCodexUsageReads.delete(sid));
}

// ─── Codex rollout watcher ────────────────────────────────────────────────
// Codex CLI hooks never fire on Windows — the elevated/unelevated sandbox
// refuses to spawn the hook command (exit 1, child never runs). So instead of
// relying on hooks, we tail the rollout JSONL files Codex writes to
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl and reconstruct the
// agent-dag event stream from them. Each rollout line is one append-only JSON
// object {timestamp, type, payload}; we map the relevant ones to the same
// synthetic hook payloads the reducer already understands:
//   session_meta                       → SessionStart
//   event_msg/user_message             → UserPromptSubmit
//   response_item/function_call        → PreToolUse
//   response_item/function_call_output → PostToolUse
//   event_msg/token_count              → UsageObserved
//   event_msg/task_started (+window)   → ModelObserved (context window)
//   turn_context / response_item.model → model snapshot (ModelObserved on change)
// Events are emitted with source "codex" so pushEvent skips the Claude-only
// transcript enrichment (which needs transcript_path / hook events) but still
// persists + broadcasts them exactly like a hook event. This path is entirely
// additive — the Claude hook flow is untouched.
const codexFileState = new Map();      // path -> { offset, sid, cwd, skip }
const codexSessionModel = new Map();   // sid -> last model string
let codexScanRunning = false;
let codexWatchTimer = null;
let codexWorkspace = "";

function codexCwdInWorkspace(cwd) {
  if (!codexWorkspace) return true;
  if (!cwd || typeof cwd !== "string") return false;
  const a = resolve(cwd).toLowerCase();
  const b = resolve(codexWorkspace).toLowerCase();
  return a === b || a.startsWith(b + sep.toLowerCase());
}

// List rollout files from the newest 2 day-directories. New sessions always
// land in today's dir, so this captures live activity without scanning years
// of history every tick.
async function listRecentCodexRollouts() {
  const out = [];
  let years;
  try { years = (await readdir(CODEX_SESSIONS_DIR)).filter(d => /^\d{4}$/.test(d)).sort().reverse(); }
  catch { return out; }
  let dayDirs = 0;
  for (const y of years) {
    let months;
    try { months = (await readdir(join(CODEX_SESSIONS_DIR, y))).sort().reverse(); } catch { continue; }
    for (const m of months) {
      let days;
      try { days = (await readdir(join(CODEX_SESSIONS_DIR, y, m))).sort().reverse(); } catch { continue; }
      for (const d of days) {
        const dir = join(CODEX_SESSIONS_DIR, y, m, d);
        let files;
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) if (f.endsWith(".jsonl")) out.push(join(dir, f));
        if (++dayDirs >= 2) return out;
      }
    }
  }
  return out;
}

// Read the first complete JSON line of a rollout (the session_meta header)
// to learn sid + cwd before we start streaming. The header line can be large
// (base_instructions text runs tens of KB), so we read in growing chunks until
// we hit the first newline rather than guessing a fixed window.
async function readCodexHeader(path) {
  try {
    const size = (await stat(path)).size;
    if (size === 0) return null;
    const CHUNK = 65536;
    let upto = Math.min(CHUNK, size);
    let text = "";
    for (;;) {
      text = await readByteRange(path, 0, upto);
      const nl = text.indexOf("\n");
      if (nl >= 0) {
        const obj = JSON.parse(text.slice(0, nl));
        if (obj && obj.type === "session_meta" && obj.payload) {
          return { sid: obj.payload.id, cwd: typeof obj.payload.cwd === "string" ? obj.payload.cwd : null };
        }
        return null;
      }
      if (upto >= size) return null;       // no newline in the whole file yet
      upto = Math.min(upto + CHUNK, size);  // grow and retry
      if (upto > 4 * 1024 * 1024) return null; // 4MB sanity cap on a single line
    }
  } catch {}
  return null;
}

// Map one parsed rollout object to a synthetic hook payload (or null to skip).
// Mutates codexSessionModel and returns { payload, modelEvent } where
// modelEvent is an optional ModelObserved to emit first when the model changed.
function codexObjToPayload(obj, sid, cwd) {
  const type = obj && obj.type;
  const pl = (obj && obj.payload) || {};
  const base = { session_id: sid, cwd, provider: "codex" };
  const model = codexSessionModel.get(sid);

  // Track model from turn_context / response_item before mapping events.
  if (type === "turn_context" && typeof pl.model === "string") {
    codexSessionModel.set(sid, pl.model);
    return null;
  }
  if (type === "response_item" && typeof pl.model === "string") {
    codexSessionModel.set(sid, pl.model);
  }

  if (type === "event_msg") {
    if (pl.type === "user_message") {
      const prompt = typeof pl.message === "string" ? pl.message : "";
      return { ...base, hook_event_name: "UserPromptSubmit", prompt, model };
    }
    if (pl.type === "token_count" && pl.info && pl.info.total_token_usage) {
      return { ...base, hook_event_name: "UsageObserved", usage: pl.info.total_token_usage, model };
    }
    if (pl.type === "task_started" && typeof pl.model_context_window === "number") {
      return { ...base, hook_event_name: "ModelObserved", model, model_context_window: pl.model_context_window };
    }
    return null;
  }
  if (type === "response_item") {
    if (pl.type === "function_call") {
      let input = pl.arguments;
      try { input = JSON.parse(pl.arguments); } catch {}
      return { ...base, hook_event_name: "PreToolUse", tool_name: pl.name ?? "tool", tool_input: input, tool_use_id: pl.call_id, model };
    }
    if (pl.type === "custom_tool_call") {
      return { ...base, hook_event_name: "PreToolUse", tool_name: pl.name ?? "tool", tool_input: { patch: pl.input }, tool_use_id: pl.call_id, model };
    }
    if (pl.type === "function_call_output" || pl.type === "custom_tool_call_output") {
      const tool_response = pl.output != null ? parseCodexOutput(pl.output) : undefined;
      return { ...base, hook_event_name: "PostToolUse", tool_use_id: pl.call_id, tool_response, model };
    }
  }
  return null;
}

function parseCodexOutput(raw) {
  if (typeof raw !== "string") return raw;
  try {
    const o = JSON.parse(raw);
    return (o && typeof o.output === "string") ? o.output : raw;
  } catch {
    return raw;
  }
}

function emitCodexEvent(payload) {
  pushEvent(payload, "codex");
}

// Emit the SessionStart root exactly once per file, lazily — only when the
// session actually produces an event. This keeps long-dead sessions that were
// merely on disk at startup from cluttering the canvas with empty roots.
function ensureCodexRoot(state) {
  if (state.rootEmitted) return;
  state.rootEmitted = true;
  emitCodexEvent({ session_id: state.sid, cwd: state.cwd, provider: "codex", hook_event_name: "SessionStart" });
}

async function codexScanOnce(firstRun) {
  if (codexScanRunning) return;
  codexScanRunning = true;
  try {
    const files = await listRecentCodexRollouts();
    for (const path of files) {
      let st;
      try { st = await stat(path); } catch { continue; }
      let state = codexFileState.get(path);

      if (!state) {
        // New file — read the header for sid + cwd, then decide whether to
        // capture it. Skip files outside our workspace.
        const header = await readCodexHeader(path);
        if (!header || !header.sid) continue; // not ready yet — retry next tick
        if (!codexCwdInWorkspace(header.cwd)) {
          codexFileState.set(path, { offset: st.size, sid: header.sid, cwd: header.cwd, skip: true, rootEmitted: false });
          continue;
        }
        state = { offset: 0, sid: header.sid, cwd: header.cwd, skip: false, rootEmitted: false };
        codexFileState.set(path, state);
        if (firstRun) {
          // On startup, skip a pre-existing session's history entirely — no
          // root, no replay. Only future appends (a live session that keeps
          // going) will lazily create the root via ensureCodexRoot.
          state.offset = st.size;
          continue;
        }
      }

      if (state.skip) { state.offset = st.size; continue; }
      if (st.size <= state.offset) continue;

      const text = await readByteRange(path, state.offset, st.size);
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) continue; // no complete line yet
      const consume = text.slice(0, lastNl);
      state.offset += Buffer.byteLength(consume, "utf8") + 1; // +1 for the \n

      for (const line of consume.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const prevModel = codexSessionModel.get(state.sid);
        const payload = codexObjToPayload(obj, state.sid, state.cwd);
        // If the model changed (turn_context/response_item), surface it.
        const nowModel = codexSessionModel.get(state.sid);
        if (nowModel && nowModel !== prevModel) {
          ensureCodexRoot(state);
          emitCodexEvent({ session_id: state.sid, cwd: state.cwd, provider: "codex", hook_event_name: "ModelObserved", model: nowModel });
        }
        if (payload) {
          ensureCodexRoot(state);
          emitCodexEvent(payload);
        }
      }
    }
  } catch {
    /* swallow — watcher must never crash the server */
  } finally {
    codexScanRunning = false;
  }
}

export function startCodexWatcher(workspace) {
  codexWorkspace = workspace ?? "";
  // Deliberately not gated on CODEX_SESSIONS_DIR existing. `codex login`
  // creates ~/.codex, but sessions/ only appears when the first session
  // starts — and rollout tailing is the only Codex capture path there is, so
  // bailing out here meant a fresh install had to restart the deck before any
  // Codex agent ever showed up, while the banner claimed to be watching.
  // listRecentCodexRollouts returns [] while the directory is missing, so the
  // poll below is a cheap no-op that doubles as the existence re-check. A
  // filesystem watch is no help: fs.watch on a missing path throws, and
  // watching the parent recursively is macOS/Windows-only.
  //
  // Initial catalog: create roots for in-progress sessions, skip their
  // history, then poll for new lines.
  codexScanOnce(true).catch(() => {});
  codexWatchTimer = setInterval(() => { codexScanOnce(false).catch(() => {}); }, 1500);
  if (codexWatchTimer.unref) codexWatchTimer.unref();
  return codexWatchTimer;
}

/** Envelopes newer than `seq` from the ring buffer, oldest first. */
export function eventsSince(seq) {
  const after = Number(seq) || 0;
  return events.filter(e => e.seq > after);
}

function pushEvent(raw, source, opts = {}) {
  // Synchronous enrichment: if we already know this session's model, stamp
  // it on the payload so the client's recursive scanner picks it up.
  if (raw && typeof raw === "object" && raw.session_id && !raw.model) {
    const modelId = cachedModelId(modelBySession.get(raw.session_id));
    if (modelId) raw.model = modelId;
  }

  const seq = nextSeq++;
  const evt = {
    seq,
    epoch: SEQ_EPOCH,
    receivedAt: opts.receivedAt ?? Date.now(),
    source,
    payload: raw,
  };
  events.push(evt);
  if (events.length > MAX_BUFFER) events.splice(0, events.length - MAX_BUFFER);

  const line = `id: ${seq}\nevent: hook\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }

  if (persistPath && !opts.replay && opts.persist !== false && writesLogFor(raw)) {
    // Fire-and-forget append. JSONL = newline-delimited JSON.
    appendFile(persistPath, JSON.stringify(evt) + "\n", "utf8").catch(() => {});
    // Cheap throttled check (every 30s) — only rotates if file > 50MB.
    maybeRotatePersistFile();
  }

  // Kick off async transcript scans. Model arrives as a one-shot
  // ModelObserved; usage is re-read periodically (throttled to 2.5s per
  // session) so the cost columns track running totals as the session
  // progresses. Both result in synthetic events.
  // Provider gates the path: Claude reads transcript_path; Codex reads its
  // rollout JSONL under ~/.codex/sessions/. The Claude scanners short-circuit
  // when transcript_path is absent (always the case for Codex hooks).
  if (source === "hook" && !opts.replay) {
    if (raw && raw.provider === "codex") {
      maybeResolveCodex(raw);
    } else {
      maybeResolveModel(raw);
      maybeResolveUsage(raw);
      maybeResolveContext(raw);
    }
  }

  return evt;
}

async function replayLog(filePath) {
  if (!existsSync(filePath)) return 0;
  let count = 0;
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }) });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line);
      if (evt && typeof evt === "object" && evt.payload) {
        pushEvent(evt.payload, evt.source ?? "replay", { receivedAt: evt.receivedAt, replay: true });
        count++;
      }
    } catch { /* skip corrupt line */ }
  }
  return count;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function serveStatic(req, res, url) {
  // Strip leading slash, default to index.html
  let rel = url.pathname.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  const filePath = join(WEB_DIST, rel);
  if (!filePath.startsWith(WEB_DIST)) return send(res, 403, { error: "forbidden" });

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) return send(res, 404, { error: "not found" });
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch {
    // SPA fallback to index.html for client-side routes
    try {
      const idx = await readFile(join(WEB_DIST, "index.html"));
      // Same no-cache as the normal path above, which this used to omit. It
      // matters more since the deck upgrades itself: index.html is the file
      // naming the hashed bundle, so a heuristically-cached copy sends the tab
      // back to the OLD assets after an update and the reload achieves nothing.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(idx);
    } catch {
      send(res, 404, { error: "ui not built. run `pnpm build` or `npm run build`." });
    }
  }
}

/** Collect a request body as a string, capped so a bad client can't fill memory. */
function readBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", c => {
      body += c;
      if (body.length > limit) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// `persist` is false when the hook posted this event to another deck as well
// and elected that one to write it to the log they share. The event is still
// buffered and broadcast here — every matching deck draws it — it is only the
// second copy on disk that is dropped.
function handleEventIngest(req, res, persist = true) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", c => {
    body += c;
    if (body.length > 5_000_000) {
      req.destroy();
    }
  });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid json" }); }
    noteLogWriter(parsed, persist);
    const evt = pushEvent(parsed, "hook", { persist });
    send(res, 200, { ok: true, seq: evt.seq });
  });
  req.on("error", () => send(res, 400, { error: "bad request" }));
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 1500\n\n`);

  // Resume: replay events after Last-Event-ID. Marked with `replay:true`
  // on the envelope so the client can suppress turn-cleanup side effects
  // (exitAt stamping, autofit churn) until the live stream takes over.
  // Without this the reducer's UserPromptSubmit handler treats replayed
  // events as a real new turn — hiding prior-turn subagents using the
  // event's stale receivedAt, which collides with wall-clock visibility
  // gates and yields the "nodes appear then vanish" symptom on refresh.
  const lastId = Number(req.headers["last-event-id"] ?? 0);
  for (const e of events) {
    if (e.seq <= lastId) continue;
    const tagged = { ...e, replay: true };
    res.write(`id: ${e.seq}\nevent: hook\ndata: ${JSON.stringify(tagged)}\n\n`);
  }
  // Sentinel: tells client "ring buffer drained, live stream starts now".
  res.write(`event: replay-end\ndata: {}\n\n`);

  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// True only when a supervisor is listening AND the event log is being written.
// Without persistence a restart wipes the canvas irrecoverably — replayLog has
// no file to read — so the deck must not offer to do it.
let _canRestart = false;

async function handleVersion(req, res) {
  const { versionReport } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
  );
  // ?refresh=1 asks npm now rather than reusing the cached answer — what the
  // version chip does when clicked, for the user who has just published or is
  // wondering whether the check is working at all.
  const force = new URL(req.url, "http://localhost").searchParams.get("refresh") === "1";
  const report = await versionReport({ running: RUNNING_VERSION, pkgRoot: PKG_ROOT, force });
  send(res, 200, { ...report, canRestart: _canRestart });
}

// Runs `npm i -g agents-deck@latest`, and only that: the argument vector is
// fixed inside self-update.mjs, so nothing about what gets installed comes from
// the request. Answers immediately — progress is read back from /api/version.
async function handleUpgrade(_req, res) {
  const { startUpgrade } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
  );
  const out = startUpgrade({ pkgRoot: PKG_ROOT });
  send(res, out.ok ? 200 : 409, out);
}

// Restart is a two-party act: this half answers before it stops listening, so
// the caller learns it was accepted rather than losing the socket mid-reply.
//
// `{ upgrade: true }` asks for the npx variant: come back through
// `npx -y <spec>@latest` instead of re-running the files already here. Granted
// only where that is genuinely how this copy updates — the mode is decided from
// the install on disk, never from the request.
async function handleRestart(req, res) {
  if (!_onRestart) return send(res, 501, { ok: false, reason: "unsupervised" });
  // Enforced here and not only in the UI. Under --no-persist a restart destroys
  // the whole canvas — replayLog has no file to read — and a destructive act
  // must not be prevented by a hidden button alone.
  if (!_canRestart) return send(res, 409, { ok: false, reason: "no_persist" });

  let wantUpgrade = false;
  if (req.method === "POST") {
    const body = await readBody(req).catch(() => null);
    try { wantUpgrade = JSON.parse(body ?? "")?.upgrade === true; } catch { /* a plain restart */ }
  }
  let mode = null;
  if (wantUpgrade) {
    const { upgradeBlock, upgradeMode, npxRestartSpec } = await import(
      pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href
    );
    if (upgradeMode(upgradeBlock(PKG_ROOT)) !== "npx" || !npxRestartSpec(PKG_ROOT)) {
      return send(res, 409, { ok: false, reason: "not_npx" });
    }
    mode = "npx";
  }

  if (_restarting) return send(res, 202, { ok: true, already: true });
  _restarting = true;
  send(res, 200, { ok: true, mode });
  // Let the response flush before the listener goes away.
  setTimeout(() => { try { _onRestart(mode); } catch { _restarting = false; } }, 120).unref();
}

async function handleQuota(req, res) {
  const { fetchClaudeQuota } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const quota = await fetchClaudeQuota({ force });
  send(res, 200, quota);
}

async function handleCodexUsage(req, res) {
  const { fetchCodexUsage } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/codex-usage.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const usage = await fetchCodexUsage({ force });
  send(res, 200, usage);
}

async function handleCodexQuota(req, res) {
  const { fetchCodexQuota } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/codex-quota.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const quota = await fetchCodexQuota({ force });
  send(res, 200, quota);
}

async function handleCcusage(req, res) {
  const { fetchCcusageDaily } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/ccusage.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const since = url.searchParams.get("since") || undefined;
  const until = url.searchParams.get("until") || undefined;
  const data = await fetchCcusageDaily({ since, until, force });
  send(res, 200, data);
}

async function handleClaudeAccounts(req, res) {
  const { fetchClaudeAccounts } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href
  );
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  send(res, 200, await fetchClaudeAccounts({ force }));
}

async function handleClaudeAccountSwitch(req, res) {
  const { switchClaudeAccount, invalidateClaudeAccountsCache } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href
  );
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  const result = await switchClaudeAccount(parsed.account);
  // The active account just moved; the next poll should see it immediately
  // rather than serving the pre-switch roster for another few seconds.
  invalidateClaudeAccountsCache();
  send(res, result.ok ? 200 : 400, result);
}

function cswapAdminModule() {
  return import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-admin.mjs")).href);
}

// Reading the login's progress. The browser polls this while its dialog is
// open, the same way the upgrade notice polls /api/version.
async function handleAccountLoginState(_req, res) {
  const { loginState } = await cswapAdminModule();
  send(res, 200, { ok: true, ...loginState() });
}

/**
 * Everything that changes the account store, behind one verb switch — the shape
 * handleCswapAutoAction already uses.
 *
 * The sign-in code is the one field here that is a credential. It is read out
 * of the body, handed straight to the child's stdin, and never logged, echoed
 * back, or written anywhere — which is also why this is a POST body and not a
 * query parameter.
 */
async function handleClaudeAccountAdmin(req, res) {
  const admin = await cswapAdminModule();
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  let result;
  switch (parsed.action) {
    case "login":        result = await admin.startLogin({ email: parsed.email }); break;
    case "login-code":   result = await admin.submitLoginCode(parsed.code); break;
    case "login-cancel": result = await admin.cancelLogin(); break;
    case "share":        result = await admin.shareAccount(parsed.account); break;
    case "import":       result = await admin.importAccount(parsed.blob); break;
    case "remove":       result = await admin.removeAccount(parsed.account); break;
    case "alias":        result = await admin.setAlias(parsed.account, parsed.alias); break;
    case "move":         result = await admin.moveAccount(parsed.account, parsed.slot); break;
    default: return send(res, 400, { ok: false, reason: "unknown_action" });
  }
  send(res, result.ok ? 200 : 400, result);
}

function cswapAutoModule() {
  return import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-auto.mjs")).href);
}

async function handleCswapAuto(req, res) {
  const { autoStatus } = await cswapAutoModule();
  send(res, 200, await autoStatus());
}

/**
 * One POST for every auto-switch control, keyed by `action`. Each one can move
 * the user's live Claude account or change when it moves, so nothing here is
 * reachable by GET.
 */
async function handleCswapAutoAction(req, res) {
  const mod = await cswapAutoModule();
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });

  let result;
  switch (parsed.action) {
    case "enable":
      result = await mod.setAutoEnabled(parsed.enabled === true);
      break;
    case "setting":
      result = await mod.setCswapConfig(String(parsed.key ?? ""), parsed.value);
      break;
    case "account":
      result = await mod.setAccountEnabled(parsed.account, parsed.enabled === true);
      break;
    default:
      return send(res, 400, { ok: false, reason: "unknown_action" });
  }
  send(res, result.ok ? 200 : 400, result);
}

async function handleSoundHook(req, res) {
  const { soundHookStatus } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/sound-hook.mjs")).href
  );
  send(res, 200, await soundHookStatus());
}

async function handleSoundHookSet(req, res) {
  const { setSoundHook, restoreParkedSoundHooks } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/sound-hook.mjs")).href
  );
  const body = await readBody(req).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });
  if (parsed.action === "restore") return send(res, 200, await restoreParkedSoundHooks());
  send(res, 200, await setSoundHook(parsed.enabled === true));
}

function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    name: "agent-dag",
    seq: nextSeq - 1,
    clients: sseClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

// A secret this process, and only this process, knows. It goes into the
// discovery file bin/deck.js writes (mode 0600) and is never sent anywhere:
// hook/hook.js reads it from that file and asks us to hash it against a nonce
// before it will send us a single session payload.
//
// Fresh per start, deliberately. A discovery file that outlives its deck —
// SIGKILL and power cuts both leave one behind — names a pid the OS is free to
// hand to something else and a port that by then may belong to anything. The
// pid probe below cannot tell that apart from a running deck, so the token is
// what actually distinguishes us: the replacement process does not have it, and
// neither does the next deck, so a stale file authenticates nothing.
const HOOK_TOKEN = randomBytes(32).toString("hex");

/** The token this deck expects to be challenged on. Written by writeDiscovery. */
export function hookToken() { return HOOK_TOKEN; }

/**
 * The proof of knowing `token`, for a nonce the challenger chose.
 *
 * hook/hook.js spells this out a second time — it is installed outside the
 * package and cannot import from here — and a test pins the two against each
 * other. Changing one without the other silently blinds the deck.
 */
export function challengeProof(token, nonce) {
  return createHash("sha256").update(`${token}:${nonce}`).digest("hex");
}

// GET /api/hook-challenge?nonce=… — answer a hook's challenge.
//
// The nonce is the caller's, so the answer proves knowledge of the token
// without disclosing it, and proves it for this exchange only. Answering
// freely is safe: a caller that can reach this port can already read the
// discovery file that holds the token, being the same user on the same
// machine, and the response is a hash the browser cannot read cross-origin.
function handleHookChallenge(_req, res, url) {
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!nonce || nonce.length > 256) return send(res, 400, { error: "bad nonce" });
  send(res, 200, { proof: challengeProof(HOOK_TOKEN, nonce) });
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

async function sweepStaleDiscovery() {
  // Same directory the installer writes and the hooks read — see claude-dir.mjs.
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const d = JSON.parse(await readFile(p, "utf8"));
      if (d && typeof d.pid === "number" && !isProcessAlive(d.pid)) {
        await unlink(p).catch(() => {});
        removed++;
      }
    } catch { /* corrupt — leave it */ }
  }
  return removed;
}

function randomPort(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Parse a request target into a URL, or null when it cannot be parsed.
//
// The base is the constant "http://localhost", never the Host header. Node's
// HTTP parser hands the header through verbatim, so a client sending
// `Host: bad host` used to produce `new URL("/", "http://bad host")`, which
// throws ERR_INVALID_URL synchronously inside the request listener. Nothing
// catches that — it becomes an uncaughtException, the worker exits 1 and the
// supervisor tears the whole deck down for a single malformed request. Only
// the path and the query are ever read from this URL, so the authority half
// is free to be a constant — which is what every other new URL call site in
// this file already does. Anything else unparseable answers 400 instead.
export function requestUrl(rawUrl) {
  try { return new URL(rawUrl ?? "/", "http://localhost"); }
  catch { return null; }
}

// Is this mutating request allowed to be acted on?
//
// The deck binds 127.0.0.1, which sounds private but is reachable from every
// page the user's browser has open: a cross-site POST with a CORS-safelisted
// `Content-Type: text/plain` fires no preflight, so any visited page could
// remove a Claude account, import an attacker-crafted one, switch the live
// account, flip auto-switching, start a global npm upgrade, restart the deck
// or truncate the event log. None of those need to read the response, so the
// same-origin policy alone never stopped them.
//
// Two headers decide it, and both are set by the browser itself — page script
// cannot forge either, they are forbidden header names:
//
//   Sec-Fetch-Site  present on every modern-browser request. `same-origin`
//                   (our own UI) and `none` (the user typed the URL) pass;
//                   `cross-site` and `same-site` are exactly the attack and
//                   are refused. Absent on older Safari, hence the second half.
//   Origin          present on every browser POST, including same-origin ones.
//                   It must name this very server: comparing it to the Host
//                   header the browser filled in from the target URL. A page
//                   on http://evil.com — or on http://localhost:8000, which is
//                   just as cross-origin — cannot make the two agree. The
//                   opaque `null` origin (sandboxed iframe, data: URL) fails
//                   to parse and is refused with it.
//
// A request carrying neither header is not a browser request and is allowed:
// that is hook/hook.js, a plain Node http.request from the user's own machine
// that sends no Origin at all, plus curl and the deck's own tooling. Ambient
// browser authority is the whole threat here, and those clients have none — a
// process that can POST here can already run anything as the user.
export function isTrustedMutation({ origin, host, secFetchSite } = {}) {
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (site && site !== "same-origin" && site !== "none") return false;
  if (typeof origin !== "string" || origin === "") return true;
  return originMatchesHost(origin, host);
}

// Does `origin` name the same host:port the request was addressed to? Ports are
// part of an origin, so http://127.0.0.1:8000 is not http://127.0.0.1:4317 —
// and the default port is spelled both ways depending on the client, so it is
// normalised off both sides before comparing.
function originMatchesHost(origin, host) {
  if (typeof host !== "string" || host === "") return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  const dropDefaultPort = (h, scheme) =>
    h.replace(scheme === "https:" ? /:443$/ : /:80$/, "");
  const fromOrigin = dropDefaultPort(parsed.host.toLowerCase(), parsed.protocol);
  const fromHost = dropDefaultPort(host.trim().toLowerCase(), parsed.protocol);
  return fromOrigin !== "" && fromOrigin === fromHost;
}

// A request handler rejected. Two audiences, two different amounts of detail:
// the operator, who needs the whole error — stack included — to find the bug,
// and the HTTP client, which needs to know only that the request failed.
//
// They used to get the same string, on the theory that this server binds
// 127.0.0.1 and its only client is the user's own tab. A DNS-rebound page
// reaches a loopback server as same-origin and can read the body, and the
// errors that land here carry absolute paths out of the user's home directory
// — a failed rename of ~/.claude/settings.json, an ENOENT from an import. So
// stderr keeps every byte and the response body carries none of it; nothing is
// swallowed, it just stops travelling over the wire.
export function sendInternalError(res, err, log = console.error) {
  log("agents-deck: request handler failed:", err);
  if (!res.headersSent) send(res, 500, { error: "internal error" });
  else res.end();
}

async function tryListen(server, port, host) {
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.removeListener("error", rej);
      res();
    });
  });
}

// Set from startServer's options. The server cannot restart itself — the
// process lifecycle belongs to the supervisor in bin/agent-dag.js, which is the
// only thing that can bring a replacement up on the same port without racing
// the dying listener. Absent (running the module directly, or under an older
// launcher), /api/restart answers 501 and the UI hides the control rather than
// offering a button that does nothing.
let _onRestart = null;
// A restart is in flight. Several browser tabs watching the same deck will each
// ask; the second ask must not re-enter the shutdown.
let _restarting = false;

export async function startServer({ port = 4317, host = "127.0.0.1", persist = null, portRange = [4318, 4400], workspace = "", codex = true, onRestart = null } = {}) {
  _onRestart = typeof onRestart === "function" ? onRestart : null;
  _canRestart = _onRestart != null && persist != null;
  const removed = await sweepStaleDiscovery();
  if (removed > 0) console.log(`  swept ${removed} stale discovery file(s)`);
  if (persist) {
    persistPath = resolve(persist);
    try { await mkdir(pdirname(persistPath), { recursive: true }); } catch {}
    const replayed = await replayLog(persistPath);
    if (replayed > 0) {
      // Don't broadcast replays as live; SSE clients catch up via Last-Event-ID
      // already. Just keep the buffer + seq counter primed.
    }
  }
  // The async handlers below are dispatched as floating promises. Node's
  // default for an unhandled rejection is to kill the process, which would
  // take the whole deck down — SSE stream, hook ingest and all — because one
  // background quota poll hit a network error. Answer the request instead.
  const guard = (p, res) => Promise.resolve(p).catch(err => sendInternalError(res, err));

  const server = createServer((req, res) => {
    const url = requestUrl(req.url);
    // Unparseable request target. Nothing below can route it, and throwing here
    // would be an uncaughtException inside the listener — i.e. the whole deck.
    if (!url) return send(res, 400, { error: "bad request target" });

    // Every route below that changes something is a POST, so one gate in front
    // of the whole table covers them all — and covers any route added later
    // without the author having to remember. See isTrustedMutation.
    if (req.method !== "GET" && req.method !== "HEAD" && !isTrustedMutation({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
    })) {
      return send(res, 403, { error: "cross-site request blocked" });
    }

    // `?persist=0` — another deck was elected to write this event to the log
    // the two of them share. Absent, this deck writes it.
    if (req.method === "POST" && url.pathname === "/api/event") return guard(handleEventIngest(req, res, url.searchParams.get("persist") !== "0"), res);
    if (req.method === "GET"  && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET"  && url.pathname === "/api/hook-challenge") return handleHookChallenge(req, res, url);
    if (req.method === "GET"  && url.pathname === "/events")     return handleSse(req, res);
    if (req.method === "GET"  && url.pathname === "/api/version")     return guard(handleVersion(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/upgrade")     return guard(handleUpgrade(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/restart")     return guard(handleRestart(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/quota")       return guard(handleQuota(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/codex-usage")  return guard(handleCodexUsage(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/codex-quota") return guard(handleCodexQuota(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/ccusage")     return guard(handleCcusage(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/claude-accounts") return guard(handleClaudeAccounts(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/claude-accounts/switch") return guard(handleClaudeAccountSwitch(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/claude-accounts/login")  return guard(handleAccountLoginState(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/claude-accounts/admin")  return guard(handleClaudeAccountAdmin(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/sound-hook") return guard(handleSoundHook(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/sound-hook") return guard(handleSoundHookSet(req, res), res);
    if (req.method === "GET"  && url.pathname === "/api/cswap-auto")  return guard(handleCswapAuto(req, res), res);
    if (req.method === "POST" && url.pathname === "/api/cswap-auto")  return guard(handleCswapAutoAction(req, res), res);

    if (req.method === "GET" && url.pathname === "/api/events") {
      return send(res, 200, eventsSince(url.searchParams.get("since") ?? 0));
    }

    // POST /api/clear — wipe in-memory buffer + persistence file (UI reset)
    if (req.method === "POST" && url.pathname === "/api/clear") {
      events.length = 0;
      if (persistPath) truncate(persistPath, 0).catch(() => {});
      pushEvent({ hook_event_name: "__clear", cwd: "" }, "internal");
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET") return serveStatic(req, res, url);
    send(res, 405, { error: "method not allowed" });
  });

  // Try requested port first, then up to 10 random ports from portRange.
  const candidates = [port];
  for (let i = 0; i < 10; i++) candidates.push(randomPort(portRange[0], portRange[1]));

  for (const candidate of candidates) {
    try {
      await tryListen(server, candidate, host);
      // Codex has no working hooks on Windows — tail its rollout files instead.
      if (codex) startCodexWatcher(workspace);
      // Auto-switch resumes only if the user previously turned it on; the
      // module reads its own persisted flag and does nothing otherwise.
      cswapAutoModule().then(m => m.initCswapAuto()).catch(() => {});
      return server;
    } catch (err) {
      if (err && err.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw Object.assign(new Error(`all ports tried — none available`), { code: "EADDRINUSE" });
}

// Allow running this file directly for dev.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CCGRAPH_PORT ?? 4317);
  startServer({ port }).then(s => {
    const addr = s.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`agents-deck server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error("agents-deck server failed:", e.message);
    process.exit(1);
  });
}
