#!/usr/bin/env node
// agent-dag hook forwarder. Invoked by Claude Code or Codex CLI as a command
// hook. Reads stdin (event JSON), tags it with the provider passed via
// `--provider <name>`, finds every agent-dag server whose workspace contains the
// session — via the discovery files in <claude config dir>/agent-dag/ — makes
// each one prove it is the deck its file describes, and POSTs the payload. Dead
// instances are cleaned up.
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

/**
 * Does a deck scoped to `workspace` capture a session running in `cwd`? This is
 * the whole of what `--workspace` means, and it is a question about ONE deck: it
 * asks nothing about the others that may also be up, so a deck's answer never
 * depends on who else is running.
 *
 * An empty workspace is the default — machine-wide — and captures everything.
 * It is answered before cwdInWorkspace rather than passed to it because
 * p.resolve("") is the resolving process's own cwd, which here is the agent's,
 * so an unscoped deck would be silently scoped to whatever directory the user
 * happened to run their agent in.
 *
 * A session that never said where it runs is inside no workspace, so only an
 * unscoped deck sees it. Unreachable from main(), which exits before this on a
 * payload with no cwd — it is here because the rule has to be stated the same
 * way on both sides to be pinned against the other one.
 *
 * src/server/log-writer.mjs answers this same question, for the sessions the
 * server builds itself out of Codex's rollout files, under the name
 * codexCwdInWorkspace — this script is copied out of the package and run
 * standalone, so it cannot import that copy. A test walks one table of paths
 * through both: a disagreement between them is `--workspace` meaning two
 * different things depending on which CLI produced the session.
 */
function capturesSession(cwd, workspace, platform = process.platform) {
  if (!workspace || typeof workspace !== "string") return true;
  if (!cwd || typeof cwd !== "string") return false;
  return cwdInWorkspace(cwd, workspace, platform);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

/**
 * Of the decks about to be posted this event, which ones should also write it
 * to disk? Returns the subset that should; every other target is asked to
 * display the event and keep no record of it.
 *
 * The fan-out itself is deliberate — several decks can match one session and
 * they should all draw it. Persisting is not: they all default to the same
 * <claude config dir>/agent-dag/events.jsonl, so each of them appending its own
 * copy wrote every event once per running deck. The file then grew N times as
 * fast, rotated N times as often, and every replay of it ingested each tool
 * call N times, which is what put duplicate tools and duplicate bubbles on the
 * canvas after a restart.
 *
 * Decks are therefore grouped by the log file each one names in its discovery
 * record, and one deck per group is elected. Grouping by the file rather than
 * counting decks is what keeps the overrides honest: a deck run with
 * `--history` sits alone in its own group and always writes, a deck run with
 * `--no-persist` reports no file and can never be elected to write for one that
 * does, and a deck too old to report either keeps the behaviour it had before
 * this rule existed. Within a group the lowest port wins — a fixed rule, so the
 * same deck holds the file for as long as it is up and the next one inherits it
 * as soon as that deck is gone.
 *
 * The platform is a parameter, like cwdInWorkspace's, so the case-folding half
 * is testable from any machine.
 *
 * src/server/log-writer.mjs repeats this rule for the events no hook delivers —
 * the ones the server builds itself from Codex's rollout files — because this
 * script is copied out of the package and cannot import it. A test compares the
 * two directly: they decide for the same decks, and a disagreement is a line
 * written twice or not at all.
 */
function electWriters(decks, platform = process.platform) {
  const byLog = new Map();
  for (const d of decks) {
    const log = typeof d.persist === "string" ? d.persist : "";
    // Two namespaces, so a deck with no log to share — and a deck too old to
    // report one — is alone in its group and cannot collide with a real path.
    const key = log
      ? `log:${foldsCase(platform) ? log.toLowerCase() : log}`
      : `deck:${d.pid}:${d.port}`;
    const held = byLog.get(key);
    // Ports are unique among live decks; pid only breaks a tie a stale
    // discovery file could invent, so the answer stays deterministic.
    if (!held || d.port < held.port || (d.port === held.port && d.pid < held.pid)) {
      byLog.set(key, d);
    }
  }
  return new Set(byLog.values());
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

/**
 * Must this target answer the challenge before it is handed a payload?
 *
 * Only a deck that advertises a token can be asked to prove it holds one. And
 * hook.js is a single shared file — <claude config dir>/agent-dag/hook.js,
 * installed by whichever deck booted most recently — while running several
 * decks at once is ordinary use. So a hook that knows about the handshake
 * routinely reads discovery files written by decks that predate it, which serve
 * no /api/hook-challenge route at all. Refusing those outright leaves every one
 * of them listening and permanently empty, with its banner still saying it is
 * receiving events.
 *
 * A tokenless file therefore falls back to what shipped before the handshake:
 * pid liveness and nothing else. That is not a weakening of anything — it is
 * the exact risk every release up to 1.33.70 already carried, unchanged — and
 * it costs the hardening nothing, because a file that does carry a token still
 * gets no payload until the port answers correctly. Drop this fallback, and
 * refuse tokenless files again, once no deck older than 1.33.71 is plausibly
 * still running.
 */
function requiresProof(d) {
  return typeof d.token === "string" && d.token !== "";
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
 *
 * A deck that advertised no token is posted to directly: see requiresProof.
 *
 * `persists` is this deck's answer from electWriters: true for the one deck
 * that logs the event, false for every other one it is also drawn on.
 */
function deliver(d, body, persists, done) {
  let settled = false;
  const finish = () => { if (settled) return; settled = true; done(); };

  if (!requiresProof(d)) return post(d, body, persists, finish);

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
      post(d, body, persists, finish);
    });
  });
  req.on("error", finish);
  req.on("timeout", () => req.destroy());
  req.end();
}

