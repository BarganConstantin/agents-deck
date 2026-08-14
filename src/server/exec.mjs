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

/**
 * What to hand `spawn`/`execFile` for `file` and `args` on this platform, with
 * the argument vector intact and no shell.
 *
 * The alternative every caller reaches for first — `shell: true`, because a
 * .cmd cannot be spawned any other way — is the one thing that must not be
 * used: Node joins the array into a command line with a single space and no
 * per-argument quoting, so `--workspace C:\Users\John Smith\proj` arrives as
 * two arguments and an `&` in a path ends the command early. Batch files go
 * through cmd.exe with each argument quoted; everything else is spawned as
 * given. The platform is a parameter so both branches can be tested.
 *
 * The one thing quoting cannot cover: cmd.exe expands `%VAR%` inside quotes
 * too, and a command line has no escape for it. Every other metacharacter —
 * `&`, `|`, `>`, `^`, `(` — is inert once quoted.
 */
export const spawnSpec = (file, args, platform = process.platform) =>
  isBatch(file, platform) ? viaCmd(file, args) : { file, args, opts: {} };

// Reasons to try the next candidate spelling rather than give up. EINVAL and
// UNKNOWN show up on Windows for a file that exists but cannot be executed the
// way it was asked for; both mean "not this one", not "no such tool".
export const tryNext = (err) =>
  Boolean(err) && (err.code === "ENOENT" || err.code === "EACCES" ||
                   err.code === "EINVAL" || err.code === "UNKNOWN");

/**
 * cmd.exe's way of saying ENOENT.
 *
 * A .cmd or .bat candidate is launched THROUGH cmd.exe, and cmd.exe exists — so
 * a missing tool is not a spawn error at all. It is a healthy shell exiting 1
 * after printing two lines:
 *
 *     'cswap' is not recognized as an internal or external command,
 *     operable program or batch file.
 *
 * Read as a real failure, that stops the candidate loop early AND puts the
 * second line — on its own, meaningless — in front of the user. Reported from
 * Windows on 2026-08-14: the accounts panel said only "operable program or
 * batch file." when sharing an account.
 */
