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
//
// Going through cmd.exe then raises a question a direct spawn never has to ask:
// under what NAME. A `.cmd` shim finds its own payload relative to `%~dp0`, so a
// bare name — which carries no directory — makes it look under the deck's
// working directory instead of its own. Every batch candidate is therefore
// launched by its full path where one can be found; see shimPath and
// candidateSpec.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Extensions Windows will execute, most specific first. `.com` is omitted —
// nothing ships one, and every extra candidate costs a failed spawn.
const WIN_EXTS = [".exe", ".cmd", ".bat", ""];

// Which spelling worked, per command name. A failed spawn is cheap but not
// free, and these run on a poll.
const resolved = new Map();

/**
 * The spellings to try for `cmd`, best first.
 *
 * Exported with the platform as a parameter for the reason everything else in
 * this file is: the Windows answer decides which candidate becomes a batch one,
 * and a batch candidate is the only kind #457 touches — so a test that wants to
 * follow a caller's bare name all the way to the command line cmd.exe receives
 * has to be able to ask for the Windows list from a machine that is not Windows.
 */
export function candidates(cmd, platform = process.platform) {
  if (platform !== "win32") return [cmd];
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
  const line = [file, ...args].map(a => shellQuoteArg(a, "win32")).join(" ");
  return {
    file: process.env.comspec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    opts: { windowsVerbatimArguments: true },
  };
}

/**
 * Quote ONE argument into a command line a shell will parse.
 *
 * Everything else in this module exists to avoid needing this: an argument
 * vector is handed to spawn untouched and nothing in it is ever read as syntax.
 * Two callers cannot take that route, and they are the reason this is exported.
 * A Claude Code hook is registered as `{type:"command", command:"<string>"}` —
 * the host CLI runs that string THROUGH A SHELL on every tool call, and the
 * format has no argv form to emit instead. So the string has to be built here,
 * correctly, once.
 *
 * The inputs are not user input in the web sense, but they are not constants
 * either: the hook path is built from $CLAUDE_CONFIG_DIR and homedir(), and the
 * node path from process.execPath. Wrapping those in double quotes — what this
 * used to do — is not escaping on POSIX at all: `$(…)`, a backtick and `\` are
 * all still live inside them, so a config dir named `/tmp/a$(id)b` became shell
 * code written into the user's settings.json and executed on every hook fire.
 * A bare `$` in a path is the same bug wearing a duller hat — `$HOME` expands to
 * nothing, the hook path silently becomes wrong, and hooks stop firing with no
 * error anywhere.
 *
 * POSIX gets single quotes, inside which NOTHING is special, with the one
 * escape that form has: close the quote, emit a backslash-quote, reopen.
 * Windows gets cmd.exe's rule — the same one viaCmd applies above, so this file
 * has one Windows quoting rule rather than two — with the same single residual
 * exec.mjs already documents: cmd.exe expands `%VAR%` inside quotes too, and a
 * command line has no escape for it. That is narrower than it sounds, since
 * `%foo%` with no variable `foo` is left alone, and it is a limit of the
 * platform rather than of this function.
 */
export function shellQuoteArg(arg, platform = process.platform) {
  const s = String(arg ?? "");
  if (platform === "win32") return `"${s.replace(/"/g, '""')}"`;
  return `'${s.split("'").join("'\\''")}'`;
}

