// The command line, parsed: everything the deck recognises, and everything it
// does not.
//
// Its own module rather than a function inside bin/deck.js, for one reason —
// importing bin/deck.js RUNS a deck. That file installs hooks, binds a port and
// opens a browser at module scope, so there was no way to ask what `--prot`
// parses to without starting a server to find out. Nothing here does any of
// that: strings in, a plain object out, no I/O, no process, no terminal.
//
// bin/deck.js is the only caller. The parser is the whole of the module's
// surface; the tables it matches against stay inside it.

/**
 * Parse `process.argv.slice(2)`.
 *
 * Returns the flags that were set, plus `unknown` — every token the loop did
 * not recognise, in the order it met them. That list is the point of this
 * module: the loop used to have no `else`, so `ccdeck --prot 4500` booted on
 * 4317 and said nothing, and a typo was indistinguishable from a flag that
 * worked.
 *
 * The three flags that TAKE a value (`--port`, `--workspace`, `--history`)
 * consume it with `args[++i]`, so the value is never re-examined as a token of
 * its own and cannot land in `unknown` — `--port 4500` says nothing about
 * `4500`, and `--workspace ~/some dir` nothing about the path. That is the way
 * an unknown-flag warning usually goes wrong, and it is asserted rather than
 * assumed; see src/web/__tests__/argv-480.test.ts.
 *
 * A bare word is `unknown` too, and deliberately: the deck takes no positional
 * arguments at all, so `ccdeck ~/proj` is the same mistake as `ccdeck --workpace
 * ~/proj` — something the deck read and then did nothing with. It is also how
 * an unquoted path with a space in it becomes visible, which is a failure this
 * repo already knew about and could not previously report: `--workspace
 * C:\Users\John Smith\proj` reaches the parser as two arguments, and the second
 * one used to be dropped in silence (see launchNpx in bin/agent-dag.js).
 */
export function parseArgs(args) {
  const out = { unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "-p" || a === "--port") out.port = args[++i];
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--workspace") out.workspace = args[++i];
    else if (a === "--scope") out.scope = true;
    else if (a === "--all") out.all = true; // legacy no-op (now default)
    else if (a === "--no-persist") out.noPersist = true;
    else if (a === "--history") out.history = args[++i];
    else if (a === "--codex") out.codex = true;
    else if (a === "--no-codex") out.noCodex = true;
    else if (a === "--claude") out.claude = true;
    else if (a === "--no-claude") out.noClaude = true;
    else out.unknown.push(a);
  }
  return out;
}