function post(d, body, persists, finish) {
  const req = http.request({
    hostname: "127.0.0.1",
    port: d.port,
    // Only the elected deck records the event; the rest are asked to draw it
    // and keep no copy, so one log file ends up with one copy of it.
    path: persists ? "/api/event" : "/api/event?persist=0",
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

    // Every deck whose workspace contains this cwd, and nothing else decides it.
    //
    // This used to sort the matches by how long each deck's workspace path was
    // and deliver only to the longest — so a deck scoped to /Users/x/proj TOOK
    // that tree's sessions away from a machine-wide deck, which then sat there
    // showing nothing while `--all` promised it captured every session on this
    // machine. Nothing documented that, and the server's own Codex capture never
    // did it: each deck tails the rollout files itself and evaluates its own
    // workspace, so a Codex session inside a scoped tree appeared on both decks
    // while the Claude session beside it appeared on one. One flag, one path,
    // two answers.
    //
    // The fan-out is the documented meaning and the one kept: `--workspace` says
    // which sessions a deck captures, not which sessions it takes from the decks
    // around it. It is also what electWriters below already assumes — several
    // decks drawing one event is the case it exists to keep from being written
    // to one log several times.
    const targets = [];
    for (const file of files) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")); } catch { continue; }
      if (typeof d.workspace !== "string" || !d.pid || !d.port) continue;
      // A missing token is not a reason to drop the file here — deliver()
      // decides what a target has to prove, and a deck older than the handshake
      // can prove nothing. See requiresProof.

      if (!isAlive(d.pid)) {
        try { fs.unlinkSync(path.join(DIR, file)); } catch {}
        continue;
      }

      // "" is machine-wide and must never reach normPath: resolving it would
      // produce this hook's own cwd — the agent's — and scope a deck that asked
      // for no scope at all. Any other spelling is canonicalized here, which is
      // now a second pass over a path bin/deck.js already canonicalized before
      // publishing it — kept because a deck old enough to have published a
      // relative one is still entitled to its events.
      const ws = d.workspace === "" ? "" : normPath(d.workspace);
      if (capturesSession(resolvedCwd, ws)) targets.push(d);
    }

    if (!targets.length) return process.exit(0);

    // One deck per events log records this event; the others only draw it.
    const writers = electWriters(targets);

    let pending = targets.length;
    const done = () => { if (--pending <= 0) process.exit(0); };

    for (const d of targets) deliver(d, taggedInput, writers.has(d), done);
  });
}

// The host CLI always runs this file as the process entry point — the command
// the installer writes is `"<node>" "<...>/hook.js" --provider <name>`. Under a
// require() it exports the rules it decides by — matching, election, the
// handshake — and starts nothing, which is what lets them be tested without a
// 1.5s exit timer in the test runner.
module.exports = { capturesSession, cwdInWorkspace, foldsCase, electWriters, challengeProof, requiresProof };
if (require.main === module) main();
