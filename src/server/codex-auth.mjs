// Codex (ChatGPT) OAuth credentials: read, refresh, persist.
//
// Ports the flow the Codex CLI itself uses (openai/codex, crate `codex-login`)
// so agents-deck keeps a live token instead of going dark the moment the one
// written by `codex login` rotates server-side.
//
// The important subtlety: OpenAI ROTATES the refresh token, single-use. A
// refresh whose result does not reach disk burns the credential outright —
// the next attempt fails with `refresh_token_reused` and the user has to run
// `codex login` again. Everything defensive in this file follows from that:
// refreshes are serialized, the token is re-read from disk inside the lock
// immediately before it is spent, a response that does not clearly carry a
// new access token is never treated as success, and nothing here throws —
// a rejected promise from a background poll would take the server down.
import { readFile, chmod, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_HOME } from "./codex-dir.mjs";
import { createTemp, renameWithRetry } from "./installer.mjs";
import { PRODUCT } from "./brand.mjs";

// This file used to resolve CODEX_HOME itself, as `process.env.CODEX_HOME ??
// join(homedir(), ".codex")`. `??` falls back on null and undefined only, so an
// empty CODEX_HOME — what `export CODEX_HOME=$SOME_UNSET_VAR` leaves in a
// profile — survived it, and join("", "auth.json") is the CWD-relative
// "auth.json". Of all five readers this was the expensive one to get wrong: the
// rotated refresh token below is single-use, so a write that lands in whatever
// directory the deck was started from does not lose a read, it burns the
// credential and costs the user a `codex login`. codex-dir.mjs owns the rule now
// and treats an empty value as "not set" (#375).
const AUTH_PATH = join(CODEX_HOME, "auth.json");

// Same client id + endpoint the Codex CLI uses (codex-rs/login/src/auth/manager.rs).
const CLIENT_ID   = process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";

// Registrable domains the deck is willing to hand an OpenAI credential to.
// Deliberately a suffix list rather than a set of exact hosts: OpenAI moves
// endpoints between subdomains, and FedRAMP tenants live on their own, so
// pinning the four hosts in use today would break a working login on a change
// that is none of our business. The suffix is the part that is.
const CREDENTIAL_HOSTS = ["openai.com", "chatgpt.com"];

/**
 * May a live OpenAI credential be sent to this URL?
 *
 * Both destinations in the Codex half of the deck are configurable by something
 * other than the deck — `chatgpt_base_url` in ~/.codex/config.toml, which the
 * access token is sent to, and $CODEX_REFRESH_TOKEN_URL_OVERRIDE, which the
 * SINGLE-USE refresh token is POSTed to — and neither was checked before the
 * credential went out. The Codex CLI honours the same two knobs; the difference
 * is that it is the program those credentials belong to, and the deck is a
 * bystander that reads them.
 *
 * Two rules. `https:`, so a base URL of `http://…` cannot put a bearer token on
 * the wire in cleartext. And a host at or under one of the domains above, so a
 * config file the deck does not own cannot name the recipient.
 *
 * `URL` does the parsing rather than a regex, which is what makes
 * `https://chatgpt.com@evil.example/` (userinfo, not a host) and
 * `https://chatgpt.com.evil.example/` (a different registrable domain) come out
 * as the hosts they really are.
 */
export function isCredentialHost(raw) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return CREDENTIAL_HOSTS.some(d => host === d || host.endsWith(`.${d}`));
}

// The override is honoured only when it names somewhere the refresh token may
// go. Falling back rather than failing outright keeps a machine with a stale or
// mistyped override working, and the log line is there so the fallback is not
// the silent kind.
function refreshUrl() {
  const override = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim();
  if (!override) return DEFAULT_REFRESH_URL;
  if (isCredentialHost(override)) return override;
  console.error(
    `${PRODUCT} codex-auth: ignoring CODEX_REFRESH_TOKEN_URL_OVERRIDE — ` +
    `a refresh token is only sent to https OpenAI hosts, not ${override}`,
  );
  return DEFAULT_REFRESH_URL;
}

// Refresh once the access token is within this much of expiring. Deliberately
// tighter than the CLI's 5 minutes: matching it would wake both processes into
// the same window to race for the same single-use token, and the loser gets a
// `refresh_token_reused` that reads to the user as "your login is broken".
const EXPIRY_SKEW_MS   = 90 * 1000;
// Fallback only, for tokens whose `exp` we cannot read.
const MAX_TOKEN_AGE_MS = 8 * 24 * 60 * 60 * 1000;

// Refresh failures that will never succeed on retry — the credential is gone
// and only `codex login` brings it back.
const PERMANENT_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant",
]);

/** Decode a JWT payload. Returns null for anything that isn't a 3-part JWT. */
export function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return (payload && typeof payload === "object") ? payload : null;
  } catch {
    return null;
  }
}

