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
const pkg = existsSync(resolve(nested, 'package.json')) ? nested
  : existsSync(resolve(sibling, 'package.json')) ? sibling
  : dirname(createRequire(import.meta.url).resolve('agents-deck/package.json'));
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
