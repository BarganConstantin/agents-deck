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
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { looksMissing, run, runDetached, runInteractive } from "./exec.mjs";
import { backupRoot, invalidateClaudeAccountsCache } from "./claude-accounts.mjs";
import { cswapBin } from "./cswap-install.mjs";
import { PRODUCT } from "./brand.mjs";

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

// ── serialization ────────────────────────────────────────────────────────────

let _chain = Promise.resolve();

// Whether the code running right now is itself the mutation holding the lock.
// Async context rather than a plain boolean, which could not tell that apart
// from another request that merely arrived while the lock was held — and would
// wave that one through, which is the opposite of a mutex.
const _holder = new AsyncLocalStorage();

/**
 * One store mutation at a time.
 *
 * Not defence against another process — that would need claude-swap's own file
 * lock, which `add` does not take either. This is defence against ourselves:
 * two browser tabs, or a double-click, are enough to race a slot assignment.
 *
 * Re-entrant, because a mutation that reaches for the lock from inside one
 * would otherwise wait for itself forever: the chain cannot advance past the
 * outer link until it settles, and the outer link is blocked on this call. It
 * already has exclusive access, so it simply runs.
 */
export function withStoreLock(fn) {
  if (_holder.getStore()) return Promise.resolve().then(fn);
  const held = () => _holder.run(true, fn);
  const next = _chain.then(held, held);
  // Keep the chain alive even when a link rejects, or every later mutation
  // inherits the failure.
  _chain = next.then(() => {}, () => {});
  return next;
}

// ── shared helpers ───────────────────────────────────────────────────────────

// cswapBin comes from cswap-install.mjs, which searches the places uv and pipx
// actually install to. This module used to answer the bare name "cswap"
// instead, which is fine on a Mac where ~/.local/bin is usually on PATH and
// wrong on Windows where it is usually not: every mutation here — share,
// import, remove, rename, reorder — failed with cmd.exe's "is not recognized",
// while the read-only half of the panel worked, because it was already using
// the resolver. Reported from Windows on 2026-08-14.
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
const CODE_PROMPT = /paste code here/gi;

/**
 * How many times one line of output asks for the code.
 *
 * Per LINE, not per delivery. The prompt ends without a newline, so exec.mjs
 * re-offers the same unterminated line on every chunk as it grows — and both
 * streams share that buffer, so a progress dot, a `\r` spinner frame on stderr,
 * or simply the prompt split across two writes all arrive as the ask again,
 * a few characters longer. Counting an ask whenever the text merely CHANGED, as
 * this used to, turned any of those into a phantom second prompt, and a second
 * prompt is exactly how submitLoginCode hears "that code was rejected": a
 * login the CLI was busy completing came back as `code_rejected`, with the
 * account unregistered and the live credentials left switched.
 *
 * A real re-ask writes the prompt again — on a fresh line, or after a `\r`
 * redraw of this one — so it shows up as another match, not as a longer tail.
 */
export function countCodePrompts(line) {
  return (stripTerminalEscapes(line).match(CODE_PROMPT) ?? []).length;
}

/**
 * The whole login, as one object, because the browser talks to it twice: once
 * to start and get a URL, once to hand back the code.
 *
 * `previousActive` is captured before anything happens. `cswap add` sets
 * activeAccountNumber to whatever it just added, so without this the machine
 * silently changes account underneath every running session.
 */
let _login = null;

