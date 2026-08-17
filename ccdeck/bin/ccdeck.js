#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
// This package ships nothing but bin/, so both halves of the deck come out of
// the agents-deck installed beside us — the binary to hand off to, and the rule
// for reporting a worker that was killed. Reached by path rather than as the
// bare specifier `agents-deck/src/server/supervisor.mjs` so the two can never
// resolve to different copies, and so an `exports` map added to agents-deck
// later cannot turn this into a startup crash. The dependency is pinned to the
// exact version at publish time, so the file is always there.
//
// TWO LAYOUTS, because npm has two and only one of them was ever handled. Under
// `npx ccdeck` the dependency is a sibling — `_npx/<hash>/node_modules/{ccdeck,
// agents-deck}` — and `../../agents-deck` finds it. Under `npm i -g ccdeck` it
// is NOT: npm stopped hoisting a global package's dependencies in v7, so it
// lands at `lib/node_modules/ccdeck/node_modules/agents-deck` while
// `../../agents-deck` points at `lib/node_modules/agents-deck`, which does not
// exist. That is not a hypothetical — installing the published 1.33.142 this
// way and running it gives ERR_MODULE_NOT_FOUND before the deck prints
// anything, so the one command every surface tells people to run has been dead
// on arrival for every global install. npx was the only shape anybody tested.
//
// So: try the nested layout first (it is the one that was broken), then the
// sibling, then let node resolve it — which covers a workspace, a pnpm store
// and any future layout none of us predicted. Path-first, resolution last,
// keeps the guarantee in the paragraph above wherever a path does answer.
const nested = resolve(__dir, '../node_modules/agents-deck');
const sibling = resolve(__dir, '../../agents-deck');

// The three codes that mean "there is no deck here", as opposed to "the deck is
// broken". Both of the steps below can fail either way and they deserve opposite
// answers, so the distinction is made once, by code, and nothing else is caught.
//
// MODULE_NOT_FOUND is what the last resort above threw in the shape people
// actually hit it: a half-removed install, a linked workspace, Yarn PnP without
// agents-deck in scope. Unguarded it reached the user as an eight-frame stack
// out of node's CJS loader before a single line of the deck — the same failure
// shape 0075d57 was written to eliminate, arriving through a different API. A
// launcher that cannot find its own deck knows exactly what is wrong and can say
// it in a sentence.
//
// ERR_PACKAGE_PATH_NOT_EXPORTED is the case the header above worries about:
// `./package.json` is not exported by default, so an `exports` map added to
// agents-deck later would make that resolve throw rather than answer. Resolving
// `agents-deck/bin/agent-dag.js` instead, as #359 suggests, does not avoid it —
// every subpath is gated by an exports map, and that one resolves to the bin
// directory rather than to the package root. The path probes are what actually
// keep the header's promise; listing the code here only makes the failure legible
// if it ever arrives.
//
// ERR_MODULE_NOT_FOUND is the import below: a pkg that was found but has no
// supervisor.mjs under it — a truncated or half-written install — is just as
// much "there is no deck here", and it used to throw its own stack too.
const NO_DECK = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);

let pkg, dieOfSignal;
try {
  pkg = existsSync(resolve(nested, 'package.json')) ? nested
    : existsSync(resolve(sibling, 'package.json')) ? sibling
    : dirname(createRequire(import.meta.url).resolve('agents-deck/package.json'));
  ({ dieOfSignal } = await import(pathToFileURL(resolve(pkg, 'src/server/supervisor.mjs')).href));
} catch (err) {
  // A supervisor.mjs that throws while it evaluates is a bug in the deck, not a
  // missing install, and it keeps its stack — that stack is the only thing that
  // would explain it.
  if (!NO_DECK.has(err?.code)) throw err;
  console.error([
    'ccdeck: could not find the agents-deck install it runs.',
    '',
    `  looked in ${nested}`,
    `       and ${sibling}`,
    '',
    '  ccdeck ships only this launcher — the deck itself is the agents-deck package',
    '  npm installs alongside it. Reinstall with `npm i -g ccdeck`, or skip the',
    '  launcher and run the deck directly with `npx agents-deck`.',
  ].join('\n'));
  process.exit(1);
}

const bin = resolve(pkg, 'bin/agent-dag.js');
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' });
// The supervisor answers a killed worker by dying of the same signal rather
// than exiting 128+n, which reaches us as (null, 'SIGTERM'). Exiting with
// `code ?? 0` turned that into 0: a `kill` or an OOM kill of a deck started as
// `npx ccdeck` was reported to systemd — or to whatever script started it — as
// a clean stop, while the same build under `npx agents-deck` reported 143.
// Ctrl+C hid it: that signals the whole group, so the stub died of SIGINT
// before this line could run — and a deck that shut itself down cleanly comes
// back through here as a plain 0 anyway. The handlers below are what stop the
// stub from dying first, which is what makes this line reachable on that path
// too; they change nothing about the verdict it reports.
child.on('exit', (code, signal) => (signal ? dieOfSignal(signal) : process.exit(code ?? 0)));

