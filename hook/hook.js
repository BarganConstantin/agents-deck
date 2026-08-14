#!/usr/bin/env node
// agent-dag hook forwarder. Invoked by Claude Code or Codex CLI as a command
// hook. Reads stdin (event JSON), tags it with the provider passed via
// `--provider <name>`, finds the matching agent-dag server via per-workspace
// discovery files in <claude config dir>/agent-dag/, and POSTs the payload.
// Dead instances are cleaned up.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

// Single shared discovery dir — Claude Code and Codex CLI both register here
// via the installer. Lets one running agent-dag server receive both providers.
//
// This has to name the same directory src/server/claude-dir.mjs does, because
// the installer writes the files read below. It is duplicated rather than
// imported because this script is copied out of the package and run standalone
// by the host CLI, with no path back to the module it came from.
const configOverride = (process.env.CLAUDE_CONFIG_DIR || "").trim();
const CLAUDE_DIR = configOverride
  ? path.resolve(configOverride)
  : path.join(os.homedir(), ".claude");
const DIR = path.join(CLAUDE_DIR, "agent-dag");

function parseProvider(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider" && i + 1 < argv.length) return argv[i + 1];
  }
  return "claude";
}
const PROVIDER = parseProvider(process.argv.slice(2));

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

/**
 * Does this platform's filesystem treat two spellings that differ only in case
 * as the same directory? Exported for tests: the platform is a parameter so
 * both answers can be checked from either kind of machine.
 *
 * Windows always does, and macOS does by default (APFS and HFS+ are formatted
 * case-insensitive unless the user deliberately chose otherwise). Linux does
 * not, and folding case there would be a bug of its own: /srv/Proj and
 * /srv/proj are two real directories, and a deck scoped to one must not be
 * handed the other's events.
 *
 * A case-sensitive macOS volume is therefore over-matched. That is the safe
 * direction to be wrong in — the cost is a deck that also sees a sibling tree
 * it was not scoped to, against the cost of the default configuration seeing
 * nothing at all.
 */
const foldsCase = (platform = process.platform) =>
  platform === "win32" || platform === "darwin";

/**
 * Is `cwd` the workspace directory or somewhere inside it?
 *
 * Both sides arrive already resolved, but resolved is not the same as
 * comparable. Neither path.resolve nor the JS fs.realpathSync canonicalizes
 * character case, so the drive letter and every component keep whatever case
 * the process that reported them happened to use — `c:\proj` from one shell,
 * `C:\Proj` from another, for one directory. A raw === / startsWith then says
 * "not in the workspace", the hook posts to nobody, and a scoped deck stays
 * empty with no error printed anywhere. Re-resolving through the platform's
 * own path flavour also settles separators and a trailing one, so
 * `C:/proj/` and `C:\proj` compare equal too.
 *
 * The platform is a parameter, following spawnSpec/isBatch in
 * src/server/exec.mjs, so the Windows rule is testable from a POSIX machine.
 */
function cwdInWorkspace(cwd, workspace, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = s => (foldsCase(platform) ? s.toLowerCase() : s);
  const a = fold(p.resolve(cwd));
  const b = fold(p.resolve(workspace));
  if (a === b) return true;
  // A root ("C:\", "/") already ends in the separator; appending a second one
  // would match nothing.
  return a.startsWith(b.endsWith(p.sep) ? b : b + p.sep);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

function main() {
  // Hard cap so a stuck server can never wedge the host CLI.
  setTimeout(() => process.exit(0), 1500);

  // The deck reads the Claude quota by running `claude --print /usage`, which is
  // a full Claude Code invocation and therefore fires these hooks. Reporting it
  // drew a session onto the canvas for every quota poll — no prompt, no tools,
  // a few seconds long — so the deck filled up with its own measurements. The
  // probe sets this in the environment and hooks inherit it.
  if (process.env.AGENTS_DECK_INTERNAL === "1") process.exit(0);

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", c => { input += c; });
  process.stdin.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(input); } catch { return process.exit(0); }
    const cwd = parsed && parsed.cwd;
    if (!cwd) return process.exit(0);

    // Stamp provider so the server / reducer can branch on it without
    // re-sniffing payload shape.
    if (parsed && typeof parsed === "object" && !parsed.provider) {
      parsed.provider = PROVIDER;
    }
    const taggedInput = JSON.stringify(parsed);

    const resolvedCwd = normPath(cwd);

    let files;
    try {
      files = fs.readdirSync(DIR).filter(f => f.endsWith(".json"));
    } catch { return process.exit(0); }
    if (!files.length) return process.exit(0);

    const matches = [];
    for (const file of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")); } catch { continue; }
      if (typeof d.workspace !== "string" || !d.pid || !d.port) continue;

      if (!isAlive(d.pid)) {
        try { fs.unlinkSync(path.join(DIR, file)); } catch {}
        continue;
      }

      if (d.workspace === "") {
        matches.push({ d, wsLen: 0 });
        continue;
      }
      const ws = normPath(d.workspace);
      if (cwdInWorkspace(resolvedCwd, ws)) {
        matches.push({ d, wsLen: ws.length });
      }
    }

    if (!matches.length) return process.exit(0);

    matches.sort((a, b) => b.wsLen - a.wsLen);
    const bestLen = matches[0].wsLen;
    const targets = matches.filter(m => m.wsLen === bestLen);

    let pending = targets.length;
    const done = () => { if (--pending <= 0) process.exit(0); };

    for (const { d } of targets) {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; done(); };
      const req = http.request({
        hostname: "127.0.0.1",
        port: d.port,
        path: "/api/event",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 1000,
      }, res => { res.resume(); res.on("end", finish); });
      req.on("error", finish);
      req.on("timeout", () => req.destroy());
      req.write(taggedInput);
      req.end();
    }
  });
}

// The host CLI always runs this file as the process entry point — the command
// the installer writes is `"<node>" "<...>/hook.js" --provider <name>`. Under a
// require() it exports the matching rule and starts nothing, which is what lets
// the rule be tested without a 1.5s exit timer in the test runner.
module.exports = { cwdInWorkspace, foldsCase };
if (require.main === module) main();
