// Everything the accounts panel does that CHANGES the claude-swap store.
//
// Reading it lives in claude-accounts.mjs. This is the other half: signing a
// new account in, sharing one to another machine, and the small edits —
// rename, reorder, remove.
//
// Two constraints from claude-swap's own source shape all of it.
//
// `cswap add` does not sign anyone in. It captures whatever is already live —
// identity from ~/.claude.json, credentials from the macOS Keychain item
// "Claude Code-credentials". So a browser login has to land in Claude Code's
// own store first, which is exactly what `claude auth login` does, and the
// panel's job is to drive that conversation rather than to invent one.
//
// And `cswap add` takes no lock while assigning the next slot as max+1. Two
// concurrent adds pick the same number and the second write silently drops the
// first account's record. Nothing upstream prevents it, so every mutation here
// goes through one mutex.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, runDetached, runInteractive } from "./exec.mjs";
import { invalidateClaudeAccountsCache } from "./claude-accounts.mjs";

// An OAuth code is short-lived at the source; there is no point holding a child
// open longer than a user would plausibly take to fetch one.
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CSWAP_TIMEOUT_MS = 60_000;
// How long to wait for the CLI's verdict on a pasted code before saying so.
// Exchanging a code is one HTTPS round trip; a minute is generous.
const CODE_VERDICT_MS = 60_000;
// How long a shared account stays importable. Long enough to walk to the other
// machine, short enough that a copy left in clipboard history goes stale.
export const SHARE_TTL_MS = 10 * 60_000;
const SHARE_PREFIX = "ccdeck1:";

function backupRoot() {
  if (process.env.CLAUDE_SWAP_BACKUP) return process.env.CLAUDE_SWAP_BACKUP;
  if (process.platform === "linux") {
    return process.env.XDG_DATA_HOME
      ? join(process.env.XDG_DATA_HOME, "claude-swap")
      : join(homedir(), ".local", "share", "claude-swap");
  }
  return join(homedir(), ".claude-swap-backup");
}

// ── serialization ────────────────────────────────────────────────────────────

let _chain = Promise.resolve();

/**
 * One store mutation at a time.
 *
 * Not defence against another process — that would need claude-swap's own file
 * lock, which `add` does not take either. This is defence against ourselves:
 * two browser tabs, or a double-click, are enough to race a slot assignment.
 */
export function withStoreLock(fn) {
  const next = _chain.then(fn, fn);
  // Keep the chain alive even when a link rejects, or every later mutation
  // inherits the failure.
  _chain = next.then(() => {}, () => {});
  return next;
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function cswapBin() {
  return process.env.AGENTS_DECK_CSWAP ?? "cswap";
}
async function claudeBin() {
  return process.env.AGENTS_DECK_CLAUDE ?? "claude";
}

/** Slot → email for everything currently in the store, plus the active slot. */
export async function readStore() {
  try {
    const seq = JSON.parse(await readFile(join(backupRoot(), "sequence.json"), "utf8"));
    const accounts = seq?.accounts ?? {};
    return {
      slots: Object.keys(accounts),
      emails: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v?.email ?? ""])),
      activeNum: seq?.activeAccountNumber ?? null,
    };
  } catch {
    return { slots: [], emails: {}, activeNum: null };
  }
}

/**
 * Which slot appeared between two store reads.
 *
 * `cswap add --json` is rejected by argparse (exit 2), so its human output is
 * the only thing it offers and parsing that would break on any wording change.
 * The store is the fact. `null` means nothing new — which is not a failure: an
 * account already present is refreshed in place, on its existing slot.
 */
export function newSlot(before, after) {
  const had = new Set(before.slots);
  const fresh = after.slots.filter(s => !had.has(s));
  return fresh.length === 1 ? fresh[0] : null;
}