/**
 * The absolute path of a Windows command shim, or null when nothing answers to
 * that name.
 *
 * Why a bare name is not good enough, which is the whole of #456. npm's `.cmd`
 * shims locate every file they need relative to THEMSELVES:
 *
 *     SET "NPM_PREFIX_JS=%~dp0\node_modules\npm\bin\npm-prefix.js"
 *     SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"
 *
 * `%~dp0` is the drive and path of `%0`, and `%0` is the command token cmd.exe
 * was given. Handed `cmd.exe /d /s /c ""npm.cmd" "install" …`, that token
 * carries no directory of its own, so `%~dp0` came out as the deck's WORKING
 * DIRECTORY instead of the shim's. Reported from Windows 10 with the deck
 * started from `C:\Users\vceban`:
 *
 *     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npm-prefix.js'
 *     Error: Cannot find module 'C:\Users\vceban\node_modules\npm\bin\npx-cli.js'
 *
 * — two stacks, one defect, and `C:\Users\vceban` is the cwd rather than
 * anything to do with npm: `where npx` on that machine printed
 * `C:\Program Files\nodejs\npx.cmd` and `npx ccdeck` ran perfectly from a
 * prompt. It is ours, introduced when #362 replaced `shell: true` with viaCmd:
 * the quoting was the fix and the bare name was the cost, and it broke the
 * managed install and the npx fallback in the same stroke, which is why every
 * diagnosis of one half kept half-fitting.
 *
 * Node's own directory is tried before PATH because node and npm ship together
 * and that is where the shims are — the same preference npxCliCandidates in
 * npx.mjs states for npm's CLI scripts, so the repo has one rule rather than
 * two. PATH is then walked in its own order, which is what cmd.exe would have
 * done, minus the current directory it searches first: a deck that resolves its
 * npm out of whatever folder it happens to be sitting in is the bug above
 * wearing a hat.
 *
 * The path arithmetic is spelled out rather than done through `node:path` for
 * the reason npxCliCandidates gives: `path` is the platform running the SUITE,
 * so a Windows layout checked from macOS would come back with forward slashes.
 * `execPath`, `pathEnv` and `exists` are injected for the same reason — the
 * Windows answer has to be checkable from an OS that cannot run it.
 *
 * The walk itself now lives in `pathLookup` below, because #433 needed the same
 * one for a tool that is not a shim; this is that walk with the two answers a
 * shim needs — Windows, and node's own directory first.
 */
export const shimPath = (name, deps) =>
  pathLookup(name, "win32", { besideNode: true, ...deps });

/**
 * Where `name` actually lives on PATH, as an absolute path, or null when
 * nothing on PATH answers to it.
 *
 * This is the general form of shimPath above, and it exists because #433 asked
 * for a third way to reach ccusage: the copy a user installed themselves. The
 * deck's own error text has told people to "put ccusage on PATH yourself" since
 * before there was anything that looked, so the choice was to either look or
 * stop saying it — see getRunner in ccusage.mjs for which way that went.
 *
 * Writing it as ONE walk rather than a second one is the point. A PATH search
 * on Windows is not a PATH search plus a note: `ccusage` there is `ccusage.cmd`
 * or `ccusage.exe` and never the bare name, because PATHEXT is a shell's job
 * and spawn is not a shell — which is the whole reason `candidates` exists, so
 * that is what supplies the spellings here. And a `.cmd` found this way is
 * returned as a FULL PATH, which is what keeps #456 fixed: launched by its bare
 * name through cmd.exe, a shim computes `%~dp0` from the deck's working
 * directory and goes hunting for its payload there.
 *
 * `besideNode` is the one thing a shim wants and a tool does not. npm ships
 * beside node, so looking there first is right for `npm.cmd`; for anything else
 * it would quietly overrule the order the user put their own PATH in, which is
 * the one statement of preference they actually made.
 *
 * The check is existence, not executability. That is what `run`'s candidate
 * loop effectively asks too — it spawns and moves on if the spawn fails — and
 * an executable bit is not a thing Windows has. The residue is a directory on
 * PATH that happens to be named after the tool; it would be resolved here and
 * fail on spawn, with the failure naming the path, which is a better place to
 * find out than a silent miss.
 */