// A start that has not published its flow yet.
//
// `_login` is only assigned once the child exists, and everything before that
// awaits — a store read, then `claude auth status`, which shells out and takes
// hundreds of milliseconds. Two requests overlapping inside that window (two
// tabs, or a double-submitted POST) therefore both read `_login` as null, both
// walked past the guards below, and both spawned `claude auth login`. Only the
// later assignment stayed reachable, so the other child — holding an open OAuth
// flow and an open stdin — was beyond cancelLogin and beyond the dialog's
// Escape, and ran on invisibly until its five-minute timeout. Concurrent starts
// share the one spawn instead, the promise guard ccusage.mjs uses to share an
// install.
let _starting = null;

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
  if (!_starting) {
    _starting = spawnLogin(email).finally(() => { _starting = null; });
  }
  const flow = await _starting;

  // The URL arrives on the child's first write, typically within a second — and
  // the child's death ends the wait just as conclusively, which is why the state
  // is polled beside it. A `claude` that cannot be run at all is gone in
  // milliseconds and the done handler below has already written down why, but
  // waiting only for a url meant this POST sat open for the whole fifteen
  // seconds afterwards: a spinner in front of a user whose answer was ready
  // almost immediately.
  await waitFor(() => flow.url || flow.state === "failed", 15_000);
  if (!flow.url) {
    flow.child.kill();
    // Same identity check as the done handler below, and for a sharper reason:
    // a second startLogin cancels this one's child (the yield path above), so
    // this url can never arrive and this wait always runs its full fifteen
    // seconds. Overwriting _login then would erase a live flow — the dialog
    // would flip to "failed" while the newer child is still waiting for a code
    // that can no longer be delivered, and with its handle gone not even
    // cancelLogin could reach it.
    //
    // A flow the child's own death already explained keeps that explanation:
    // failureText turns an unrunnable CLI into "not on PATH. Set
    // AGENTS_DECK_CLAUDE to its full path.", the only sentence in the whole flow
    // that names a fix, and publishing a guess about the missing link over it
    // destroyed it on the server.
    const died = flow === _login && flow.state === "failed" ? flow.error : null;
    if (flow === _login && !died) {
      _login = { state: "failed", error: "the claude CLI did not print a sign-in link" };
    }
    // Carried as `detail` because that is the only field that outranks the
    // reason in the dialog's say(): REASONS["no_url"] asks "is it installed?",
    // which is exactly the question the sentence above has already answered, and
    // it would win over `error`.
    return { ok: false, reason: "no_url", ...(died ? { detail: died } : {}), ...loginState() };
  }
  return { ok: true, ...loginState() };
}

/**
 * Start the child and publish it, as one indivisible step.
 *
 * Separate from startLogin so `_starting` can dedupe it: everything here runs
 * before `_login` exists, and a caller that reaches it a second time
 * concurrently would spawn a sign-in nothing can cancel.
 */
