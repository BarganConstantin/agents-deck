// Overlay that renders a small "tool bubble" next to each agent for the
// last MAX_PER_AGENT tool calls — a persistent trail of recent activity.
// Bubbles fly out FROM the agent's centre (via per-bubble --spawn-dx/dy
// custom properties) on spawn, get pushed out FIFO when newer tools land,
// and only fade away when the owning agent retires (exitAt set). Earlier
// versions hid bubbles a few seconds after the tool finished, which left
// idle/just-finished sessions looking empty next to a wall of "DONE" cards.
// They live on a layer above React Flow's nodes and follow the canvas
// pan/zoom via useViewport().
import React from "react";
import { useViewport } from "reactflow";
import type { AgentNodeData, ToolCall } from "../types";

const FADE_MS = 600;
const MAX_PER_AGENT = 4;
const BUBBLE_VERT_GAP = 36;
const BUBBLE_HALF_H = 16;
const BUBBLE_OFFSET_X = 60;
/** Vertical inset from the agent's top — first bubble sits this far below
 *  the agent's top edge, then they stack downward. Anchoring to the top
 *  (rather than the middle) keeps the trail from overflowing above the
 *  card or running over the card's own header/title area. */
const BUBBLE_TOP_INSET = 6;
/** Floor for the agent's measured width — the .agent-node CSS has
 *  min-width:220px, so even an unmeasured card is at least this wide. Using
 *  it stops bubbles from being computed flush with a wrong-tiny width and
 *  then visually overlapping the card once measurement settles. */
const AGENT_W_MIN = 220;
/** Approximate width of a bubble — used to position chained sub-bubbles
 *  before we know their measured width. ~96 fits "📖 Read" through
 *  "🎬 Workflow"; anything longer wraps naturally. */
const ESTIMATED_BUBBLE_W = 96;
const SUB_GAP = 28;

// Group every tool into a category so we can tint its bubble accent. Picked
// to read at a glance even at low zoom: file = blue, shell = amber, web =
// cyan, agent = pink, tasks/todos = green, plan = violet, mcp = teal.
type ToolCategory = "file" | "shell" | "web" | "agent" | "task" | "plan" | "mcp" | "other";

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  Read: "file", Write: "file", Edit: "file", MultiEdit: "file",
  Glob: "file", Grep: "file", LS: "file", NotebookEdit: "file",
  Bash: "shell", PowerShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  TodoWrite: "task", TaskCreate: "task", TaskUpdate: "task",
  TaskList: "task", TaskGet: "task", TaskOutput: "task", TaskStop: "task",
  EnterPlanMode: "plan", ExitPlanMode: "plan", AskUserQuestion: "plan",
  Skill: "plan", Workflow: "plan",
  ScheduleWakeup: "other", CronCreate: "other", CronList: "other",
  CronDelete: "other", Monitor: "other", PushNotification: "other",
  RemoteTrigger: "other", ToolSearch: "other",
};

function categoryFor(name: string): ToolCategory {
  if (name.startsWith("mcp__")) return "mcp";
  return TOOL_CATEGORY[name] ?? "other";
}

// Distinct emojis for every CC built-in I know about + sensible fallback.
const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Write: "💾",
  Edit: "✏️",
  MultiEdit: "🔧",
  Glob: "🗺️",
  Grep: "🔎",
  Bash: "⚡",
  PowerShell: "💻",
  LS: "📂",
  Task: "🤖",
  Agent: "🤖",
  TodoWrite: "📋",
  TaskCreate: "📋",
  TaskUpdate: "📝",
  TaskList: "🗂️",
  TaskGet: "🗂️",
  TaskOutput: "📤",
  TaskStop: "🛑",
  WebFetch: "🌐",
  WebSearch: "🔭",
  ToolSearch: "🧰",
  NotebookEdit: "📓",
  EnterPlanMode: "🧭",
  ExitPlanMode: "🏁",
  AskUserQuestion: "❓",
  ScheduleWakeup: "⏰",
  CronCreate: "⏰",
  CronList: "📅",
  CronDelete: "🗑️",
  Skill: "🎯",
  Workflow: "🎬",
  Monitor: "📡",
  PushNotification: "🔔",
  RemoteTrigger: "📡",
};

