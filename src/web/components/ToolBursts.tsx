// Overlay that renders a small "tool bubble" next to each agent for every
// tool call that is in-flight or recently completed. Bubbles literally fly
// out FROM the agent's centre (via per-bubble --spawn-dx/dy custom
// properties) and fade out ~LIFETIME_MS after the tool finishes. They live
// on a layer above React Flow's nodes and follow the canvas pan/zoom via
// useViewport().
import React from "react";
import { useViewport } from "reactflow";
import type { AgentNodeData, ToolCall } from "../types";

const LIFETIME_MS = 4000;
const FADE_MS = 600;
const MAX_PER_AGENT = 4;
const BUBBLE_VERT_GAP = 44;
const BUBBLE_HALF_H = 16;
const BUBBLE_OFFSET_X = 52;
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
  WebFetch_: "🌐",
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

/** Single entry point that picks whichever skin applies (shell first, then
 *  file). Keeps collectBursts callers from caring about tool families. */
function skinFor(toolName: string, input: unknown): CommandSkin | null {
  return skinForShellCall(toolName, input) ?? skinForFileCall(toolName, input);
}

type Status = "inflight" | "done" | "err";

function statusOf(t: ToolCall): Status {
  if (t.endedAt == null) return "inflight";
  return t.ok === false ? "err" : "done";
}

function fadeAt(t: ToolCall, now: number): number {
  if (t.endedAt == null) return 1;
  const since = now - t.endedAt;
  if (since < LIFETIME_MS) return 1;
  return Math.max(0, 1 - (since - LIFETIME_MS) / FADE_MS);
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
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  now: number,
): Burst[] {
  const out: Burst[] = [];
  for (const a of agents.values()) {
    if (a.exitAt != null && now - a.exitAt > 600) continue;
    // Read position from the SAME source that feeds ReactFlow's nodes prop.
    // Reading from ReactFlow's nodeInternals (its computed mirror) lagged
    // one frame behind during layout reflows — that produced the "bursts
    // floating with no agents" state when dagre repositioned everything.
    const pos = pinned.get(a.id) ?? positions.get(a.id);
    if (!pos) continue; // no position yet — agent not laid out
    const visible = a.tools.filter(t => {
      if (t.endedAt == null) return true;
      return now - t.endedAt < LIFETIME_MS + FADE_MS;
    }).slice(-MAX_PER_AGENT);
    if (visible.length === 0) continue;
    const size = measured.get(a.id);
    const aW = size?.width ?? 240;
    const aH = size?.height ?? 130;
    const aX = pos.x;
    const aY = pos.y;
    const anchorX = aX + aW;
    const anchorY = aY + aH / 2;
    const lastIdx = visible.length - 1;
    visible.forEach((t, idx) => {
      const offsetY = (idx - lastIdx / 2) * BUBBLE_VERT_GAP;
      const worldX = aX + aW + BUBBLE_OFFSET_X;
      const worldY = aY + aH / 2 + offsetY - BUBBLE_HALF_H;
      const fade = fadeAt(t, now);
      // The delta is from the bubble's anchor point (its visual left-centre)
      // back to the agent's right edge. The bubble starts there during spawn
      // and rides outward to its resting place.
      const inputPreview = t.inputPreview ?? "";
      const status = statusOf(t);
      const fading = fade < 0.999;
      // Primary bubble — the actual tool name as CC reported it.
      out.push({
        id: t.id,
        toolId: t.id,
        agentId: a.id,
        toolName: t.name,
        name: t.name,
        emoji: emojiFor(t.name),
        status,
        category: categoryFor(t.name),
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
  /** Same maps that feed ReactFlow's `nodes` prop. Reading from these means
   *  bursts and agents share a single source of truth for positions — they
   *  can never disagree, even mid-reflow. */
  positions: Map<string, { x: number; y: number }>;
  pinned: Map<string, { x: number; y: number }>;
  measured: Map<string, { width: number; height: number }>;
  now: number;
  /** Open the existing ToolModal for the given tool id. */
  onOpenTool?: (toolId: string) => void;
}

export default function ToolBursts({ agents, positions, pinned, measured, now, onOpenTool }: ToolBurstsProps) {
  const { x, y, zoom } = useViewport();
  const bursts = collectBursts(agents, positions, pinned, measured, now);
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
          return (
            <path
              key={`l:${b.id}`}
              d={`M ${sx} ${sy} Q ${cx} ${sy}, ${tx} ${ty}`}
              className={`tool-conn status-${b.status}${b.fading ? " fading" : ""}`}
              opacity={b.fade}
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
        return (
          <div key={b.id} className="tool-burst-wrap" style={wrapStyle}>
            <div
              className={`tool-burst cat-${b.category} status-${b.status}${b.fading ? " fading" : ""}${clickable ? " clickable" : ""}${b.isSub ? " sub" : ""}`}
              title={title}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
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
