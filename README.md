# agent-dag

Live DAG of Claude Code **and OpenAI Codex** agents. Watch parallel subagents fork, call tools, and return — all on one calm canvas.

## Run

```bash
npx agent-dag
```

Opens http://127.0.0.1:4317 (or a random port in 4318–4400 if 4317 is taken). Start a Claude Code **or Codex** session in any directory and watch the graph fill in. Both providers render side by side on the same canvas; the model chip on each node tells them apart (e.g. `Opus 4.8`, `GPT-5.5`).

## Options

```
-p, --port <number>      Preferred port (default: 4317; falls back to random 4318–4400)
    --no-open            Don't open the browser automatically
    --workspace <path>   Only capture sessions whose cwd is inside <path>
    --scope              Restrict to the current working directory
    --all                Capture sessions from all workspaces (machine-wide; default)
    --codex              Force-enable Codex capture even if ~/.codex/ is missing
    --no-codex           Skip Codex capture (Claude only)
    --history <path>     Override events log file (default: ~/.claude/agent-dag/events.jsonl)
    --no-persist         RAM-only mode, no log file
    --uninstall          Remove agent-dag hooks from ~/.claude/settings.json
-h, --help               Show help
```

## Design

- One canvas. No tabs. No kanban.
- Node = agent (root session, subagent).
- Edge = parent → child (spawn) or agent → tool (call).
- In-flight edges animate; settled edges fade.
- Click a node for details.

## How it works

Two providers, two capture paths — both stream to the same server, which pushes events to the browser over SSE.

**Claude Code** — `agent-dag` registers a hook script in `~/.claude/settings.json` for these events:

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, `Notification`.

The hook forwards the event JSON to the running server.

**OpenAI Codex** — Codex CLI hooks don't fire reliably on Windows (the sandbox refuses to spawn the hook command), so instead the server tails Codex's session rollout files at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and reconstructs the same event stream (session start, prompts, tool calls, token usage, model). No hook install and no `/hooks` trust step is needed — just run a Codex session and it shows up. Honors `CODEX_HOME` if set.

## Uninstall

```bash
npx agent-dag --uninstall
```

Removes all hooks from `~/.claude/settings.json`.

## Status

Pre-alpha. Names, ports, and event shapes may change.