function emojiFor(name: string): string {
  if (name.startsWith("mcp__")) return "🔌";
  return TOOL_EMOJI[name] ?? "✨";
}

// ─── Shell-command introspection ──────────────────────────────────────────
// When a tool call is Bash/PowerShell we crack open its input and surface the
// underlying command (git/npm/grep/…) instead of just labelling the bubble
// "Bash". The category accent stays amber for `shell` so you still know it
// was a shell call, and the original Bash/PowerShell text + full command go
// into the tooltip.

const COMMAND_EMOJI: Record<string, string> = {
  // VCS / forges
  git: "🐙", gh: "🐙", glab: "🐙",
  // Package managers
  npm: "📦", pnpm: "📦", yarn: "📦", bun: "📦", brew: "🍺",
  // Languages / runtimes
  node: "🟢", deno: "🟢",
  python: "🐍", python3: "🐍", py: "🐍", pip: "🐍", pip3: "🐍", uv: "🐍",
  ruby: "💎", bundle: "💎", gem: "💎",
  cargo: "🦀", rustc: "🦀", rustup: "🦀",
  go: "🐹",
  // Containers / orchestration
  docker: "🐳", "docker-compose": "🐳", podman: "🐳",
  kubectl: "☸️", helm: "☸️", k9s: "☸️",
  // Search / files
  grep: "🔎", rg: "🔎", ag: "🔎", ack: "🔎",
  find: "🔍", fd: "🔍", locate: "🔍", which: "🔍",
  ls: "📂", dir: "📂", tree: "📂",
  cat: "📄", head: "📄", tail: "📄", less: "📄", more: "📄", bat: "📄",
  cp: "📋", mv: "✂️", rm: "🗑️", rmdir: "🗑️", mkdir: "📁", touch: "📁",
  sed: "✏️", awk: "✏️", tr: "✏️",
  // Network
  curl: "🌐", wget: "🌐", http: "🌐", httpie: "🌐",
  ssh: "🔐", scp: "🔐", rsync: "🔐", ping: "📡",
  // Build / make
  make: "🔨", cmake: "🔨", ninja: "🔨", bazel: "🔨", just: "🔨",
  // Infra / config
  terraform: "🏗️", ansible: "📕", pulumi: "🏗️",
  // Process / system
  ps: "📊", top: "📊", htop: "📊", btm: "📊",
  kill: "💀", pkill: "💀",
  systemctl: "⚙️", service: "⚙️",
  // Archives
  tar: "🗜️", zip: "🗜️", unzip: "🗜️", gzip: "🗜️", "7z": "🗜️",
  // Editors / data
  vim: "📝", nvim: "📝", nano: "📝", emacs: "📝", code: "📝",
  jq: "🪺", yq: "🪺",
  // Echo-likes
  echo: "💬", printf: "💬",
  // Media
  ffmpeg: "🎞️", ffprobe: "🎞️", imagemagick: "🖼️", convert: "🖼️",
  // PowerShell cmdlets — picked the ones I see most often in actual hook
  // payloads. Same emoji as their POSIX cousins so the eye is trained once.
  "Get-ChildItem": "📂", "Get-Content": "📄", "Set-Content": "💾",
  "Out-File": "💾", "Add-Content": "💾",
  "Set-Location": "📍", "Get-Location": "📍",
  "Get-Process": "📊", "Start-Process": "▶️", "Stop-Process": "💀",
  "Invoke-WebRequest": "🌐", "Invoke-RestMethod": "🌐",
  "New-Item": "📁", "Remove-Item": "🗑️", "Copy-Item": "📋", "Move-Item": "✂️",
  "Test-Path": "🔍", "Where-Object": "🔎", "ForEach-Object": "🔁",
  "Select-Object": "🎯", "Measure-Object": "📊",
  "Get-Service": "⚙️", "Restart-Service": "⚙️",
  "ConvertTo-Json": "🪺", "ConvertFrom-Json": "🪺",
};