export function pathLookup(name, platform = process.platform, {
  execPath = process.execPath,
  pathEnv = process.env.PATH ?? process.env.Path ?? "",
  exists = existsSync,
  besideNode = false,
} = {}) {
  // A name that already carries a directory needs no lookup, and re-rooting it
  // would be a way to run something else entirely.
  if (typeof name !== "string" || !name || /[\\/]/.test(name)) return null;
  const win = platform === "win32";
  const sep = win ? "\\" : "/";
  const dirs = [];
  if (besideNode) {
    const beside = String(execPath ?? "").split(/[\\/]/).slice(0, -1).join(sep);
    if (beside) dirs.push(beside);
  }
  // `;` on Windows, `:` everywhere else. Splitting on the wrong one is not a
  // near miss: a POSIX PATH read with `;` is one enormous directory that
  // exists nowhere, so every lookup would answer null and the feature would
  // look like it had never been written.
  for (const raw of String(pathEnv ?? "").split(win ? ";" : ":")) {
    // A PATH entry may be quoted, and may end in a separator; neither is part
    // of the directory, and both would produce a path nothing exists at.
    const dir = raw.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
    if (dir) dirs.push(dir);
  }
  // On POSIX this is `[name]`, so the inner loop runs once and the cost is one
  // stat per directory, exactly as before.
  const spellings = candidates(name, platform);
  for (const dir of dirs) {
    for (const spelling of spellings) {
      const full = `${dir}${sep}${spelling}`;
      try {
        if (exists(full)) return full;
      } catch {
        // An entry that cannot even be stat'ed — a disconnected network drive
        // is the usual one — is a miss, not a reason to stop looking.
      }
    }
  }
  return null;
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

/**
 * The same thing for ONE CANDIDATE SPELLING out of the list above — which on
 * Windows means deciding the NAME the shim is launched under before deciding
 * how, because those are not the same question.
 *
 * `spawnSpec` answers "how". This answers what #457 put in front of it. A batch
 * candidate runs THROUGH cmd.exe (see viaCmd), and a `.cmd` shim locates its own
 * payload relative to `%~dp0` — the drive and path of the command token cmd.exe
 * was handed. A bare `claude.cmd` carries no directory at all, so `%~dp0` came
 * out as the deck's WORKING DIRECTORY and the shim went hunting for its
 * JavaScript under whatever folder the deck happened to be started from. #456
 * proved exactly that for ccusage's `npm.cmd` and `npx.cmd`; it left the three
 * helpers below alone, and they carry the shims the panels depend on — the
 * `claude.cmd` behind the quota poll and the sign-in, and whatever `.cmd` a
 * Python installer left for cswap. Same defect, same machine, wider blast
 * radius.
 *
 * `?? raw` is the whole safety story and is not optional: when shimPath can see
 * no layout it answers null, and the candidate stays the bare name today's code
 * already uses, so nothing that works now can start failing. It is the same
 * `?? name` ccusage.mjs and npx.mjs spell, so the repo has one rule rather than
 * three. shimPath also refuses any name that already carries a directory, which
 * is what keeps a caller's own absolute candidate — quotaClaudeBin's
 * `%APPDATA%\npm\claude.cmd`, cswapCandidates' `~/.local/bin/cswap.exe` — from
 * being re-rooted somewhere else entirely.
 *
 * `launch` comes back beside the spec because looksMissing has to be told the
 * spelling cmd.exe was ACTUALLY GIVEN rather than the one the loop started
 * from; its own header explains what breaks otherwise, and that coupling is the
 * reason #456 stopped short of doing this.
 *
 * On POSIX `isBatch` is false, so no lookup happens, no filesystem is touched,
 * `launch` is `raw`, and the spec is the object spawnSpec always returned —
 * byte-identical, which is the point.
 */
export function candidateSpec(raw, args, platform = process.platform, deps) {
  const launch = isBatch(raw, platform) ? (shimPath(raw, deps) ?? raw) : raw;
  return { ...spawnSpec(launch, args, platform), launch };
}

/**
 * Stop a child AND everything it started.
 *
 * On POSIX the child is the tool, so a signal to it is the whole job and this
 * is exactly the `child.kill()` it replaces. On Windows a .cmd or .bat runs
 * THROUGH cmd.exe (see viaCmd), so the tool — node, for the claude and npm
 * shims — is a grandchild, and a kill is one TerminateProcess against the
 * wrapper. Windows terminates no descendants and libuv's job object lets them
 * break away, so the wrapper vanished and the work carried on: every cancelled
 * or expired `claude auth login` left a node.exe blocked forever on the stdin
 * pipe this process holds, and because that node.exe kept the inherited stdout
 * handle open, the wrapper's 'close' never arrived either — the run that was
 * reported dead never settled.
 *
 * `taskkill /T` is the descendant walk Windows does have, and `/F` is what
 * stops a console app that is not pumping its message queue. Taking it from
 * System32 rather than from PATH matters here: PATH is the user's, and this is
 * the program we hand a pid to kill. If it cannot run at all, the plain kill
 * still happens, which is no worse than before.
 *
 * A process group would be the tidier answer and is the wrong one on Windows:
 * `detached` there only means CREATE_NEW_PROCESS_GROUP, and Node cannot signal
 * a group — `process.kill(-pid)` is POSIX-only.
 */
export function killTree(child, signal) {
  const plain = () => { try { child?.kill(signal); } catch { /* already gone */ } };
  if (process.platform !== "win32" || !child?.pid) return plain();
  try {
    const root = process.env.SystemRoot || process.env.systemroot;
    const exe = root ? `${root}\\System32\\taskkill.exe` : "taskkill";
    const killer = spawn(exe, ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    killer.on("error", plain);
    killer.on("exit", (code) => { if (code !== 0) plain(); });
    killer.unref?.();
  } catch {
    plain();
  }
}

// Reasons to try the next candidate spelling rather than give up. EINVAL and
// UNKNOWN show up on Windows for a file that exists but cannot be executed the
// way it was asked for; both mean "not this one", not "no such tool".
export const tryNext = (err) =>
  Boolean(err) && (err.code === "ENOENT" || err.code === "EACCES" ||
                   err.code === "EINVAL" || err.code === "UNKNOWN");

// The three lines cmd.exe prints when it cannot find what it was asked to run,
// anchored to a whole line each. First the two-line pair for a bare name, then
// the one it uses when a directory in an explicit path does not exist.
const CMD_UNKNOWN = /^'(.+)' is not recognized as an internal or external command,?$/i;
const CMD_UNKNOWN_TAIL = /^operable program or batch file\.?$/i;
const CMD_NO_PATH = /^the system cannot find the (?:path|file) specified\.?$/i;

// cmd.exe echoes the command token exactly as it was given, so an exact match
// is what we expect; the comparison is only case- and quote-insensitive because
// Windows paths are.
const sameCommand = (quoted, name) => {
  const norm = (s) => String(s).trim().replace(/^"+|"+$/g, "").toLowerCase();
  return norm(quoted) === norm(name);
};

/**
 * cmd.exe's way of saying ENOENT — and only cmd.exe's.
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
 *
 * The fussiness is about the other direction, which is worse. "The system
 * cannot find the file specified" is Windows' generic text for ENOENT, and it
 * appears INSIDE the output of tools that ran perfectly well — cswap is a
 * Python CLI, and a FileNotFoundError traceback ends in that exact sentence.
 * Believed there, it threw the real error away, told the user the tool was not
 * on PATH when PATH was fine, and — the dangerous half — sent the candidate
 * loop on to re-run the entire command, which for `cswap remove 3` means asking
 * to delete an account a second time.
 *
 * So the output has to be cmd.exe's message and nothing else: cmd.exe prints it
 * INSTEAD of running anything, so any other line, or any prefix on the line,
 * means something ran and this is its report. And when cmd.exe names the
 * command it could not find, that name must be the candidate we asked for — a
 * tool that shells out itself can forward the message about some other command.
 *
 * `name` is the spelling cmd.exe was ACTUALLY GIVEN — which since #457 is the
 * shim's absolute path whenever shimPath found one, not the bare candidate the
 * loop started from. That distinction is the coupling #456 named as its reason
 * for stopping short, and it is a one-way trap rather than a detail: cmd.exe
 * echoes the command token back exactly as it received it, so a check against
 * the bare name stops matching the instant the token becomes a path. What that
 * costs is not a cosmetic mismatch — it is the honesty of the whole answer. A
 * shim that shimPath saw and that is gone by the time cmd.exe looks for it (a
 * stale memo, an uninstall mid-session, a network drive that dropped, a roaming
 * profile still syncing) would come back as an ordinary exit 1 whose stderr is
 * cmd.exe's two-line "is not recognized / operable program or batch file."
 * instead of the `code: "ENOENT"` every panel keys its "not installed" message
 * off. The user would be told their CLI failed, and shown half a sentence about
 * batch files, when the truthful answer is that it is not there.
 *
 * Feeding it the launch spelling keeps the comparison EXACT, which is what the
 * paragraph above is protecting: matching loosely — on the basename, say —
 * would let a tool that shells out itself have its own child's "is not
 * recognized" read as the tool's absence, re-running a command that may be
 * `cswap remove 3`. So the rule is not "compare less", it is "compare against
 * what was actually asked for".
 *
 * Callers that only have the text (failureText) omit it and get the shape rules
 * alone.
 */
export function looksMissing(text, name = "") {
  const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  for (const line of lines) {
    const named = CMD_UNKNOWN.exec(line);
    if (named) {
      if (name && !sameCommand(named[1], name)) return false;
      continue;
    }
    if (CMD_UNKNOWN_TAIL.test(line) || CMD_NO_PATH.test(line)) continue;
    return false;
  }
  return true;
}

// How much of a hung child's output the deadline keeps. The full buffers belong
// to execFile's callback, which a timed-out run never waits for, and the tail is
// where a tool puts the line that explains itself.
const TIMEOUT_TAIL = 8 << 10;

/**
 * Run a command and collect its output. Never rejects, and never throws —
 * failures come back as `{ ok: false }`, because every caller here is a poll or
 * a UI action where a missing tool is an expected state rather than an
 * exception. execFile can throw synchronously on Windows, so the call itself is
 * guarded as well as its callback.
 *
 * A run stopped by its deadline answers `{ ok: false, code: "ETIMEDOUT",
 * killed: true, timedOut: true }` — never ok, whatever the child said on its
 * way out.
 *
 * `env` replaces the child's environment wholesale, the way spawn's does; pass
 * `{...process.env, X: "1"}` to add to it. It exists because the quota probe
 * runs a whole Claude Code and has to mark the run as the deck's own, and that
 * marker is what stops every poll drawing itself onto the canvas.
 */
export function run(cmd, args, { timeout = 20_000, maxBuffer = 4 << 20, env } = {}) {
  const tries = candidates(cmd);
  return new Promise((resolve) => {
    const attempt = (i) => {
      if (i >= tries.length) {
        return resolve({ ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: "", stderr: "" });
      }
      const raw = tries[i];
      // `launch` is what cmd.exe is handed and `raw` is what the loop is
      // reasoning about; on Windows those differ for a batch candidate whose
      // shim was found (#457) and are the same everywhere else.
      const { file, args: argv, opts, launch } = candidateSpec(raw, args);

      const tree = isBatch(raw);
      let timer = null, timedOut = false;
      // A tail of what the child managed to say. The deadline below answers
      // before execFile's callback does, and the callback owns the full
      // buffers, so without this copy a timed-out run reports nothing at all —
      // and the last line a hung tool printed is usually the only clue why it
      // hung.
      let sawOut = "", sawErr = "";

      const done = (err, stdout, stderr) => {
        clearTimeout(timer);
        // The deadline already gave this attempt its verdict, and killed the
        // child to make it stop. What the corpse reports is not news, and
        // believing it is what put "cswap export exited 0" in front of the
        // user: execFile calls a signalled exit `code: null`, which `?? 0`
        // turns into a success code, and a tool that handles SIGTERM by
        // exiting 0 — the well-behaved kind — arrives here with no error at
        // all, so the run we cut short came back `ok: true` and got its
        // spelling remembered as one that works.
        if (timedOut) return;
        // cmd.exe's "is not recognized" counts as "not this spelling" too, and
        // it arrives as a normal non-zero exit rather than a spawn error. Only
        // a batch candidate goes through a shell, so only there can the output
        // be a shell's verdict rather than the tool's own words — spawned
        // directly, a missing file is a plain ENOENT and anything printed came
        // from a tool that ran.
        const missing = Boolean(err) && tree && looksMissing(`${stderr ?? ""}\n${stdout ?? ""}`, launch);
        if (err && (tryNext(err) || missing) && i + 1 < tries.length) return attempt(i + 1);
        // The CANDIDATE is what gets remembered, never the resolved path. The
        // memo is the only entry `candidates` offers afterwards, so recording an
        // absolute path would pin this process to one install location for its
        // whole life — an upgrade that moves the shim would then fail forever
        // where today it simply gets found again. Re-running the lookup per
        // attempt costs a handful of stats against a process spawn.
        if (!err) resolved.set(cmd, raw);
        resolve({
          ok: !err,
          // A tool cmd.exe could not find is missing, not "exited 1" — callers
          // key their message off this.
          code: missing ? "ENOENT" : (err?.code ?? 0),
          killed: Boolean(err?.killed),
          timedOut: false,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      };

      try {
        const cp = execFile(file, argv,
          { timeout: 0, shell: false, windowsHide: true, maxBuffer, ...(env ? { env } : {}), ...opts }, done);
        // Give the child EOF on stdin straight away, which is what this
        // function's contract has always claimed ("run closes stdin", says
        // runInteractive's header) and what execFile does not do: it leaves the
        // pipe open with nobody at the writing end, so a tool that reads stdin
        // waits for a writer that will never arrive. `claude --print /usage`
        // waits three seconds for exactly that before giving up, which is why
        // the shell command it replaced had to end in `< /dev/null`. Closing
        // the pipe is that redirection without a shell to parse it.
        try { cp.stdin?.on("error", () => {}); cp.stdin?.end(); } catch { /* no stdin to close */ }
        cp.stdout?.on("data", (d) => { sawOut = (sawOut + d).slice(-TIMEOUT_TAIL); });
        cp.stderr?.on("data", (d) => { sawErr = (sawErr + d).slice(-TIMEOUT_TAIL); });
        // The deadline states the outcome itself and only then kills, which is
        // the order startUpgrade needs for the same reason: the answer must not
        // depend on the killed child cooperating.
        //
        // execFile's own `timeout` is not used at all. It ends with one signal
        // to the process it started, which for a batch candidate is the cmd.exe
        // wrapper — the deadline was reported as enforced while the tool
        // underneath went on running — and it reports through the callback,
        // which waits for the stdio pipes. On Windows those are held by the
        // grandchild under the wrapper, so when the tree kill could not reach
        // it the callback never came and the run never settled at all: the
        // accounts panel sat on a request that had already timed out.
        timer = setTimeout(() => {
          timedOut = true;
          resolve({ ok: false, code: "ETIMEDOUT", killed: true, timedOut: true, stdout: sawOut, stderr: sawErr });
          killTree(cp);
        }, timeout);
        timer.unref?.();
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
    killTree(child);
  }, timeout);
  timer.unref?.();

  const attempt = (i) => {
    if (i >= tries.length) return finish(-1, { code: "ENOENT" });
    const raw = tries[i];
    // Same split as in `run`: `launch` is the spelling cmd.exe receives — an
    // absolute `.cmd` once shimPath can see one — and `raw` stays the candidate
    // the loop and the memo are about.
    const { file, args: argv, opts, launch } = candidateSpec(raw, args);
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
      // this spelling does not exist, not that the tool failed. Restricted to a
      // batch candidate, which is the only kind launched through a shell, and
      // to output that is cmd.exe's message alone — everything below re-runs
      // the whole command, and these commands remove accounts.
      if (code !== 0 && isBatch(raw) && looksMissing(`${stderr}\n${stdout}`, launch)) {
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
    /** Stop the run. On Windows that means the tool under the cmd.exe wrapper
     *  too — see killTree; a cancelled sign-in used to leave it running. */
    kill() {
      killed = true;
      killTree(child);
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
    // Nothing here reads output, so there is no looksMissing call to keep
    // honest — but the shim still has to be launched by its full path, or the
    // detached `cswap list` this exists for computes `%~dp0` from the deck's cwd
    // exactly like every other caller.
    const { file, args: argv, opts } = candidateSpec(raw, args);
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
