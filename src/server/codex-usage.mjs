// Aggregates Codex token usage from ~/.codex/sessions rollout JSONL files.
// Unlike Claude, Codex has no CLI quota command — we derive usage from the
// actual session logs for 5h and 7d rolling windows.
import { readdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CODEX_HOME = process.env.CODEX_HOME
  ? process.env.CODEX_HOME
  : join(homedir(), ".codex");
const CODEX_SESSIONS_DIR = join(CODEX_HOME, "sessions");

// Cache results for 60s (lighter than Claude quota — reads more files)
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 60_000;

const WINDOW_5H_MS  = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS  = 7 * 24 * 60 * 60 * 1000;

// Read the full series of cumulative token_count events from a rollout file.
// Each token_count event carries `info.total_token_usage` — the running total
// for the session at that point. We keep the whole series (with timestamps) so
// we can compute how many tokens were spent *within* a rolling window via a
// cumulative delta, rather than dumping a session's lifetime total into a bucket
// based on when it merely started.
//
// Returns an ascending-by-time array of { ts, inp, out, cacheR, total } where
// `inp` includes the cached portion (Codex reports input_tokens incl. cache),
// or null if the file has no usable token_count events.
async function readTokenSeries(filePath) {
  let fd;
  try {
    fd = await open(filePath, "r");
    const { size } = await fd.stat();
    if (size === 0) return null;
    const text = (await fd.readFile()).toString("utf8");
    const series = [];
    for (const raw of text.split("\n")) {
      // Cheap pre-filter before the (relatively) expensive JSON.parse.
      if (!raw.includes("total_token_usage")) continue;
      let obj;
      try { obj = JSON.parse(raw); } catch { continue; }
      if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") continue;
      const u = obj.payload.info?.total_token_usage;
      if (!u) continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      series.push({
        ts:     isNaN(ts) ? null : ts,
        inp:    u.input_tokens         ?? 0,
        out:    u.output_tokens        ?? 0,
        cacheR: u.cached_input_tokens  ?? 0,
        total:  u.total_tokens         ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
      });
    }
    return series.length ? series : null;
  } catch { return null; }
  finally { fd?.close().catch(() => {}); }
}

// Tokens spent within [windowStartMs, now]: the last cumulative snapshot minus
// the last snapshot taken *before* the window opened. If the session began
// inside the window (no prior snapshot), the baseline is zero and the full
// cumulative end counts. Fields are returned non-overlapping so they sum to
// `total`: `input` is fresh (non-cached) input, `cacheRead` is the cached
// portion, `output` is output. (Codex's input_tokens includes cache, so we
// subtract it out to avoid double-counting.)
function windowDelta(series, windowStartMs) {
  if (!series || series.length === 0) return null;
  const end = series[series.length - 1];
  // Baseline = last event strictly before the window opened.
  let base = null;
  for (const e of series) {
    if (e.ts != null && e.ts < windowStartMs) base = e;
    else if (e.ts != null) break;
  }
  const dInp    = Math.max(0, end.inp    - (base?.inp    ?? 0));
  const dOut    = Math.max(0, end.out    - (base?.out    ?? 0));
  const dCacheR = Math.max(0, end.cacheR - (base?.cacheR ?? 0));
  const dTotal  = Math.max(0, end.total  - (base?.total  ?? 0));
  return {
    inputTokens:     Math.max(0, dInp - dCacheR), // fresh (non-cached) input
    outputTokens:    dOut,
    cacheReadTokens: dCacheR,
    totalTokens:     dTotal,
  };
}

// Parse session start time from rollout filename.
// Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
// The timestamp portion uses dashes instead of colons (Windows-safe).
function parseRolloutTime(filename) {
  // e.g. rollout-2026-06-17T12-39-01-019ed4f2-c821-...jsonl
  const m = filename.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/);
  if (!m) return null;
  // Replace the last two dashes in time part with colons
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3") + "Z";
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

// List rollout files whose start times fall within the given window.
async function listRolloutFiles(sinceMs) {
  const out = [];
  let years;
  try { years = (await readdir(CODEX_SESSIONS_DIR)).filter(d => /^\d{4}$/.test(d)).sort().reverse(); }
  catch { return out; }

  const nowMs = Date.now();
  for (const y of years) {
    // Skip years that can't possibly contain files within the window
    if (parseInt(y, 10) < new Date(nowMs - sinceMs - 86400000).getFullYear()) break;
    let months;
    try { months = (await readdir(join(CODEX_SESSIONS_DIR, y))).sort().reverse(); } catch { continue; }
    for (const m of months) {
      let days;
      try { days = (await readdir(join(CODEX_SESSIONS_DIR, y, m))).sort().reverse(); } catch { continue; }
      for (const d of days) {
        const dir = join(CODEX_SESSIONS_DIR, y, m, d);
        let files;
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const t = parseRolloutTime(f);
          if (t != null && nowMs - t <= sinceMs) {
            out.push({ path: join(dir, f), startMs: t });
          }
        }
      }
    }
  }
  return out;
}

function emptyWindow() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 0, sessionCount: 0 };
}

export async function fetchCodexUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const w5h  = emptyWindow();
  const w7d  = emptyWindow();
  const start5h = now - WINDOW_5H_MS;
  const start7d = now - WINDOW_7D_MS;

  const addTo = (win, d) => {
    if (!d || d.totalTokens <= 0) return;
    win.inputTokens      += d.inputTokens;
    win.outputTokens     += d.outputTokens;
    win.cacheReadTokens  += d.cacheReadTokens;
    win.totalTokens      += d.totalTokens;
    win.sessionCount++;
  };

  try {
    // Files whose session *started* within 7d. A long session that started up
    // to 7d ago but is still active is captured here too, and its share of the
    // 5h window is recovered via the cumulative delta below — so bucketing no
    // longer drops active-but-old sessions or over-counts the pre-window tail.
    const files = await listRolloutFiles(WINDOW_7D_MS);

    await Promise.all(files.map(async ({ path }) => {
      const series = await readTokenSeries(path);
      if (!series) return;
      // Same series feeds both windows; baseline differs per window start.
      addTo(w5h, windowDelta(series, start5h));
      addTo(w7d, windowDelta(series, start7d));
    }));
  } catch (err) {
    console.error("agents-deck codex-usage: scan failed:", err?.message ?? err);
    const result = { ok: false, fetchedAt: now };
    _cache = result;
    _cacheAt = now;
    return result;
  }

  const result = { ok: true, window5h: w5h, window7d: w7d, fetchedAt: now };
  _cache = result;
  _cacheAt = now;
  return result;
}

export function invalidateCodexUsageCache() {
  _cache = null;
  _cacheAt = 0;
}