/** Pull the primary executable name out of a shell command string. Tries
 *  hard enough to be useful — strips `env VAR=val`, `sudo`, and unwraps a
 *  `bash -c "..."` shell — but doesn't pretend to be a real parser. */
function parseShellCommand(input: string): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;

  // bash -c "git status"  /  sh -c '...'  /  powershell -Command "..."  →
  // recurse into the inner command so we get the real verb.
  const wrap = s.match(/^(?:bash|sh|zsh|fish|powershell|pwsh)(?:\.exe)?\s+(?:-c|-Command|-NoProfile|-NonInteractive|\s)+["']([^"']+)["']/i);
  if (wrap) return parseShellCommand(wrap[1]);

  // env VAR=val VAR2=val2 cmd  →  strip leading var assignments.
  while (true) {
    const m = s.match(/^([A-Z_][A-Z0-9_]*=\S*)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }

  // sudo [-flags] cmd  →  cmd
  s = s.replace(/^sudo(?:\s+-\S+)*\s+/, "");
  // time / nohup / xargs wrappers
  s = s.replace(/^(?:time|nohup|xargs)\s+/, "");

  const first = s.match(/^([^\s|;&<>(]+)/);
  if (!first) return null;
  let cmd = first[1];

  // Strip a leading path: /usr/bin/git → git, ./foo.sh → foo.sh
  cmd = cmd.replace(/^.*[/\\]/, "");
  // Strip a trailing .exe / .cmd on Windows
  cmd = cmd.replace(/\.(exe|cmd|bat|ps1)$/i, "");

  return cmd || null;
}

interface CommandSkin {
  emoji: string;
  label: string;
  /** Sub-bubble accent — picks the colored stripe + glow. */
  category: ToolCategory;
  /** Optional richer text for the tooltip — full path / full command. */
  detail?: string;
}

/** Extract a usable command string from CC's tool_input.
 *  - Bash:        { command: "git status", description?: string, ... }
 *  - PowerShell:  { command: "..." } or sometimes { script: "..." }
 *  - Fallback:    if input is a bare string, use it directly. */
function commandStringOf(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.cmd === "string") return obj.cmd;
  if (typeof obj.script === "string") return obj.script;
  return null;
}

function skinForShellCall(toolName: string, input: unknown): CommandSkin | null {
  if (toolName !== "Bash" && toolName !== "PowerShell") return null;
  const raw = commandStringOf(input);
  if (!raw) return null;
  const cmd = parseShellCommand(raw);
  if (!cmd) return null;
  // Always render a sub-bubble for parseable shell calls. If the command
  // isn't in our curated emoji map, use a generic gear so the user can
  // still see "agent → Bash → <whatever-the-command-was>".
  const emoji = COMMAND_EMOJI[cmd] ?? "⚙️";
  return { emoji, label: cmd, category: "shell", detail: raw };
}

// ─── File-tool introspection ──────────────────────────────────────────────
// Mirror what we did for Bash: for Read/Write/Edit/MultiEdit/NotebookEdit,
// crack open tool_input, take the file basename, pick an emoji by
// extension so the canvas reads "📖 Read → 🐍 main.py" instead of just
// "📖 Read". Tooltip shows the full path.

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "LS", "Glob"]);

/** Emoji by file extension — covers code / config / docs / media / etc.
 *  Picked so each ext is visually distinct from neighbours at low zoom. */