// ── a signal aimed at this process has to reach the deck, and must not reach it
//    twice ─────────────────────────────────────────────────────────────────────
//
// Nothing here trapped a signal, so `kill <pid>` against the stub — a systemd
// unit without KillMode=control-group, any supervisor that signals only the main
// pid, a hand-typed kill — ended the launcher in about six milliseconds and left
// agent-dag.js and deck.js running: still serving on 4317, still advertising a
// live pid in the discovery file. Hooks keep posting to a deck the user believes
// is stopped, and the next `npx ccdeck` finds the port taken and quietly binds
// another one.
//
// Ctrl+C is why that survived: the terminal signals the whole foreground process
// group, and the child is in it — nothing here spawns detached — so the deck
// gets its own copy and tears itself down without us. Measured rather than
// assumed, by group-signalling a real stub over a real child: under a group-wide
// SIGINT the child receives exactly one signal and shuts down; under a targeted
// one it receives none and is still alive seconds later.
//
// Which is exactly why forwarding cannot be unconditional. Under Ctrl+C the
// child has already had the signal, and a forwarded copy lands about a
// millisecond behind it as a SECOND one — measured the same way, three runs out
// of three. agent-dag.js reads a second signal as an impatient user pressing
// Ctrl+C again and answers it by SIGKILLing deck.js, and a SIGKILLed deck is a
// deck denied its own shutdown: the discovery file it was partway through
// removing stays behind, naming a pid that is gone. That is this very bug
// arriving from the other direction, so the obvious one-liner trades an orphaned
// deck for a stale one.
//
// So the forward is delayed, and the child's own exit cancels it. If the child
// got the signal too it is gone long before the timer and nothing is sent; if it
// did not, the timer fires and the deck comes down. A second signal means
// somebody is waiting, so it goes straight through. Deciding this by clock
// rather than by asking agent-dag to tolerate a duplicate keeps the answer true
// against a deck this stub did not ship with — a workspace, a pnpm store, an
// older global agents-deck found by the resolution above — which is the whole
// reason those layouts are supported at all.
//
// Staying alive is the other half of the fix, and it is what the delay is built
// on. The default action for all three signals is to die, so the stub used to
// vanish while the deck was still shutting down, handing the shell a prompt and
// a status of its own before the deck had one. Now the child's status is what
// the caller gets, the way `npx agents-deck` has always answered — including the
// 0 deck.js chooses for a Ctrl+C, where the stub used to report 130. That is the
// parity the exit handler above exists for, extended to the signals that arrive
// here rather than there. dieOfSignal drops our handler before it re-raises, so
// a deck that really did die of a signal still comes back as 128+n instead of
// being swallowed by the handlers below.
//
// WINDOWS GETS THE OPPOSITE ANSWER, because it has no signals to forward. The
// only thing that runs these handlers there is a console event — Ctrl+C,
// Ctrl+Break, the window closing — and the console delivers those to every
// process attached to it, so the child always has its own copy already. A
// targeted kill there is TerminateProcess: no handler runs at all, and there is
// nothing this file can do about that. Meanwhile `child.kill()` on Windows IS
// TerminateProcess, so forwarding would take agent-dag.js out mid-shutdown and
// orphan deck.js underneath it — the failure we are here to fix, caused by the
// fix. So on Windows the handlers only keep us alive for the child's exit
// status, and never forward.
//
// The delay itself is chosen against what it has to outlast and what it makes
// wait: longer than a healthy teardown, since deck.js caps its entire shutdown
// at 1500ms, and shorter than every stop timeout that would be sitting on the
// other end of a `kill` — docker's 10s is the tightest, systemd's 90s the most
// common. Ctrl+C never waits it out, because the deck is long gone by then.
const FORWARD_AFTER_MS = 2000;

let pending = null;   // a forward waiting to see whether the child needs one
let forwarded = false; // whether one has already gone out

const forward = (sig) => {
  pending = null;
  forwarded = true;
  try { child.kill(sig); } catch { /* already gone */ }
};

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    // Node sets both of these in the same breath as it emits 'exit', so this is
    // the child's real state and not a guess: there is nothing left to signal,
    // and the exit handler above is already on its way to ending us.
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') return;
    if (!pending && !forwarded) {
      // unref'd because the child's own handle is what keeps this process alive;
      // a forward that is still waiting should never be the reason the stub
      // outlives the deck.
      pending = setTimeout(() => forward(sig), FORWARD_AFTER_MS).unref();
      return;
    }
    // Anything after the first goes straight out, and `forwarded` keeps it that
    // way: once somebody has asked twice, a later ask must not be slower than
    // the one before it. The clear is a no-op when the delay has already run.
    clearTimeout(pending);
    forward(sig);
  });
}
