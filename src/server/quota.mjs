// Claude rate-limit quota, from whichever source costs least.
//
// All three sources below end at the same place: GET /api/oauth/usage, which
// Anthropic budgets at roughly 28-30 calls per rolling hour PER TOKEN, shared
// by every tool on the machine. That budget is the constraint this module is
// built around, because it was being blown by this module: a 60s poll is 60
// calls an hour on its own, and the account the deck was polling started
// answering http-429 to claude-swap, whose collections the accounts panel is
// entirely made of. One panel went stale so the other could be a minute
// fresher.
//
//   1. claude-swap's store — free. It polls the active account on its own
//      schedule and writes what it got; reading that file costs nothing and
//      spends none of the budget. Used whenever it holds a recent enough row.
//   2. The OAuth usage API directly, with the token from
//      ~/.claude/.credentials.json. Exact and instant. Mechanism
//      reverse-engineered from steipete/CodexBar.
//   3. `claude --print /usage`, parsed. Used when there is no readable token —
//      notably on macOS, where Claude Code keeps credentials in the Keychain
//      and that file does not exist, so this is the ONLY self-service path
//      there. It is also the most expensive: a whole Claude Code process per
//      poll. On Windows the binary may be a .cmd wrapper, which spawn cannot
//      launch directly — exec.mjs's `run` routes that case through cmd.exe with
//      the argument vector intact, so no shell ever parses a path this module
//      read out of the environment.
//
// 2 and 3 are rate-floored (SELF_POLL_MS) and gated behind the same 429
// cooldown; 1 is not, because it is a local file read.
import { activeAccountUsage, requestCollection } from "./claude-accounts.mjs";
import { run } from "./exec.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix as posixPath, win32 as winPath } from "node:path";
import { homedir } from "node:os";
import { PRODUCT } from "./brand.mjs";

const CREDS_PATH  = join(homedir(), ".claude", ".credentials.json");
const USAGE_URL   = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
const WIN_5H_SEC  = 18000;
const WIN_7D_SEC  = 604800;

// 429 cooldown gate — after a rate-limit, skip the API until this passes.
let _rateLimitedUntil = 0;

async function readOAuthToken() {
  try {
    const raw  = await readFile(CREDS_PATH, "utf8");
    const auth = JSON.parse(raw)?.claudeAiOauth;
    if (!auth?.accessToken) return null;
    // expiresAt is epoch milliseconds. If expired, the CLI fallback handles it.
    if (auth.expiresAt && Date.now() >= auth.expiresAt) return null;
    return auth.accessToken;
  } catch {
    return null;
  }
}

// ISO-8601 → "Jun 19, 1:19pm" (local time, matching the CLI display format).
function fmtResetIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  // "Jun 19, 1:19 PM" → "Jun 19, 1:19pm" (matches the CLI display format)
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).replace(/\s+(AM|PM)/, (_, p) => p.toLowerCase());
}

function isoToSec(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : Math.floor(t / 1000);
}

// Map the OAuth usage JSON to our quota result shape.
// utilization is already a 0–100 percentage. 5h falls back to 7d if absent.
function mapOAuthUsage(data) {
  const fh = data?.five_hour;
  const sd = data?.seven_day;
  const son = data?.seven_day_sonnet;
  const opus = data?.seven_day_opus;

  const primary = (fh?.utilization != null) ? fh : sd;
  if (!primary || primary.utilization == null) return null;

  const round = (v) => Math.min(100, Math.max(0, Math.round(v)));
  const result = {
    session5hPct:       round(primary.utilization),
    session5hWindowSec: WIN_5H_SEC,
    session5hReset:     fmtResetIso(primary.resets_at),
    session5hResetAt:   isoToSec(primary.resets_at),
    week7dWindowSec:    WIN_7D_SEC,
  };
  if (sd?.utilization != null) {
    result.week7dPct     = round(sd.utilization);
    result.week7dReset   = fmtResetIso(sd.resets_at);
    result.week7dResetAt = isoToSec(sd.resets_at);
  } else {
    result.week7dPct = 0;
  }
  if (son?.utilization != null)  result.weekSonnetPct = round(son.utilization);
  if (opus?.utilization != null) result.weekOpusPct   = round(opus.utilization);

  // extra usage credits (pay-as-you-go top-up), if enabled
  const extra = data?.extra_usage;
  if (extra?.is_enabled) {
    result.extraEnabled = true;
    if (extra.used_credits != null)  result.extraUsedCredits  = extra.used_credits;
    if (extra.monthly_limit != null) result.extraMonthlyLimit = extra.monthly_limit;
    if (extra.currency)              result.extraCurrency     = extra.currency;
  }
  return result;
}

