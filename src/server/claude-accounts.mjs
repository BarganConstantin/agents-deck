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
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
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
 * Returns { ok: false, reason: "no_store" } when claude-swap isn't installed —
 * the panel then explains itself rather than showing an empty list.
 */
export async function fetchClaudeAccounts({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const finish = (r) => { _cache = r; _cacheAt = Date.now(); return r; };

  const root = backupRoot();
  const seq  = await readJson(join(root, "sequence.json"));
  if (!seq?.accounts) return finish({ ok: false, reason: "no_store", fetchedAt: now });

  const usage = await readJson(join(root, "cache", "usage.json"));
  // A schema bump means the rows may not mean what this code thinks they do.
  const rows = usage?.schemaVersion === 2 ? (usage.accounts ?? {}) : {};

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

  return new Promise((resolve) => {
    execFile("cswap", ["switch", String(num)], {
      timeout: 30_000,
      // Argument array, never a shell — and PATH-resolved rather than pinned
      // because cswap installs to a handful of different places.
      shell: false,
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, output: String(stdout).trim() });
      const reason = err.code === "ENOENT" ? "no_cswap"
                   : err.killed              ? "timeout"
                   : "switch_failed";
      resolve({ ok: false, reason, output: String(stderr || stdout).trim().slice(0, 500) });
    });
  });
}
