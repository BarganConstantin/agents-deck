// What bin/agent-dag.js does when the worker dies: bring it back, fetch a
// newer one, or let the whole thing stop — and, for a worker that was killed
// rather than exited, how to hand that on to whoever started the deck. Plus the
// question that now comes BEFORE any of that, since the fetch happens while the
// worker is still serving: whether this upgrade is worth attempting at all.
//
// It lives here rather than inline in the supervisor because the supervisor
// launches a real child process the moment it is imported, so the rule could
// not be checked any other way — and it is a rule with a race in it.
//
// The race: the worker exits 75 because the user clicked Restart, and Ctrl+C
// lands in the same instant. The supervisor's signal handler runs first and
// sets `stopping`, then the exit event arrives carrying 75 — and a supervisor
// that reads the code without asking whether it is still supposed to be
// running spawns a fresh deck AFTER the user stopped it. That deck prints
// `restarted → vX` over the shutdown and keeps serving until the handler's
// 2.5s retry timer happens to kill it; the 76 variant starts a whole npx
// registry fetch first. So `stopping` outranks the code, always.
//
// Ctrl+C reaches this process on every platform we support — POSIX delivers it
// to the foreground process group, and on Windows the console raises
// CTRL_C_EVENT for every process attached to it, which Node surfaces as
// 'SIGINT'. What differs is only how the child dies, which is not this
// function's business.

import { constants } from "node:os";

// Chosen because they mean nothing else here: the worker exits 0 normally and
// non-zero on failure, both of which must pass straight through.
export const RESTART_CODE = 75; // come back running the files on disk
export const UPGRADE_CODE = 76; // come back through npx, which fetches newer files

/**
 * What a dead worker means.
 *
 *   { relaunch: "disk" }  — spawn it again from the files on disk
 *   { relaunch: "npx" }   — spawn it again through npx, which fetches newer ones
 *   { relaunch: null, code } — stop, exiting with `code`
 *
 * `stopping` is a parameter rather than the supervisor's module-level flag for
 * the same reason `spawnSpec` takes a platform: it is the input that decides
 * the answer, and both answers have to be testable.
 *
 * A stop exits 0 for 75 and 76. Those two are a private protocol between the
 * worker and its supervisor — nobody outside knows they mean "come back", and
 * 75 is EX_TEMPFAIL to anything that reads sysexits, so handing either to the
 * shell would report a failure the user did not have. Every other code is the
 * worker's own verdict and passes through untouched.
 */
export function workerExitAction(code, stopping) {
  const ours = code === RESTART_CODE || code === UPGRADE_CODE;
  if (ours && !stopping) return { relaunch: code === UPGRADE_CODE ? "npx" : "disk" };
  return { relaunch: null, code: ours ? 0 : code ?? 0 };
}

/**
 * How to report a worker that did not exit at all but was killed by a signal.
 *
 *   { reraise: "SIGHUP", code: 129 } — die of the same signal; `code` is only
 *                                      the fallback if that somehow returns
 *   { reraise: null, code: 129 }     — no signal to die of, exit with the number
 *
 * A supervisor that just exits 0 here tells the shell the deck stopped cleanly
 * after somebody killed it. The status a caller expects is the shell's own
 * convention, 128 + the signal number: 129 for SIGHUP, 143 for SIGTERM. On
 * POSIX the honest way to produce it is to die of the signal rather than to
 * exit with the arithmetic — only that also sets the "killed by a signal" bit
 * every wait(2)-based caller reads, and `$?` comes out the same either way.
 *
 * Windows has no signals: a process there cannot die of one, and `process.kill`
 * against ourselves would be a TerminateProcess with an unrelated status. So
 * the number is all we can offer, and it is still better than 0 — the deck was
 * killed, and whatever started it should be able to see that.
 *
 * The signal numbers come from `os.constants.signals`, which is also the table
 * `process.kill` accepts, so a name missing from it is a name we could not
 * re-raise anyway; it becomes a plain failure exit.
 */
export function signalExitAction(signal, platform = process.platform, numbers = constants.signals) {
  const n = numbers?.[signal];
  if (typeof n !== "number") return { reraise: null, code: 1 };
  return { reraise: platform === "win32" ? null : signal, code: 128 + n };
}

/**
 * End this process the way the worker ended: killed by `signal`.
 *
 * The re-raise is the obvious half and on its own it does not work, which is
 * the reason this is a function rather than one line at the call site. The
 * supervisor traps SIGINT, SIGTERM and SIGHUP — and those are exactly the
 * signals a worker is most likely to die of, since deck.js does not handle
 * SIGHUP at all and registers the other two only after a boot that takes
 * seconds. For all three the re-raise lands back in our own handler, which
 * finds no child left and exits 0: `kill -HUP` on the deck was reported to the
 * shell as a clean, successful stop. Dropping the handler first restores the
 * default action, which is to die of the signal.
 *
 * `proc` is a parameter so the whole sequence can be driven in a test child.
 */
