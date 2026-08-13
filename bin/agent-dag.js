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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Chosen because it means nothing else here: the worker exits 0 normally and
// non-zero on failure, both of which must pass straight through.
const RESTART_CODE = 75;
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "deck.js");

// The port the worker actually bound, which is not necessarily the one it was
// asked for — the first launch falls back to a random port when 4317 is taken.
// Re-launching without this is how a restart silently moves the deck out from
// under an open tab.
let boundPort = null;
let restarts = 0;
let child = null;

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
    if (code === RESTART_CODE) {
      restarts++;
      launch(true);
      return;
    }
    // Anything else is the worker's own verdict and belongs to whoever started
    // us — including the ccdeck wrapper, which exits with our code in turn.
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    console.error(`agents-deck: could not start ${WORKER}: ${err.message}`);
    process.exit(1);
  });
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
    if (child) { try { child.kill(sig); } catch { /* already gone */ } }
    else process.exit(0);
  });
}

launch(false);
