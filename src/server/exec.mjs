// Running an external command the same way on Linux, macOS and Windows.
//
// On POSIX, `spawn("cswap", …)` finds cswap on PATH. On Windows it does not:
// the thing on PATH is `cswap.exe` or a `cswap.cmd` shim, and Node only
// applies PATHEXT when it goes through a shell. So the naive call fails with
// ENOENT on Windows even though the tool is installed and on PATH — which
// looks exactly like "not installed" and is why this is worth a module.
//
// Resolving the extension ourselves keeps the argument vector intact, which
// blanket `shell: true` would not: it concatenates arguments into a command
// line, so an argument containing a quote or an ampersand stops being an
// argument.
//
// The exception is .cmd and .bat, which since Node 20.12 CANNOT be spawned
// without a shell at all — the fix for CVE-2024-27980 makes that throw EINVAL,
// synchronously, from inside execFile. Those are routed through cmd.exe the
// same way Node's own `shell: true` does it, with the arguments quoted here
// rather than pasted together. Getting this wrong is not a degraded feature:
// the throw escaped the retry path and took the whole process down on Windows
// before the server ever started.
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

/** Exported for tests: the platform is a parameter so both can be checked. */
export const isBatch = (file, platform = process.platform) =>
  platform === "win32" && /\.(cmd|bat)$/i.test(file);

/**
 * Rewrite a batch-file invocation as a cmd.exe one.
 *
 * Mirrors what Node does internally for `shell: true` on Windows — comspec,
 * /d /s /c, the whole command line as a single quoted argument, and
 * windowsVerbatimArguments so Node does not quote it a second time. Each
 * argument is quoted here, with embedded quotes doubled, which is the escape
 * cmd.exe understands inside a quoted string.
 */
export function viaCmd(file, args) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const line = [file, ...args].map(q).join(" ");
  return {
    file: process.env.comspec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    opts: { windowsVerbatimArguments: true },
  };
}

// Reasons to try the next candidate spelling rather than give up. EINVAL and
// UNKNOWN show up on Windows for a file that exists but cannot be executed the
// way it was asked for; both mean "not this one", not "no such tool".
export const tryNext = (err) =>
  Boolean(err) && (err.code === "ENOENT" || err.code === "EACCES" ||
                   err.code === "EINVAL" || err.code === "UNKNOWN");

/**
 * Run a command and collect its output. Never rejects, and never throws —
 * failures come back as `{ ok: false }`, because every caller here is a poll or
 * a UI action where a missing tool is an expected state rather than an
 * exception. execFile can throw synchronously on Windows, so the call itself is
 * guarded as well as its callback.
 */
export function run(cmd, args, { timeout = 20_000, maxBuffer = 4 << 20 } = {}) {
  const tries = candidates(cmd);
  return new Promise((resolve) => {
    const attempt = (i) => {
      if (i >= tries.length) {
        return resolve({ ok: false, code: "ENOENT", killed: false, stdout: "", stderr: "" });
      }
      const raw = tries[i];
      const { file, args: argv, opts } = isBatch(raw)
        ? viaCmd(raw, args)
        : { file: raw, args, opts: {} };

      const done = (err, stdout, stderr) => {
        if (err && tryNext(err) && i + 1 < tries.length) return attempt(i + 1);
        if (!err) resolved.set(cmd, raw);
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          killed: Boolean(err?.killed),
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      };

      try {
        execFile(file, argv, { timeout, shell: false, windowsHide: true, maxBuffer, ...opts }, done);
      } catch (err) {
        // Synchronous throw — the EINVAL case. Same handling as a callback
        // error; letting it propagate here is what crashed the server, because
        // this runs inside the previous attempt's error handler.
        done(err, "", "");
      }
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
    if (i >= tries.length) return;
    const raw = tries[i];
    const { file, args: argv, opts } = isBatch(raw)
      ? viaCmd(raw, args)
      : { file: raw, args, opts: {} };
    try {
      const child = spawn(file, argv, { stdio: "ignore", shell: false, windowsHide: true, ...opts });
      child.on("error", (err) => { if (tryNext(err)) attempt(i + 1); });
      child.on("spawn", () => resolved.set(cmd, raw));
      child.unref?.();
    } catch {
      attempt(i + 1);
    }
  };
  attempt(0);
}