const EXT_EMOJI: Record<string, string> = {
  ts: "🟦", tsx: "🟦", d: "🟦",
  js: "🟨", jsx: "🟨", mjs: "🟨", cjs: "🟨",
  py: "🐍", pyi: "🐍", ipynb: "📓",
  rs: "🦀",
  go: "🐹",
  rb: "💎", erb: "💎",
  java: "☕", kt: "☕", scala: "☕", gradle: "☕",
  cs: "🔷", fs: "🔷",
  php: "🐘",
  swift: "🦅",
  c: "🇨", cpp: "🇨", cc: "🇨", h: "🇨", hpp: "🇨",
  md: "📝", mdx: "📝", rst: "📝",
  json: "🪺", json5: "🪺", jsonl: "🪺",
  yaml: "⚙️", yml: "⚙️", toml: "⚙️", ini: "⚙️", conf: "⚙️", cfg: "⚙️",
  xml: "📰", html: "🌐", htm: "🌐", vue: "🌐", svelte: "🌐",
  css: "🎨", scss: "🎨", sass: "🎨", less: "🎨",
  sh: "⚡", bash: "⚡", zsh: "⚡", fish: "⚡", ps1: "⚡",
  txt: "📄", log: "📄", out: "📄",
  csv: "📊", tsv: "📊", xlsx: "📊", xls: "📊",
  pdf: "📕",
  png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️", ico: "🖼️",
  mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬", webm: "🎬",
  mp3: "🎵", wav: "🎵", ogg: "🎵", flac: "🎵",
  zip: "🗜️", tar: "🗜️", gz: "🗜️", bz2: "🗜️", "7z": "🗜️", xz: "🗜️", rar: "🗜️",
  env: "🔐", lock: "🔐", pem: "🔐", key: "🔐", crt: "🔐",
  sql: "🗄️", db: "🗄️", sqlite: "🗄️", parquet: "🗄️",
};

/** Special filename overrides — when the whole filename is iconic. */
const SPECIAL_FILES: Record<string, string> = {
  "dockerfile": "🐳",
  "makefile": "🔨",
  "rakefile": "💎",
  "package.json": "📦",
  "pnpm-lock.yaml": "📦",
  "yarn.lock": "📦",
  "cargo.toml": "🦀",
  "cargo.lock": "🦀",
  "go.mod": "🐹",
  "go.sum": "🐹",
  "pyproject.toml": "🐍",
  "requirements.txt": "🐍",
  "readme.md": "📖",
  "readme": "📖",
  "license": "📜",
  ".gitignore": "🐙",
  ".gitattributes": "🐙",
  ".env": "🔐",
  ".dockerignore": "🐳",
};

function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function emojiForFilename(name: string): string {
  const lc = name.toLowerCase();
  if (SPECIAL_FILES[lc]) return SPECIAL_FILES[lc];
  if (lc.startsWith("dockerfile.")) return "🐳";
  // Test files
  if (/\.(test|spec)\.[a-z]+$/.test(lc)) return "🧪";
  // Extension lookup
  const dot = lc.lastIndexOf(".");
  if (dot > 0 && dot < lc.length - 1) {
    const ext = lc.slice(dot + 1);
    if (EXT_EMOJI[ext]) return EXT_EMOJI[ext];
  }
  return "📄";
}

function extractFilePath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  // CC's most-common key shapes across file tools.
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.notebook_path === "string") return obj.notebook_path;
  if (typeof obj.path === "string") return obj.path;
  // Glob uses pattern as the "thing" — render that instead.
  if (toolName === "Glob" && typeof obj.pattern === "string") return obj.pattern;
  return null;
}

function skinForFileCall(toolName: string, input: unknown): CommandSkin | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  const path = extractFilePath(toolName, input);
  if (!path) return null;
  const name = basenameOf(path);
  if (!name) return null;
  // For directories (LS) treat as "file" category with folder emoji.
  const isDir = toolName === "LS";
  const emoji = isDir ? "📂" : emojiForFilename(name);
  return { emoji, label: name, category: "file", detail: path };
}

// ─── MCP server introspection ─────────────────────────────────────────────
// CC names MCP tools as `mcp__<server>__<method>`. When we recognise the
// server we use a branded emoji + name on the primary bubble; the
// sub-bubble carries the actual method. Unknown servers still get
// distinct treatment via a hash-based hue (so 5 unknown MCP servers each
// look different from each other).

