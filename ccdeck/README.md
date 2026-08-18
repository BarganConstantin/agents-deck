# ccdeck

**A live canvas for your AI agents.** Watch Claude Code and OpenAI Codex call tools and finish — every Claude Code subagent on a node of its own — all on one calm graph, in real time.

```bash
npx ccdeck
```

Opens **http://127.0.0.1:4317** and registers the Claude Code hook on first run. Start any Claude Code or Codex session and the graph fills in live. `Ctrl+C` stops it. No config file, no account, no telemetry.

## What this package is

`ccdeck` is the short name for [`agents-deck`](https://www.npmjs.com/package/agents-deck) — one project published under three names (`ccdeck`, `agents-deck`, and the original `agent-dag`), running the same deck from any of them.

This package is a thin stub: it depends on the exact matching version of `agents-deck`, hands your arguments to its binary, and reports back whatever the deck reported — including the signal it was killed by. It ships only the `ccdeck` command; a global install of `agents-deck` puts all three on your `PATH`.

## Everything else

Options, environment variables, the Accounts panel, how capture works for each provider, updating, uninstalling — all of it is documented once, in the project README:

**https://github.com/BarganConstantin/ccdeck#readme**

## Requirements

Node.js ≥ 18 — macOS, Linux and Windows. Plus the Claude Code CLI or the OpenAI Codex CLI, or both.

## Links

- Documentation and source — https://github.com/BarganConstantin/ccdeck
- Issues — https://github.com/BarganConstantin/ccdeck/issues
- The package this one forwards to — https://www.npmjs.com/package/agents-deck

MIT © [Bargan Constantin](https://github.com/BarganConstantin)
