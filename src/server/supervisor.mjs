// The one decision bin/agent-dag.js makes when the worker dies: bring it back,
// fetch a newer one, or let the whole thing stop.
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
