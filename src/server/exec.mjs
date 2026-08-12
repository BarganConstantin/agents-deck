// Running an external command the same way on Linux, macOS and Windows.
//
// On POSIX, `spawn("cswap", …)` finds cswap on PATH. On Windows it does not:
// the thing on PATH is `cswap.exe` or a `cswap.cmd` shim, and Node only
// applies PATHEXT when it goes through a shell. So the naive call fails with
// ENOENT on Windows even though the tool is installed and on PATH — which
// looks exactly like "not installed" and is why this is worth a module.
//
// The alternative, `shell: true`, would work but concatenates arguments into a
// command line instead of passing them as a vector: an argument containing a
// quote or an ampersand stops being an argument. Resolving the extension
// ourselves keeps the argument vector intact.
import { execFile, spawn } from "node:child_process";

// Extensions Windows will execute, most specific first. `.com` is omitted —
// nothing ships one, and every extra candidate costs a failed spawn.
const WIN_EXTS = [".exe", ".cmd", ".bat", ""];

// Which spelling worked, per command name. A failed spawn is cheap but not
// free, and these run on a poll.
const resolved = new Map();

function candidates(cmd) {
  if (process.platform !== "win32") return [cmd];
  // An explicit extension is respected as given.
  if (/\.[a-z]+$/i.test(cmd)) return [cmd];
  const known = resolved.get(cmd);
  return known ? [known] : WIN_EXTS.map(ext => cmd + ext);
}

const isMissing = (err) => err && (err.code === "ENOENT" || err.code === "EACCES");

/**
 * Run a command and collect its output. Never rejects — failures come back as
 * `{ ok: false }`, because every caller here is a poll or a UI action where a
 * missing tool is an expected state rather than an exception.
 */
export function run(cmd, args, { timeout = 20_000, maxBuffer = 4 << 20 } = {}) {
  const tries = candidates(cmd);
  return new Promise((resolve) => {
    const attempt = (i) => {
      execFile(tries[i], args, { timeout, shell: false, windowsHide: true, maxBuffer },
        (err, stdout, stderr) => {
          if (err && isMissing(err) && i + 1 < tries.length) return attempt(i + 1);
          if (!err) resolved.set(cmd, tries[i]);
          resolve({
            ok: !err,
            code: err?.code ?? 0,
            killed: Boolean(err?.killed),
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        });
    };
    attempt(0);
  });
}

/**
 * Start a command and don't wait for it. Same resolution, no output captured.
 * Used where the result lands somewhere else — a file the next poll reads, or
 * a sound the user hears.
 */
export function runDetached(cmd, args) {
  const tries = candidates(cmd);
  const attempt = (i) => {
    try {
      const child = spawn(tries[i], args, { stdio: "ignore", shell: false, windowsHide: true });
      child.on("error", (err) => {
        if (isMissing(err) && i + 1 < tries.length) attempt(i + 1);
      });
      child.on("spawn", () => resolved.set(cmd, tries[i]));
      child.unref?.();
    } catch {
      if (i + 1 < tries.length) attempt(i + 1);
    }
  };
  attempt(0);
}
