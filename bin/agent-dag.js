#!/usr/bin/env node
// Supervisor. Owns one thing: the worker's lifecycle.
//
// Why this exists at all: Node caches every module at import, so a deck that is
// running when an upgrade lands keeps executing the old code until the process
// is replaced. The deck can now see that (GET /api/version) — this is the half
// that can act on it.
//
// The tempting shortcut is to have the server respawn itself and exit. Every
// version of that is worse than it looks:
//   • the replacement races the dying listener, and startServer answers
//     EADDRINUSE by binding one of ten RANDOM ports in 4318–4400 — so the tab
//     you are looking at reconnects forever next to a healthy invisible server;
//   • an orphan spawned from a dying parent leaves the shell's foreground
//     process group, so Ctrl+C stops reaching it;
//   • with stdio ignored it also loses the banner, the URL line and every
//     console.error the server writes.
// A parent that stays alive avoids all three: the child is dead — and its
// listening socket released — before the next one is spawned, stdio is
// inherited so the terminal is unchanged, and Ctrl+C keeps working because the
// process group never changes.
//
// Everything else the deck does still lives in bin/deck.js. This file must stay
// boring: it is the one process that is never replaced.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npxFailureHint, npxFailureSummary, npxLaunch } from "../src/server/npx.mjs";
import {
  bareSpecName, claimRestartFailureKey, clearRestartFailure, installedVersion, npxRestartSpec,
  recordRestartFailure,
} from "../src/server/self-update.mjs";
import { dieOfSignal, workerExitAction } from "../src/server/supervisor.mjs";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER = join(BIN_DIR, "deck.js");
const PKG_ROOT = dirname(BIN_DIR);

const VERSION = installedVersion(PKG_ROOT) ?? "?";

// Who the restart-failure note below belongs to. Several decks of the same
// package run out of one home directory — two `npx ccdeck` runs even share the
// _npx directory and therefore the version — so a note named after the package
// alone was read by every one of them, and a deck that had never asked for an
// update reported someone else's failed npx as its own. Our pid is unique among
// the decks alive on the machine, and putting it in our own environment is what
// carries it to the worker: launch() spawns with a copy of it.
claimRestartFailureKey();

// The port the worker actually bound, which is not necessarily the one it was
// asked for — the first launch falls back to a random port when 4317 is taken.
// Re-launching without this is how a restart silently moves the deck out from
// under an open tab.
let boundPort = null;
let restarts = 0;
let child = null;
// Set by the signal handlers, and the first thing every exit path asks. Without
// it, Ctrl+C during an npx fetch looks exactly like a failed fetch, and a
// worker that was already exiting 75 or 76 when the signal landed reads as a
// restart request — both resurrect the deck the user just stopped.
let stopping = false;

function launch(respawn) {
  const args = [WORKER, ...process.argv.slice(2)];
  // Appended last so it wins: the worker's parser keeps the final --port.
  if (respawn && boundPort != null) args.push("--port", String(boundPort));

  child = spawn(process.execPath, args, {
    // stdio inherited so the child owns the same terminal the user started:
    // same banner, same colours, same Ctrl+C. The fourth slot adds an IPC
    // channel — the only way the worker can tell us which port it got, since
    // parsing its stdout would be guesswork.
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: {
      ...process.env,
      // Boot did the slow, once-per-session work already (hook install, the
      // claude-swap probe with its 8s timeout, the ccusage prime). Repeating it
      // is what would make a restart feel like a restart.
      AGENTS_DECK_RESPAWN: respawn ? "1" : "",
      AGENTS_DECK_RESTARTS: String(restarts),
    },
  });

  child.on("message", (m) => {
    if (m && m.type === "listening" && typeof m.port === "number") boundPort = m.port;
  });

  child.on("exit", (code, signal) => {
    child = null;
    // `stopping` outranks the exit code — see supervisor.mjs. A restart and a
    // Ctrl+C can land together, and honouring the code first is how the deck
    // came back to life after the user stopped it.
    const next = workerExitAction(code, stopping);
    if (next.relaunch === "disk") {
      restarts++;
      launch(true);
      return;
    }
    if (next.relaunch === "npx") {
      restarts++;
      launchNpx();
      return;
    }
    // Anything else is the worker's own verdict and belongs to whoever started
    // us — including the ccdeck wrapper, which exits with our code in turn. A
    // worker killed by a signal is reported by dying of the same one; doing
    // that naively re-enters the handlers below and exits 0 — see
    // supervisor.mjs.
    if (signal) dieOfSignal(signal);
    else process.exit(next.code);
  });

  child.on("error", (err) => {
    console.error(`agents-deck: could not start ${WORKER}: ${err.message}`);
    process.exit(1);
  });
}

/** Drop the two flags launchNpx sets itself. `--port` takes a value, and both
 *  spellings npm's parser accepts (`--port 4317`, `--port=4317`) have to go. */
function withoutPortAndOpen(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--no-open") continue;
    if (a === "--port") { i++; continue; } // and its value
    if (a.startsWith("--port=")) continue;
    out.push(a);
  }
  return out;
}

/**
 * Come back on a newer version, for a deck that npx started.
 *
 * There is nothing to install here: npx unpacks each spec into its own
 * content-addressed directory under _npx, so `npm i -g` would upgrade something
 * this process could never reach. `npx -y <spec>@latest` resolves fresh, gets a
 * DIFFERENT directory, and starts the deck there — on the port we hand it, so
 * the tab that asked for the update reconnects to the same URL.
 *
 * This process stays as the parent rather than exec-ing, for the same reasons
 * the file's header gives, plus one more: a fetch can fail (offline, registry
 * down), and someone has to bring the working copy back when it does.
 */