/** Built-in server identity — emoji + display name. Keep names short. */
const MCP_SERVERS: Record<string, { emoji: string; name: string }> = {
  github:    { emoji: "🐙", name: "GitHub" },
  git:       { emoji: "🐙", name: "Git" },
  gitlab:    { emoji: "🦊", name: "GitLab" },
  slack:     { emoji: "💬", name: "Slack" },
  discord:   { emoji: "💬", name: "Discord" },
  linear:    { emoji: "📐", name: "Linear" },
  jira:      { emoji: "🅹",  name: "Jira" },
  atlassian: { emoji: "🅰️", name: "Atlassian" },
  notion:    { emoji: "📓", name: "Notion" },
  asana:     { emoji: "📋", name: "Asana" },
  intercom:  { emoji: "💬", name: "Intercom" },
  figma:     { emoji: "🎨", name: "Figma" },
  gmail:     { emoji: "📧", name: "Gmail" },
  calendar:  { emoji: "📅", name: "Calendar" },
  drive:     { emoji: "☁️", name: "Drive" },
  zoom:      { emoji: "📹", name: "Zoom" },
  spotify:   { emoji: "🎵", name: "Spotify" },
  youtube:   { emoji: "📺", name: "YouTube" },
  ccd_session:     { emoji: "📡", name: "Session" },
  ccd_directory:   { emoji: "📂", name: "Directory" },
  ccd_session_mgmt:{ emoji: "📡", name: "Sessions" },
  mcp_registry:    { emoji: "🧰", name: "Registry" },
  "computer-use":  { emoji: "🖱️", name: "Computer" },
  "claude-in-chrome":  { emoji: "🌐", name: "Chrome" },
  "claude-preview":    { emoji: "👀", name: "Preview" },
  "scheduled-tasks":   { emoji: "⏰", name: "Scheduler" },
  visualize:           { emoji: "🎨", name: "Visualize" },
  "plugin-design-asana":    { emoji: "📋", name: "Asana" },
  "plugin-design-atlassian":{ emoji: "🅰️", name: "Atlassian" },
  "plugin-design-figma":    { emoji: "🎨", name: "Figma" },
  "plugin-design-intercom": { emoji: "💬", name: "Intercom" },
  "plugin-design-linear":   { emoji: "📐", name: "Linear" },
  "plugin-design-notion":   { emoji: "📓", name: "Notion" },
  "plugin-design-slack":    { emoji: "💬", name: "Slack" },
};

/** Pull `<server>` out of `mcp__<server>__<method>`. The server segment is
 *  often a long uuid for ad-hoc MCPs — we still return it so unknown
 *  servers get colour-tinted by hash. */
interface McpParse { server: string; method: string }
function parseMcpName(toolName: string): McpParse | null {
  if (!toolName.startsWith("mcp__")) return null;
  // After the mcp__ prefix the rest is `<server>__<method>`. Server names
  // can contain hyphens but `__` is the separator.
  const rest = toolName.slice(5);
  const idx = rest.indexOf("__");
  if (idx <= 0) return { server: rest, method: "" };
  return { server: rest.slice(0, idx), method: rest.slice(idx + 2) };
}

/** Stable hash → 0..359 hue for unknown MCP servers. */
function hashHue(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h) % 360;
}

function skinForMcpCall(toolName: string, _input: unknown): CommandSkin | null {
  const parsed = parseMcpName(toolName);
  if (!parsed) return null;
  const { server, method } = parsed;
  if (!method) return null; // not enough to chain
  // Try a few key shapes: full server, no-prefix-hash server, etc.
  const known = MCP_SERVERS[server.toLowerCase()];
  return {
    emoji: known?.emoji ?? "🔌",
    label: method,
    category: "mcp",
    detail: known ? `${known.name} · ${method}` : `${server} · ${method}`,
  };
}

/** Single entry point that picks whichever skin applies (shell first, then
 *  file, then MCP). Keeps collectBursts callers from caring about tool
 *  families. */
function skinFor(toolName: string, input: unknown): CommandSkin | null {
  return skinForShellCall(toolName, input)
      ?? skinForFileCall(toolName, input)
      ?? skinForMcpCall(toolName, input);
}

/** Used by the primary bubble — for MCP calls we replace the generic
 *  "mcp__foo__bar" with the server name so the primary reads e.g.
 *  "🐙 GitHub" and the sub bubble reads "create_pr". Non-MCP tools fall
 *  back to the existing emojiFor / tool name. */
