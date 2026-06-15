// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// Single-file pure Node HTTP server, zero deps.
import { createServer } from "node:http";
import { readFile, stat, mkdir, appendFile, open, truncate, readdir, unlink } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, dirname as pdirname } from "node:path";
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
    console.log(`agent-dag: rotated ${persistPath} (${(s.size / 1024 / 1024).toFixed(0)}MB → ${oldPath})`);
  } catch (err) {
    console.error("agent-dag: persist rotation failed:", err && err.message ? err.message : err);
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
const modelBySession = new Map();         // sessionId -> "claude-…"
const pendingTranscriptReads = new Set(); // sessionId currently being read

async function readModelFromTranscript(path) {
  try {
    const s = await stat(path);
    if (s.size === 0) return null;
    // Read up to last 128 KB — plenty for the most-recent model
    // declaration. Reading from the tail handles sessions that switched
    // model mid-conversation (we want the current one).
    const TAIL = 128 * 1024;
    const start = Math.max(0, s.size - TAIL);
    const fh = await open(path, "r");
    try {
      const len = s.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const text = buf.toString("utf8");
      // Scan all matches and return the LAST one — most recent model used.
      const re = /"model"\s*:\s*"(claude[-_][^"]+)"/gi;
      let last = null;
      for (const m of text.matchAll(re)) last = m[1];
      return last;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function maybeResolveModel(payload) {
  if (!payload || typeof payload !== "object") return;
  const sid = payload.session_id;
  const tp = payload.transcript_path;
  if (!sid || !tp) return;
  if (modelBySession.has(sid)) return;
  if (pendingTranscriptReads.has(sid)) return;
  pendingTranscriptReads.add(sid);
  readModelFromTranscript(tp)
    .then(model => {
      if (!model) return;
      modelBySession.set(sid, model);
      // Synthetic enrichment event — reducer applies to every agent in
      // this session, including ones created before we resolved.
      pushEvent({ hook_event_name: "ModelObserved", session_id: sid, model }, "internal");
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
    const text = buf.toString("utf8");
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
    // usage block. Each assistant message's usage describes the context
    // window for THAT call; summing across calls double-counts cached
    // prefixes and explodes past the real ceiling. Take the most recent.
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
  if (source === "hook" && !opts.replay) {
    maybeResolveModel(raw);
    maybeResolveUsage(raw);
    maybeResolveContext(raw);
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

  // Resume: replay events after Last-Event-ID
  const lastId = Number(req.headers["last-event-id"] ?? 0);
  for (const e of events) {
    if (e.seq <= lastId) continue;
    res.write(`id: ${e.seq}\nevent: hook\ndata: ${JSON.stringify(e)}\n\n`);
  }

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

export async function startServer({ port = 4317, host = "127.0.0.1", persist = null, portRange = [4318, 4400] } = {}) {
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
    console.log(`agent-dag server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error("agent-dag server failed:", e.message);
    process.exit(1);
  });
}