/** Access-token expiry in ms, or null when the token carries no readable `exp`. */
function expiryMs(accessToken) {
  const exp = decodeJwt(accessToken)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

async function readAuthFile() {
  try {
    const parsed = JSON.parse(await readFile(AUTH_PATH, "utf8"));
    return (parsed && typeof parsed === "object") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write auth.json back atomically: write a sibling tmp file, fsync it, then
 * rename over the target. A reader can never observe a half-written file, and
 * the fsync means a machine crash cannot leave an empty one behind after we
 * have already spent the old refresh token.
 *
 * Resolves symlinks first — `~/.codex/auth.json` is often a link into a
 * dotfiles repo or an encrypted volume, and renaming onto the link would
 * replace it with a regular file, quietly detaching the user's setup.
 *
 * The temp file comes from the installer's createTemp, which numbers every
 * write and creates it with O_EXCL, rather than from a name built out of the
 * pid alone. A pid names a process, not a write, so that name was one file
 * shared by every write this process makes, and the open that filled it
 * truncated whatever it found: a second refresh in flight would fill it from
 * offset zero underneath the first, and the loser would rename a splice of the
 * two over auth.json — or find its temp file already renamed away and throw
 * ENOENT. What is left at that name between runs is a live rotated refresh
 * token in cleartext, so the leftover a crashed deck strands there is not inert
 * either: a plain create adopts it whole, keeping its permissions, because
 * open() applies the mode it is given only when it is the call that creates the
 * file. O_EXCL turns a taken name into an error the caller handles instead,
 * which is also what makes the 0600 binding from the very first byte rather
 * than whatever the file it inherited happened to allow.
 *
 * The rename is the installer's retrying one because Windows fails it outright
 * with EPERM/EBUSY while another process holds auth.json open, and a virus
 * scanner, the search indexer or the Codex CLI itself does exactly that for a
 * few milliseconds at a time. Everywhere else that costs a re-download; here
 * the refresh token has already been spent server-side, so losing that
 * millisecond race logs the user out of Codex until they run `codex login`.
 *
 * Throws on failure; the caller must treat that as "the refresh did not
 * happen" rather than swallowing it.
 */
async function persistAuth(auth) {
  const target = await realpath(AUTH_PATH).catch(() => AUTH_PATH);
  const { tmp, handle } = await createTemp(target, { mode: 0o600 });

  let ok = false;
  try {
    try {
      await handle.writeFile(JSON.stringify(auth, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The umask only ever clears bits off the creation mode, so the token is
    // never wider than 0600 — but it can land narrower, and an auth.json at
    // 0400 is one the Codex CLI's own writer cannot open the next time it
    // rotates. On Windows chmod's only effect is the read-only bit, and a
    // read-only target is one no rename can replace. Pin it either way.
    await chmod(tmp, 0o600);
    await renameWithRetry(tmp, target);
    ok = true;
  } finally {
    // A tmp left behind holds a live rotated refresh token in cleartext.
    if (!ok) await unlink(tmp).catch(() => {});
  }
}

/** True when the stored access token is expired, near-expiry, or stale. */
function shouldRefresh(auth) {
  const tokens = auth?.tokens;
  if (!tokens?.refresh_token) return false;
  if (!tokens.access_token) return true;

  const exp = expiryMs(tokens.access_token);
  if (exp != null) return exp <= Date.now() + EXPIRY_SKEW_MS;

  // No readable expiry — fall back to how long ago the CLI last refreshed.
  const last = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;
  if (isNaN(last)) return false;
  return last < Date.now() - MAX_TOKEN_AGE_MS;
}

/** Pull the failure code out of the several shapes the endpoint returns it in. */
function refreshErrorCode(body) {
  const raw = typeof body?.error === "object" ? body?.error?.code
            : typeof body?.error === "string" ? body.error
            : body?.code;
  return typeof raw === "string" ? raw.toLowerCase() : null;
}

/**
 * Spend the refresh token. Never throws — every failure is a return value,
 * because callers include a 60s background poll whose rejection would reach
 * the HTTP router as an unhandled rejection and kill the process.
 */
async function doRefresh(auth) {
  let res, body;
  try {
    // Resolved per call, not once at import: the module is loaded lazily and a
    // test (or an embedder) can set the override after load — the same reason
    // ccusage.mjs reads AGENTS_DECK_NO_INSTALL per call.
    res = await fetch(refreshUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     CLIENT_ID,
        grant_type:    "refresh_token",
        refresh_token: auth.tokens.refresh_token,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    body = await res.json().catch(() => null);
  } catch {
    // Network error or timeout: the server may or may not have rotated the
    // token. Nothing is written, so the next attempt retries with what we
    // have — the only safe move when the outcome is unknown.
    return { ok: false, reason: "refresh_failed" };
  }

  if (!res.ok) {
    const code = refreshErrorCode(body);
    const permanent = (code && PERMANENT_CODES.has(code)) || res.status === 401;
    return { ok: false, reason: permanent ? "refresh_rejected" : "refresh_failed", code };
  }

  // A 2xx whose body did not survive the trip (truncated response, captive
  // portal, proxy error page) is NOT success: writing here would persist the
  // old, now-consumed token plus a fresh `last_refresh`, reporting a working
  // login while guaranteeing the next call fails as `refresh_token_reused`.
  if (typeof body?.access_token !== "string" || body.access_token === "") {
    return { ok: false, reason: "refresh_failed", code: "no_access_token" };
  }

  // Write back only the fields that came in, leaving the rest of auth.json
  // (OPENAI_API_KEY, auth_mode, account_id, anything unknown) untouched.
  const next = { ...auth, tokens: { ...auth.tokens } };
  next.tokens.access_token = body.access_token;
  if (body.id_token)      next.tokens.id_token      = body.id_token;
  if (body.refresh_token) next.tokens.refresh_token = body.refresh_token;
  next.last_refresh = new Date().toISOString();

  try {
    await persistAuth(next);
  } catch (err) {
    // The rotated token exists server-side but never reached disk. Say so
    // plainly — the credential on disk is now dead and only a re-login fixes
    // it, so reporting a transient failure would just mislead.
    console.error(`${PRODUCT} codex-auth: could not write auth.json:`, err?.message ?? err);
    return { ok: false, reason: "refresh_rejected", code: "persist_failed" };
  }

  return { ok: true, auth: next };
}

// Refreshes run strictly one at a time per process. A queue rather than a
// shared promise: callers that arrive during a refresh must be able to make
// their own decision afterwards (see the staleness checks below) instead of
// inheriting a result produced before their token failed.
let _chain = Promise.resolve();
function serialize(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});
  return run;
}

/**
 * Refresh under the lock.
 *
 * `ifStale` — only refresh when the credentials on disk still look expiring.
 * `staleAccessToken` — only refresh when disk still holds the token the caller
 * saw fail. Both exist for the same reason: auth.json is re-read *inside* the
 * lock, so a caller that queued behind another refresh discovers it already
 * got what it needed and does not spend a second single-use token.
 */
function refreshCredentials({ ifStale = false, staleAccessToken = null } = {}) {
  return serialize(async () => {
    const auth = await readAuthFile();
    if (!auth?.tokens?.refresh_token) return { ok: false, reason: "no_token" };
    if (ifStale && !shouldRefresh(auth)) return { ok: true, auth };
    if (staleAccessToken && auth.tokens.access_token !== staleAccessToken) {
      return { ok: true, auth };  // someone else already rotated past it
    }
    return doRefresh(auth);
  });
}

function identityFrom(auth, refreshed) {
  // Claims live in the id_token, not the access token. account_id is seeded at
  // login into tokens.account_id; the id_token claim is the fallback for
  // credential files written before that field existed.
  const claims = decodeJwt(auth.tokens.id_token) ?? {};
  const oai    = claims["https://api.openai.com/auth"] ?? {};
  return {
    ok:          true,
    accessToken: auth.tokens.access_token,
    accountId:   auth.tokens.account_id ?? oai.chatgpt_account_id ?? null,
    isFedramp:   oai.chatgpt_account_is_fedramp === true,
    planType:    oai.chatgpt_plan_type ?? null,
    email:       claims.email ?? null,
    refreshed,
  };
}

/**
 * Current Codex credentials, refreshed if needed.
 *
 * Returns { ok: true, accessToken, accountId, … } or { ok: false, reason }
 * where reason is `no_token` (never logged in) / `refresh_rejected` (re-login
 * required) / `refresh_failed` (transient). Never throws.
 */
export async function getCodexAuth({ allowRefresh = true } = {}) {
  let auth = await readAuthFile();

  // An `OPENAI_API_KEY` login is a platform credential, not a ChatGPT session.
  // Flagged rather than rejected so the caller can say so plainly instead of
  // sending the key to chatgpt.com and reporting the resulting 401 as a bug.
  const apiKey = typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  if (auth?.auth_mode === "apikey" || (apiKey && !auth?.tokens?.access_token)) {
    return { ok: true, apiKeyMode: true, accessToken: null, accountId: null };
  }

  if (!auth?.tokens?.access_token) return { ok: false, reason: "no_token" };

  let refreshed = false;
  if (allowRefresh && shouldRefresh(auth)) {
    const r = await refreshCredentials({ ifStale: true });
    if (!r.ok) return r;
    refreshed = r.auth.tokens.access_token !== auth.tokens.access_token;
    auth = r.auth;
  }

  return identityFrom(auth, refreshed);
}

/**
 * Refresh because the backend rejected a token that looked valid locally —
 * OpenAI revokes server-side, so the JWT's own `exp` is not the last word.
 *
 * Pass the access token that was rejected: if disk has already moved past it
 * (a concurrent refresh, or the Codex CLI), this returns the newer credentials
 * without spending another single-use refresh token.
 */
export async function forceCodexRefresh(rejectedAccessToken = null) {
  const r = await refreshCredentials({ staleAccessToken: rejectedAccessToken });
  return r.ok ? identityFrom(r.auth, true) : r;
}
