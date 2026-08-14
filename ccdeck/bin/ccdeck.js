#!/usr/bin/env node
import { spawn } from 'child_process';
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
const pkg = resolve(__dir, '../../agents-deck');
const { dieOfSignal } = await import(pathToFileURL(resolve(pkg, 'src/server/supervisor.mjs')).href);

const bin = resolve(pkg, 'bin/agent-dag.js');
const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' });
// The supervisor answers a killed worker by dying of the same signal rather
// than exiting 128+n, which reaches us as (null, 'SIGTERM'). Exiting with
// `code ?? 0` turned that into 0: a `kill` or an OOM kill of a deck started as
// `npx ccdeck` was reported to systemd — or to whatever script started it — as
// a clean stop, while the same build under `npx agents-deck` reported 143.
// Ctrl+C hides it, since that signals the whole group and kills us directly.
child.on('exit', (code, signal) => (signal ? dieOfSignal(signal) : process.exit(code ?? 0)));
