# agents-deck

[![npm](https://img.shields.io/npm/v/agents-deck?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/agents-deck)
[![npm downloads](https://img.shields.io/npm/dm/agents-deck?color=blue)](https://www.npmjs.com/package/agents-deck)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)

Live canvas for **Claude Code** and **OpenAI Codex** agents. Watch parallel subagents fork, call tools, and finish — all on one calm graph.

![agents-deck — live agent DAG](image_2026-06-16_08-58-42.png)

## Quick start

```bash
npx agents-deck
```

Opens **http://127.0.0.1:4317** and auto-registers the Claude Code hook. Start any Claude Code or Codex session and the graph fills in live.

No config. No install step. Ctrl+C to stop.

## Features

- **Live DAG** — nodes are agents, edges are spawns and tool calls; in-flight edges animate, settled edges fade
- **Dual provider** — Claude Code via hooks, Codex via log-tail; both appear on the same canvas; the model chip (`Opus 4.8`, `GPT-5.5`) tells them apart
- **Click-to-inspect** — click any node for prompt, tool calls, token usage, and timing
- **Persistent replay** — events survive restarts; the log at `~/.claude/agent-dag/events.jsonl` replays the last session on open
- **Workspace filter** — `--scope` limits capture to the current directory; `--workspace <path>` for any subtree
- **Zero trust step for Codex** — no hook install, no `/hooks` trust prompt; the server tails `~/.codex/sessions/` directly
- **Version drift warning** — Node caches modules at startup, so a deck upgraded while running keeps executing the old code. The topbar says so, and points at the restart or the upgrade command
- **Restarts itself when idle** — once the newer code is on disk, the deck comes back on the same port as soon as nothing has been running for 30 seconds. The canvas replays; it never installs anything on your behalf

## How it works

Two capture paths feed one SSE stream → one browser canvas.

**Claude Code** — on first run `agents-deck` injects a hook entry into `~/.claude/settings.json` for every relevant event:

```
SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · PostToolUseFailure
SubagentStart · SubagentStop · Stop · SessionEnd · Notification
```

Each hook fires the bundled `hook.js`, which POSTs the event JSON to the running server.

**OpenAI Codex** — Codex CLI hooks don't fire reliably on Windows (the sandbox refuses to spawn them). Instead, the server tails Codex's rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and reconstructs an equivalent event stream — session start, prompts, tool calls, token usage, model. No hook install, no trust step needed. Set `CODEX_HOME` to override the default path.

## Options

```
agents-deck [options]

  -p, --port <number>      Preferred port  (default: 4317; fallback: random 4318–4400)
      --no-open            Don't open the browser automatically
      --workspace <path>   Only capture sessions whose cwd is inside <path>
      --scope              Restrict to the current working directory
      --all                Capture every session on this machine  (default)
      --history <path>     Override the events log file
                           (default: ~/.claude/agent-dag/events.jsonl)
      --no-persist         RAM-only mode — don't write or replay the log
      --codex              Force Codex capture even if ~/.codex/ is missing
      --no-codex           Skip Codex capture (Claude only)
      --uninstall          Remove agents-deck hooks from settings files
  -h, --help               Show this help
```

Environment:

```
AGENT_DAG_PORT               Default port, same as -p
CODEX_HOME                   Override ~/.codex
AGENTS_DECK_NO_INSTALL=1     Never install or update claude-swap / ccusage,
                             and don't ask npm about newer agents-deck releases
AGENTS_DECK_NO_UPDATE_CHECK=1  Don't ask npm about releases, but keep everything else
AGENTS_DECK_NO_FRESHEN=1     Never nudge claude-swap to collect usage early
```

The update check is one ~20-byte GET to `registry.npmjs.org`, at most once a day,
and it never installs anything. Being told to restart after an upgrade is local
only — no network involved — and cannot be turned off, because a deck running
superseded code is a bug you cannot see any other way.

### Restarting

`agents-deck` runs as a two-process pair: a supervisor that owns nothing but the
lifecycle, and the deck itself. When newer code is found on disk, the deck exits
with code 75 and the supervisor brings it back **on the port it actually bound**,
which is not always the one it asked for. Ctrl+C, stdout and exit codes behave
exactly as before — same terminal, same process group.

It restarts on its own only once nothing has been running for 30 seconds: hook
events are fire-and-forget, so anything fired during the gap is lost. Turn that
off with the toggle in the banner and use the button instead; the preference is
per-browser. Under `--no-persist` restarting is refused outright, by the server
and not just by the UI — with no event log there is nothing to replay, and the
canvas would be gone.

## Uninstall

```bash
npx agents-deck --uninstall
```

Removes all hook entries injected by agents-deck from `~/.claude/settings.json` (and `~/.codex/hooks.json` if present).

## Legacy name

Formerly **agent-dag**. Both names publish the same package and the `agent-dag` command is a built-in alias — existing installs and scripts keep working.

```bash
# both work identically
npx agents-deck
npx agent-dag
```

## Design

One canvas. No tabs. No kanban.

- Node = agent (root session or subagent)
- Edge = parent → child (spawn) or agent → tool (call)
- In-flight = animated; settled = dimmed
- Click a node for full details

## Requirements

- Node.js ≥ 18
- Claude Code CLI or OpenAI Codex CLI (or both)

## License

MIT © [Bargan Constantin](https://github.com/BarganConstantin)