interface PrimaryDisplay { emoji: string; label: string; hue?: number }
function primaryDisplayFor(toolName: string): PrimaryDisplay {
  const mcp = parseMcpName(toolName);
  if (mcp) {
    const known = MCP_SERVERS[mcp.server.toLowerCase()];
    if (known) return { emoji: known.emoji, label: known.name };
    // Unknown server — keep the literal segment, tint by hash.
    return { emoji: "🔌", label: mcp.server, hue: hashHue(mcp.server) };
  }
  return { emoji: emojiFor(toolName), label: toolName };
}

type Status = "inflight" | "done" | "err";

function statusOf(t: ToolCall): Status {
  if (t.endedAt == null) return "inflight";
  return t.ok === false ? "err" : "done";
}

/** Bubble opacity — full while inflight or in the last-N trail. The fade
 *  branch is only used when an agent is retiring (exitAt set); otherwise
 *  the bubble stays at full opacity so the trail of recent activity
 *  persists. `agentExitAt` is the agent's exitAt timestamp, or null. */
function fadeAt(t: ToolCall, now: number, agentExitAt: number | null): number {
  if (agentExitAt == null) return 1;
  const since = now - agentExitAt;
  if (since < 0) return 1;
  return Math.max(0, 1 - since / FADE_MS);
}

interface Burst {
  /** React key — unique per visible bubble (a tool can produce 1 or 2). */
  id: string;
  /** Underlying ToolCall id, used for click-to-open. Same for primary and
   *  its shell sub-bubble. */
  toolId: string;
  agentId: string;
  /** Original tool name (e.g. "Bash"). Always present; goes into the tooltip. */
  toolName: string;
  /** Display label. */
  name: string;
  /** Display emoji. */
  emoji: string;
  /** True for shell sub-bubbles. Lets us style them slightly differently. */
  isSub?: boolean;
  status: Status;
  category: ToolCategory;
  /** For unknown MCP servers — hash-based hue so 5 distinct servers read
   *  as 5 distinct colors instead of all 🔌. */
  mcpHue?: number;
  inputPreview: string;
  fade: number;
  fading: boolean;
  worldX: number;
  worldY: number;
  anchorX: number;
  anchorY: number;
  /** Worldspace delta from final position back to agent centre. Drives the
   *  spawn-from-origin animation via CSS custom properties. */
  spawnDx: number;
  spawnDy: number;
}

