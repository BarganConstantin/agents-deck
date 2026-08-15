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
  /** Set once this call fell out of the reducer's blob window and its `input`
   *  / `response` were released to keep the tab's heap bounded. The previews
   *  survive; the modal tells the user the full payload is gone. */
  trimmed?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Claude-only: how `cacheCreateTokens` splits across cache TTLs, from
   *  `usage.cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens`. A
   *  1-hour write costs 2× base input against the 5-minute 1.25×, and CC
   *  writes 1-hour caches for most of its prefix, so the two are not
   *  interchangeable. Left undefined when the source carried no split
   *  (Codex, transcripts written before CC emitted one) — pricing.ts bills
   *  everything the split doesn't cover at the 5-minute rate. */
  cacheCreate1hTokens?: number;
  cacheCreate5mTokens?: number;
  /** Codex-only: reasoning_output_tokens from o-series / gpt-5 reasoning
   *  models. Carried separately so the UI can surface it without polluting
   *  Claude usage math (Claude doesn't emit this bucket). */
  reasoningOutputTokens?: number;
}

export interface PromptEntry {
  at: number;
  text: string;
}

/** Claude Code is blocked on a human, and which chore that is. `Notification`
 *  emits exactly two kinds and they are different jobs: `permission_prompt` is
 *  a decision you owe a session that is still mid-turn, `idle_prompt` is a turn
 *  that ended about a minute ago and is waiting for your next instruction. */
export interface WaitingBlock {
  kind: "permission" | "idle";
  /** CC's own wording, shown verbatim — it is the only human sentence we get.
   *  The payload carries no tool_name and no tool_input, so this and the kind
   *  are the whole of what the deck honestly knows about the block. */
  message: string;
  /** When the block started, from the envelope's `receivedAt`. Never re-stamped
   *  by a duplicate delivery, or the "waiting 4m" readout on the card resets to
   *  zero every time a second deck's copy of the same notification lands. */
  since: number;
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
  /** Set while Claude Code is blocked on a human. Rides ALONGSIDE `state`
   *  rather than being a fourth AgentState, because waiting is orthogonal to
   *  running and folding it in would destroy information in both directions: a
   *  permission prompt arrives mid-turn and the session is still active, an
   *  idle prompt arrives after Stop and the session is still done. Null (or
   *  absent) whenever the session is not blocked. Only the root agent carries
   *  it — `Notification` has no parent_tool_use_id to attribute to a subagent,
   *  and the block is on the session as a whole. Always null for Codex, which
   *  reconstructs its stream from rollout files and emits no notification at
   *  all; absence of the signal there is not evidence of no block. */
  waiting?: WaitingBlock | null;
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
  /** Identifies the server process that assigned `seq`. The counter restarts
   *  at 1 on every boot, so a changed epoch means "the numbering restarted,
   *  don't compare this seq with the previous one". Absent on older servers. */
  epoch?: string;
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
  /** Claude-only, on `Notification`: which of the two blocks this is —
   *  "permission_prompt" or "idle_prompt". `message` beside it is the sentence
   *  CC would have printed in the terminal. */
  notification_type?: string;
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
