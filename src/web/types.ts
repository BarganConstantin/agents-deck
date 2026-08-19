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
  /** The subagent node id this call's OWN payload named (`${session}::${agent_id}`),
   *  when it named one. Absent means the payload named nobody, which is what the
   *  root's own calls look like.
   *
   *  Not the same question as `agentId`: with a Task in flight the reducer
   *  attributes an unattributed tool call to the deepest live subagent, because
   *  CC's tool hooks did not always carry an agent_id — a heuristic, and the
   *  right one for drawing the call on the canvas. #361's clear rule cannot use
   *  a heuristic: it decides whether a permission block survives, and it must
   *  read what the payload actually said, exactly as it does for the events that
   *  clear the block. */
  explicitSubagentId?: string;
  usage?: TokenUsage;
  /** Set once this call fell out of the reducer's blob window and its `input`
   *  / `response` were released to keep the tab's heap bounded. The previews
   *  survive; the modal tells the user the full payload is gone. */
  trimmed?: boolean;
  /** Set once a `PostToolUse` / `PostToolUseFailure` event has been applied to
   *  THIS call, which is a different fact from `endedAt != null` and is the only
   *  one that answers "may a new outcome still change this record?".
   *
   *  Two writers settle a call and only one of them saw evidence. A real outcome
   *  event reports what the tool did; `sweepStaleTools` stamps a verdict on a
   *  call whose session went quiet, and that verdict is a guess #436 explicitly
   *  allows a late outcome to overturn. `endedAt` cannot tell the two apart —
   *  both write it — and neither can "missing from `toolIndex`", because the
   *  sweep and the settle both delete the entry. So a second delivery of one
   *  outcome and a genuinely late first one arrive at the reducer looking
   *  identical, and `PostToolUse` is the one event whose handler does
   *  arithmetic: it adds the call's usage to its owner, so telling them apart is
   *  the difference between a session's spend and twice a session's spend.
   *
   *  Only an outcome event sets this, so it is exactly that discriminator. It is
   *  the `ToolCall` counterpart of `reaped` on a root (#350) and it exists for
   *  the same reason that flag does: both record WHO settled the node rather
   *  than THAT it is settled, because only the "who" says whether later evidence
   *  is allowed to reopen it. */
  outcomeApplied?: boolean;
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
  /** Which SUBAGENT this permission prompt is about, as that agent's node id
   *  (`${session_id}::${agent_id}`), or absent when the root asked — which is
   *  also what an idle block always is, and what a prompt we could not attribute
   *  falls back to.
   *
   *  The payload names nobody: `Notification` carries no agent_id, no tool_name
   *  and no tool_use_id (see `message` above). What it does have is a position in
   *  the stream — CC runs the PreToolUse hook before it asks for permission, so
   *  the tool call that is about to block is the newest one still in flight on
   *  this session when the notification lands. That is the guess, and it is a
   *  guess; both ways of being wrong land on behaviour the deck already had
   *  before #361, never on something worse.
   *
   *  It exists because #361's rule — subagent-attributed traffic must not clear
   *  the block — otherwise leaves nothing to clear a prompt a SUBAGENT raised:
   *  the human answers, the subagent's own PostToolUse is the next thing that
   *  arrives, and it carries an agent_id. Naming the subagent lets exactly that
   *  event, and nothing its siblings do, take the block away. */
  subagentId?: string;
}

