// Multi-account Claude usage, read out of claude-swap's store.
//
// Anthropic has no endpoint that reports usage for an account you are not
// logged into: the only way is to hold that account's OAuth token and call
// /api/oauth/usage once per account. claude-swap already does exactly that,
// and pays the whole cost of it — credential custody, one-time refresh tokens
// (double-spending one permanently kills an account), macOS Keychain access,
// and a request budget of roughly 28-30 calls per rolling hour PER ACCOUNT
// that is shared across every tool on the machine.
//
// So agents-deck does not fetch. It reads what claude-swap already fetched and
// renders it. Nothing here makes a network call or writes a credential, which
// means the deck cannot 429 the user's account, cannot burn a refresh token,
// and cannot lose a login. Switching shells out to `cswap` rather than
// reimplementing the lock protocol its correctness depends on.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cswapBin, cswapVersion, installHint } from "./cswap-install.mjs";
import { run, runDetached } from "./exec.mjs";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";

// claude-swap keeps its store under XDG on Linux and in the home directory
// everywhere else (paths.py get_backup_root).
function backupRoot() {
  if (process.env.CLAUDE_SWAP_BACKUP) return process.env.CLAUDE_SWAP_BACKUP;
  if (platform() === "linux") {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && xdg.startsWith("/")) return join(xdg, "claude-swap");
    return join(homedir(), ".local/share/claude-swap");
  }
  return join(homedir(), ".claude-swap-backup");
}

let _cache   = null;
let _cacheAt = 0;
// Short: these are local file reads, and the point of the panel is that it
// tracks what claude-swap is doing. No network cost to amortise.
const CACHE_MS = 5_000;

// Past this, claude-swap's own numbers are old enough that showing them
// without a marker would misrepresent them (its own trust ceiling is 3600s).
const STALE_AFTER_MS = 15 * 60_000;

// Nudging the collector: at most this often, however many times the panel asks.
const NUDGE_EVERY_MS = 60_000;
let _lastNudge = 0;

/**
 * Ask claude-swap to collect, if its own schedule says anything is due.
 *
 * Without this the panel is only as live as whatever else is running: if the
 * user has no `cswap watch`/`auto`/TUI open, nothing ever writes the store and
 * the panel shows frozen numbers while looking current.
 *
 * `cswap list` is the safe way to ask. It runs the same on-demand pass every
 * claude-swap surface uses, and the store — not us — decides which accounts,
 * if any, may actually hit the network. So this cannot outrun the request
 * budget no matter how often the panel polls: when nothing is due, it is a
 * local read that fetches nothing.
 *
 * Fire-and-forget. The result lands in the store for the next poll to pick up;
 * making the caller wait would just delay the numbers it already has.
 */
/**
 * Whether anything is waiting to be collected.
 *
 * Judged per account that actually exists, and an account counts as waiting in
 * three cases:
 *
 *   - it has no usage row at all;
 *   - it has a row whose fetchedAt is not a number. claude-swap writes a row
 *     when an account is added and fills in the numbers when it first polls,
 *     so "row exists" is not the same as "has been fetched" — and that is the
 *     state a freshly added account sits in. Treating the row's existence as
 *     proof of a fetch left a new account reading "never fetched" forever;
 *   - its own schedule says the next poll is due.
 *
 * Rows are consulted only for accounts in the store. A removed account leaves
 * its row behind, permanently overdue and impossible to collect because the
 * account is gone — counting those meant something was always due and the
 * collector was asked every minute for the rest of the session.
 */
export function collectionDue(rows, slots, now) {
  for (const slot of slots) {
    const r = rows[slot];
    if (!r) return true;                                                  // never seen
    if (typeof r.fetchedAt !== "number") return true;                     // seen, never fetched
    if (typeof r.nextPollAt === "number" && r.nextPollAt * 1000 <= now) return true;
  }
  return false;
}

function nudgeCollector(rows, slots, now) {
  if (now - _lastNudge < NUDGE_EVERY_MS) return;
  if (!collectionDue(rows, slots, now)) return;

  _lastNudge = now;
  // Fire-and-forget: this function is deliberately synchronous so callers never
  // wait on it, and resolving the binary is the only async part.
  cswapBin().then(bin => runDetached(bin, ["list"])).catch(() => {});
}

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