function launchNpx() {
  const spec = npxRestartSpec(PKG_ROOT);
  if (!spec) { launch(true); return; } // not an npx run after all
  // Our two are appended, so the originals are dropped rather than left to be
  // overridden — `--port 4317 --no-open --port 4317 --no-open` works, but it is
  // what the next person reads in `ps`.
  const args = ["-y", spec, ...withoutPortAndOpen(process.argv.slice(2))];
  if (boundPort != null) args.push("--port", String(boundPort));
  // The tab that asked for this is open and reconnecting; a second one would be
  // the deck talking over itself.
  args.push("--no-open");

  // A retry answers for itself: whatever the last attempt left on disk is about
  // to be replaced by this attempt's outcome, and leaving it there would keep
  // the browser showing an old failure over a running fetch.
  const pkgName = bareSpecName(spec) ?? "agents-deck";
  clearRestartFailure(pkgName);

  process.stdout.write(`\n  ↻  fetching ${spec}…\n`);
  // npxLaunch prefers npm's own npx-cli.js next to this Node binary, which
  // needs no PATH lookup and no batch shim; the PATH shim is the fallback and
  // still goes through cmd.exe with each argument quoted.
  //
  // Not `shell: true` on either path. Everything after the spec is the user's
  // own argv, and Node would paste it into one command line unquoted:
  // `--workspace C:\Users\John Smith\proj` would reach the new deck as two
  // arguments, the second one silently dropped by its parser — an upgraded deck
  // watching the wrong directory.
  const { file, args: argv, opts } = npxLaunch(args);
  // stderr is piped rather than inherited so a crash can be summarised instead
  // of dumped: npm's MODULE_NOT_FOUND stack, with its `requireStack` and its
  // caret line, is not something a user of a DAG dashboard can act on. stdout
  // stays inherited — the new deck's banner, colours and URL line are the whole
  // point of the supervisor staying out of the way.
  const started = spawn(file, argv, { stdio: ["inherit", "inherit", "pipe"], ...opts });
  child = started;

  // Held, not discarded: the moment the replacement is serving, everything it
  // wrote goes to the terminal and every later byte passes straight through.
  // Until then it is only evidence for a failure that may not happen.
  let tail = "";
  let teeing = false;
  const tee = () => {
    if (teeing) return;
    teeing = true;
    if (tail) process.stderr.write(tail);
  };
  started.stderr?.on("data", (d) => {
    const s = String(d);
    if (teeing) { process.stderr.write(s); return; }
    tail = (tail + s).slice(-8000);
  });

  // Whether the replacement ever got as far as serving. An npx that cannot
  // resolve exits in seconds having bound nothing; a deck the user stops with
  // Ctrl+C exits non-zero too, and only this tells the two apart.
  let served = false;
  const probe = setInterval(() => {
    if (boundPort == null || served) return;
    const sock = connect({ port: boundPort, host: "127.0.0.1" });
    sock.setTimeout(1000);
    sock.on("connect", () => { served = true; tee(); sock.destroy(); });
    sock.on("timeout", () => sock.destroy());
    sock.on("error", () => { /* not up yet */ });
  }, 1000);
  probe.unref?.();

  const giveUp = (why) => {
    clearInterval(probe);
    child = null;
    if (stopping || served) return; // the user stopped it, or it ran and ended
    const summary = npxFailureSummary(tail);
    const hint = npxFailureHint(tail);
    console.error(`agents-deck: ${why} — staying on v${VERSION}`);
    if (summary) console.error(`  ${summary}`);
    if (hint) console.error(`  ${hint}`);
    // Left for the worker about to be launched: it is the only way the browser
    // learns this happened at all. See recordRestartFailure.
    recordRestartFailure({
      name: pkgName,
      command: `npx -y ${spec}`,
      error: [summary ?? why, hint].filter(Boolean).join(" — "),
      version: VERSION === "?" ? null : VERSION,
    });
    restarts++;
    launch(true);
  };

  started.on("exit", (code, signal) => {
    clearInterval(probe);
    child = null;
    if (stopping || served) {
      if (signal) dieOfSignal(signal);
      else process.exit(code ?? 0);
      return;
    }
    giveUp(`npx ${spec} exited ${code ?? signal}`);
  });
  started.on("error", (err) => giveUp(`could not run npx: ${err.message}`));
}

// Ctrl+C already reaches the child directly — it shares this process group — so
// forwarding would deliver it twice. These handlers exist only to keep the
// supervisor alive long enough for the child's own graceful shutdown to run and
// for its exit code to arrive.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    // On Windows none of these are delivered to a Node process, which is fine:
    // there the console kills the whole tree and sweepStaleDiscovery cleans up
    // on the next boot.
    const second = stopping; // an impatient user pressing Ctrl+C again
    stopping = true;
    if (!child) { process.exit(0); return; }
    try { child.kill(second ? "SIGKILL" : sig); } catch { /* already gone */ }
    // The npx step is a shell that exec's the new deck, and a signal can land in
    // the gap: the shell dies, the process replacing it never saw it. One more
    // attempt a moment later catches that; it is a no-op when the first worked.
    if (!second) {
      setTimeout(() => {
        if (stopping && child) { try { child.kill("SIGTERM"); } catch { /* gone */ } }
      }, 2500).unref();
    }
  });
}

launch(false);