export interface ContextBreakdown {
  msgsUser: number;
  msgsAssistant: number;
  toolUses: number;
  toolResults: number;
  systemReminders: number;
  /** Tokens loaded into the model on the most recent assistant turn —
   *  the actual current context size. Sum-across-calls double-counts the
   *  cached prefix every turn, so we read the LAST usage block instead.
   *
   *  Claude: the last usage block in the transcript, input + cache_read +
   *  cache_creation. Codex: `last_token_usage.total_tokens` off the newest
   *  `token_count` record, which is the CLI's own count rather than an
   *  estimate — see the mapper in index.mjs for why that field and not
   *  `input_tokens` beside it (#399). */
  currentContextTokens: number;
  /** The memory files this session loaded, nearest-first from cwd outwards.
   *
   *  BOTH ECOSYSTEMS, WHICH IS WHY IT IS NOT CALLED `claudeMdFiles` ANY MORE.
   *  It held CLAUDE.md paths and only ever could: the sole producer walked for
   *  CC's filenames, and the Codex path never reached it. Codex reads AGENTS.md
   *  and does not read CLAUDE.md at all — verified against every rollout under
   *  this machine's CODEX_HOME, where `AGENTS.md` appears on 9 lines across 5 of
   *  the 8 files and `CLAUDE.md` on none — so the field now carries whichever of
   *  the two the session's own CLI loads, and ContextModal titles the section
   *  from `provider` rather than asserting one name at both. */
  memoryFiles: Array<{ path: string; bytes: number }>;
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
  /** The name Claude Code gave this session, from the transcript's `agent-name`
   *  records — e.g. "account-management-oauth-flow". Session root only, and
   *  Claude only: a Codex rollout carries no such record, so the field stays
   *  undefined there and the card renders exactly what it always did.
   *
   *  RARE. Present on 18 of the 7,743 transcripts under ~/.claude/projects on
   *  this machine — 0.2%, and 1.1% of the ones over 50 KB. Nothing may be built
   *  on it alone; see `sessionTitle` and session-display.ts.
   *
   *  It is a description, not an address. It is rewritten as the session moves
   *  and two sessions may well share one, which is why it is shown NEXT TO the
   *  session id rather than in place of it. */
  sessionName?: string;
  /** The session's `ai-title` — a sentence, e.g. "Inspect repository to
   *  understand current state".
   *
   *  The COMMON one, by a factor of seventeen: 318 of those 7,743 transcripts
   *  carry it and 25.3% of the ones over 50 KB do, and not one transcript here
   *  has a `sessionName` without also having this. So it is what the card and
   *  the cluster header actually draw most of the time — `sessionName ?? this`,
   *  decided in session-display.ts — rather than tooltip-only as #520 had it.
   *
   *  Often EQUAL to `sessionName` rather than a longer form of it. CC overwrites
   *  the title with the slug once a session has a name — measured at 353 of 685
   *  records in one transcript here, and across the whole sweep every one of the
   *  18 named sessions ends up with the two byte-identical — so the reducer
   *  drops this one when they match, or the tooltip just repeats the card. */
  sessionTitle?: string;
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
  /** The context window the CLI itself reports, which takes precedence over the
   *  static table in pricing.ts when present.
   *
   *  NOT from `session_meta`, as this said until #399 went looking: that record
   *  does carry a `context_window` key, but it holds `{ window_id }` — the id of
   *  the terminal window — and no token count at all. The number comes from
   *  `event_msg/task_started` and from every `event_msg/token_count`, which is
   *  why a session now has it from its first usage record rather than from its
   *  next turn.
   *
   *  It is a property of the model and does not move: 258,400 on all 236
   *  records that carry it across the rollouts sampled here, two CLI versions
   *  and two models, changing mid-session in none of them. "Live" means the CLI
   *  said it rather than the deck guessed it — and the guess for the same model
   *  is 1,050,000, so the difference is the whole readout. */
  contextWindow?: number;
  /** Codex-only: `approval_policy` off the newest `turn_context` in the rollout
   *  — "never", "on-request", "on-failure", "untrusted". Only the root carries
   *  it, because it is a property of the session and not of any one agent.
   *
   *  It exists because it is the only recorded fact that says whether this
   *  session can stop and ask a human AT ALL, and the deck has no other way to
   *  know: Codex emits no notification and writes no approval record, so
   *  `waiting` below is permanently null here and every alarm surface is
   *  structurally blind to a blocked Codex session. This does not
   *  make the block visible — nothing can — it makes the BLINDNESS visible, on
   *  the sessions where it can cost something. codex-approval.ts holds the rule
   *  and the reason it is never fed into `isAlarming`. */
  approvalPolicy?: string;
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
  /** When this session was last heard from: the newest `receivedAt` of any
   *  event carrying its session id, whichever agent that event was attributed
   *  to. Only the root carries it, for the same reason only the root carries
   *  `waiting` — a subagent's tool call is still the session moving, and being
   *  stale is a property of the session as a whole.
   *
   *  Nothing else on this type answers the question. `startedAt` never advances
   *  after the first event, `endedAt` is set only by a Stop the dead session
   *  never sent, and the `lastActivity` SessionList derives from
   *  `endedAt ?? startedAt` therefore stands still for the entire life of a
   *  RUNNING session — which is precisely the window `sweepStaleSessions` has
   *  to measure. */
  lastEventAt?: number;
  /** Set when `sweepStaleSessions` settled this root, rather than a `Stop` or a
   *  `SessionEnd` doing it honestly. The flag is what lets a late event undo the
   *  guess: a session reaped after 90 minutes of silence and then heard from
   *  again was alive the whole time, and goes straight back to `active`. Without
   *  it there is no way to tell a reaped root from a genuinely finished one, and
   *  a transcript scan landing after a real `Stop` would un-finish the session. */
  reaped?: boolean;
  /** When the SESSION ended, as opposed to when its last TURN did. Only the
   *  root carries it, and only a real ending writes it: `SessionEnd`, or
   *  `sweepStaleSessions` giving up on a session nothing has been heard from
   *  for `STALE_SESSION_MS`.
   *
   *  It exists because `endedAt` cannot answer that question and was being
   *  asked to (#445). Both providers end a TURN with `Stop` — Claude's Stop hook
   *  fires when the main agent finishes responding, and the Codex watcher maps
   *  `task_complete` / `turn_aborted` onto the same name, deliberately and per
   *  turn (#395) — so `endedAt` on a root means "the last turn finished", which
   *  is true of an idle terminal the user is still sitting in front of and about
   *  to type into. `pruneDoneSessions` read it as "this session is over" and
   *  evicted the terminal two minutes into thinking time; the next prompt then
   *  rebuilt it as a brand-new node with no prompt history, no tool history, no
   *  `firstPrompt`, no model, and `startedAt` reset to now. On this machine's
   *  logs (20,864 envelopes, 22 sessions), 223 of 250 `Stop`s were followed by
   *  another turn on the same session and only 89 of those came back inside the
   *  two-minute grace — so for 60% of turn boundaries the deck was holding a
   *  still-open terminal in the eviction queue.
   *
   *  `reaped` is the neighbouring flag and answers a different question: it says
   *  the ENDING was a guess, so a late event can undo it. This one says the
   *  ending was of the session rather than of a turn, so the pruner can prefer a
   *  session that is genuinely over to one that is merely between turns. A
   *  reaped session sets both — the sweep's whole judgement is that the session
   *  is gone — and the un-reap clears both, because an ending that has been
   *  withdrawn was not an ending.
   *
   *  Absence means "not known to be closed", never "still open": a killed CLI
   *  sends no `SessionEnd` and Codex has no such record at all, which is the
   *  same reason the server refuses to use it as a cache-eviction signal. That
   *  is why it only ever ranks the eviction order and never gates it — the cap
   *  still holds exactly, so a board of nothing but idle sessions still settles
   *  at `cap` with the oldest going first.
   *
   *  Nothing on screen reads it. `state`, `endedAt` and `waiting` are untouched
   *  by it, so the card, the session list, `runningSessionCount` and the favicon
   *  show exactly what they showed before. */
  closedAt?: number;
  /** Server-derived breakdown of what's in the context window. Only the root
   *  agent carries this — subagent context isn't separately observable.
   *
   *  How much of it is filled in depends on the provider, and the modal says so
   *  rather than printing the gaps as zeroes. Claude: an approximation, from a
   *  regex scan of the transcript JSONL plus a cwd walk for CLAUDE.md. Codex:
   *  `currentContextTokens` is the CLI's own figure and exact, `memoryFiles`
   *  comes from a cwd walk for AGENTS.md, and the five composition counts are
   *  not populated at all — the rollout watcher skips a pre-existing session's
   *  history, so counting from the moment the deck attached would be five
   *  confident numbers that are all short (#399). */
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
  /** Claude-only, on the synthetic `SessionNamed`: the session's `agent-name`
   *  and `ai-title` as the transcript cursor last folded them. Either may be
   *  null on a session that has one record but not the other; an absent field
   *  means the scan has nothing to say, never that the name was cleared. */
  sessionName?: string | null;
  sessionTitle?: string | null;
  /** Codex-only: per-turn identifier for tool-call attribution. */
  turn_id?: string;
  /** Codex-only: emitted by sessions/<sid>/event_msg/task_started events,
   *  surfaced by the server-side rollout reader. */
  model_context_window?: number;
  /** Codex-only: the session's approval policy, read off `turn_context` by the
   *  rollout watcher and spread onto every payload it emits — see
   *  `AgentNodeData.approvalPolicy`. */
  approval_policy?: string;
  /** Codex-only: how much of the context window is occupied right now, taken
   *  from `token_count.info.last_token_usage.total_tokens` and carried on the
   *  `UsageObserved` the same record produces. It rides along rather than
   *  arriving as its own event because it is measured by the same record at the
   *  same instant as the usage totals beside it (#399). */
  context_tokens?: number;
  [key: string]: any;
}