/** Anthropic's own view of who is signed in. Null when it cannot be read. */
export async function currentIdentity() {
  const r = await run(await claudeBin(), ["auth", "status", "--json"], { timeout: 20_000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout);
    return j?.loggedIn ? { email: j.email ?? "", orgId: j.orgId ?? "" } : null;
  } catch {
    return null;
  }
}

// ── login ────────────────────────────────────────────────────────────────────

// `claude auth login` prints the link as an OSC-8 hyperlink: ESC ] 8 ; ; <url>
// BEL, then the visible text — which is the same url again — then an empty
// closer. Verified byte for byte against real output: two `\x1b]8;;`, both
// terminated by BEL, never the ESC-backslash form.
//
// So the url appears TWICE, back to back, and a naive /https:\/\/\S+/ captures
// them joined into one unusable string. Stripping the escape sequences takes
// the link target away with them and leaves the visible copy, once.
const OSC8 = /\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripTerminalEscapes(text) {
  return String(text ?? "").replace(OSC8, "").replace(ANSI, "");
}

/** The sign-in URL out of `claude auth login`'s output, or null. */
export function extractLoginUrl(text) {
  const clean = stripTerminalEscapes(text);
  const m = clean.match(/https:\/\/[^\s'"]*\/oauth\/authorize\?[^\s'"]+/);
  return m ? m[0] : null;
}

// The prompt the CLI blocks on. Matched rather than assumed: writing a code
// into a child that is not asking for one would send it somewhere unknown.
const CODE_PROMPT = /paste code here/i;

/**
 * The whole login, as one object, because the browser talks to it twice: once
 * to start and get a URL, once to hand back the code.
 *
 * `previousActive` is captured before anything happens. `cswap add` sets
 * activeAccountNumber to whatever it just added, so without this the machine
 * silently changes account underneath every running session.
 */
let _login = null;

export function loginState() {
  if (!_login) return { state: "idle" };
  const { state, url, error, account, expiresAt } = _login;
  return { state, url: url ?? null, error: error ?? null, account: account ?? null, expiresAt: expiresAt ?? null };
}

export async function startLogin({ email } = {}) {
  // Registering is the half that writes to the store; interrupting it would
  // leave an account half-recorded, so that one is refused. A flow merely
  // waiting for a code is not precious — it is most often the one abandoned by
  // the page reload that just happened — and it yields to the new request
  // rather than blocking it for the rest of its five minutes.
  if (_login?.state === "registering") {
    return { ok: false, reason: "already_running", ...loginState() };
  }
  if (_login?.state === "awaiting_url" || _login?.state === "awaiting_code") {
    await cancelLogin();
  }
  const before = await readStore();
  const identity = await currentIdentity();

  const args = ["auth", "login"];
  if (typeof email === "string" && email.includes("@")) args.push("--email", email);

  const child = runInteractive(await claudeBin(), args, { timeout: LOGIN_TIMEOUT_MS });
  // A sign-in outlives the request that started it, so it can also outlive the
  // deck. Nothing else would ever reap it: it is waiting on a stdin that no
  // longer has a writer, and it holds the user's next attempt hostage for five
  // minutes. Killed on the way out, and unregistered as soon as it settles so
  // the handler list cannot grow.
  const onExit = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on("exit", onExit);
  child.done.then(() => process.off("exit", onExit), () => process.off("exit", onExit));

  _login = {
    state: "awaiting_url",
    child,
    previousActive: before.activeNum,
    previousEmail: identity?.email ?? null,
    before,
    url: null,
    error: null,
    account: null,
    expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
    // How many times the CLI has asked for a code. A second ask after we
    // answered is how a rejected code announces itself — the process does not
    // exit, it just asks again, so waiting for exit would hang for the whole
    // five-minute window on a typo.
    prompts: 0,
    lastPromptText: "",
  };
  const flow = _login;

  child.onLine((line) => {
    if (!flow.url) {
      const url = extractLoginUrl(line);
      if (url) { flow.url = url; flow.state = "awaiting_code"; }
    }
    // The prompt is an unterminated line, re-delivered as it grows, so the
    // same ask must not count twice.
    const clean = stripTerminalEscapes(line);
    if (CODE_PROMPT.test(clean)) {
      if (clean !== flow.lastPromptText) { flow.prompts += 1; flow.lastPromptText = clean; }
    } else if (clean.trim()) {
      flow.lastPromptText = "";
    }
  });
  // The child dying before the code was accepted is a failure of the login, not
  // of the deck; say so rather than leaving the dialog spinning.
  child.done.then((r) => {
    if (flow !== _login) return;
    if (flow.state === "awaiting_url" || flow.state === "awaiting_code") {
      flow.state = "failed";
      flow.error = r.timedOut ? "the sign-in window expired" : firstUseful(r.stderr || r.stdout) || "sign-in ended without a code";
    }
  });

  // The URL arrives on the child's first write, typically within a second.
  const url = await waitFor(() => flow.url, 15_000);
  if (!url) {
    child.kill();
    _login = { state: "failed", error: "the claude CLI did not print a sign-in link" };
    return { ok: false, reason: "no_url", ...loginState() };
  }
  return { ok: true, ...loginState() };
}

/**
 * Hand the code back, then register whatever it signed us in as.
 *
 * Every step after the code is verification, not optimism: the CLI can exit 0
 * having changed nothing, so the identity is re-read and compared before the
 * store is touched at all.
 */
export async function submitLoginCode(code) {
  const flow = _login;
  if (!flow || flow.state !== "awaiting_code") return { ok: false, reason: "not_waiting", ...loginState() };
  if (typeof code !== "string" || !code.trim()) return { ok: false, reason: "empty_code", ...loginState() };
  if (flow.prompts === 0) return { ok: false, reason: "not_prompted", ...loginState() };

  const askedBefore = flow.prompts;
  flow.state = "registering";
  flow.child.write(code.trim() + "\n");

  // Whichever comes first: the CLI finishing, or it asking again. A wrong code
  // produces the second, and the flow stays usable so the user can retype
  // rather than starting the whole sign-in over.
  const r = await Promise.race([
    flow.child.done,
    waitFor(() => flow.prompts > askedBefore, CODE_VERDICT_MS, 200).then(again => (again ? "rejected" : "slow")),
  ]);
  if (r === "rejected") {
    flow.state = "awaiting_code";
    flow.error = "that code was not accepted — copy it again from the browser";
    return { ok: false, reason: "code_rejected", ...loginState() };
  }
  if (r === "slow") {
    flow.state = "awaiting_code";
    flow.error = "the claude CLI has not answered — try the code again";
    return { ok: false, reason: "no_verdict", ...loginState() };
  }
  if (!r.ok) {
    flow.state = "failed";
    flow.error = r.timedOut ? "the sign-in window expired" : firstUseful(r.stderr || r.stdout) || "the code was not accepted";
    return { ok: false, reason: "login_failed", ...loginState() };
  }

  const identity = await currentIdentity();
  if (!identity) {
    flow.state = "failed";
    flow.error = "signed in, but the claude CLI still reports nobody logged in";
    return { ok: false, reason: "no_identity", ...loginState() };
  }

  return withStoreLock(async () => {
    const add = await run(await cswapBin(), ["add"], { timeout: CSWAP_TIMEOUT_MS });
    if (!add.ok) {
      flow.state = "failed";
      flow.error = addFailureText(add);
      await restoreActive(flow.previousActive);
      return { ok: false, reason: "add_failed", ...loginState() };
    }

    const after = await readStore();
    const slot = newSlot(flow.before, after);
    // No new slot means the account was already managed and cswap refreshed its
    // credentials in place. That is a success with a different sentence.
    const num = slot ?? Object.keys(after.emails).find(k => after.emails[k] === identity.email) ?? null;

    await restoreActive(flow.previousActive);
    invalidateClaudeAccountsCache();
    // Collect straight away, so the new row shows numbers instead of "never
    // collected" until the next poll — the same nudge seedFirstAccount uses.
    runDetached(await cswapBin(), ["list"]);

    flow.state = "done";
    flow.account = { num, email: identity.email, added: slot != null };
    return { ok: true, ...loginState() };
  });
}

export async function cancelLogin() {
  const flow = _login;
  if (!flow) return { ok: true, ...loginState() };
  try { flow.child?.kill(); } catch { /* already gone */ }
  // The login may have completed before the cancel arrived, in which case the
  // live credentials already moved and putting them back is the point.
  await restoreActive(flow.previousActive);
  invalidateClaudeAccountsCache();
  _login = null;
  return { ok: true, ...loginState() };
}

/** Put the account that was active before the login back in front. */
async function restoreActive(num) {
  if (num == null) return;
  const after = await readStore();
  if (String(after.activeNum) === String(num)) return;
  await run(await cswapBin(), ["switch", String(num)], { timeout: 30_000 }).catch(() => {});
}

// ── share / import ───────────────────────────────────────────────────────────

/**
 * One account, packaged for another deck.
 *
 * claude-swap's envelope carries the account's OAuth token in the clear — its
 * own module header says so ("No encryption is built in"). The wrapper adds an
 * expiry so a copy left behind in clipboard history stops working, and nothing
 * more: it is not encryption and is not presented as any.
 *
 * The default export shape is used deliberately, never --full, which would
 * embed the entire ~/.claude.json including every project and MCP server.
 */
export function wrapShare(payload, now = Date.now(), ttlMs = SHARE_TTL_MS) {
  const body = JSON.stringify({ v: 1, exp: now + ttlMs, payload });
  return SHARE_PREFIX + Buffer.from(body, "utf8").toString("base64");
}

/** The inverse. Returns `{ok:true, payload}` or `{ok:false, reason}`. */
export function unwrapShare(blob, now = Date.now()) {
  const text = String(blob ?? "").trim();
  if (!text.startsWith(SHARE_PREFIX)) return { ok: false, reason: "not_a_share" };
  let env;
  try {
    env = JSON.parse(Buffer.from(text.slice(SHARE_PREFIX.length), "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (env?.v !== 1) return { ok: false, reason: "wrong_version" };
  // Checked before the payload is looked at, let alone handed to cswap.
  if (typeof env.exp !== "number" || env.exp < now) return { ok: false, reason: "expired" };
  if (typeof env.payload !== "string" || !env.payload) return { ok: false, reason: "corrupt" };
  return { ok: true, payload: env.payload };
}

export async function shareAccount(num) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };
  const r = await run(await cswapBin(), ["export", "-", "--account", String(n)], { timeout: CSWAP_TIMEOUT_MS });
  if (!r.ok || !r.stdout.trim()) {
    return { ok: false, reason: "export_failed", detail: firstUseful(r.stderr || r.stdout) };
  }
  return { ok: true, blob: wrapShare(r.stdout), expiresAt: Date.now() + SHARE_TTL_MS };
}

export async function importAccount(blob) {
  const un = unwrapShare(blob);
  if (!un.ok) return { ok: false, reason: un.reason };

  return withStoreLock(async () => {
    const before = await readStore();
    const child = runInteractive(await cswapBin(), ["import", "-"], { timeout: CSWAP_TIMEOUT_MS });
    child.write(un.payload);
    try { child.write(""); } catch { /* best effort */ }
    // cswap reads stdin to EOF, so the pipe has to close for it to proceed.
    endStdin(child);

    const r = await child.done;
    if (!r.ok) return { ok: false, reason: "import_failed", detail: firstUseful(r.stderr || r.stdout) };

    const after = await readStore();
    const slot = newSlot(before, after);
    invalidateClaudeAccountsCache();
    if (slot != null) runDetached(await cswapBin(), ["list"]);
    // No new slot is not an error: without --force, cswap skips an account it
    // already holds. Saying which happened is the difference between "it
    // worked" and "why is nothing different".
    return { ok: true, added: slot != null, num: slot, output: firstUseful(r.stdout) };
  });
}

// ── the small edits ──────────────────────────────────────────────────────────

// The exact question `cswap remove` asks. There is no --yes flag: assume_yes is
// a Python parameter its TUI passes in-process, so the only way through from a
// CLI is to answer. Matched, never assumed — an unrecognised prompt gets the
// child killed instead of a blind "y".
const REMOVE_PROMPT = /are you sure you want to permanently remove account-(\d+)/i;

export function removePromptMatches(line, num) {
  const m = REMOVE_PROMPT.exec(stripTerminalEscapes(line));
  return Boolean(m) && m[1] === String(num);
}

export async function removeAccount(num) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };

  return withStoreLock(async () => {
    const child = runInteractive(await cswapBin(), ["remove", String(n)], { timeout: CSWAP_TIMEOUT_MS });
    let answered = false;
    child.onLine((line) => {
      if (answered) return;
      if (removePromptMatches(line, n)) { answered = true; child.write("y\n"); }
    });
    const r = await child.done;
    invalidateClaudeAccountsCache();
    if (!r.ok) return { ok: false, reason: "remove_failed", detail: firstUseful(r.stderr || r.stdout) };
    // Exit 0 without the prompt means cswap declined for its own reason — a
    // live session on that account, most often — and printed why.
    if (!answered) return { ok: false, reason: "not_confirmed", detail: firstUseful(r.stdout || r.stderr) };
    return { ok: true, output: firstUseful(r.stdout) };
  });
}

export async function setAlias(num, alias) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };
  const clean = typeof alias === "string" ? alias.trim() : "";
  const args = clean ? ["alias", String(n), clean] : ["alias", String(n), "--unset"];
  return withStoreLock(async () => {
    const r = await run(await cswapBin(), args, { timeout: CSWAP_TIMEOUT_MS });
    invalidateClaudeAccountsCache();
    return r.ok
      ? { ok: true, output: firstUseful(r.stdout) }
      : { ok: false, reason: "alias_failed", detail: firstUseful(r.stderr || r.stdout) };
  });
}