function collectBursts(
  agents: Map<string, AgentNodeData>,
  visibleAgentIds: Set<string>,
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  now: number,
): Burst[] {
  const out: Burst[] = [];
  for (const a of agents.values()) {
    // HARD gate: if the agent isn't on the canvas, no bursts for it either.
    // This is the single source of truth shared with snapshotToFlow so
    // bursts can never linger after their owning card has been filtered out
    // (the classic "orphan bursts floating with no agent card" bug).
    if (!visibleAgentIds.has(a.id)) continue;
    if (a.exitAt != null && now - a.exitAt > FADE_MS) continue;
    const pos = pinned.get(a.id) ?? positions.get(a.id);
    if (!pos) continue; // no position yet — agent not laid out
    // Always show the last MAX_PER_AGENT tools' bubbles as a persistent
    // "trail" of recent activity — no time-based culling. Bubbles only
    // leave when newer tools push them out of the window, or when the
    // agent itself retires (exitAt set, handled via fadeAt above).
    const visible = a.tools.slice(-MAX_PER_AGENT);
    if (visible.length === 0) continue;
    const agentExitAt = a.exitAt ?? null;
    const size = measured.get(a.id);
    // Floor to the CSS min-width so we never under-estimate the card's
    // right edge and end up positioning a bubble inside it.
    const aW = Math.max(size?.width ?? AGENT_W_MIN, AGENT_W_MIN);
    const aH = size?.height ?? 130;
    const aX = pos.x;
    const aY = pos.y;
    const anchorX = aX + aW;
    const anchorY = aY + aH / 2;
    visible.forEach((t, idx) => {
      const offsetY = idx * BUBBLE_VERT_GAP;
      const worldX = aX + aW + BUBBLE_OFFSET_X;
      const worldY = aY + BUBBLE_TOP_INSET + offsetY;
      const fade = fadeAt(t, now, agentExitAt);
      // The delta is from the bubble's anchor point (its visual left-centre)
      // back to the agent's right edge. The bubble starts there during spawn
      // and rides outward to its resting place.
      const inputPreview = t.inputPreview ?? "";
      const status = statusOf(t);
      const fading = fade < 0.999;
      // Primary bubble — the actual tool name as CC reported it. For MCP
      // calls we substitute the server name + branded emoji so the eye
      // reads "🐙 GitHub → create_pr" instead of two identical 🔌s.
      const primary = primaryDisplayFor(t.name);
      out.push({
        id: t.id,
        toolId: t.id,
        agentId: a.id,
        toolName: t.name,
        name: primary.label,
        emoji: primary.emoji,
        status,
        category: categoryFor(t.name),
        mcpHue: primary.hue,
        inputPreview,
        fade,
        fading,
        worldX,
        worldY,
        anchorX,
        anchorY,
        spawnDx: anchorX - worldX,
        spawnDy: anchorY - (worldY + BUBBLE_HALF_H),
      });
      // Chained sub-bubble — applies to:
      //   - Bash/PowerShell: show the parsed underlying command (git, npm…)
      //   - Read/Write/Edit/MultiEdit/NotebookEdit/LS/Glob: show the file
      //     basename (or directory / glob pattern)
      // Pass raw t.input, not inputPreview — CC's tool_input is an object
      // and stringifying it loses field access.
      const skin = skinFor(t.name, t.input);
      if (skin) {
        const subWorldX = worldX + ESTIMATED_BUBBLE_W + SUB_GAP;
        const subWorldY = worldY;
        const subAnchorX = worldX + ESTIMATED_BUBBLE_W;
        const subAnchorY = worldY + BUBBLE_HALF_H;
        out.push({
          id: `sub:${t.id}`,
          toolId: t.id,
          agentId: a.id,
          toolName: t.name,
          name: skin.label,
          emoji: skin.emoji,
          isSub: true,
          status,
          category: skin.category,
          // For sub-bubbles, prefer the richer `detail` (full path or full
          // command) over the raw JSON inputPreview — both end up in the
          // tooltip but `detail` reads better.
          inputPreview: skin.detail ?? inputPreview,
          fade,
          fading,
          worldX: subWorldX,
          worldY: subWorldY,
          anchorX: subAnchorX,
          anchorY: subAnchorY,
          spawnDx: subAnchorX - subWorldX,
          spawnDy: 0,
        });
      }
    });
  }
  return out;
}

interface ToolBurstsProps {
  /** The full agents Map. */
  agents: Map<string, AgentNodeData>;
  /** The exact set of agent ids currently on the canvas (computed in
   *  App.tsx via computeVisibleIds). Bursts only render for agents in this
   *  set — guarantees burst visibility matches card visibility. */
  visibleAgentIds: Set<string>;
  /** Same maps that feed ReactFlow's `nodes` prop. Reading from these means
   *  bursts and agents share a single source of truth for positions — they
   *  can never disagree, even mid-reflow. */
  positions: Map<string, { x: number; y: number }>;
  pinned: Map<string, { x: number; y: number }>;
  measured: Map<string, { width: number; height: number }>;
  /** When set, bursts whose agent isn't in this set get dimmed (matches the
   *  /-search behaviour applied to nodes). null = no filter. */
  dimUnmatched?: Set<string> | null;
  /** Spotlight: when an agent is selected, this set contains its lineage
   *  (ancestors + descendants). Bursts outside the lineage fade hard.
   *  null = no selection, full brightness everywhere. */
  spotlight?: Set<string> | null;
  /** Bursts whose category is in this set are skipped entirely (user
   *  toggled the category off via the filter chips). */
  hiddenCategories?: Set<ToolCategory>;
  now: number;
  /** Open the existing ToolModal for the given tool id. */
  onOpenTool?: (toolId: string) => void;
}

