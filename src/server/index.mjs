// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// Single-file pure Node HTTP server, zero deps.
import { createServer } from "node:http";
import { readFile, stat, mkdir, appendFile, open, truncate, readdir, unlink } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, dirname as pdirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { claudeConfigDir } from "./claude-dir.mjs";
import { CODEX_SESSIONS_DIR, STOP, walkRolloutDays } from "./codex-dir.mjs";
import { PRODUCT } from "./brand.mjs";
import { invokedName, renameNotice } from "./invoked-as.mjs";
import { codexCwdInWorkspace, writesCodexLog } from "./log-writer.mjs";

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
    console.log(`${PRODUCT}: rotated ${persistPath} (${(s.size / 1024 / 1024).toFixed(0)}MB → ${oldPath})`);
  } catch (err) {
    console.error(`${PRODUCT}: persist rotation failed:`, err && err.message ? err.message : err);
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
  ephemeral_1h_input_tokens: /"ephemeral_1h_input_tokens"\s*:\s*(\d+)/,
  ephemeral_5m_input_tokens: /"ephemeral_5m_input_tokens"\s*:\s*(\d+)/,
};
// The flat `cache_creation_input_tokens` says how many tokens were written to
// cache but not at which TTL, and Anthropic bills a 1-hour write at 2x input
// against the 5-minute 1.25x — CC writes 1-hour caches for most of its prefix,
// so pricing the whole lot at the cheaper rate under-reports the bill. The
// split lives in a `cache_creation` sub-object that USAGE_BLOCK_RE cannot
// reach: its `[^}]+` stops at the first `}`, which in a real transcript closes
// `server_tool_use`, several fields earlier. Match the sub-object on the raw
// line instead of on the extracted blob.
const CACHE_CREATION_BLOCK_RE = /"cache_creation"\s*:\s*\{([^}]*)\}/g;

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
    rootModel: null,
    lastModel: null,    // last claude-* model on any line, sidechain included
    subagentModels: {},
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0,
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
  for (const m of line.matchAll(CACHE_CREATION_BLOCK_RE)) {
    state.usage.ephemeral_1h_input_tokens += grabUsageField(m[1], "ephemeral_1h_input_tokens");
    state.usage.ephemeral_5m_input_tokens += grabUsageField(m[1], "ephemeral_5m_input_tokens");
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

/** Record a use of `path` and keep the map under the cap. Re-inserting on
 *  every touch makes the Map's own insertion order the LRU order, so eviction
 *  reads one key instead of scanning for the smallest timestamp. Scanning a
 *  timestamp is also what broke the cache: a state is created with no stamp
 *  yet, so the entry the scan had just inserted was the smallest of all and
 *  the one deleted, every time. Past 256 distinct transcripts the map froze on
 *  the first 256 paths and every later transcript re-read its whole JSONL from
 *  byte 0 on every throttled pass — the O(n)-per-pass stall the cursor exists
 *  to remove. */
function touchTranscriptScan(path, state) {
  transcriptScans.delete(path);
  transcriptScans.set(path, state);
  pruneTranscriptScans();
}

function pruneTranscriptScans() {
  while (transcriptScans.size > MAX_TRANSCRIPT_SCANS) {
    transcriptScans.delete(transcriptScans.keys().next().value);
  }
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
    if (!state) state = newTranscriptState();
    touchTranscriptScan(path, state);
    try {
      const s = await stat(path);
      // Shorter than the cursor means the file was truncated, rotated or
      // replaced — the offset now points at unrelated bytes, so start over.
      if (s.size < state.offset) {
        state = newTranscriptState();
        // Touch again rather than set: the await above yielded, and another
        // path's scan may have re-ordered or evicted this entry meanwhile.
        touchTranscriptScan(path, state);
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
// `"model":"claude-opus-4-7"`. We re-read the tail of that file on every
// event for the session (throttled to MODEL_READ_THROTTLE_MS), cache the
// resolved root + subagent models, and (a) inject `model` into subsequent
// payloads for that session before broadcasting, (b) emit a synthetic
// `ModelObserved` event whenever that set CHANGES, so the client backfills
// agents created before the model was resolved. The cache is the emit
// filter, not a read filter: reading once per session meant a subagent
// model that only appears after the root is known was never picked up.
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
// any CLAUDE.md files in scope. Cumulative token totals come from
// UsageObserved; this scan produces the structural counts ("what does the
// context contain") plus the current window size — currentContextTokens, the
// last usage block after the most recent /clear or /compact, which is what
// the context donut and the modal's percentage are drawn from.
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

/** Longest slug CC will store verbatim. Anything longer is truncated here and
 *  given a hash suffix, so two deep paths sharing a 200-character prefix still
 *  get separate directories. */
const CC_SLUG_MAX = 200;

/** CC's hash of the *unencoded* path, used only for the truncation suffix:
 *  the classic h*31 + c string hash, kept in a signed 32-bit int. */
function ccPathHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** Encode an absolute path the way CC stores it under
 *  ~/.claude/projects/<slug>/, so the auto-memory scan below looks in the
 *  directory CC actually wrote.
 *
 *  CC flattens *every* non-alphanumeric character to "-", not just the path
 *  separators and the Windows drive colon this used to replace. Dots are the
 *  ones that bite: a worktree under .claude/worktrees/, or any folder named
 *  like my.app, produced a slug with a literal dot in it, the readdir below
 *  missed, and the project's auto-memory files were quietly left out of the
 *  context panel. Underscores and spaces were wrong the same way. */
export function ccProjectSlug(cwd) {
  if (!cwd) return "";
  // resolve() gives the platform's own absolute form — "/Users/…" on
  // macOS/Linux, "C:\Users\…" on Windows — and this class covers both, so the
  // drive colon and the backslashes fall out of the general rule.
  const abs = resolve(cwd);
  const slug = abs.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= CC_SLUG_MAX) return slug;
  return `${slug.slice(0, CC_SLUG_MAX)}-${Math.abs(ccPathHash(abs)).toString(36)}`;
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
// for usage + model. CODEX_HOME overrides ~/.codex, and codex-dir.mjs owns that
// rule for every module on the Codex side — this one used to spell it inline,
// which is how five modules ended up with three spellings of it (#375).
//
// Re-exported because bin/deck.js prints this path in the boot banner, and it
// used to build its own `join(homedir(), ".codex", "sessions")` for the purpose
// — which ignored CODEX_HOME and so named a directory that does not exist on any
// machine that sets it. Handing out the binding the watcher itself reads, rather
// than a second computation of the same rule, is what makes the printed path and
// the tailed path unable to disagree.
export { CODEX_SESSIONS_DIR };
const codexRolloutPathBySid = new Map();
const lastCodexUsageReadAt = new Map();
const pendingCodexUsageReads = new Set();
const CODEX_READ_THROTTLE_MS = 2500;

async function findCodexRolloutPath(sid) {
  const cached = codexRolloutPathBySid.get(sid);
  if (cached) return cached;
  // Walk year → month → day → files, newest first. Codex includes the sid in the
  // filename (rollout-...-<sid>.jsonl) so a directory-scoped match is enough.
  // The walk itself lives in codex-dir.mjs, shared with the watcher's listing
  // below and with codex-usage.mjs, so all three read one tree the same way.
  let found = null;
  await walkRolloutDays((dayDir, files) => {
    const hit = files.find(f => f.includes(sid) && f.endsWith(".jsonl"));
    if (!hit) return;
    found = join(dayDir, hit);
    return STOP;
  });
  if (found) codexRolloutPathBySid.set(sid, found);
  return found;
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
//   event_msg/user_message             → UserPromptSubmit (Codex ≤ 0.144)
//   event_msg/item_completed/UserMessage → UserPromptSubmit (Codex ≥ 0.147)
//   response_item/function_call        → PreToolUse
//   response_item/function_call_output → PostToolUse / PostToolUseFailure,
//                                        decided by the outcome line Codex
//                                        prepends to the output (codexCallFailed)
//   event_msg/token_count              → UsageObserved
//   event_msg/task_started (+window)   → ModelObserved (context window)
//   event_msg/task_complete            → Stop (the turn finished)
//   event_msg/turn_aborted             → Stop (the turn was interrupted)
//   turn_context / response_item.model → model snapshot (ModelObserved on change)
//   turn_context.approval_policy       → session snapshot, spread onto every
//                                        payload below (#398); no event of its own
// There is deliberately no SessionEnd here: Codex writes no session-close
// record, so the end of a SESSION is still inferred by sweepStaleSessions.
// Nor is there anything that maps to `Notification`, and no synthetic one is
// invented: Codex writes no approval record to a rollout at all, so the deck
// cannot see a Codex session blocked on a human and does not pretend to — see
// codex-approval.ts for the evidence and for what is said instead of guessing.
// Events are emitted with source "codex" so pushEvent skips the Claude-only
// transcript enrichment (which needs transcript_path / hook events) but still
// broadcasts them exactly like a hook event, and persists them when this deck is
// the one elected to log this rollout — see writesCodexLog. This path is
// entirely additive — the Claude hook flow is untouched.
const codexFileState = new Map();      // path -> { offset, sid, cwd, skip, seenAt }
const codexSessionModel = new Map();   // sid -> last model string
// sid -> the `approval_policy` of the newest `turn_context` seen on this
// session. See codexObjToPayload for why this is read and what it is NOT used
// for; #398 for why the deck holds it at all.
const codexSessionApproval = new Map(); // sid -> last approval_policy string
// How long a rollout's tail cursor is kept after it stops showing up in the
// listing. The listing covers two day-directories, so anything missing from it
// is at least a day old and will never be appended to again.
const CODEX_STATE_TTL_MS = 10 * 60 * 1000;
let codexScanRunning = false;
let codexWatchTimer = null;
let codexWorkspace = "";

/**
 * Every deck registered right now, as its own discovery record spells it.
 *
 * These are the files hook.js enumerates; this is the server reading them for
 * itself, because the rollout watcher has no hook to do it and still has to know
 * which other decks are tailing the same file into the same log. Dead pids are
 * ignored rather than unlinked — sweepStaleDiscovery owns that, and a poll
 * running every 1.5s is no place to be deleting other decks' registrations.
 */
async function readLiveDecks() {
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const decks = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8"));
      // Without both numbers there is nothing to group or tie-break on, so the
      // record cannot take part in an election either way.
      if (!d || typeof d.pid !== "number" || typeof d.port !== "number") continue;
      if (!isProcessAlive(d.pid)) continue;
      decks.push(d);
    } catch { /* corrupt, or gone between listing and read */ }
  }
  return decks;
}

// List rollout files from the newest 2 day-directories. New sessions always
// land in today's dir, so this captures live activity without scanning years
// of history every tick.
async function listRecentCodexRollouts() {
  const out = [];
  let dayDirs = 0;
  await walkRolloutDays((dir, files) => {
    for (const f of files) if (f.endsWith(".jsonl")) out.push(join(dir, f));
    // Two day-directories deep is the whole point of this listing: it runs every
    // tick, and anything older than that is a session no process will append to.
    if (++dayDirs >= 2) return STOP;
  });
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

/**
 * The human's prompt out of a 0.147-era `item_completed` item.
 *
 * `item.content` is an array of parts — every UserMessage observed carries a
 * single `{ type: "text", text, text_elements }` — so the parts are joined
 * rather than indexed, and a part with no string `text` contributes nothing
 * instead of printing "undefined" into the prompt the card shows.
 */
function codexItemText(item) {
  const parts = Array.isArray(item && item.content) ? item.content : [];
  return parts.map(p => (p && typeof p.text === "string" ? p.text : "")).join("");
}

// Map one parsed rollout object to a synthetic hook payload (or null to skip).
// Mutates codexSessionModel and returns { payload, modelEvent } where
// modelEvent is an optional ModelObserved to emit first when the model changed.
//
// Exported for the tests: this is the whole of the Codex translation, and the
// lifecycle it produces is worth pinning against the real reducer without
// standing up a watcher, a temp home and a 1.5s poll to get at it.
export function codexObjToPayload(obj, sid, cwd) {
  const type = obj && obj.type;
  const pl = (obj && obj.payload) || {};
  const model = codexSessionModel.get(sid);
  // Rides on every payload this function returns, exactly as `model` does and
  // for the same reason: it is a property of the SESSION rather than of any one
  // event, the rollout restates it on every turn, and a field spread onto each
  // payload needs no event of its own and self-heals on the next line the
  // watcher reads. The reducer stamps it on the root beside `contextWindow`.
  const approval_policy = codexSessionApproval.get(sid);
  const base = { session_id: sid, cwd, provider: "codex", approval_policy };

  // Track model from turn_context / response_item before mapping events.
  if (type === "turn_context") {
    if (typeof pl.model === "string") codexSessionModel.set(sid, pl.model);
    // #398: the deck used to read `model` out of this record and drop
    // everything else, and `approval_policy` was the field that mattered most
    // among the discarded ones. It is the ONLY recorded fact anywhere in a
    // rollout that says whether this session is even capable of stopping to ask
    // a human: at "never" Codex denies an escalation outright rather than
    // prompting, so a quiet session there is genuinely working, while at
    // "on-request" / "on-failure" / "untrusted" a quiet one may be parked on a
    // prompt the deck will never see.
    //
    // It is read to SAY that, and deliberately not to infer a block from it —
    // see codex-approval.ts. Codex persists no approval record of any kind (58
    // turn_contexts and ~1,100 records across the rollouts on this machine
    // carry no approval-shaped type; the persist filter keeps every *_end and
    // drops every request/begin — patch_apply_end with no patch_apply_begin,
    // web_search_end with no begin, item_completed with no item_started), so a
    // "waiting" state derived from this plus a pending call would be a guess
    // wearing the clothes of a measurement.
    //
    // Written on the record even when the value is missing or not a string, so
    // a future Codex that renames or drops the field clears the stale answer
    // rather than pinning the session to whatever it last said.
    if (typeof pl.approval_policy === "string" && pl.approval_policy) {
      codexSessionApproval.set(sid, pl.approval_policy);
    } else {
      codexSessionApproval.delete(sid);
    }
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
    // Codex 0.147 stopped writing `user_message` and writes the same submission
    // as an `item_completed` carrying a `UserMessage` item instead. The two are
    // mutually exclusive per CLI version — across the rollouts sampled here the
    // 0.144 files have `user_message` and no `item_completed` at all, and the
    // 0.147 files have exactly one `UserMessage` item per turn and no
    // `user_message` — so handling both names emits one prompt per turn either
    // way rather than two on either version. The item is the human's typed text
    // only: the AGENTS.md preamble Codex prepends is written as a bare
    // `response_item` with role "user" and never gets an item of its own.
    //
    // This matters far beyond the prompt text. `UserPromptSubmit` is what puts
    // a settled root back to `active` (reducer.ts), so on 0.147 it is the ONLY
    // thing that reopens a session for its second turn — without it the `Stop`
    // below would trade "live forever" for "done forever", which is not better.
    if (pl.type === "item_completed" && pl.item && pl.item.type === "UserMessage") {
      return { ...base, hook_event_name: "UserPromptSubmit", prompt: codexItemText(pl.item), model };
    }
    if (pl.type === "token_count" && pl.info && pl.info.total_token_usage) {
      return { ...base, hook_event_name: "UsageObserved", usage: pl.info.total_token_usage, model };
    }
    if (pl.type === "task_started" && typeof pl.model_context_window === "number") {
      return { ...base, hook_event_name: "ModelObserved", model, model_context_window: pl.model_context_window };
    }
    // The end of a turn, which is the only end Codex ever announces. Both names
    // are one outcome as far as the deck is concerned — the turn is over and
    // nothing is running — so both settle the root the way Claude's own Stop
    // hook does. They are also exhaustive: across the rollouts sampled here
    // every `task_started` is answered by exactly one of the two (54 completes
    // + 1 abort for 55 starts), so no turn is left open by this mapping and
    // none is closed twice. `turn_aborted` is the Esc key, and it is the case
    // that matters most on the deck: pressing Esc is precisely when the user is
    // watching to confirm the thing stopped.
    //
    // Per TURN, not per session, and that is correct: Codex writes no
    // session-close record at all — a rollout simply stops growing when the
    // terminal goes away — so `sweepStaleSessions` remains the only thing that
    // ends a Codex *session*, and it must. What changes is that it now only
    // ever sees the sessions it was written for: the ones that died without
    // finishing. A turn that really ended is settled here, at the moment it
    // ended, with no `reaped` flag, because it was a finish and not a guess.
    if (pl.type === "task_complete" || pl.type === "turn_aborted") {
      return { ...base, hook_event_name: "Stop", model };
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
      return { ...base, hook_event_name: "PreToolUse", tool_name: pl.name ?? "tool", tool_input: codexCustomToolInput(pl.name, pl.input), tool_use_id: pl.call_id, model };
    }
    // #397: the outcome, not just the fact that an outcome arrived. This used
    // to hardcode "PostToolUse" for both output types, and the reducer derives
    // `ok` from the event NAME (`tc.ok = name === "PostToolUse"`) — so `ok` was
    // structurally incapable of being false on the Codex path and a command
    // that exited non-zero drew exactly like one that succeeded. Every surface
    // that reads the flag inherited the lie: the burst dot, the tool row, the
    // ToolModal styling, the detail-panel error count, and the session
    // summary's "Errors" stat, which was therefore pinned at 0 for the life of
    // a Codex session. `PostToolUseFailure` is the name the reducer already
    // understands (it sets `ok = false` and writes an `errorPreview` from the
    // response); nothing but this mapper was missing.
    if (pl.type === "function_call_output" || pl.type === "custom_tool_call_output") {
      const tool_response = pl.output != null ? parseCodexOutput(pl.output) : undefined;
      const name = codexCallFailed(pl.output) ? "PostToolUseFailure" : "PostToolUse";
      return { ...base, hook_event_name: name, tool_use_id: pl.call_id, tool_response, model };
    }
  }
  return null;
}

/**
 * Wrap a `custom_tool_call`'s raw input under the key that describes what it
 * actually is.
 *
 * WHY THIS IS NOT JUST `{ patch: input }` ANY MORE (#417). Codex's
 * `custom_tool_call` container carries a bare string and nothing that says what
 * kind of string it is — the tool's NAME is the only discriminator. When this
 * branch was written the container had exactly one inhabitant, `apply_patch`,
 * so it hardcoded `patch` and was right. It is no longer the only inhabitant,
 * and on 0.147 it is not even the common one:
 *
 *   CLI      custom_tool_call name   count
 *   0.144.5  exec                       77
 *   0.144.5  apply_patch                 2
 *   0.147.0  exec                        6
 *
 * Eighty-three shell scripts were therefore filed on the deck as patches. The
 * client's `commandStringOf` reads `cmd` / `command` / `script` and never
 * `patch`, so no Codex call could show what it ran; `extractFilePath` mean-
 * while reads `patch` and tried to find a `*** Update File:` header in a
 * JavaScript program. Keying off the name fixes both directions at once.
 *
 * WHY `exec` GETS `script` AND NOT `command`. Because it is not a command. The
 * `exec` tool takes a small JavaScript program that calls into a `tools.*` API
 * — 83 of 83 inputs on this machine start with `const `, none parses as JSON,
 * all are multi-line — and Codex's own result wrapper calls it one, prefixing
 * the output with "Script completed" / "Script failed" rather than an exit code
 * (the line #397 reads). Filing a program under `command` would make the deck
 * draw the first token of the program as the command that ran, which is the
 * word `const` on every Codex call in the session. `script` is both true and
 * already understood by the client, which digs the real command out of the
 * program from there.
 *
 * WHY THE FALLBACK IS `input` AND NOT A GUESS. A name this function has never
 * heard of is a string whose meaning is unknown, and the one thing worse than
 * showing it under a neutral key is showing it under a confident wrong one —
 * that is the whole of this bug, repeated. `input` claims nothing; the tool's
 * own name still reaches the bubble, so an unrecognised Codex tool degrades to
 * "a tool I cannot read the arguments of" instead of "a patch".
 */
const CODEX_CUSTOM_TOOL_INPUT_KEY = {
  // A `*** Begin Patch … *** End Patch` document (2/2 observed, both 0.144.5).
  // Unchanged, and it has to stay unchanged: the client's extractFilePath()
  // pulls the edited file's path out of `input.patch` for the sub-bubble.
  apply_patch: "patch",
  // A JavaScript program. See above.
  exec: "script",
};

function codexCustomToolInput(name, input) {
  const key = CODEX_CUSTOM_TOOL_INPUT_KEY[name] ?? "input";
  return { [key]: input };
}

/**
 * The text parts of a Codex tool result, in the order Codex wrote them.
 *
 * Codex writes the result in two different containers and the deck sees both,
 * so this is where the difference stops. Across the rollouts sampled here:
 * `custom_tool_call_output.output` is an ARRAY of `{ type: "input_text", text }`
 * parts (85/85, on 0.144 and 0.147 alike), and `function_call_output.output` is
 * a bare string (32/32). The `{ output, metadata }` envelope `parseCodexOutput`
 * unwraps was written by neither, but it is cheap to keep tolerating and the
 * unwrapping already lives there, so the string case is routed through it
 * rather than duplicating the guess.
 */
function codexOutputParts(output) {
  if (output == null) return [];
  if (Array.isArray(output)) {
    return output.map(p => (p && typeof p.text === "string" ? p.text : ""));
  }
  const unwrapped = parseCodexOutput(output);
  return typeof unwrapped === "string" ? [unwrapped] : [];
}

/**
 * Did this Codex tool call actually fail?
 *
 * Codex prepends its own wrapper line to the tool's output and that line — not
 * any structured field — is where the outcome lives. Verified against every
 * tool result in this machine's CODEX_HOME:
 *
 *   0.144.5  exec         "Script completed"   75    "Script failed"   2
 *   0.147.0  exec         "Script completed"    6    (no failure observed)
 *   0.144.5  apply_patch  "Exit code: 0"        2
 *   0.144.5  exec_command / run — bare string, no wrapper line at all      32
 *
 * The two CLI versions spell it IDENTICALLY, which is why one rule covers both
 * and why this needs no version sniffing: 0.147 renamed the prompt event (see
 * the `item_completed` branch above) but left the exec wrapper alone.
 *
 * Only the FIRST part's FIRST line is read, and that precision is load-bearing
 * rather than tidiness. The wrapper line is at part index 0 in 85 of 85 results
 * that have one; the later parts are the command's own stdout, and the command
 * prints whatever it likes there. On this machine two exec results contain a
 * line reading "Script error:" in part 1 — output from a script that ran fine
 * under a wrapper that says "Script completed" — so a rule that scanned every
 * part would paint two successful calls red. `\r` is stripped because the same
 * wrapper is written by Codex on Windows.
 *
 * Silence means success, deliberately. A result with no wrapper line — every
 * `function_call_output` on 0.144, and whatever container a future Codex
 * invents — keeps today's behaviour of mapping to `PostToolUse`. Reporting an
 * unknown outcome as a failure would trade one wrong colour for another, and
 * this direction is the recoverable one: a missed failure is a call that draws
 * as it always has, while a false failure puts a red dot and an "Errors" count
 * on a session that did nothing wrong.
 */
function codexCallFailed(output) {
  const first = codexOutputParts(output)[0];
  if (typeof first !== "string") return false;
  const head = first.split("\n")[0].replace(/\r$/, "");
  if (/^Script failed\b/.test(head)) return true;
  // apply_patch reports itself with an exit code instead of a word. Anything
  // non-zero is a patch that did not apply.
  const exit = /^Exit code:\s*(\d+)/.exec(head);
  if (exit) return Number(exit[1]) !== 0;
  return false;
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

// `persist` is false when another deck tailing this same rollout was elected to
// write it to the log they share. The event is still buffered and broadcast —
// every deck watching the session draws it — it is only the second copy on disk
// that is dropped. See writesCodexLog in log-writer.mjs.
function emitCodexEvent(payload, persist) {
  pushEvent(payload, "codex", { persist });
}

// Emit the SessionStart root exactly once per file, lazily — only when the
// session actually produces an event. This keeps long-dead sessions that were
// merely on disk at startup from cluttering the canvas with empty roots.
function ensureCodexRoot(state, persist) {
  if (state.rootEmitted) return;
  state.rootEmitted = true;
  emitCodexEvent({ session_id: state.sid, cwd: state.cwd, provider: "codex", hook_event_name: "SessionStart" }, persist);
}

async function codexScanOnce(firstRun) {
  if (codexScanRunning) return;
  codexScanRunning = true;
  try {
    const now = Date.now();
    // Read at most once per scan, and only from the first rollout that actually
    // has new bytes: most ticks read nothing and must not pay a directory
    // listing for the answer to a question nothing is asking.
    let decksRead = null;
    const liveDecks = () => (decksRead ??= readLiveDecks());
    const files = await listRecentCodexRollouts();
    for (const path of files) {
      let st;
      try { st = await stat(path); } catch { continue; }
      let state = codexFileState.get(path);
      if (state) state.seenAt = now;

      if (!state) {
        // New file — read the header for sid + cwd, then decide whether to
        // capture it. Skip files outside our workspace.
        const header = await readCodexHeader(path);
        if (!header || !header.sid) continue; // not ready yet — retry next tick
        if (!codexCwdInWorkspace(header.cwd, codexWorkspace)) {
          codexFileState.set(path, { offset: st.size, sid: header.sid, cwd: header.cwd, skip: true, rootEmitted: false, seenAt: now });
          continue;
        }
        state = { offset: 0, sid: header.sid, cwd: header.cwd, skip: false, rootEmitted: false, seenAt: now };
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

      // Decided per file rather than per line: which decks are up, and which of
      // them tail this rollout, cannot change inside one batch of appended
      // lines, and the answer must be the same for every event in it — a root
      // written by one deck and its tool calls by another is worse than either.
      const persist = !persistPath
        || writesCodexLog({ decks: await liveDecks(), pid: process.pid, cwd: state.cwd });

      for (const line of consume.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const prevModel = codexSessionModel.get(state.sid);
        const payload = codexObjToPayload(obj, state.sid, state.cwd);
        // If the model changed (turn_context/response_item), surface it.
        const nowModel = codexSessionModel.get(state.sid);
        if (nowModel && nowModel !== prevModel) {
          ensureCodexRoot(state, persist);
          emitCodexEvent({ session_id: state.sid, cwd: state.cwd, provider: "codex", hook_event_name: "ModelObserved", model: nowModel }, persist);
        }
        if (payload) {
          ensureCodexRoot(state, persist);
          emitCodexEvent(payload, persist);
        }
      }
    }

    // Rollout files fall out of the newest-2-days listing and never come back,
    // but their tail cursors used to live as long as the process did. Expire by
    // "not seen for a while" rather than "absent from this listing": a single
    // unreadable directory mid-scan would otherwise drop a live file's cursor,
    // and re-adding it at offset 0 replays that entire rollout as fresh events.
    for (const [p, s] of codexFileState) {
      if (now - (s.seenAt ?? 0) > CODEX_STATE_TTL_MS) codexFileState.delete(p);
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

// ─── Per-session cache expiry ────────────────────────────────────────────
// Every enrichment cache above is keyed by session id and nothing ever
// removed an entry: a deck left up for weeks — the 24/7 use this thing is
// built for — kept a model string, a subagent signature and four read-throttle
// stamps for every session it had ever seen, plus the Codex rollout path and
// model of each. SessionEnd is not a usable eviction signal (a killed CLI
// never sends one, and Codex has no such hook at all), so entries expire by
// least-recent use against a cap instead — the same shape pruneTranscriptScans
// already uses for its per-path state. The cap sits far above any plausible
// number of concurrent sessions, so a live session is never evicted; and an
// evicted one that speaks again simply re-reads its transcript.
const sessionTouchedAt = new Map();   // sid -> ms of the last event seen
const MAX_TRACKED_SESSIONS = 256;

function forgetSession(sid) {
  modelBySession.delete(sid);
  modelLastReadAt.delete(sid);
  lastUsageReadAt.delete(sid);
  lastContextReadAt.delete(sid);
  codexRolloutPathBySid.delete(sid);
  lastCodexUsageReadAt.delete(sid);
  codexSessionModel.delete(sid);
  codexSessionApproval.delete(sid);
}

function touchSession(sid) {
  if (!sid || typeof sid !== "string") return;
  // Re-insert so the Map's own insertion order *is* the LRU order and eviction
  // below is one key read rather than a scan of every session ever seen.
  sessionTouchedAt.delete(sid);
  sessionTouchedAt.set(sid, Date.now());
  while (sessionTouchedAt.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessionTouchedAt.keys().next().value;
    sessionTouchedAt.delete(oldest);
    forgetSession(oldest);
  }
}

// ─── SSE backpressure ────────────────────────────────────────────────────
// A client that stops reading without closing its socket — a frozen tab, a
// suspended machine, a stalled `ssh -L` tunnel — never fires 'close' and never
// makes write() throw, so the old `try { res.write(line) } catch {}` had no
// way to notice it. On loopback nothing times the connection out either, so
// every event (tool responses run to megabytes) queued in that socket's write
// buffer for as long as the process lived.
//
// We drop the client rather than the events. EventSource reconnects after the
// `retry: 1500` we send on connect and resumes from Last-Event-ID, so the ring
// buffer replays whatever it missed. Dropping individual events instead would
// leave a hole the resume path cannot even see, the client's last id having
// moved past it.
const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;

/** Bytes queued for a client: what the response has not handed to the socket
 *  yet, plus what the socket has not handed to the kernel. */
function queuedBytes(res) {
  const own = typeof res.writableLength === "number" ? res.writableLength : 0;
  const sock = res.socket && typeof res.socket.writableLength === "number" ? res.socket.writableLength : 0;
  return own + sock;
}

/** Hang up on a client we have decided not to keep. `delete` on a response
 *  that never made it into the set — the resume path below hangs up on clients
 *  before they are subscribed — is a harmless no-op. */
function dropSse(res) {
  sseClients.delete(res);
  // Destroying the socket is what makes the request emit 'close', which is
  // where the ping interval is cleared.
  try { res.destroy(); } catch {}
  try { res.socket?.destroy(); } catch {}
}

/** Write one SSE frame, hanging up on a client too far behind to keep. */
function writeSse(res, frame) {
  try {
    res.write(frame);
    if (queuedBytes(res) <= MAX_CLIENT_BUFFER_BYTES) return;
  } catch { /* already dead — drop it below */ }
  dropSse(res);
}

// How long a resuming client is given to accept the bytes already queued for
// it before the deck concludes it is not reading at all. Generous on purpose:
// what it has to work through is a full MAX_CLIENT_BUFFER_BYTES, the link may
// be an `ssh -L` tunnel rather than loopback, and dropping a client that is
// merely slow costs it the whole replay. A tab that is genuinely frozen will
// not accept a byte in any budget, so the only thing a long one buys it is a
// few more seconds of holding its own buffer. The environment override exists
// so the tests can pin the drop without sitting through the real budget.
const REPLAY_DRAIN_MS = Number(process.env.AGENTS_DECK_REPLAY_DRAIN_MS) > 0
  ? Number(process.env.AGENTS_DECK_REPLAY_DRAIN_MS)
  : 30_000;

/**
 * Write one frame of the resume stream under the same ceiling the live path
 * obeys, waiting rather than dropping when the client is at it. Resolves true
 * while the client is worth keeping, false once it is not.
 *
 * Waiting is the whole difference from writeSse, and the replay is why. The
 * live path writes one frame per event, so a full buffer there means the
 * client stopped reading and the only answer is to hang up. Here the burst is
 * ours: the loop below hands the socket the entire ring buffer in one turn of
 * the event loop, so even a client reading at full speed sees its buffer fill
 * — nothing has drained it yet, because nothing could. Dropping on that would
 * hang up on healthy clients, and hang up on them again every time they came
 * back: EventSource reconnects with the same Last-Event-ID, meets the same
 * oversized replay, and is dropped again 1.5 seconds later, forever. So we
 * stop writing until the socket has taken what it already has, and only give
 * up on a client that takes nothing at all for REPLAY_DRAIN_MS.
 *
 * The wait is on write()'s completion callback rather than on a 'drain' event:
 * 'drain' only follows a write that was answered false, and a frame can push
 * queuedBytes past the cap while still being answered true, the socket's own
 * pending bytes being one of the two terms in that sum. The callback fires
 * once this chunk —
 * and therefore everything queued ahead of it — has reached the OS, which is
 * exactly the condition being waited for. It also fires, with an error we do
 * not need to read, if the response is destroyed underneath us, so this cannot
 * hang on a client that goes away.
 */
async function writeResume(res, frame) {
  // Below the cap this is the plain write it has always been. The `await` in
  // the caller costs a microtask and nothing else: the checkpoint drains
  // before the loop can accept I/O, so no live event can slip between two
  // replay frames the way it could across a real wait.
  if (queuedBytes(res) <= MAX_CLIENT_BUFFER_BYTES) {
    try { res.write(frame); return true; } catch { return false; }
  }
  return new Promise(resolve => {
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // Unref'd so a client that stopped reading can never be the reason the
    // process stays alive, and cleared on every path out so a completed replay
    // leaves no timer behind.
    const timer = setTimeout(() => done(false), REPLAY_DRAIN_MS);
    timer.unref?.();
    try { res.write(frame, () => done(!res.destroyed)); }
    catch { done(false); }
  });
}

// What a redacted occurrence of the deck's token is replaced with. A visible
// marker rather than an empty string, because the reader of a mangled Bash
// output deserves to know the deck did it and why, and because the UI renders
// payload strings verbatim — a silent hole would look like a truncated tool
// response and get debugged as one.
const TOKEN_REDACTED = "[redacted: ccdeck token]";

/**
 * Take the deck's own token back out of an event, before anything stores it.
 *
 * #366 made HOOK_TOKEN the one credential separating "may read" from "may
 * mutate", and there is a path that copies it into a store needing no
 * credential to read. `POST /api/event` is deliberately open — hook/hook.js is
 * installed outside this package, into the user's ~/.claude, so requiring a
 * credential there would silence every session whose hook predates that change
 * — while `GET /api/events`, `GET /events` and events.jsonl are all readable
 * without one. So an agent session that merely LOOKS at the discovery file puts
 * the token into the ring buffer, and that is not an exotic act: `cat
 * ~/.claude/agent-dag/<pid>.json`, a `Read` of it, or a plain `grep -r
 * ~/.claude` all do it, and CC records both the tool input and the tool
 * response. From the buffer it is served to exactly the two callers #366 was
 * written for — the other local UID and the sandboxed subprocess — neither of
 * which can open the discovery file itself but both of which reach the API. For
 * them this turned "cannot mutate" back into "can mutate", the token read out
 * of the event log being the whole of the new gate. What keeps those two out of
 * the discovery file itself — a mode bit on Unix, the profile directory's ACL
 * on Windows, where the chmod is a no-op — is spelled out at presentsDeckToken.
 *
 * Why this sits in pushEvent and not in handleEventIngest, which is where the
 * report first put it. Events reach the buffer through more than one door:
 * handleEventIngest is the hook's, emitCodexEvent is the Codex rollout
 * watcher's — those events never pass through an HTTP handler at all —
 * replayLog is the boot replay's, `/api/clear` pushes its own marker, and six
 * enrichment sites push synthetic events off the back of a transcript read.
 * Redacting at the ingest handler covers one of those and leaves the next route
 * somebody adds uncovered. pushEvent is the one point every event passes
 * through exactly once, so the check is written once and cannot be forgotten.
 *
 * Why a walk over the string values rather than
 * `JSON.stringify(payload).includes(token)`, which is the obvious one-liner.
 * Measured rather than assumed, on 4.7k real payloads out of a 21MB
 * events.jsonl (mean 5KB serialized): the walk costs 1.3–3.6 µs per event and
 * serialize-then-search costs 14–48 µs, the same order as the JSON.parse the
 * ingest path already pays for the body. Serializing here would also defeat the
 * deliberate optimization below, which skips serializing ENTIRELY when nothing
 * is subscribed and nothing is being logged — a headless deck, and the boot
 * replay of a log that only rotates at 50MB. The walk allocates nothing at all
 * until it finds something.
 *
 * Iterative rather than recursive on purpose. The payload arrives from
 * JSON.parse of a body capped at 5MB, which is free to nest as deeply as it
 * likes, and a recursive scan would be a new way to overflow the stack inside
 * the request listener — where nothing catches it.
 *
 * Scope is the token and nothing else in the discovery file. pid, port,
 * workspace, the log path and startedAt are not credentials — /api/health
 * already answers with the workspace path — and redacting the workspace would
 * mangle the `cwd` of every honest event the deck draws.
 *
 * What this does NOT catch, stated plainly so nobody mistakes it for more. A
 * token split across two string fields, or across two events, survives — but
 * every substring search has that shape, and the halves are individually
 * worthless: secretEquals is byte-exact, so a partial token authenticates
 * nothing. Case is not folded for the same reason; HOOK_TOKEN is lowercase hex
 * and an uppercased copy would not authenticate either.
 *
 * And this is not a new oracle. A caller who can POST here and read
 * /api/events can post a guess and watch whether it comes back redacted, which
 * tells them precisely what `x-ccdeck-token: <guess>` on any protected route
 * already tells them — against 256 bits with no structure to search.
 *
 * Returns the payload, because a top-level JSON string is a legal body for
 * `POST /api/event` and a primitive cannot be redacted in place.
 */
function redactDeckToken(raw) {
  // Read at call time, not at definition time: HOOK_TOKEN is declared far
  // below this line and nothing calls pushEvent during module evaluation.
  const token = HOOK_TOKEN;
  if (typeof raw === "string") return raw.includes(token) ? raw.replaceAll(token, TOKEN_REDACTED) : raw;
  if (raw === null || typeof raw !== "object") return raw;

  const stack = [raw];
  while (stack.length > 0) {
    const node = stack.pop();
    // Arrays and objects are walked separately because an indexed loop over an
    // array is markedly cheaper than `for…in` over one, and this runs on every
    // event: a single PostToolUse response can be an array of thousands.
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") {
          if (v.includes(token)) node[i] = v.replaceAll(token, TOKEN_REDACTED);
        } else if (v !== null && typeof v === "object") stack.push(v);
      }
    } else {
      // `for…in` is safe on these: they come from JSON.parse or from an object
      // literal in this file, so the prototype chain is Object.prototype, which
      // has nothing enumerable. A `"__proto__"` key in the posted JSON becomes
      // an OWN data property — JSON.parse does not run the setter — so it both
      // enumerates here and takes the assignment below as an ordinary write,
      // leaving the prototype alone.
      for (const k in node) {
        const v = node[k];
        if (typeof v === "string") {
          if (v.includes(token)) node[k] = v.replaceAll(token, TOKEN_REDACTED);
        } else if (v !== null && typeof v === "object") stack.push(v);
      }
    }
  }
  return raw;
}

function pushEvent(raw, source, opts = {}) {
  // First, before anything below can see it: the deck's own credential does not
  // belong in a store that is served without one. Every entry point to the
  // buffer, the SSE fan-out and events.jsonl passes through here, so this is
  // the single line that keeps it out of all three. See redactDeckToken.
  raw = redactDeckToken(raw);

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

  // Does this event reach the log at all? Not on a replay (it came from
  // there), not when the hook told us another deck owns this session's log,
  // and not when we have no log. Decided before serializing because it is half
  // of the answer to whether serializing is worth doing.
  const persisting = persistPath && !opts.replay && opts.persist !== false && writesLogFor(raw);

  // One serialization, shared by both consumers — and skipped entirely when
  // neither wants it. This used to stringify the whole envelope twice on the
  // hottest path in the process (once for the SSE frame, once for the persist
  // line), and built the frame even with nobody subscribed: a headless deck
  // paid a full stringify per event for a string no one read, and boot replay
  // — which runs before the listener exists and never broadcasts — paid one
  // for every line of a log that rotates at 50MB. An event this deck is not
  // logging is still broadcast, so a subscriber alone is reason enough.
  const json = (sseClients.size > 0 || persisting) ? JSON.stringify(evt) : null;

  if (sseClients.size > 0) {
    const line = `id: ${seq}\nevent: hook\ndata: ${json}\n\n`;
    // writeSse may drop a client mid-loop; deleting from a Set while iterating
    // it is well defined and skips only the entry removed.
    for (const res of sseClients) writeSse(res, line);
  }

  if (persisting) {
    // Fire-and-forget append. JSONL = newline-delimited JSON.
    appendFile(persistPath, json + "\n", "utf8").catch(() => {});
    // Cheap throttled check (every 30s) — only rotates if file > 50MB.
    maybeRotatePersistFile();
  }

  // Note the session so the caches the scanners below fill can expire by
  // least-recent use. Replays are excluded: they fill nothing, and a boot
  // replay of a log spanning weeks would otherwise churn the whole LRU through
  // dead session ids before the first live event even arrives.
  if (!opts.replay && raw && typeof raw === "object") touchSession(raw.session_id);

  // Kick off async transcript scans. Model and usage are both re-read
  // periodically (throttled to 2.5s per session) so the cost columns track
  // running totals as the session progresses and late subagent models still
  // land; ModelObserved is only emitted when the resolved set changes. Both
  // result in synthetic events.
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

// How long an oversized POST is drained after it has been refused, so the 413
// reaches a poster that is still uploading. Generous next to hook.js's own
// one-second budget, and finite so nothing can sit on the socket indefinitely.
const OVERSIZE_DRAIN_MS = 10_000;

// `persist` is false when the hook posted this event to another deck as well
// and elected that one to write it to the log they share. The event is still
// buffered and broadcast here — every matching deck draws it — it is only the
// second copy on disk that is dropped.
function handleEventIngest(req, res, persist = true) {
  let body = "";
  // Set once the cap is hit, because everything after that point is about an
  // exchange that is already over: more `data` may still be in flight, and
  // `end` must not go on to parse the truncated half.
  let refused = false;
  req.setEncoding("utf8");
  req.on("data", c => {
    if (refused) return;
    body += c;
    if (body.length > 5_000_000) {
      refused = true;
      body = "";              // nothing will read it now; let it go
      // ANSWER, rather than vanish. `req.destroy()` on its own tore the socket
      // down with no status line on it at all, so the poster learned only that
      // the connection had gone — indistinguishable from a deck that died or
      // was never there, and nothing in the exchange to tell those apart. `end`
      // never fires on a destroyed request either, so the handler below got no
      // second chance to speak. readBody above gets this right already, by
      // rejecting into a caller that replies.
      send(res, 413, { error: "event too large" });
      // Then keep reading, and throw it away. Answering is not enough on its
      // own, because the poster is still mid-upload when the answer goes out:
      // hang up now and its next write lands on a dead socket, it aborts with
      // EPIPE, and the 413 that was already sitting in its receive buffer is
      // discarded unread — the same disappearance in a different costume.
      // `Connection: close` is the tempting version of hanging up and has
      // exactly that effect: Node destroys the socket the moment such a
      // response flushes. Draining lets the poster finish and then read the
      // answer, which is the whole point of answering. `body` no longer grows,
      // so it costs no memory.
      req.resume();
      // Bounded, because draining forever is its own denial of service: a
      // poster that stops without ending would otherwise hold the socket for as
      // long as it liked.
      const grace = setTimeout(() => req.destroy(), OVERSIZE_DRAIN_MS);
      grace.unref?.();
      req.on("close", () => clearTimeout(grace));
    }
  });
  req.on("end", () => {
    if (refused) return;
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid json" }); }
    noteLogWriter(parsed, persist);
    const evt = pushEvent(parsed, "hook", { persist });
    send(res, 200, { ok: true, seq: evt.seq });
  });
  // Guarded for the same reason `end` is, and more sharply: destroying the
  // request above is itself what raises this, and answering a second time on a
  // response already sent throws ERR_HTTP_HEADERS_SENT out of an error handler,
  // where nothing is waiting to catch it.
  req.on("error", () => { if (!refused) send(res, 400, { error: "bad request" }); });
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 1500\n\n`);

  // A stale or absent id replays the whole ring, and so does a malformed one:
  // Number("nonsense") is NaN, every `seq <= NaN` is false, and the catch-up
  // loop below would rather compare against a number.
  const asked = Number(req.headers["last-event-id"] ?? 0);
  const lastId = Number.isFinite(asked) ? asked : 0;

  // The replay waits on the socket now, so it can no longer be part of this
  // synchronous handler. Nothing is waiting on the result here — the response
  // is already committed to a 200 and its own failure path is to hang up — so
  // start it, keep the router's contract of returning nothing, and make sure a
  // rejection ends the stream rather than the process.
  resumeSse(req, res, lastId).catch(() => dropSse(res));
}

/**
 * Drain the ring buffer into a newly connected client, then subscribe it.
 *
 * Two things had to change when this stopped being one synchronous burst.
 * `close` is registered before the first frame, because a tab closed mid-replay
 * has to stop it. And the replay repeats until it reaches the live tail: an
 * actual wait lets pushEvent run, and an event that lands after we have walked
 * past its place but before the client is in `sseClients` would otherwise be in
 * neither stream — a hole the client cannot even ask for again, its last id
 * having moved past it.
 */
async function resumeSse(req, res, lastId) {
  let sentThrough = lastId;
  let ping = null;
  let closed = false;
  req.on("close", () => {
    closed = true;
    if (ping) clearInterval(ping);
    sseClients.delete(res);
  });

  for (;;) {
    // A snapshot per pass, because a wait lets pushEvent splice the head of
    // `events` off, and iterating an array being spliced from the front skips
    // entries. Events evicted that way are gone for this client, which is the
    // same bargain every resume against a rotated ring already makes.
    const batch = events.slice();
    for (const e of batch) {
      if (e.seq <= sentThrough) continue;
      if (closed || res.destroyed) return;
      // Marked with `replay:true` on the envelope so the client can suppress
      // turn-cleanup side effects (exitAt stamping, autofit churn) until the
      // live stream takes over. Without this the reducer's UserPromptSubmit
      // handler treats replayed events as a real new turn — hiding prior-turn
      // subagents using the event's stale receivedAt, which collides with
      // wall-clock visibility gates and yields the "nodes appear then vanish"
      // symptom on refresh.
      const tagged = { ...e, replay: true };
      if (!await writeResume(res, `id: ${e.seq}\nevent: hook\ndata: ${JSON.stringify(tagged)}\n\n`)) {
        return dropSse(res);
      }
      sentThrough = e.seq;
    }
    // Caught up with the tail as it stands right now. Reached in one pass
    // unless a wait let new events in, and it terminates for the same reason
    // the client is still here at all: either it is taking bytes, in which case
    // loopback outruns any hook, or it is not, in which case writeResume gives
    // up on it.
    if (events.length === 0 || events[events.length - 1].seq <= sentThrough) break;
  }

  if (closed || res.destroyed) return;

  // Sentinel: tells client "ring buffer drained, live stream starts now". It
  // goes out under the same rule as the frames before it, so a client that has
  // just been handed a large replay is not hung up on over the last 30 bytes of
  // it before it has had the chance to read any.
  //
  // Subscribing before waiting on that write, rather than after, is what closes
  // the last hole: writeResume puts the bytes on the socket before it returns,
  // so the sentinel still precedes every live frame, and an event pushed while
  // we wait reaches this client through the live fan-out instead of falling
  // into the gap between the two. If the wait then ends in a drop, dropSse
  // takes it back out of the set — the same exit writeSse uses.
  const flushed = writeResume(res, `event: replay-end\ndata: {}\n\n`);
  sseClients.add(res);
  // Through writeSse like every other frame: on a client that has stopped
  // reading, the ping is the one thing still being written between events, and
  // it is what eventually reveals the socket as unrecoverable.
  ping = setInterval(() => writeSse(res, `: ping\n\n`), 15000);
  if (!await flushed) dropSse(res);
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
  // Attached here rather than inside versionReport for the same reason
  // canRestart is: the report is what this package root says about itself,
  // while both of these are facts about the process serving it — the command
  // the user typed lives in this process's environment and argv, not on disk.
  //
  // It is deliberately not folded into `name`, which is documented as the
  // package an upgrade would install and is load-bearing for the update flow.
  // The two answer different questions and give different answers: `name` is
  // read off the install on disk and is always known, while this one is the
  // command that was typed and is silent wherever it cannot be proven — every
  // Windows global install, and every `npm i -g ccdeck`, whose stub spawns the
  // deck by absolute path and leaves nothing in argv to read.
  const invoked = invokedName({ pkgRoot: PKG_ROOT });
  // The second half of that notice, computed here rather than in the browser.
  //
  // The banner needs one more fact than the name: whether typing `ccdeck` is
  // enough (a global install ships all three commands, so it already is) or
  // whether the whole answer is `npx ccdeck`. The browser used to derive that
  // from `upgradeMode`, which reads like the same question and is not — it
  // answers "may this copy install over itself", and `AGENTS_DECK_NO_INSTALL=1`
  // makes it null for EVERY shape including npx, because upgradeBlockedReason
  // tests the opt-out before it tests npx. So an npx user who opted out of
  // installs was told the global-install line and sent to a command that does
  // not exist on their machine, while the terminal row two feet away said
  // `npx ccdeck` — one fact, two surfaces, opposite answers (#363).
  //
  // renameNotice is where that fact is decided for the terminal, so it decides
  // it here too and the browser renders the string rather than a branch. No
  // `dash` argument on purpose: the glyph tier is a terminal concern, and the
  // default em dash is what a browser should get.
  const rename = renameNotice({ invoked, pkgRoot: PKG_ROOT });
  send(res, 200, {
    ...report, canRestart: _canRestart, invokedAs: invoked, renameFix: rename?.fix ?? null,
  });
}

// Runs `npm i -g <this deck>@latest`, and only that: the argument vector is
// fixed inside self-update.mjs — including which of the three published names
// it installs, which comes from the layout npm built rather than from the
// request. Answers immediately — progress is read back from /api/version.
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

/** The other end of the latch above, for the upgrade that never happened.
 *
 * An npx upgrade is now fetched before anything is torn down, so a fetch that
 * fails leaves this process serving — with `_restarting` still set from a
 * restart that is not coming. Nothing would ever clear it: the only path that
 * did was the process ending. Every later click, from any tab, answered 202
 * "already restarting" for the rest of the deck's life. */
export function releaseRestart() {
  _restarting = false;
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

/**
 * ccusage's `--since`/`--until` grammar: a `YYYYMMDD` calendar date, or nothing
 * at all — an absent parameter lets ccusage.mjs pick the default 30-day range.
 *
 * Eight digits is a shape, not a calendar, and deliberately so. What this gate
 * is for is keeping anything that is not a date out of a child process's
 * argument vector; `99999999` is exactly as inert an argument as `20260101`,
 * and whether a date outside the logs means an empty chart is ccusage's
 * question to answer rather than the deck's to guess at.
 */
export const isCliDate = (v) => v === undefined || /^\d{8}$/.test(v);

async function handleCcusage(req, res) {
  const url = new URL(req.url, "http://localhost");
  const force = url.searchParams.get("refresh") === "1";
  const since = url.searchParams.get("since") || undefined;
  const until = url.searchParams.get("until") || undefined;
  // Refused here, at the boundary, because this is where a string chosen by
  // someone else enters: /api/ccusage is a GET, so it needs no CORS, no
  // preflight and no ability to read the response — any page the user has open
  // can fire it at the loopback port — and both values end up in the argv of a
  // spawned CLI. The spawn no longer goes through a shell (see ccusage.mjs), so
  // this is the second lock rather than the only one, and it is the one that
  // keeps the pair honest if a shell is ever reintroduced downstream.
  if (!isCliDate(since) || !isCliDate(until)) {
    return send(res, 400, {
      ok: false,
      reason: "bad_range",
      error: "since and until must be YYYYMMDD dates, e.g. 20260101",
    });
  }
  const { fetchCcusageDaily } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/ccusage.mjs")).href
  );
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
  // The 5h/7d percentages moved with it — they are read for whichever account is
  // active — and only this side knows: /api/quota is polled by the usage panel,
  // which has no idea the accounts panel just switched and so never sends
  // ?refresh=1. Without this the two panels sit on one screen disagreeing about
  // the same account for a full poll cycle, and the stale one is the one the
  // user just acted on. Only on a switch that took: a refused one left the
  // account where it was, and throwing away a reading we paid for costs a real
  // answer to fix nothing.
  if (result.ok) {
    const { invalidateQuotaCache } = await import(
      pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href
    );
    invalidateQuotaCache();
  }
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

// The tree this deck was told to capture, "" when it captures the whole
// machine. Set by startServer and never changed afterwards.
//
// The browser had no way to learn it: the launcher prints the scope on stdout
// and the hook reads it out of the discovery file, but nothing put it in an
// HTTP response — so the deck's own empty state guessed, and guessed wrong for
// everyone who passed --workspace or --scope. Health is where it belongs: it
// already answers "which deck am I talking to", and it is the one route the UI
// can read before a single event has arrived.
let _workspace = "";

// Which CLIs this deck is actually watching. Decided in bin/deck.js — from
// whether each one is on the machine, and from --claude/--no-claude and
// --codex/--no-codex — and passed in here, because the browser had no way to
// learn it and so drew both sides of the UI on every machine.
//
// That is the whole of #402 and its mirror. A Codex-only machine got the
// accounts panel open on first run, telling it to sign into a CLI it does not
// have; a Claude-only machine permanently carried "Quota unavailable. / Run
// codex login to authenticate." Same missing fact, two directions.
//
// Defaults are both true, which is what an older deck effectively reported by
// saying nothing — and the browser reads a missing field as "could not say" and
// shows both, so the two agree.
let _providers = { claude: true, codex: true };

/**
 * The one spelling of `--workspace` everything downstream compares against.
 * Empty — including a value that is nothing but spaces — stays empty, which is
 * how every reader of it says "machine-wide".
 *
 * Called once, in bin/deck.js, where the flag arrives: that process's cwd is the
 * shell the user typed the command in, and it is the only process on either
 * capture path whose cwd is the one a relative `--workspace ./sub` was written
 * against. The raw string used to go straight into the discovery file, and
 * hook.js resolved it inside its own process — which the host CLI runs with the
 * AGENT's cwd — so `--workspace ./sub` scoped Claude sessions to a `sub`
 * directory under whatever the agent happened to be working in, a different
 * directory per agent and none of them the one asked for. The Codex path
 * resolved the same string in the server process and was right. Resolving here
 * makes both of them right, and for the same reason bin/deck.js already resolves
 * the events log before publishing it: what goes in the discovery file is read
 * by other processes that cannot reconstruct the context it was written in.
 *
 * Symlinks are resolved too, because a process's cwd — which is what both
 * providers report — comes from getcwd() and has none left in it. Without this,
 * `--workspace /tmp/proj` on a Mac is scoped to /tmp/proj while every session
 * inside it reports /private/tmp/proj, and the deck stays empty. A path that
 * does not exist yet keeps its resolved form rather than failing: scoping a deck
 * to a directory you are about to create is not an error.
 */
export function canonicalWorkspace(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  const abs = resolve(raw);
  try { return realpathSync(abs); } catch { return abs; }
}

function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    name: "agent-dag",
    seq: nextSeq - 1,
    clients: sseClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
    workspace: _workspace,
    providers: _providers,
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
// freely is what the exchange requires: the hook is asking whether the process
// on this port is the deck that wrote the discovery file, and it asks precisely
// because it does not yet know — a deck that demanded credentials before
// answering could not be told apart from a stranger that refuses.
//
// So this route is an oracle, and it must stay one. That makes its answer
// useless as a credential FOR this server, and nothing here may ever accept it
// as one: a caller who can GET this can obtain a valid proof for any nonce, so
// a gate honouring proofs is a gate honouring anybody. See presentsDeckToken,
// which takes the token itself and refuses the hashed form for this reason.
//
// What the free answer does NOT give away is the token: the response is a
// one-way hash of it, and after the read gate above a rebound page cannot see
// even that.
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

// Is this request allowed to be answered at all, whatever it asks for?
//
// The rebinding gate below was reached only by mutations, on the reasoning that
// a cross-site page cannot read a loopback reply. That is true of a genuinely
// cross-origin page and false of a rebound one: the browser resolved
// attacker.example to 127.0.0.1 itself, so it calls the reply same-origin and
// hands the body to the page. Every read was therefore open to exactly the
// attack the mutation gate was written to stop — and the reads are where the
// secrets are. GET /api/events is the whole ring buffer: prompt text, the Bash
// command lines the agent ran, the paths and contents it wrote, the contents of
// every file it read back. /api/claude-accounts names the accounts,
// /api/claude-accounts/login carries a live OAuth authorize URL, /api/sound-hook
// the user's own hook command lines, /api/health the absolute workspace path.
//
// So the Host check runs for every method now. What it asks is only the
// rebinding question — did this request arrive addressed to a name that can
// only ever be this machine — and it asks it of browser-shaped requests alone,
// meaning anything carrying an Origin or fetch metadata. A client sending
// neither is not a page and has no ambient authority to borrow: that is
// hook/hook.js, a plain Node http.request from the user's own machine, and it
// keeps reaching the deck under whatever name it used before.
//
// Deliberately not part of this: the Sec-Fetch-Site test that isTrustedMutation
// applies. `cross-site` on a read is an ordinary top-level navigation — a link
// to http://localhost:4317 clicked on any page — and the document it loads is
// the deck's own UI on the deck's own origin, which is not an attack and used
// to work. Rebinding does not need that test either: a rebound page's requests
// report `same-origin`, and it is the Host that gives it away.
export function isTrustedRead({ origin, host, secFetchSite } = {}) {
  const browserShaped = (typeof origin === "string" && origin !== "")
    || (typeof secFetchSite === "string" && secFetchSite.trim() !== "");
  if (!browserShaped) return true;
  return isLoopbackHost(host);
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
// Agreement between the two is necessary but not sufficient, because both are
// derived from the URL the page was served from and neither says a word about
// the address the socket actually landed on — so the Host must also name a
// loopback identity. See isLoopbackHost for the attack that gets through
// without it.
//
// A request carrying neither header is not a browser request and is allowed
// whatever Host it names: that is hook/hook.js, a plain Node http.request from
// the user's own machine that sends no Origin at all, plus curl and the deck's
// own tooling. Ambient browser authority is the whole threat here, and those
// clients have none — a process that can POST here can already run anything as
// the user, and nothing it sends is chosen by a page.
export function isTrustedMutation({ origin, host, secFetchSite } = {}) {
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (site && site !== "same-origin" && site !== "none") return false;
  const hasOrigin = typeof origin === "string" && origin !== "";
  if (!hasOrigin && !site) return true;
  // Either header present means a browser sent this, so the rebinding gate
  // applies even to the shape that carries fetch metadata but no Origin. Every
  // request reaching this line is browser-shaped by the test just above, so
  // isTrustedRead here is exactly its isLoopbackHost half.
  if (!isTrustedRead({ origin, host, secFetchSite })) return false;
  return hasOrigin ? originMatchesHost(origin, host) : true;
}

// Was this request addressed to a name that can only ever be this machine?
//
// Origin === Host alone is not a defence against DNS rebinding: the page is
// served from http://attacker.example:4317, the attacker re-points that record
// at 127.0.0.1, and the browser then sends Host: attacker.example:4317 with a
// matching Origin and Sec-Fetch-Site: same-origin — every header self-consistent
// and every one attacker-chosen, because fetch metadata comes from the origin
// tuple (scheme, host, port), not from the resolved IP. The browser also treats
// the reply as same-origin, so the page reads the body: that is the account
// share envelope, with the OAuth token in it. A loopback literal has no DNS
// record to re-point, and `localhost` is reserved to loopback, so requiring one
// of them is what separates the deck's own UI from the rebound page.
function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const authority = host.trim().toLowerCase();
  // A real Host header is bare authority. Userinfo or a path would let
  // `evil.example@127.0.0.1` and `127.0.0.1/…` parse to a loopback hostname
  // while naming something else, so refuse them rather than reason about them.
  if (authority === "" || /[/\\?#@\s]/.test(authority)) return false;
  let name;
  try { name = new URL(`http://${authority}`).hostname; } catch { return false; }
  if (name === "localhost" || name === "[::1]") return true;
  // The whole 127.0.0.0/8 is this machine, not just .0.1 — a second deck parked
  // on 127.0.0.2 is as local as the first. URL only produces a dotted quad for
  // something it already validated as an IPv4 address, so shape is enough here.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
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

// Mutating routes that ask nothing of the caller beyond the gates above.
//
// Only the hook's ingest, and only because hook/hook.js is installed OUTSIDE
// this package — it lives in the user's ~/.claude and is loaded by whatever
// Claude Code session is already running. Requiring a credential here would
// stop every event from every session whose hook predates this change, on a
// machine where nothing is obviously broken and nothing says why, until each
// one is reinstalled. It also carries no credential and destroys nothing: the
// worst a caller does with it is draw a session on the canvas that is not
// there. See the handshake in hook/hook.js for the authentication that does
// run on this path, which is the deck proving itself to the hook.
const OPEN_MUTATIONS = new Set(["/api/event"]);

// Constant-time comparison of two secrets, and a length test that is not.
// Lengths differ freely in public — a mismatched one only says "not this
// token" — but timingSafeEqual throws rather than answering false when they do.
function secretEquals(given, expected) {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Does this request carry the deck's own token?
//
// One spelling, `x-ccdeck-token`, carrying the token itself. That is all a
// local process needs, because the only way it can hold the token is to have
// read it out of a file only it can open.
//
// The token is HOOK_TOKEN, fresh per deck and written to the discovery file at
// mode 0600. That mode is the whole of the access control: the answer to "who
// may do this" is "whoever can read that file", which is the user this deck
// runs as and nobody else. On Windows the chmod is a best-effort no-op, so
// there the file's protection is the per-user ACL on the profile directory it
// sits in rather than a mode bit; the token still works identically.
//
// The hashed challengeProof form is deliberately NOT accepted here, and this
// is the paragraph that must be read before anyone adds it. GET
// /api/hook-challenge?nonce=… answers challengeProof(HOOK_TOKEN, nonce) to any
// caller for any nonce, by design — so accepting a proof as a credential means
// the server hands out its own credentials on request, and two unauthenticated
// GETs are a complete bypass of everything below. This gate shipped that way
// for one commit; the regression test in csrf-origin.test.ts pins it shut.
//
// The premise that makes the oracle safe is the one this gate rejects, which is
// exactly why the two cannot share a secret: the challenge is the deck proving
// itself TO the hook, not the hook proving itself to the deck. hook/hook.js
// already holds the token — it read the same 0600 file — and challenges the
// port to find out whether the process listening there is really the deck that
// wrote it, or something else that inherited the port number from a stale
// discovery file. Nothing travels in the other direction, so no caller ever
// needed the hashed form as a way IN, and a client entitled to mutate holds the
// token itself anyway.
function presentsDeckToken(headers = {}) {
  const raw = headers["x-ccdeck-token"];
  return typeof raw === "string" && secretEquals(raw.trim(), HOOK_TOKEN);
}

// Is this the deck's own page in the user's browser?
//
// A strict subset of isTrustedMutation, which every request here has already
// passed: an Origin must actually be present — a browser sends one on every
// POST, including a same-origin one — it must name this very server, the Host
// must be a loopback identity, and any fetch metadata must say `same-origin`.
// `none` is excluded on purpose: that is a top-level navigation the user typed
// or a form submitted from one, never the UI's own fetch.
function isDeckUiRequest({ origin, host, secFetchSite } = {}) {
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (site !== "" && site !== "same-origin") return false;
  if (typeof origin !== "string" || origin === "") return false;
  if (!isLoopbackHost(host)) return false;
  return originMatchesHost(origin, host);
}

// May this request change something?
//
// Everything above this line is about the browser: whether a page chose the
// request, and whether it was addressed to this machine. None of it asks who
// the caller is, and for a client that is not a browser at all nothing did —
// a request carrying no Origin and no fetch metadata was waved through on the
// reasoning that a process able to POST here can already run anything as the
// user. That holds on a single-user laptop and fails twice elsewhere. Loopback
// is not scoped to a UID, so on a shared box or a multi-tenant container every
// other account on the machine can reach this port; and a sandboxed subprocess
// denied the credential store but allowed loopback egress — the ordinary shape
// of an agent's Bash sandbox — reaches the same credentials through the API.
// `curl -XPOST localhost:4317/api/claude-accounts/admin -d '{"action":"share"}'`
// answered with the account's live OAuth refresh token in the clear, and the
// same request reached account remove and import, the live account switch, a
// global `npm i -g`, the restart and the event log.
//
// So a mutation must now be either of two things:
//
//   - the user's own browser tab, recognised by the headers a page cannot
//     forge and the deck's own loopback address (isDeckUiRequest), or
//   - a client holding the deck's token, which it can only have read from the
//     0600 discovery file (presentsDeckToken).
//
// What this does NOT do, stated plainly so nobody mistakes it for more: the
// browser clause rests on headers that page script cannot set but any local
// program can. A local attacker who adds `Origin` and `Sec-Fetch-Site` to the
// request is back through. That is not a gap left by laziness — there is no
// fix for it here. Authenticating the tab would mean giving the tab a secret,
// and every channel from this process to a browser on the same machine is
// readable by any other process on that machine: a token in the served
// index.html is read by the same `curl http://localhost:4317/` that the gate
// is meant to stop, and a token in the URL the deck opens is read out of the
// browser's argv by `ps`. What is closed is the free pass — a request that
// presents nothing at all no longer changes anything — and what is opened is
// the honest door, so a script of the user's own authenticates by reading the
// token instead of impersonating a page.
function isAuthorizedMutation(req) {
  const headers = req?.headers ?? {};
  if (presentsDeckToken(headers)) return true;
  return isDeckUiRequest({
    origin: headers.origin,
    host: headers.host,
    secFetchSite: headers["sec-fetch-site"],
  });
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
  log(`${PRODUCT}: request handler failed:`, err);
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

export async function startServer({ port = 4317, host = "127.0.0.1", persist = null, portRange = [4318, 4400], workspace = "", codex = true, claude = true, onRestart = null } = {}) {
  _onRestart = typeof onRestart === "function" ? onRestart : null;
  _canRestart = _onRestart != null && persist != null;
  _workspace = typeof workspace === "string" ? workspace : "";
  // `!== false` rather than a cast: a caller that omits the field means "yes",
  // which is how every embedder that predates this option keeps working.
  _providers = { claude: claude !== false, codex: codex !== false };
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

    // Three gates in front of the whole table, so every route is covered and
    // any route added later is covered too, without the author having to
    // remember. They ask three different questions and they run in the order
    // that answers the cheapest first.

    // Was this addressed to this machine? Every method, because a rebound page
    // reads a reply as readily as it writes a request. See isTrustedRead.
    if (!isTrustedRead({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
    })) {
      return send(res, 403, { error: "cross-site request blocked" });
    }

    // Did a page choose this? Mutations only — the same-site read this refuses
    // is an ordinary navigation. See isTrustedMutation.
    if (req.method !== "GET" && req.method !== "HEAD" && !isTrustedMutation({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
    })) {
      return send(res, 403, { error: "cross-site request blocked" });
    }

    // And who is asking? Refusing by default is the point: a mutating route
    // added later is protected until someone deliberately lists it as open,
    // which is the direction this has to fail in. See isAuthorizedMutation.
    if (req.method !== "GET" && req.method !== "HEAD"
      && !OPEN_MUTATIONS.has(url.pathname) && !isAuthorizedMutation(req)) {
      return send(res, 401, { error: "unauthenticated" });
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

// Allow running this file directly for dev (`npm run dev:server`). The port
// variable is the CLI's, deliberately: this block spent two renames reading a
// name from the project's first identity that no README ever documented, so
// the one variable people know worked everywhere except here.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.AGENT_DAG_PORT ?? 4317);
  startServer({ port }).then(s => {
    const addr = s.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`${PRODUCT} server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error(`${PRODUCT} server failed:`, e.message);
    process.exit(1);
  });
}
