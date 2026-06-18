// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// Single-file pure Node HTTP server, zero deps.
import { createServer } from "node:http";
import { readFile, stat, mkdir, appendFile, open, truncate, readdir, unlink } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, dirname as pdirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");
const WEB_DIST = resolve(PKG_ROOT, "dist", "web");

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
const sseClients = new Set();       // res handles

let persistPath = null;             // absolute path to events.jsonl, or null

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
    console.log(`agent-deck: rotated ${persistPath} (${(s.size / 1024 / 1024).toFixed(0)}MB → ${oldPath})`);
  } catch (err) {
    console.error("agent-deck: persist rotation failed:", err && err.message ? err.message : err);
  } finally {
    rotateInProgress = false;
  }
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

/** Read the main session JSONL. Returns the root model and any
 *  legacy-schema subagent models (older CC versions kept subagent blocks
 *  inline with `isSidechain:true` + `parentToolUseID`). Current CC versions
 *  store subagents in `<sessionDir>/subagents/agent-<id>.jsonl` — those are
 *  handled by `readSubagentModelsFromDir` below. */
async function readModelFromTranscript(path) {
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
    let rootModel = null;
    const subagentModels = {};
    let anyModelSeen = null;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj && obj.message;
      const model = (msg && typeof msg.model === "string" && /^claude[-_]/i.test(msg.model)) ? msg.model
                  : (typeof obj.model === "string" && /^claude[-_]/i.test(obj.model))         ? obj.model
                  : null;
      if (!model) continue;
      anyModelSeen = model;
      const isSide = obj.isSidechain === true || obj.is_sidechain === true;
      const ptid = obj.parentToolUseID || obj.parent_tool_use_id || obj.parentToolUseId || null;
      if (isSide && ptid) {
        subagentModels[ptid] = model;
      } else if (!isSide) {
        rootModel = model;
      }
    }
    if (!rootModel) rootModel = anyModelSeen;
    if (!rootModel && Object.keys(subagentModels).length === 0) return null;
    return { rootModel, subagentModels };
  } catch {
    return null;
  }
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
      const s = await stat(full);
      if (s.size === 0) continue;
      const fh = await open(full, "r");
      let text;
      try {
        const buf = Buffer.alloc(s.size);
        await fh.read(buf, 0, s.size, 0);
        text = buf.toString("utf8");
      } finally {
        await fh.close();
      }
      // Last-seen claude-* model wins — subagents may switch model mid-turn
      // (Sonnet → Haiku for tool-call fallback etc.).
      let last = null;
      for (const line of text.split("\n")) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const msg = obj && obj.message;
        const m = (msg && typeof msg.model === "string" && /^claude[-_]/i.test(msg.model)) ? msg.model
                : (typeof obj.model === "string" && /^claude[-_]/i.test(obj.model))         ? obj.model
                : null;
        if (m) last = m;
      }
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

async function readUsageFromTranscript(path) {
  try {
    const s = await stat(path);
    if (s.size === 0) return null;
    // Transcripts can grow large (thinking blocks, tool inputs) — read the
    // whole file. Each entry has its own usage object and we sum every
    // occurrence, so missing earlier bytes would undercount. Files are
    // usually < 1MB; tens-of-MB sessions cost a few ms to scan.
    const fh = await open(path, "r");
    let buf;
    try {
      buf = Buffer.alloc(s.size);
      await fh.read(buf, 0, s.size, 0);
    } finally {
      await fh.close();
    }
    const text = buf.toString("utf8");
    const totals = {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    };
    // Match each `"usage":{...}` block and sum the four numeric fields.
    // Regex is good enough — these blocks are flat single-level JSON.
    const re = /"usage"\s*:\s*\{([^}]+)\}/g;
    const grab = (blob, key) => {
      const km = blob.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
      return km ? Number(km[1]) : 0;
    };
    for (const m of text.matchAll(re)) {
      const blob = m[1];
      totals.input_tokens += grab(blob, "input_tokens");
      totals.output_tokens += grab(blob, "output_tokens");
      totals.cache_read_input_tokens += grab(blob, "cache_read_input_tokens");
      totals.cache_creation_input_tokens += grab(blob, "cache_creation_input_tokens");
    }
    if (totals.input_tokens === 0 && totals.output_tokens === 0
        && totals.cache_read_input_tokens === 0 && totals.cache_creation_input_tokens === 0) return null;
    return totals;
  } catch {
    return null;
  }
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