async function fetchOAuthUsage() {
  if (Date.now() < _rateLimitedUntil) return null;
  const token = await readOAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": BETA_HEADER,
        "Accept":         "application/json",
        "Content-Type":   "application/json",
        "User-Agent":     "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const cooldownMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 5 * 60_000;
      _rateLimitedUntil = Date.now() + cooldownMs;
      return null;
    }
    if (!res.ok) return null;

    return mapOAuthUsage(await res.json());
  } catch {
    return null;
  }
}

let _cache    = null;
let _cacheAt  = 0;
let _inflight = null;   // deduplicates concurrent CLI probes
let _lastGood = null;   // last result that had real quota percentages
let _lastSelfPollAt = 0;

const CACHE_MS = 60_000;

// Floor between two polls WE pay for. Twelve an hour against a budget of
// ~28-30 leaves claude-swap room to collect for every account, which is what
// the accounts panel is made of. Only reached when the store cannot answer.
const SELF_POLL_MS = 5 * 60_000;

// The refresh button may beat that floor, but not turn into a poll loop when
// held down. It never beats the 429 cooldown.
const FORCE_POLL_MS = 60_000;

// How old a claude-swap row may be before we stop treating it as the answer.
// Its own default poll interval is 1800s, so a row older than this means its
// collector is backing off or not running — the case self-polling exists for.
const STORE_TRUSTED_MS = 45 * 60_000;

/**
 * claude-swap's row for the active account, in the shape the panel speaks.
 *
 * Exported for tests: the mapping is where a wrong number would come from, and
 * it is pure.
 */
export function quotaFromStore(entry) {
  const good = entry?.lastGood;
  const fh = good?.five_hour;
  const sd = good?.seven_day;
  const primary = (typeof fh?.pct === "number") ? fh : sd;
  if (typeof primary?.pct !== "number") return null;

  const round = (v) => Math.min(100, Math.max(0, Math.round(v)));
  const out = {
    ok: true,
    source: "claude-swap",
    session5hPct:       round(primary.pct),
    session5hWindowSec: WIN_5H_SEC,
    session5hReset:     fmtResetIso(primary.resets_at),
    session5hResetAt:   isoToSec(primary.resets_at),
    week7dWindowSec:    WIN_7D_SEC,
    week7dPct:          typeof sd?.pct === "number" ? round(sd.pct) : 0,
    week7dReset:        fmtResetIso(sd?.resets_at),
    week7dResetAt:      isoToSec(sd?.resets_at),
    // The age of the DATA, not of our read of it. The panel prints this, and
    // "30s ago" over numbers claude-swap collected twenty minutes back is the
    // kind of true-looking lie this whole change exists to remove.
    fetchedAt: entry.fetchedAt,
  };
  // claude-swap keeps per-model windows in a named list rather than fixed
  // fields, because which ones an account has depends on its plan.
  for (const s of Array.isArray(good.scoped) ? good.scoped : []) {
    if (typeof s?.pct !== "number") continue;
    if (/sonnet/i.test(s.name ?? "")) out.weekSonnetPct = round(s.pct);
    else if (/opus/i.test(s.name ?? "")) out.weekOpusPct = round(s.pct);
  }
  return out;
}

