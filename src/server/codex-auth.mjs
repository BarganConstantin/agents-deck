// Codex (ChatGPT) OAuth credentials: read, refresh, persist.
//
// Ports the flow the Codex CLI itself uses (openai/codex, crate `codex-login`)
// so agents-deck keeps a live token instead of going dark the moment the one
// written by `codex login` rotates server-side.
//
// The important subtlety: OpenAI ROTATES the refresh token. A refresh whose
// result is not written back to auth.json burns the credential — the next use
// of the old refresh token fails permanently with `refresh_token_reused`, and
// the user has to re-run `codex login`. So refreshing and persisting are one
// operation here, never two, and the write is atomic (tmp + rename) rather
// than the CLI's own truncate-in-place.
import { readFile, writeFile, rename, chmod, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const AUTH_PATH  = join(CODEX_HOME, "auth.json");
const BACKUP_PATH = `${AUTH_PATH}.agents-deck-bak`;

// Same client id + endpoint the Codex CLI uses (codex-rs/login/src/auth/manager.rs).
const CLIENT_ID   = process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? "https://auth.openai.com/oauth/token";

// Refresh once the access token is within this much of expiring. The CLI uses
// 5 minutes; matching it means both refresh on the same schedule instead of
// fighting over the rotation.
const EXPIRY_SKEW_MS   = 5 * 60 * 1000;
// Fallback only, for tokens whose `exp` we cannot read.
const MAX_TOKEN_AGE_MS = 8 * 24 * 60 * 60 * 1000;

// Refresh failures that will never succeed on retry — the credential is gone
// and only `codex login` brings it back.
const PERMANENT_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

/** Decode a JWT payload. Returns null for anything that isn't a 3-part JWT. */
export function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
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
    return JSON.parse(await readFile(AUTH_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write auth.json back. Atomic (write tmp in the same directory, then rename)
 * so a crash mid-write cannot leave the user without credentials, and 0600 so
 * the rotated tokens are no more readable than the ones they replace.
 *
 * The first write also snapshots the original next to it, once — cheap
 * insurance for the one file the user cannot regenerate without re-logging in.
 */
async function persistAuth(auth) {
  try { await access(BACKUP_PATH); }
  catch { await copyFile(AUTH_PATH, BACKUP_PATH).catch(() => {}); }

  const tmp = `${AUTH_PATH}.agents-deck-${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, AUTH_PATH);
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

// One refresh at a time per process. Concurrent callers await the same promise
// rather than each spending the (single-use) refresh token.
let _inFlight = null;

async function doRefresh(auth) {
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      grant_type:    "refresh_token",
      refresh_token: auth.tokens.refresh_token,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const code = refreshErrorCode(body);
    const permanent = (code && PERMANENT_CODES.has(code)) || res.status === 401;
    return { ok: false, reason: permanent ? "refresh_rejected" : "refresh_failed", code, permanent };
  }

  // Every field is optional — write back only what came in, leaving the rest
  // of auth.json (OPENAI_API_KEY, auth_mode, account_id, …) untouched.
  const next = { ...auth, tokens: { ...auth.tokens } };
  if (body?.id_token)      next.tokens.id_token      = body.id_token;
  if (body?.access_token)  next.tokens.access_token  = body.access_token;
  if (body?.refresh_token) next.tokens.refresh_token = body.refresh_token;
  next.last_refresh = new Date().toISOString();

  await persistAuth(next);
  return { ok: true, auth: next };
}

/**
 * Current Codex credentials, refreshed if needed.
 *
 * Returns { ok: true, accessToken, accountId, isFedramp, planType, email,
 *           refreshed } or { ok: false, reason } where reason is one of
 * `no_token` (never logged in) / `refresh_rejected` (re-login required) /
 * `refresh_failed` (transient).
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
    _inFlight ??= doRefresh(auth).finally(() => { _inFlight = null; });
    const r = await _inFlight;
    if (!r.ok) return r;
    auth = r.auth;
    refreshed = true;
  }

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
 * Force a refresh regardless of expiry — used when the backend rejects a token
 * it considers expired even though its own `exp` claim says otherwise (OpenAI
 * revokes server-side, so the JWT is not the last word).
 */
export async function forceCodexRefresh() {
  const auth = await readAuthFile();
  if (!auth?.tokens?.refresh_token) return { ok: false, reason: "no_token" };
  _inFlight ??= doRefresh(auth).finally(() => { _inFlight = null; });
  return _inFlight;
}
