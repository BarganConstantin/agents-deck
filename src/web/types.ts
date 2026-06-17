// Shared types between client modules.

export type AgentState = "active" | "done" | "err";

/** Which CLI emitted the events for this agent. */
export type Provider = "claude" | "codex";

export interface ToolCall {
  id: string;                 // tool_use_id when available, else generated
  name: string;
  inputPreview: string;
  input?: unknown;            // full input (kept for modal)
  response?: unknown;         // full response (kept for modal)
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  errorPreview?: string;
  /** Owning agent id, so callers (modal) can navigate back to source. */
  agentId?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Codex-only: reasoning_output_tokens from o-series / gpt-5 reasoning
   *  models. Carried separately so the UI can surface it without polluting
   *  Claude usage math (Claude doesn't emit this bucket). */
  reasoningOutputTokens?: number;
}

export interface PromptEntry {
  at: number;
  text: string;
}

export interface ContextBreakdown {
  msgsUser: number;
  msgsAssistant: number;
  toolUses: number;
  toolResults: number;
  systemReminders: number;
  /** Tokens loaded into the model on the most recent assistant turn —
   *  the actual current context size. Sum-across-calls double-counts the
   *  cached prefix every turn, so we read the LAST usage block instead. */
  currentContextTokens: number;
  claudeMdFiles: Array<{ path: string; bytes: number }>;
}

export interface AgentNodeData {
  id: string;                 // session_id or `${session}::${parent_tool_use_id}`
  sessionId: string;          // root session id (same as id for root agents)
  label: string;              // human label (workspace basename, subagent_type, etc.)
  kind: "root" | "subagent";
  parentId?: string;
  state: AgentState;
  startedAt: number;
  endedAt?: number;
  tools: ToolCall[];
  cwd?: string;
  cwdBasename?: string;
  firstPrompt?: string;
  prompts: PromptEntry[];
  toolCount: number;
  /** When true, we synthesised this node because a child arrived before any
   *  event from this agent itself (e.g. CC was already running). */
  synthetic?: boolean;
  /** Tool call currently in-flight (most recently started + not yet ended). */
  inFlightTool?: ToolCall | null;
  /** Number of direct subagents spawned by this agent. */
  childCount: number;
  usage: TokenUsage;
  /** Model id observed in this agent's hook payloads. Claude: e.g.
   *  "claude-opus-4-7-20250101". Codex: e.g. "gpt-5.3-codex". Surfaces on
   *  the card as a short label ("Opus 4.7", "GPT-5.3"). */
  model?: string;
  /** Which CLI ecosystem this agent belongs to. Set from the hook payload's
   *  `provider` field on first event; defaults to "claude" for back-compat
   *  with replay events written before multi-provider support. */
  provider?: Provider;
  /** Codex emits the actual model context window in session_meta
   *  (model_context_window). When present, takes precedence over the static
   *  table in pricing.ts. */
  contextWindow?: number;
  /** Set to the timestamp at which this agent should disappear (e.g. a new
   *  turn has started and this subagent already finished). UI plays an exit
   *  animation, then drops it from the canvas. */
  exitAt?: number;
  /** Server-derived structural breakdown of what's in the context window.
   *  Approximation: server reads the transcript JSONL + scans cwd for
   *  CLAUDE.md and emits a synthetic ContextObserved event. Only the root
   *  agent carries this — subagent context isn't separately observable. */
  context?: ContextBreakdown;
}

export interface HookEnvelope {
  seq: number;
  receivedAt: number;
  source: string;
  payload: HookPayload;
  /** Server stamps `true` on events re-sent during the SSE-connect ring-
   *  buffer drain. The reducer uses this to suppress turn-cleanup logic
   *  (e.g. retiring prior-turn subagents on UserPromptSubmit) so refreshing
   *  the page doesn't make every past subagent vanish. */
  replay?: boolean;
}

/** Loose shape — different hook events deliver different keys. Claude Code
 *  and Codex CLI share most fields (session_id, cwd, hook_event_name,
 *  tool_name, model). Codex adds turn_id / permission_mode; Claude adds
 *  transcript_path / agent_id. */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  tool_use_id?: string;
  /** Real CC SubagentStart/Stop payloads. */
  agent_id?: string;
  agent_type?: string;
  /** Synthetic / older alias used by some test fixtures. */
  parent_tool_use_id?: string;
  subagent_type?: string;
  message?: string;
  prompt?: string;
  /** Stamped by hook.js when forwarding. Lets the reducer branch without
   *  re-sniffing payload shape. */
  provider?: Provider;
  /** Codex-only: per-turn identifier for tool-call attribution. */
  turn_id?: string;
  /** Codex-only: emitted by sessions/<sid>/event_msg/task_started events,
   *  surfaced by the server-side rollout reader. */
  model_context_window?: number;
  [key: string]: any;
}