/**
 * Whether we may spend a request of the user's budget right now.
 *
 * Exported for tests — this is the rule that stopped the deck from starving
 * claude-swap, and it is worth pinning down.
 */
export function maySelfPoll({ now, force, lastSelfPollAt, rateLimitedUntil }) {
  if (now < rateLimitedUntil) return false;
  return now - lastSelfPollAt >= (force ? FORCE_POLL_MS : SELF_POLL_MS);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stripAnsi(s) {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][AB012]/g, "");
}

// Parse "Jun 18, 4:09pm" (local time, no tz) into unix seconds.
// Claude shows times in the user's local timezone, so parsing as local is correct.
// `now` is injectable so the year-boundary case is testable.
export function parseResetToSec(resetStr, now = Date.now()) {
  if (!resetStr) return null;
  try {
    // "4:09pm" → "4:09 PM" so Date.parse handles it. Minutes are optional in
    // the CLI's output ("9am"); Date.parse rejects "9 AM", so supply ":00".
    const norm = resetStr
      .replace(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
               (_all, h, mm, ampm) => `${h}:${mm ?? "00"} ${ampm}`)
      .trim();
    // The CLI prints no year, so we have to supply one. Stamping the current
    // year blindly puts a "Jan 2" reset read on Dec 30 eleven months in the
    // past, which hides the countdown and pins the pace marker at 100%. A
    // reset is never more than a week away, so the neighbouring year that
    // lands nearest to `now` is the one Claude meant.
    const thisYear = new Date(now).getFullYear();
    let best = null;
    for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
      const t = new Date(`${norm} ${year}`).getTime();
      if (isNaN(t)) continue;
      if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t;
    }
    return best === null ? null : Math.floor(best / 1000);
  } catch { return null; }
}

/**
 * Parse `claude --print /usage` output.
 *
 * Observed format (Claude Code ≥ 1.x):
 *   "Current session: 84% used · resets Jun 18, 4:09pm (Europe/Chisinau)"
 *   "Current week (all models): 85% used · resets Jun 21, 8:59am (Europe/Chisinau)"
 *   "Current week (Sonnet only): 48% used · resets Jun 21, 9am (Europe/Chisinau)"
 *   "Current week (Opus only): ..."   (if present)
 */