export function dieOfSignal(signal, proc = process) {
  const { reraise, code } = signalExitAction(signal, proc.platform);
  if (reraise) {
    proc.removeAllListeners(reraise);
    try { proc.kill(proc.pid, reraise); } catch { /* fall through to the number */ }
  }
  // Reached on Windows, and on POSIX only when the signal is ignored or
  // blocked — inherited dispositions survive spawn — so the kill above returns
  // instead of ending us.
  proc.exit(code);
}

// ── how often an upgrade that failed may be attempted again ──────────────────
//
// Reported from a terminal that had been left alone: the same version, the same
// npm error, the same teardown, four times over. Nothing anywhere remembered
// that this exact target had already failed, so every path back into the deck
// offered the identical attempt — and each one cost a real interruption.
//
// Five minutes is chosen against what actually fails. A registry blip or a
// version that has not finished propagating is gone well inside it; being
// offline, behind a proxy that blocks the registry, or on the broken npx shim
// of #184 is not, and no amount of retrying will change that. So the second
// attempt waits, and there is no third: the copyable command is already on
// screen beside the failure and is the honest escape hatch. A newer target
// resets both — that is a different question, and it deserves its own answer.
export const UPGRADE_COOLDOWN_MS = 300_000;
export const UPGRADE_MAX_ATTEMPTS = 2;

/** Whether a note on disk is a failure at all, and one about `target`.
 *
 *  Both sides of the comparison can be null — the version check is cached for
 *  an hour and can be off entirely — and two unknowns count as the same target
 *  rather than as two different ones. Guessing "different" would hand back the
 *  unbounded retry this exists to end. A note from a deck older than this rule
 *  carries no target at all, which is genuinely unknown against a target we do
 *  know, so it is not held against a fresh version. */
function noteAbout(note, target) {
  if (!note || typeof note.error !== "string" || !note.error) return false;
  return (note.target ?? null) === (target ?? null);
}

/** How many attempts the note already stands for. A note written before this
 *  rule existed has no count and is exactly one failure. */
function attemptsOf(note) {
  return Number.isInteger(note?.attempts) && note.attempts > 0 ? note.attempts : 1;
}

/** When the attempt behind the note actually failed, which is not when the note
 *  was last written: a refusal re-stamps `at` so the browser can tell it from
 *  the failure before it, and the cooldown must not be pushed out by being
 *  asked. */
function failedAtOf(note) {
  if (typeof note?.failedAt === "number") return note.failedAt;
  return typeof note?.at === "number" ? note.at : null;
}

/**
 * Whether an upgrade to `target` may be attempted, given what the last one left
 * behind.
 *
 *   { allow: true, attempt: n }                     — go ahead; this is the nth
 *   { allow: false, reason: "cooling", waitMs, attempt }
 *   { allow: false, reason: "exhausted", attempt }
 *
 * Pure, and the note is a parameter rather than a read, because this is the
 * rule that has to terminate an unattended loop and a rule worth a bug is worth
 * a test.
 */
export function upgradeAttempt({
  note, target = null, now = Date.now(),
  cooldownMs = UPGRADE_COOLDOWN_MS, maxAttempts = UPGRADE_MAX_ATTEMPTS,
} = {}) {
  if (!noteAbout(note, target)) return { allow: true, attempt: 1 };
  const attempt = attemptsOf(note);
  if (attempt >= maxAttempts) return { allow: false, reason: "exhausted", attempt, waitMs: 0 };
  const failedAt = failedAtOf(note);
  // A clock that moved backwards — a laptop waking, an NTP correction — must
  // not leave the deck cooling forever, so an unmeasurable wait counts as
  // elapsed. The attempt cap is what makes that safe: it holds however the
  // clock behaves, and it is the half that ends the loop.
  const waited = typeof failedAt === "number" && now >= failedAt ? now - failedAt : cooldownMs;
  if (waited < cooldownMs) {
    return { allow: false, reason: "cooling", attempt, waitMs: cooldownMs - waited };
  }
  return { allow: true, attempt: attempt + 1 };
}

/** The refusal as the deck should state it — this is the whole of what the
 *  banner and the terminal say, so it has to name the version, say what already
 *  happened to it, and leave the user somewhere to go. The copyable command is
 *  already on screen next to it. */
export function upgradeRefusalText({ reason, waitMs = 0, attempt = 0 } = {}, target = null) {
  const what = target ? `v${target}` : "this update";
  if (reason === "exhausted") {
    return `${what} failed to fetch ${attempt} times — not trying again from here; run the command yourself`;
  }
  const left = waitMs >= 60_000 ? `${Math.ceil(waitMs / 60_000)}m` : `${Math.max(1, Math.ceil(waitMs / 1000))}s`;
  return `${what} failed to fetch a moment ago — waiting ${left} before trying again`;
}