export default function ToolBursts({ agents, visibleAgentIds, positions, pinned, measured, dimUnmatched, spotlight, hiddenCategories, now, onOpenTool }: ToolBurstsProps) {
  const { x, y, zoom } = useViewport();
  const all = collectBursts(agents, visibleAgentIds, positions, pinned, measured, now);
  const bursts = hiddenCategories && hiddenCategories.size > 0
    ? all.filter(b => !hiddenCategories.has(b.category))
    : all;
  // We always render the layer — even when empty — so that the bubbles'
  // CSS spawn animations don't re-run every time the agent's tool list
  // briefly normalises. Returning null here would unmount the entire
  // layer (and every bubble inside) on any momentary empty state.

  return (
    <div className="tool-bursts-layer" aria-hidden>
      <svg className="tool-bursts-svg">
        {bursts.map(b => {
          const sx = b.anchorX * zoom + x;
          const sy = b.anchorY * zoom + y;
          const tx = (b.worldX + 6) * zoom + x;
          const ty = (b.worldY + BUBBLE_HALF_H) * zoom + y;
          const cx = sx + (tx - sx) * 0.55;
          const isDim = dimUnmatched != null && !dimUnmatched.has(b.agentId);
          const isSpotOut = spotlight != null && !spotlight.has(b.agentId);
          const opacity = b.fade * (isDim || isSpotOut ? 0.14 : 1);
          return (
            <path
              key={`l:${b.id}`}
              d={`M ${sx} ${sy} Q ${cx} ${sy}, ${tx} ${ty}`}
              className={`tool-conn status-${b.status}${b.fading ? " fading" : ""}`}
              opacity={opacity}
            />
          );
        })}
      </svg>
      {bursts.map(b => {
        const px = b.worldX * zoom + x;
        const py = b.worldY * zoom + y;
        const wrapStyle: React.CSSProperties & Record<string, string> = {
          left: `${px}px`,
          top: `${py}px`,
          transform: `scale(${zoom})`,
          transformOrigin: "left top",
          "--spawn-dx": `${b.spawnDx}px`,
          "--spawn-dy": `${b.spawnDy}px`,
        };
        // Tooltip always shows the underlying tool (Bash/PowerShell/…) so
        // the transport is never hidden, plus the input preview when present.
        const titleHead = b.isSub ? `${b.toolName} · ${b.name}` : b.toolName;
        const title = b.inputPreview ? `${titleHead} · ${b.inputPreview}` : titleHead;
        const clickable = onOpenTool != null;
        // For unknown MCP servers we set --cat-accent inline so each one
        // gets a distinct hue without needing a static class.
        const innerStyle: React.CSSProperties & Record<string, string> = b.mcpHue != null
          ? { "--cat-accent": `hsl(${b.mcpHue} 65% 65%)` }
          : {};
        const isDimmed = dimUnmatched != null && !dimUnmatched.has(b.agentId);
        const isSpotOut = spotlight != null && !spotlight.has(b.agentId);
        const dimClass = isDimmed || isSpotOut ? " dim" : "";
        return (
          <div key={b.id} className="tool-burst-wrap" style={wrapStyle}>
            <div
              className={`tool-burst cat-${b.category} status-${b.status}${b.fading ? " fading" : ""}${clickable ? " clickable" : ""}${b.isSub ? " sub" : ""}${dimClass}`}
              style={innerStyle}
              title={title}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `Open ${b.toolName} ${b.status === "inflight" ? "in flight" : b.status} — click for details` : undefined}
              onClick={clickable ? () => onOpenTool!(b.toolId) : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTool!(b.toolId); } } : undefined}
            >
              <span className="tb-emoji">{b.emoji}</span>
              <span className="tb-name">{b.name}</span>
              {b.status === "inflight" && <span className="tb-spin" />}
              {b.status === "done" && <span className="tb-mark done">✓</span>}
              {b.status === "err" && <span className="tb-mark err">×</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