function parseUsageText(raw) {
  const text = stripAnsi(raw);
  const result = {};

  // Helper: find "X% used · resets <rest>" on a line matching a label.
  const extract = (labelRe) => {
    const line = text.split("\n").find(l => labelRe.test(l));
    if (!line) return null;
    const pctM = line.match(/(\d{1,3})\s*%/);
    const resetM = line.match(/resets\s+(.+)/i);
    const resetFull = resetM
      ? resetM[1].replace(/\(.*?\)/g, "").replace(/·/g, "").trim()
      : null;
    return {
      pct:     pctM ? Math.min(100, parseInt(pctM[1], 10)) : null,
      reset:   resetFull,
      resetAt: parseResetToSec(resetFull),
    };
  };

  const session = extract(/current session/i);
  if (session?.pct != null) {
    result.session5hPct       = session.pct;
    result.session5hWindowSec = 18000;
    if (session.reset)   result.session5hReset   = session.reset;
    if (session.resetAt) result.session5hResetAt  = session.resetAt;
  }

  const weekAll = extract(/current week\s*\(all models\)/i) || extract(/current week\s*[:·]/i);
  if (weekAll?.pct != null) {
    result.week7dPct       = weekAll.pct;
    result.week7dWindowSec = 604800;
    if (weekAll.reset)   result.week7dReset   = weekAll.reset;
    if (weekAll.resetAt) result.week7dResetAt  = weekAll.resetAt;
  }

  const weekSon = extract(/current week\s*\(sonnet/i);
  if (weekSon?.pct != null) result.weekSonnetPct = weekSon.pct;

  const weekOpus = extract(/current week\s*\(opus/i);
  if (weekOpus?.pct != null) result.weekOpusPct = weekOpus.pct;

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Every place the `claude` CLI is known to live, in the order to try them.
 *
 * Pure, and the platform, environment and home directory are parameters, so the
 * Windows list can be checked from a Mac — which is the only way this list stays
 * right, since it exists entirely for machines the author is not sitting at.
 */
export function quotaClaudeCandidates(platform = process.platform, env = process.env, home = homedir()) {
  // The path flavour follows the PLATFORM ARGUMENT, not the host: node's `join`
  // would emit forward slashes when the Windows list is built on a Mac.
  const { join } = platform === "win32" ? winPath : posixPath;
  if (platform !== "win32") {
    return [
      "claude",
      join(home, ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ];
  }
  return [
    // The native installer, which ships a bare claude.exe and NO .cmd shim. It
    // was the one install this branch could not reach: the npm path below does
    // not exist on such a machine, and the bare-name fallback used to be spelled
    // `claude.cmd`, which cmd.exe cannot resolve to an .exe — PATHEXT supplies a
    // missing extension, it never substitutes one that is already there.
    join(home, ".local", "bin", "claude.exe"),
    // `npm i -g @anthropic-ai/claude-code`. npm's global prefix is %APPDATA%\npm
    // — Roaming rather than Local, deliberately, since it follows the user
    // between machines — and APPDATA is read from the environment because a
    // roaming profile puts it on a network share, not under the home directory.
    join(env.APPDATA || join(home, "AppData", "Roaming"), "npm", "claude.cmd"),
    // Last resort: the bare name, which cmd.exe resolves through PATH + PATHEXT
    // and so finds claude.exe and claude.cmd alike.
    "claude",
  ];
}

/** Which `claude` to run for `--print /usage`: the first candidate that exists.
 *
 *  This used to hand back a whole shell command line — `"<bin>" --print /usage
 *  < /dev/null` — for `exec()` to parse. Double quotes are not escaping on
 *  POSIX: `$(…)`, backticks and `\` all still work inside them, and every
 *  ingredient of that line came from the environment (`%APPDATA%`, `homedir()`),
 *  so a home directory named `/home/a$(id)b` was shell code the quota poll ran
 *  every minute. A bare `$` was the duller half of the same bug — it expanded
 *  to nothing and the probe looked for a binary at a path that did not exist.
 *
 *  There is nothing left to escape once there is no shell: exec.mjs's `run`
 *  spawns the argument vector as given, resolves the Windows `.cmd`/`.exe`
 *  spelling itself, and closes the child's stdin — which is what `< /dev/null`
 *  was for, since `claude --print` waits three seconds on a stdin pipe nobody
 *  is writing to.
 *
 *  Exported, with everything it touches injectable, so the Windows branch is
 *  testable from the platforms this repo is actually developed on.
 */
export function quotaClaudeBin(platform = process.platform, env = process.env,
                               home = homedir(), exists = existsSync) {
  const sep = platform === "win32" ? "\\" : "/";
  // A bare name is left to spawn's own PATH lookup (and, on Windows, to the
  // PATHEXT walk exec.mjs does by hand); a full path is only worth naming when
  // it is actually there.
  return quotaClaudeCandidates(platform, env, home)
    .find(c => !c.includes(sep) || exists(c)) ?? "claude";
}

export async function fetchClaudeQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  // If another CLI probe is already in flight, wait for it instead of spawning a
  // second concurrent process (which can return empty output and overwrite the
  // good result with 0%).
  if (_inflight) return _inflight;

  _inflight = _doFetch(now, force).finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * claude-swap's numbers for the active account, if it has any.
 *
 * Never throws and never blocks on the network: worst case the store is
 * missing, unparseable, or about a different account than the one that is
 * active, and the caller falls through to fetching for itself.
 */
async function storeQuota() {
  try {
    return quotaFromStore(await activeAccountUsage());
  } catch {
    return null;
  }
}

// After asking claude-swap to collect, how long to keep looking for the row it
// writes. Its fetch is a single HTTPS call; three tries covers a slow one
// without making the refresh button feel stuck.
const REREAD_TRIES = 3;
const REREAD_GAP_MS = 800;

/**
 * Whichever of two readings was collected later, regardless of source.
 *
 * Quota numbers only ever move forward in time, so "newer" is the only ranking
 * that makes sense between a store row and something we fetched ourselves. A
 * five-hour window can also reset between the two, which makes an older reading
 * not merely stale but wrong — 23% from before the reset, 3% after it.
 */
export function freshest(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return (b.fetchedAt ?? 0) > (a.fetchedAt ?? 0) ? b : a;
}

/** Ask for a collection, then watch the store for the result. */
async function nudgeAndReread(previous) {
  let asked = false;
  try { asked = await requestCollection(); } catch { /* cswap missing */ }
  if (!asked) return previous;

  for (let i = 0; i < REREAD_TRIES; i++) {
    await sleep(REREAD_GAP_MS);
    const fresh = await storeQuota();
    if (fresh && (!previous || fresh.fetchedAt > previous.fetchedAt)) return fresh;
  }
  return previous;
}

// Run `claude --print /usage` once. Returns { cliOk, parsed }.
//   cliOk  — the CLI ran and we recognized its output (preamble present)
//   parsed — quota percentages object, or null if the "Current session/week"
//            lines were absent (CLI cold-start, or genuinely <1% usage)
async function _execOnce(bin) {
  const r = await run(bin, ["--print", "/usage"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    // Marks this Claude Code run as the deck's own. `claude --print /usage`
    // is a full invocation, so it fires the hooks we installed, and every
    // quota poll was drawing itself onto the canvas as a fresh session with
    // no prompt and no tools. Hooks inherit the environment, so hook.js
    // sees this and stays quiet.
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb", AGENTS_DECK_INTERNAL: "1" },
  });
  // `run` never rejects, so there is one path rather than two — and the output
  // is kept either way, which matters because the CLI writes the quota lines to
  // stdout and can still exit non-zero afterwards.
  const combined = r.stdout + "\n" + r.stderr;
  if (!r.ok) {
    const msg = stripAnsi(r.stderr).trim() || `claude exited ${r.code}`;
    console.error(`${PRODUCT} quota: claude CLI failed:`, msg);
  }
  const cliOk = /subscription/i.test(combined) || /claude code usage/i.test(combined);
  return { cliOk, parsed: parseUsageText(combined) };
}

async function _doFetch(now, force = false) {
  // Source 1: claude-swap's store. Free, and already paid for.
  let store = await storeQuota();

  // Refresh asks for newer numbers, and the honest way to get them from this
  // source is to ask the collector that owns it — which applies its own
  // schedule and backoff, so this cannot become a poll loop.
  if (force && (!store || now - store.fetchedAt > FORCE_POLL_MS)) {
    store = await nudgeAndReread(store);
  }
  if (store && now - store.fetchedAt <= STORE_TRUSTED_MS) {
    // Keep the store moving even when the accounts panel is closed. Without
    // this the numbers only advance while something else asks — claude-swap's
    // own schedule still decides whether this touches the network, and the
    // throttle inside is shared with the accounts panel, so two open panels
    // ask no more often than one.
    if (!force) requestCollection().catch(() => {});
    _cache = store; _cacheAt = now;
    _lastGood = store;
    return store;
  }

  // Nothing usable in the store. Everything below spends the user's budget, so
  // it happens on a floor, and not at all while a 429 cooldown is running.
  if (!maySelfPoll({ now, force, lastSelfPollAt: _lastSelfPollAt, rateLimitedUntil: _rateLimitedUntil })) {
    // A stale row still beats an empty panel, and says how stale it is — but
    // it must be the freshest thing we hold, not just the store. Preferring
    // the store here threw away readings we had already paid for: after a boot
    // that fell through to the CLI, the panel showed 3% (fetched seconds ago)
    // and then reverted to 23% (from a 48-minute-old store row) on the very
    // next poll, because the store had not moved.
    const held = freshest(store, _lastGood);
    if (held) {
      const result = { ...held, stale: true };
      _cache = result; _cacheAt = now;
      return result;
    }
    const result = { ok: false, reason: now < _rateLimitedUntil ? "rate_limited" : "waiting", fetchedAt: now };
    _cache = result; _cacheAt = now - (CACHE_MS - 5_000);
    return result;
  }
  _lastSelfPollAt = now;

  // Source 2: OAuth usage API — instant, exact, no cold-start gap.
  const api = await fetchOAuthUsage();
  if (api) {
    const result = { ok: true, ...api, source: "api", fetchedAt: now };
    _cache = result; _cacheAt = now;
    _lastGood = result;
    return result;
  }

  // Source 3: parse `claude --print /usage` CLI output.
  const bin = quotaClaudeBin();

  // The CLI sometimes omits the "Current session/week" quota lines on a cold
  // invocation (right after the server starts, or after the page is hard-
  // refreshed). The real lines appear on a subsequent call. Retry a couple
  // times before giving up so the first paint already shows real values.
  let cliOk = false;
  let parsed = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200);
    const r = await _execOnce(bin);
    cliOk = r.cliOk || cliOk;
    if (r.parsed) { parsed = r.parsed; break; }
  }

  // Got real quota lines — cache normally and remember as last-known-good.
  if (parsed) {
    const result = { ok: true, ...parsed, source: "cli", fetchedAt: now };
    _cache = result; _cacheAt = now;
    _lastGood = result;
    return result;
  }

  // No quota lines after retries. If we've ever seen real values, keep showing
  // them rather than regressing to 0% on a transient empty read — with the
  // timestamp of the answer they actually are. Re-stamping them `now` put "just
  // now" over percentages collected hours earlier for one poll in five, then let
  // the label snap back to the true age: an age indicator that oscillates, and
  // vouches for numbers this branch already knows are stale. Short-cache so we
  // retry the CLI again soon.
  if (_lastGood) {
    const result = { ..._lastGood, stale: true };
    _cache = result;
    _cacheAt = now - (CACHE_MS - 5_000);
    return result;
  }

  // Never had good data. CLI ran but lines absent → treat as genuine <1%.
  // CLI failed entirely → ok:false. Either way short-cache for a quick retry.
  const result = cliOk
    ? { ok: true, session5hPct: 0, session5hWindowSec: 18000,
        week7dPct: 0, week7dWindowSec: 604800, fetchedAt: now }
    : { ok: false, fetchedAt: now };
  _cache = result;
  _cacheAt = now - (CACHE_MS - 5_000);
  return result;
}

/**
 * Forget every reading held for the account that was active when it was taken.
 *
 * `?refresh=1` is the browser asking for a fresher read; this is the server
 * knowing the numbers it holds are the wrong account's. A Claude account switch
 * makes them that — every percentage here belongs to whoever was active when it
 * was collected — and the switch happens server-side, where no tab is in a
 * position to send the flag: it is driven from the accounts panel, and the usage
 * panel neither owns that state nor hears about it.
 *
 * `_lastGood` goes with the result cache, and it is the half that matters.
 * Clearing `_cache` alone only shortens the wrong answer's life to the next
 * poll, because both fallbacks in _doFetch hand `_lastGood` straight back — and
 * freshest() ranks by fetchedAt, so a reading the deck already paid for beats
 * any row the store holds for an account nobody has collected for since. The
 * panel would print the previous account's percentages under a "stale" label
 * instead of admitting it has no answer for this one yet.
 *
 * The self-poll floor deliberately survives: a switch is not a reason to spend
 * the shared request budget, and one that reset it would make switching a way to
 * hammer it. Until the store answers for the new account, "no reading yet" is
 * the honest thing to serve.
 */
export function invalidateQuotaCache() {
  _cache = null;
  _cacheAt = 0;
  _lastGood = null;
}