export async function moveAccount(num, slot) {
  const n = Number(num), s = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };
  if (!Number.isInteger(s) || s < 1 || s > 999) return { ok: false, reason: "bad_slot" };
  return withStoreLock(async () => {
    const r = await run(await cswapBin(), ["move", String(n), String(s)], { timeout: CSWAP_TIMEOUT_MS });
    invalidateClaudeAccountsCache();
    return r.ok
      ? { ok: true, output: firstUseful(r.stdout) }
      : { ok: false, reason: "move_failed", detail: firstUseful(r.stderr || r.stdout) };
  });
}

// ── text ─────────────────────────────────────────────────────────────────────

/** The line worth showing a user out of a CLI's output. */
export function firstUseful(text) {
  const lines = stripTerminalEscapes(text)
    .split(/\r?\n/)
    .map(l => l.replace(/^Error:\s*/i, "").trim())
    .filter(l => l && !/^-+$/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

/**
 * `cswap add`'s failure, in the words most likely to be actionable.
 *
 * The Keychain case is singled out because it is the one a server hits and a
 * terminal does not: a process without a GUI session cannot read the login
 * keychain, so the credential read times out and the message alone
 * ("unreadable right now") does not say what to do.
 */
export function addFailureText(r) {
  const text = firstUseful(r.stderr || r.stdout);
  if (/keychain/i.test(text)) {
    return `${text} — start agents-deck from a Terminal window rather than a background service.`;
  }
  return text || `cswap add exited ${r.code}`;
}

async function waitFor(get, timeoutMs, stepMs = 100) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() >= until) return null;
    await new Promise(r => setTimeout(r, stepMs));
  }
}