export const looksMissing = (text) =>
  /is not recognized as an internal or external command/i.test(String(text ?? "")) ||
  /operable program or batch file/i.test(String(text ?? "")) ||
  /The system cannot find the (?:path|file) specified/i.test(String(text ?? ""));

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
        // cmd.exe's "is not recognized" counts as "not this spelling" too, and
        // it arrives as a normal non-zero exit rather than a spawn error.
        const missing = Boolean(err) && looksMissing(`${stderr ?? ""}\n${stdout ?? ""}`);
        if (err && (tryNext(err) || missing) && i + 1 < tries.length) return attempt(i + 1);
        if (!err) resolved.set(cmd, raw);
        resolve({
          ok: !err,
          // A tool cmd.exe could not find is missing, not "exited 1" — callers
          // key their message off this.
          code: missing ? "ENOENT" : (err?.code ?? 0),
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
 * Run a command whose stdin stays open, so the caller can answer it.
 *
 * `run` above closes stdin and waits for the end; that is right for everything
 * that only reports. It is useless for the two commands the accounts panel has
 * to drive: `claude auth login` prints a URL and then blocks reading the code
 * the user pastes back, and `cswap remove` blocks on its own `[y/N]` — there is
 * no `--yes` flag to avoid it. Both need a child that outlives one request and
 * can be written to.
 *
 * Returns immediately with a handle:
 *   write(text)  — into the child's stdin
 *   kill()       — give up; `done` still settles
 *   onLine(cb)   — every complete stdout/stderr line as it arrives
 *   done         — Promise<{ok, code, killed, timedOut, stdout, stderr}>
 *
 * Never rejects, for the same reason `run` never does. Same Windows candidate
 * resolution, since `claude` and `cswap` are `.cmd` shims there.
 */
export function runInteractive(cmd, args, { timeout = 300_000, maxOutput = 256 << 10 } = {}) {
  const tries = candidates(cmd);
  const lineSubs = [];
  let child = null;
  let pending = "";           // partial line carried between chunks
  let stdout = "", stderr = "";
  let timedOut = false, killed = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });

  // Subscribers get `(text, partial)`. A subscriber must not throw and must
  // tolerate repeats: `partial` is the still-unterminated tail, re-offered as
  // it grows, because a prompt is written WITHOUT a newline —
  // "Paste code here if prompted > " never terminates a line, so a
  // newline-only reader would wait for it forever.
  const emitLines = (text) => {
    pending += text;
    let nl;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      for (const cb of lineSubs) { try { cb(line, false); } catch { /* a subscriber must not kill the child */ } }
    }
    if (pending) {
      for (const cb of lineSubs) { try { cb(pending, true); } catch { /* ignore */ } }
    }
  };

  const finish = (code, err) => {
    if (!settle) return;
    const s = settle; settle = null;
    clearTimeout(timer);
    s({ ok: code === 0 && !err && !timedOut, code: err?.code ?? code ?? -1, killed, timedOut, stdout, stderr });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    try { child?.kill(); } catch { /* already gone */ }
  }, timeout);
  timer.unref?.();

  const attempt = (i) => {
    if (i >= tries.length) return finish(-1, { code: "ENOENT" });
    const raw = tries[i];
    const { file, args: argv, opts } = isBatch(raw) ? viaCmd(raw, args) : { file: raw, args, opts: {} };
    let proc;
    try {
      proc = spawn(file, argv, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, ...opts });
    } catch (err) {
      return tryNext(err) ? attempt(i + 1) : finish(-1, err);
    }
    child = proc;
    // A spelling that fails to spawn emits 'error' AND THEN 'close' — with code
    // -2 after an ENOENT. Once the error handler has moved on to the next
    // candidate, that trailing 'close' is news about a child nobody is waiting
    // for any more, and answering it settled `done` with ok:false while the
    // real child was still running. On Windows that is the normal path, not a
    // corner case: `claude.exe` does not exist, `claude.cmd` does, so the very
    // first login reported "the code was not accepted" while the child it had
    // abandoned went on to complete the OAuth and switch the live account.
    // Every listener below therefore speaks only while its own child is the
    // current one.
    const stale = () => proc !== child;
    proc.on("error", (err) => {
      if (stale()) return;
      // Only retry another spelling while nothing has run yet; a mid-run error
      // is this child's failure, not evidence the name was wrong.
      if (tryNext(err) && !stdout && !stderr) { child = null; return attempt(i + 1); }
      finish(-1, err);
    });
    // Spawning proves a spelling exists — except a .cmd/.bat one, which is
    // launched THROUGH cmd.exe. cmd.exe is always there, so it spawns just as
    // happily for a batch file that is not, and only says so later by exiting
    // non-zero with "is not recognized". Caching at spawn time therefore
    // remembered a spelling that never existed, and since `candidates` then
    // offers only the remembered one, the tool stayed unrunnable — with the
    // false message "not on PATH" — even after it was installed. A batch
    // spelling is confirmed by the clean exit below instead, which is the rule
    // `run` already applies with `if (!err)`.
    if (!isBatch(raw)) proc.on("spawn", () => resolved.set(cmd, raw));
    // Capped so a runaway child cannot grow the heap without bound; the tail is
    // what carries the error, so the head is what gets dropped.
    const keep = (buf, text) => (buf + text).slice(-maxOutput);
    proc.stdout?.on("data", (d) => { if (stale()) return; const t = String(d); stdout = keep(stdout, t); emitLines(t); });
    proc.stderr?.on("data", (d) => { if (stale()) return; const t = String(d); stderr = keep(stderr, t); emitLines(t); });
    proc.on("close", (code) => {
      if (stale()) return;
      // Same cmd.exe case as in `run`: exit 1 with "is not recognized" means
      // this spelling does not exist, not that the tool failed.
      if (code !== 0 && looksMissing(`${stderr}\n${stdout}`)) {
        if (i + 1 < tries.length) {
          stdout = ""; stderr = ""; pending = "";
          child = null;
          return attempt(i + 1);
        }
        return finish(-1, { code: "ENOENT" });
      }
      // Ran to a clean exit, so this spelling is real — the only confirmation a
      // batch one ever gets.
      if (code === 0 && !killed && !timedOut) resolved.set(cmd, raw);
      finish(code ?? -1, null);
    });
  };
  attempt(0);

  return {
    write(text) {
      try { child?.stdin?.write(text); } catch { /* the child is gone; `done` says so */ }
    },
    /** Close stdin. A command that reads to EOF (`cswap import -`) needs this
     *  to start work at all; a prompting one must never see it. */
    end() {
      try { child?.stdin?.end(); } catch { /* already closed */ }
    },
    kill() {
      killed = true;
      try { child?.kill(); } catch { /* already gone */ }
    },
    onLine(cb) { lineSubs.push(cb); },
    done,
  };
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
      // Same trap as above: a batch spelling is spawned through cmd.exe, which
      // succeeds whether or not the batch file is there, so only a clean exit
      // proves this one is worth remembering.
      if (isBatch(raw)) child.on("exit", (code) => { if (code === 0) resolved.set(cmd, raw); });
      else child.on("spawn", () => resolved.set(cmd, raw));
      child.unref?.();
    } catch {
      attempt(i + 1);
    }
  };
  attempt(0);
}