function pctOf(win) {
  const p = win?.pct;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

/** One lane, in the shape the panel's bars already speak. */
function lane(id, label, win) {
  const pct = pctOf(win);
  if (pct == null) return null;
  const resetAt = win?.resets_at ? Date.parse(win.resets_at) : NaN;
  return {
    id,
    label,
    pct,
    // claude-swap stores a countdown string too, but it was computed when the
    // row was written and drifts — the client recomputes from the timestamp.
    resetAt: isNaN(resetAt) ? null : Math.floor(resetAt / 1000),
  };
}

/**
 * Every managed account with whatever usage claude-swap last saw for it.
 *
 * When there is nothing to show, says which of the two reasons it is:
 * "no_cswap" (the tool is not installed, and here is the command for this
 * machine) or "no_accounts" (it is installed but nothing has been added yet).
 * They need different things from the user, and reporting both as one empty
 * panel leaves whichever one they are in with nowhere to go.
 */
export async function fetchClaudeAccounts({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const finish = (r) => { _cache = r; _cacheAt = Date.now(); return r; };

  const root = backupRoot();
  const seq  = await readJson(join(root, "sequence.json"));
  if (!seq?.accounts) {
    const version = await cswapVersion();
    return finish(version
      ? { ok: false, reason: "no_accounts", version, fetchedAt: now }
      : { ok: false, reason: "no_cswap", hint: await installHint(), fetchedAt: now });
  }

  const usage = await readJson(join(root, "cache", "usage.json"));
  // A schema bump means the rows may not mean what this code thinks they do.
  const rows = usage?.schemaVersion === 2 ? (usage.accounts ?? {}) : {};

  // Kick a collection for the NEXT poll if anything is due — either because
  // claude-swap's schedule says so, or because an account has never been
  // fetched at all.
  nudgeCollector(rows, Object.keys(seq.accounts), now);

  const order = Array.isArray(seq.sequence) && seq.sequence.length
    ? seq.sequence.map(String)
    : Object.keys(seq.accounts).sort((a, b) => Number(a) - Number(b));

  const accounts = [];
  for (const num of order) {
    const acct = seq.accounts[num];
    if (!acct) continue;                       // sequence lists a slot that no longer exists

    const row = rows[num];
    // claude-swap keys usage rows by slot but guards them on identity, because
    // a removed account leaves its row behind and slots get reused. Without
    // the same check the panel would show the previous occupant's numbers.
    const matches = row
      && row.email === acct.email
      && (row.organizationUuid ?? "") === (acct.organizationUuid ?? "");
    const good = matches ? row.lastGood : null;

    const fetchedAtMs = matches && typeof row.fetchedAt === "number" ? row.fetchedAt * 1000 : null;

    const lanes = [
      lane("five_hour", "5h", good?.five_hour),
      lane("seven_day", "7d", good?.seven_day),
      ...(Array.isArray(good?.scoped) ? good.scoped : [])
        .map((s, i) => lane(`scoped-${i}`, s?.name ?? "model", s))
        .filter(Boolean),
    ].filter(Boolean);

    accounts.push({
      num:      Number(num),
      email:    acct.email ?? null,
      alias:    acct.alias ?? null,
      org:      acct.organizationName ?? null,
      active:   String(seq.activeAccountNumber) === num,
      disabled: acct.disabled === true,
      lanes,
      // Headroom against the tightest lane — the number that decides whether
      // this account is worth switching to.
      headroom: lanes.length ? Math.max(0, 100 - Math.max(...lanes.map(l => l.pct))) : null,
      fetchedAt: fetchedAtMs,
      stale:     fetchedAtMs == null || now - fetchedAtMs > STALE_AFTER_MS,
      // Surfaced rather than hidden: a rate-limited or re-login-needed account
      // is exactly the one the user is about to try switching to.
      //
      // Keyed off consecutiveFailures, not lastError: claude-swap keeps
      // lastError as history and only advances fetchedAt on success, so an
      // account that hit a 429 an hour ago and has been fine since still
      // carries the string. Reading it directly pins a red badge on a healthy
      // account forever.
      error: (matches && row.consecutiveFailures > 0) ? (row.lastError ?? "error") : null,
    });
  }

  return finish({ ok: true, accounts, activeNum: seq.activeAccountNumber ?? null, fetchedAt: now });
}

export function invalidateClaudeAccountsCache() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Switch the active Claude account by delegating to `cswap`.
 *
 * Not reimplemented here on purpose. A correct switch has to hold three of
 * Claude Code's own lock files, in its order, with its staleness values, or it
 * can interleave with Claude Code's token refresh and clobber it. cswap does
 * that; a second implementation racing it would be worse than useless.
 */
export function switchClaudeAccount(accountNum) {
  // Straight into an exec argument, so nothing but a slot number gets through.
  const num = Number(accountNum);
  if (!Number.isInteger(num) || num < 1 || num > 999) {
    return Promise.resolve({ ok: false, reason: "bad_account" });
  }

  // Argument vector, never a shell — and resolved through exec.mjs so the
  // Windows `.exe`/`.cmd` shim is found too.
  return cswapBin()
    .then(bin => run(bin, ["switch", String(num)], { timeout: 30_000 }))
    .then(r => {
      if (r.ok) return { ok: true, output: r.stdout.trim() };
      const reason = r.code === "ENOENT" ? "no_cswap" : r.killed ? "timeout" : "switch_failed";
      return { ok: false, reason, output: (r.stderr || r.stdout).trim().slice(0, 500) };
    });
}


/**
 * Register the account already signed in, the first time and only the first
 * time.
 *
 * A fresh install leaves claude-swap with an empty store, so the panel comes up
 * saying "no accounts added yet" and telling the user to run `cswap add`
 * themselves — for the account they are already using, on the machine they are
 * already on. Running it for them is the difference between the panel working
 * and the panel being a to-do item.
 *
 * `cswap add` takes no arguments, prompts for nothing, and does not sign
 * anyone in: it records the Claude Code session that already exists. Even so it
 * is bounded tightly, because it writes to a credential store:
 *
 *   - only when the store holds no accounts at all, so nothing can be
 *     overwritten or reordered;
 *   - only once ever, marked on disk, so a user who deliberately removes their
 *     last account does not get it added back on the next launch;
 *   - never when AGENTS_DECK_NO_INSTALL=1.
 *
 * Failure is normal and quiet: on a machine where Claude Code has never signed
 * in there is nothing to record.
 */
const SEED_MARKER = join(homedir(), ".agents-deck", ".cswap-seeded");

/**
 * How many accounts a sequence.json holds.
 *
 * claude-swap writes `accounts` as an object keyed by slot number — {"2": {…},
 * "3": {…}} — not as a list. An Array.isArray guard here read that as "no
 * accounts" and ran `cswap add` against a populated store, which is exactly
 * what the guard existed to prevent. Both shapes are accepted now, and
 * anything unrecognised counts as -1: unknown is not the same as empty, and
 * only a confident zero may lead to a write.
 */
export function accountCount(seq) {
  const a = seq?.accounts;
  if (Array.isArray(a)) return a.length;
  if (a && typeof a === "object") return Object.keys(a).length;
  if (a == null && seq && typeof seq === "object") return 0;   // store exists, no accounts yet
  return -1;                                                    // unreadable — do nothing
}

export async function seedFirstAccount() {
  if (process.env.AGENTS_DECK_NO_INSTALL === "1") return { state: "skipped" };
  if (existsSync(SEED_MARKER)) return { state: "already-tried" };

  // Empty store only. A store with accounts in it is the user's, not ours, and
  // a store we cannot parse is treated the same way.
  // No file at all is the fresh install this exists for; a file that will not
  // parse is a store in an unknown state. readJson answers null to both, so
  // they are told apart before deciding, because they call for opposite
  // decisions — seed, and keep well away.
  const seqPath = join(backupRoot(), "sequence.json");
  const before = existsSync(seqPath) ? accountCount(await readJson(seqPath)) : 0;
  if (before > 0) return { state: "has-accounts", count: before };
  if (before < 0) return { state: "unreadable-store" };

  // Mark before running, not after: if `cswap add` half-succeeds or the process
  // dies mid-way, the retry-forever loop is the worse outcome.
  try {
    await mkdir(dirname(SEED_MARKER), { recursive: true });
    await writeFile(SEED_MARKER, new Date().toISOString());
  } catch { /* best-effort — worst case it is attempted again */ }

  const r = await run(await cswapBin(), ["add"], { timeout: 60_000 });
  if (!r.ok) {
    return { state: "failed", detail: (r.stderr || r.stdout).trim().slice(0, 200) };
  }

  invalidateClaudeAccountsCache();
  const count = existsSync(seqPath) ? accountCount(await readJson(seqPath)) : 0;
  if (count > 0) {
    // Collect straight away. Otherwise the first thing the user sees is their
    // account listed with "never fetched" beside it, waiting on a poll cycle
    // for numbers that are the reason the panel exists.
    runDetached(await cswapBin(), ["list"]);
  }
  return count > 0 ? { state: "added", count } : { state: "nothing-to-add" };
}
