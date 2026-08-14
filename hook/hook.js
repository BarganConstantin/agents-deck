#!/usr/bin/env node
// agent-dag hook forwarder. Invoked by Claude Code or Codex CLI as a command
// hook. Reads stdin (event JSON), tags it with the provider passed via
// `--provider <name>`, finds the matching agent-dag server via per-workspace
// discovery files in <claude config dir>/agent-dag/, makes that server prove it
// is the deck the file describes, and POSTs the payload. Dead instances are
// cleaned up.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const crypto = require("crypto");

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

/**
 * The answer a deck must give to be handed a session payload.
 *
 * Liveness of the recorded pid is not evidence that the thing listening on the
 * recorded port is a deck. A deck killed with SIGKILL or lost to a power cut
 * leaves its discovery file behind — nothing unlinks it — and every cleanup
 * path here and in the server probes the same pid. Once the OS hands that
 * number to some other long-lived process the file passes forever, and the
 * port it names may by then belong to anything at all (4317, the deck's own
 * default, is also the standard OTLP collector port). What was POSTed there is
 * the whole hook event: prompt text, tool inputs, tool results, cwd.
 *
 * So the port has to prove itself before it is told anything. The deck writes a
 * fresh random token into its discovery file at startup; this hook asks the
 * listener to hash that token against a nonce it has never seen, and sends the
 * payload only if the answer matches. A stranger on the port cannot answer
 * without the token, and the nonce is new every time, so an answer overheard
 * earlier is worth nothing. Note the direction: the hook never transmits the
 * token itself, only a challenge, so a wrong listener learns nothing it could
 * replay against the next event.
 *
 * Both sides must derive the proof identically — src/server/index.mjs exports
 * the same function under the same name, and the pair is pinned by a test.
 */
function challengeProof(token, nonce) {
  return crypto.createHash("sha256").update(`${token}:${nonce}`).digest("hex");
}

// Constant-time compare, purely so a hostile listener cannot walk the expected
// proof out of us one byte at a time by timing how long we take to hang up. The
// lengths are public (64 hex chars) and a mismatched one is rejected outright,
// which is what timingSafeEqual requires of its arguments anyway.
function sameProof(got, want) {
  if (typeof got !== "string") return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Two round trips now happen per target, and main()'s hard cap is 1500ms, so
// the pair has to fit inside it with room to spare. The challenge is a bodyless
// GET to a loopback port — sub-millisecond when a deck is there, and instant
// ECONNREFUSED when nothing is.
const CHALLENGE_TIMEOUT_MS = 400;
const POST_TIMEOUT_MS = 1000;

/**
 * Ask the listener to prove it is the deck that wrote `d`, and POST the payload
 * only once it has. `done` runs exactly once, whatever the outcome — a refused
 * connection, a silent port, a wrong answer and a delivered event all just mean
 * this target is finished.
 */
function deliver(d, body, done) {
  let settled = false;
  const finish = () => { if (settled) return; settled = true; done(); };

  const nonce = crypto.randomBytes(16).toString("hex");
  const want = challengeProof(d.token, nonce);

  const req = http.request({
    hostname: "127.0.0.1",
    port: d.port,
    path: `/api/hook-challenge?nonce=${nonce}`,
    method: "GET",
    timeout: CHALLENGE_TIMEOUT_MS,
  }, res => {
    if (res.statusCode !== 200) { res.resume(); return res.on("end", finish); }
    let answer = "";
    res.setEncoding("utf8");
    res.on("data", c => {
      answer += c;
      // A deck answers in ~100 bytes. Anything pouring data at us is not one,
      // and must not be allowed to grow this buffer without bound.
      if (answer.length > 4096) { req.destroy(); finish(); }
    });
    res.on("end", () => {
      // Already given up on this target — a flood we cut off above. Whatever
      // arrived before that is not an answer we are going to act on.
      if (settled) return;
      let proof;
      try { proof = JSON.parse(answer).proof; } catch { return finish(); }
      if (!sameProof(proof, want)) return finish();
      post(d, body, finish);
    });
  });
  req.on("error", finish);
  req.on("timeout", () => req.destroy());
  req.end();
}

function post(d, body, finish) {
  const req = http.request({
    hostname: "127.0.0.1",
    port: d.port,
    path: "/api/event",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeout: POST_TIMEOUT_MS,
  }, res => { res.resume(); res.on("end", finish); });
  req.on("error", finish);
  req.on("timeout", () => req.destroy());
  req.write(body);
  req.end();
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
      // No token, no payload. A file this old was written by a deck from before
      // the handshake existed; that deck rewrites its file with a token the
      // moment it restarts, so the cost of refusing is a blind deck until the
      // next start, against the cost of trusting an unauthenticated port with
      // every prompt the user types.
      if (typeof d.token !== "string" || d.token === "") continue;

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

    for (const { d } of targets) deliver(d, taggedInput, done);
  });
}

// The host CLI always runs this file as the process entry point — the command
// the installer writes is `"<node>" "<...>/hook.js" --provider <name>`. Under a
// require() it exports the matching rule and starts nothing, which is what lets
// the rule be tested without a 1.5s exit timer in the test runner.
module.exports = { cwdInWorkspace, foldsCase, challengeProof };
if (require.main === module) main();