async function spawnLogin(email) {
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
  };
  const flow = _login;

  // How many asks the line currently being written has already contributed.
  // The prompt is an unterminated line, re-delivered as it grows, so the same
  // ask arrives over and over — and once more, whole, when something else
  // finally ends the line.
  let countedOnLine = 0;

  child.onLine((line, partial) => {
    if (!flow.url) {
      const url = extractLoginUrl(line);
      if (url) { flow.url = url; flow.state = "awaiting_code"; }
    }
    const asks = countCodePrompts(line);
    if (asks > countedOnLine) {
      flow.prompts += asks - countedOnLine;
      countedOnLine = asks;
    }
    // A newline ended that line; whatever comes next is a new one.
    if (!partial) countedOnLine = 0;
  });
  // The child dying before the code was accepted is a failure of the login, not
  // of the deck; say so rather than leaving the dialog spinning.
  child.done.then((r) => {
    if (flow !== _login) return;
    if (flow.state === "awaiting_url" || flow.state === "awaiting_code") {
      flow.state = "failed";
      flow.error = r.timedOut ? "the sign-in window expired" : failureText(r, "claude auth login") || "sign-in ended without a code";
    }
  });
  return flow;
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
    flow.error = r.timedOut ? "the sign-in window expired" : failureText(r, "claude auth login") || "the code was not accepted";
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
  // Stopping the child touches no file, so it happens straight away: a cancel
  // that waited its turn first would leave `claude auth login` sitting on the
  // user's next attempt for the rest of its five minutes.
  try { flow.child?.kill(); } catch { /* already gone */ }
  // Switching back does touch the store, so it is queued like every other
  // mutation. Cancel is reachable while submitLoginCode holds the lock — the
  // dialog fires it on Escape, mid-registration — and running `cswap switch`
  // beside an in-flight `cswap add` is precisely the unlocked read-modify-write
  // of sequence.json the mutex exists to prevent: claude-swap takes no file lock
  // around `add`, so whichever write lands second drops the other's record.
  return withStoreLock(async () => {
    // The login may have completed before the cancel arrived, in which case the
    // live credentials already moved and putting them back is the point.
    await restoreActive(flow.previousActive);
    invalidateClaudeAccountsCache();
    // A newer sign-in can have started while this waited its turn; clearing the
    // slot then would drop a live flow's handle instead of this dead one's.
    if (flow === _login) _login = null;
    return { ok: true, ...loginState() };
  });
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
    return { ok: false, reason: "export_failed", detail: failureText(r, "cswap export") };
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
    // cswap reads stdin to EOF, so the pipe has to close for it to proceed.
    //
    // This used to write a raw EOT byte and then call `endStdin(child)` — a
    // helper that was never written. EOT only means end-of-file on a TTY, so
    // the byte did nothing to a pipe, and the call threw ReferenceError before
    // cswap ever saw the payload: the route answered 500 and the dialog fell
    // back to "the import failed", which is exactly what a genuinely refused
    // import says. Reported 2026-08-14.
    child.end();

    const r = await child.done;
    if (!r.ok) return { ok: false, reason: "import_failed", detail: failureText(r, "cswap import") };

    const after = await readStore();
    const slot = newSlot(before, after);
    invalidateClaudeAccountsCache();
    if (slot != null) runDetached(await cswapBin(), ["list"]);
    // Who arrived, so the dialog can name them instead of saying "an account".
    const email = slot != null ? (after.emails[slot] || null) : null;
    // No new slot is not an error: without --force, cswap skips an account it
    // already holds. Saying which happened is the difference between "it
    // worked" and "why is nothing different".
    return { ok: true, added: slot != null, num: slot, email, output: firstUseful(r.stdout) };
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
    if (!r.ok) return { ok: false, reason: "remove_failed", detail: failureText(r, "cswap remove") };
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
      : { ok: false, reason: "alias_failed", detail: failureText(r, "cswap alias") };
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
      : { ok: false, reason: "move_failed", detail: failureText(r, "cswap move") };
  });
}

// ── text ─────────────────────────────────────────────────────────────────────

/**
 * What went wrong, in a sentence the user can act on.
 *
 * The missing-tool case is singled out because its own output is useless: on
 * Windows it is cmd.exe's two-line "is not recognized …/operable program or
 * batch file.", and `firstUseful` — which takes the LAST line, correctly for
 * every other CLI — leaves the second half on screen by itself.
 */
export function failureText(r, what = "cswap") {
  const out = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`;
  const tool = String(what).split(" ")[0];
  if (r?.code === "ENOENT" || looksMissing(out)) {
    return tool === "claude"
      ? "the claude CLI could not be run: not on PATH. Set AGENTS_DECK_CLAUDE to its full path."
      : "cswap could not be run: not on PATH, and not in the places uv and pipx install to. Set AGENTS_DECK_CSWAP to its full path.";
  }
  // A run its deadline stopped has no exit status worth quoting and no last
  // line worth quoting either — whatever it had printed, it had not finished.
  // Asked for one anyway, this said "cswap export exited 0", a success code for
  // a command that never completed.
  if (r?.timedOut || r?.code === "ETIMEDOUT") return `${what} took too long and was stopped`;
  return firstUseful(out) || `${what} exited ${r?.code}`;
}

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
    return `${text} — start ${PRODUCT} from a Terminal window rather than a background service.`;
  }
  return failureText(r, "cswap add");
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