async function readContextFromTranscript(path) {
  try {
    const s = await stat(path);
    if (s.size === 0) return null;
    const fh = await open(path, "r");
    let buf;
    try { buf = Buffer.alloc(s.size); await fh.read(buf, 0, s.size, 0); }
    finally { await fh.close(); }
    const fullText = buf.toString("utf8");
    // CC `/clear` writes a user message `<command-name>/clear</command-name>`
    // into the same transcript file and resets its in-memory context window
    // to ~0, but the JSONL keeps growing — every usage block before the
    // clear marker is stale (pre-reset) and reading the LAST one made the
    // donut report ~100% even though CC's actual context was empty. Same
    // applies to `/compact`: it writes a summary and starts a fresh context.
    // Slice the transcript to the segment AFTER the most recent reset so
    // counts/usage reflect what CC is actually carrying forward.
    const resetRe = /<command-name>\s*\/(?:clear|compact)\s*<\/command-name>/g;
    let lastResetIdx = -1;
    for (const m of fullText.matchAll(resetRe)) {
      lastResetIdx = (m.index ?? -1) + m[0].length;
    }
    const text = lastResetIdx >= 0 ? fullText.slice(lastResetIdx) : fullText;
    const breakdown = {
      msgsUser: 0,
      msgsAssistant: 0,
      toolUses: 0,
      toolResults: 0,
      systemReminders: 0,
      currentContextTokens: 0,
    };
    breakdown.msgsUser       = (text.match(/"type"\s*:\s*"user"/g) ?? []).length;
    breakdown.msgsAssistant  = (text.match(/"type"\s*:\s*"assistant"/g) ?? []).length;
    breakdown.toolUses       = (text.match(/"type"\s*:\s*"tool_use"/g) ?? []).length;
    breakdown.toolResults    = (text.match(/"type"\s*:\s*"tool_result"/g) ?? []).length;
    breakdown.systemReminders = (text.match(/<system-reminder>/g) ?? []).length;
    // Current context size = input + cache_read + cache_create on the LAST
    // usage block in the post-reset slice. If the user just ran /clear and
    // hasn't sent a new prompt yet, this stays 0 (no usage blocks yet) —
    // matches what CC's own `/context` would report.
    const re = /"usage"\s*:\s*\{([^}]+)\}/g;
    const grab = (blob, key) => {
      const km = blob.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
      return km ? Number(km[1]) : 0;
    };
    let lastBlob = null;
    for (const m of text.matchAll(re)) lastBlob = m[1];
    if (lastBlob) {
      breakdown.currentContextTokens =
        grab(lastBlob, "input_tokens") +
        grab(lastBlob, "cache_read_input_tokens") +
        grab(lastBlob, "cache_creation_input_tokens");
    }
    return breakdown;
  } catch { return null; }
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

function startCodexWatcher(workspace) {
  codexWorkspace = workspace ?? "";
  if (!existsSync(CODEX_SESSIONS_DIR)) return null;
  // Initial catalog: create roots for in-progress sessions, skip their
  // history, then poll for new lines.
  codexScanOnce(true).catch(() => {});
  codexWatchTimer = setInterval(() => { codexScanOnce(false).catch(() => {}); }, 1500);
  if (codexWatchTimer.unref) codexWatchTimer.unref();
  return codexWatchTimer;
}

function pushEvent(raw, source, opts = {}) {
  // Synchronous enrichment: if we already know this session's model, stamp
  // it on the payload so the client's recursive scanner picks it up.
  if (raw && typeof raw === "object" && raw.session_id && !raw.model) {
    const cached = modelBySession.get(raw.session_id);
    if (cached) raw.model = cached;
  }

  const seq = nextSeq++;
  const evt = {
    seq,
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

  if (persistPath && !opts.replay) {
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(idx);
    } catch {
      send(res, 404, { error: "ui not built. run `pnpm build` or `npm run build`." });
    }
  }
}

function handleEventIngest(req, res) {
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
    const evt = pushEvent(parsed, "hook");
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

function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    name: "agent-dag",
    seq: nextSeq - 1,
    clients: sseClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

async function sweepStaleDiscovery() {
  const dir = join(homedir(), ".claude", "agent-dag");
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

async function tryListen(server, port, host) {
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.removeListener("error", rej);
      res();
    });
  });
}

export async function startServer({ port = 4317, host = "127.0.0.1", persist = null, portRange = [4318, 4400], workspace = "", codex = true } = {}) {
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
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

    if (req.method === "POST" && url.pathname === "/api/event") return handleEventIngest(req, res);
    if (req.method === "GET"  && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET"  && url.pathname === "/events")     return handleSse(req, res);

    if (req.method === "GET" && url.pathname === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return send(res, 200, events.filter(e => e.seq > since));
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
    console.log(`agent-deck server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error("agent-deck server failed:", e.message);
    process.exit(1);
  });
}
