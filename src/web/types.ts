// Shared types between client modules.

export type AgentState = "active" | "done" | "err";

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
  /** Claude model id observed in this agent's hook payloads, e.g.
   *  "claude-opus-4-7-20250101". Surfaces on the card as "Opus 4.7". */
  model?: string;
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

/** Loose shape - different Claude Code hook events deliver different keys. */
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
  [key: string]: any;
}
