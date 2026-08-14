// How to run npx from a supervisor that cannot afford npx to be broken.
//
// The supervisor's upgrade path is `npx -y <spec>@latest`, and it used to
// resolve npx by bare name — `npx.cmd` on Windows — letting the OS find it on
// PATH. That trusts a batch shim to be sitting in a real npm install root,
// because the shim computes everything else from its own directory:
//
//   SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js"
//   SET "NPM_PREFIX_JS=%~dp0\node_modules\npm\bin\npm-prefix.js"
//
// Reported from a Windows machine on Node 24 where `%~dp0` was the user's home
// directory and no `node_modules\npm` existed under it — the usual cause is an
// npm global prefix pointed somewhere the shim did not follow. Clicking
// "Update & restart" printed a raw MODULE_NOT_FOUND stack trace and came back
// on the same version.
//
// Node ships npm, so npx's real entry point can be reached from
// `process.execPath` with no PATH lookup, no batch file, and no shim-relative
// arithmetic. That is what this prefers. The shim stays as the fallback for
// installs whose npm lives somewhere else entirely, and it still goes through
// spawnSpec — the cmd.exe quoting there is load-bearing and unchanged.
import { existsSync } from "node:fs";
import { spawnSpec } from "./exec.mjs";

/**
 * Where npm's own `npx-cli.js` sits relative to the running Node binary, most
 * likely first. Pure: the platform and the executable path are parameters, so
 * the Windows layout can be checked from any OS.
 *
 * Windows keeps npm beside node.exe (`C:\Program Files\nodejs\node_modules\npm`,
 * and the same shape under nvm-windows). POSIX puts it in a `lib` next to the
 * `bin` — usually the parent (`/usr/local/bin/node` →
 * `/usr/local/lib/node_modules/npm`, as for nvm, fnm and Volta), but not
 * always: Homebrew's node lives in `/usr/local/Cellar/node/<v>/bin` while its
 * npm stays at the prefix, four levels up. So the `lib` spelling is tried at
 * each of the first four ancestors rather than only at the parent. Every
 * candidate is confirmed by the exact file existing, so a wider search cannot
 * pick something that is not npm.
 *
 * The path arithmetic is done on the string rather than through `node:path`,
 * for the same reason npxRoot in self-update.mjs does: `path` here is the
 * platform running the SUITE, so a Windows layout checked from macOS would come
 * back with forward slashes and a `..` nothing resolves.
 */
export function npxCliCandidates(execPath = process.execPath, platform = process.platform) {
  if (typeof execPath !== "string" || !execPath) return [];
  const sep = platform === "win32" ? "\\" : "/";
  const dir = execPath.split(/[\\/]/);
  dir.pop(); // the binary itself
  if (!dir.length) return [];
  const beside = [...dir, "node_modules", "npm", "bin", "npx-cli.js"].join(sep);
  const above = [];
  for (let up = 1; up <= 4 && dir.length - up > 0; up++) {
    above.push([...dir.slice(0, -up), "lib", "node_modules", "npm", "bin", "npx-cli.js"].join(sep));
  }
  return platform === "win32" ? [beside, ...above] : [...above, beside];
}

/**
 * What to hand `spawn` to run `npx <args>`.
 *
 * Returns `{ file, args, opts, via }`, where `via` is "node" for the bundled
 * CLI and "shim" for the PATH lookup. `exists` is injected so the choice can be
 * tested without a matching Node install on the machine running the suite.
 */
export function npxLaunch(args, {
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  for (const cli of npxCliCandidates(execPath, platform)) {
    let found = false;
    try { found = exists(cli); } catch { found = false; }
    // Same node, same npm, spawned directly: nothing here reads PATH and
    // nothing resolves a path relative to a shim's own directory.
    if (found) return { file: execPath, args: [cli, ...args], opts: {}, via: "node", cli };
  }
  const shim = platform === "win32" ? "npx.cmd" : "npx";
  return { ...spawnSpec(shim, args, platform), via: "shim", cli: null };
}

// Lines that are structure rather than content: a Node crash prints a stack,
// the source line it threw on, a caret under it, then the error object's own
// fields and the runtime version. None of that tells a user of a DAG dashboard
// what went wrong.
const NOISE = [
  /^\s*at\s/,
  /^\s*\^+\s*$/,
  /^node:internal\//,
  /^\s*throw\s/,
  /^Node\.js v/,
  /^\s*[{}]\s*$/,
  /^\s*(code|errno|syscall|path|requireStack|stack):/,
  /^A complete log/,
];

// The line worth quoting, when there is one. npm's failures and Node's both
// lead with the sentence a person can act on; everything after it is detail.
const SIGNAL = /(Error:|error code|ERR_|No matching version|ENOENT|EACCES|EPERM|not found|permission denied)/i;

/**
 * One line summarising why an npx run failed, or null when its output said
 * nothing. Pure, and separate from the printing, because "do not dump a stack
 * trace at the user" is the rule and a rule worth a bug is worth a test.
 */
export function npxFailureSummary(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    // A warning is by definition not the reason this failed, and npm emits one
    // for every ordinary exec ("the following package will be installed") whose
    // wording would otherwise outrank the real error below it.
    .filter(l => !/^npm (WARN|warn)\b/.test(l))
    .map(l => l.replace(/^npm (ERR!|error)\s*/i, "").trimEnd())
    .filter(l => l.trim() && !NOISE.some(re => re.test(l)));
  if (!lines.length) return null;
  const pick = lines.find(l => SIGNAL.test(l)) ?? lines[lines.length - 1];
  return pick.trim().slice(0, 300);
}

/**
 * The actionable half, for the one failure shape that is a broken environment
 * rather than a broken network: npx exists, runs, and cannot find the npm it is
 * supposed to load. `npm config get prefix` is the thing to check — a prefix
 * pointing at a directory with no `node_modules/npm` under it leaves exactly
 * this trace.
 */
export function npxFailureHint(output) {
  const s = String(output ?? "");
  if (/MODULE_NOT_FOUND/.test(s) && /(npx-cli\.js|npm-cli\.js|npm-prefix\.js)/.test(s)) {
    return "the npx on PATH is a shim whose npm install is missing — check `npm config get prefix`";
  }
  return null;
}
