// Event → graph reducer. Pure-ish: same events in any order = same end state.
import type { AgentNodeData, HookEnvelope, HookPayload, TokenUsage, ToolCall } from "./types";

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
}

/** The TTL split of the cache-creation tokens, in either shape it reaches us:
 *  nested under `cache_creation` the way Anthropic writes it into a transcript
 *  line, or flattened onto the totals our own UsageObserved carries. Returns
 *  nothing at all when neither field is present — absent is not zero, and
 *  pricing.ts leans on that to keep a split-less session at the dollars it
 *  already showed. */
function cacheTtlSplit(
  obj: Record<string, unknown>,
): Pick<TokenUsage, "cacheCreate1hTokens" | "cacheCreate5mTokens"> {
  const nested = obj.cache_creation;
  const src = nested && typeof nested === "object"
    ? nested as Record<string, unknown>
    : obj;
  const h1 = src.ephemeral_1h_input_tokens;
  const m5 = src.ephemeral_5m_input_tokens;
  if (typeof h1 !== "number" && typeof m5 !== "number") return {};
  return {
    cacheCreate1hTokens: Number(h1 ?? 0),
    cacheCreate5mTokens: Number(m5 ?? 0),
  };
}

/** Recursively look for a `usage` object with numeric token fields in any
 *  shape Anthropic / CC might deliver (top-level, nested under message, etc.).
 */
function extractUsage(node: unknown, depth = 0): TokenUsage | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  // Direct shape: { input_tokens, output_tokens, ... }
  if (
    typeof obj.input_tokens === "number" ||
    typeof obj.output_tokens === "number" ||
    typeof obj.cache_read_input_tokens === "number" ||
    typeof obj.cache_creation_input_tokens === "number"
  ) {
    return {
      inputTokens: Number(obj.input_tokens ?? 0),
      outputTokens: Number(obj.output_tokens ?? 0),
      cacheReadTokens: Number(obj.cache_read_input_tokens ?? 0),
      cacheCreateTokens: Number(obj.cache_creation_input_tokens ?? 0),
      ...cacheTtlSplit(obj),
    };
  }
  // Nested: { usage: { ... } } or { message: { usage: {...} } } etc.
  for (const v of Object.values(obj)) {
    const u = extractUsage(v, depth + 1);
    if (u) return u;
  }
  return null;
}

function addUsage(into: TokenUsage, add: TokenUsage): void {
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheCreateTokens += add.cacheCreateTokens;
  // Only start tracking the split once something actually reported one, so a
  // provider that never does keeps it undefined rather than pinning it to 0.
  if (add.cacheCreate1hTokens !== undefined || add.cacheCreate5mTokens !== undefined) {
    into.cacheCreate1hTokens = (into.cacheCreate1hTokens ?? 0) + (add.cacheCreate1hTokens ?? 0);
    into.cacheCreate5mTokens = (into.cacheCreate5mTokens ?? 0) + (add.cacheCreate5mTokens ?? 0);
  }
}

/** Model ids we recognise. Claude family: claude-* . Codex family: gpt-*,
 *  o*-, codex-* . The regex is permissive on purpose — Codex publishes new
 *  slugs frequently and we'd rather pick up an unknown gpt variant than
 *  miss it. */
const MODEL_PATTERN = /^(?:claude[-_]|gpt[-_]|o\d|codex[-_])/i;

/** Recursively look for a `model` string anywhere in the payload — both
 *  CCs surface it on different keys per event. Accept Claude or Codex ids. */
function extractModel(node: unknown, depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.model === "string" && MODEL_PATTERN.test(obj.model)) {
    return obj.model;
  }
  for (const v of Object.values(obj)) {
    const m = extractModel(v, depth + 1);
    if (m) return m;
  }
  return null;
}

export interface GraphState {
  agents: Map<string, AgentNodeData>;
  toolIndex: Map<string, ToolCall>;
  /** tool_use_id → owning agent.id, so PostToolUse can settle the right agent's tool. */
  toolOwner: Map<string, string>;
  /** Per-session LIFO stack of active subagent ids — used to attribute incoming
   *  PreToolUse to the deepest live subagent, since CC tool-call hooks don't
   *  carry agent_id themselves. */
  activeSubagentStack: Map<string, string[]>;
  lastSeq: number;
  /** Which server process the `lastSeq` counter belongs to — the `epoch` the
   *  envelopes carry. Stays null while talking to a server too old to stamp it. */
  seqEpoch: string | null;
  totalEvents: number;
}

export function initialState(): GraphState {
  return {
    agents: new Map(),
    toolIndex: new Map(),
    toolOwner: new Map(),
    activeSubagentStack: new Map(),
    lastSeq: 0,
    seqEpoch: null,
    totalEvents: 0,
  };
}

function basename(p?: string): string | undefined {
  if (!p) return undefined;
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function rootAgentId(sessionId: string): string {
  return sessionId;
}

function subagentIdFor(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

/** True if this event explicitly identifies a subagent (vs the root session). */
function isExplicitSubagent(p: HookPayload): boolean {
  return Boolean(p.agent_id || p.parent_tool_use_id);
}

function subagentLabel(p: HookPayload): string {
  return p.agent_type ?? p.subagent_type ?? "subagent";
}

function explicitSubagentKey(p: HookPayload): string | null {
  if (p.agent_id) return p.agent_id;
  if (p.parent_tool_use_id) return p.parent_tool_use_id;
  return null;
}

function ensureRoot(state: GraphState, sessionId: string, now: number, synthetic: boolean): AgentNodeData {
  const id = rootAgentId(sessionId);
  let a = state.agents.get(id);
  if (a) return a;
  a = {
    id,
    sessionId,
    label: "session",
    kind: "root",
    state: "active",
    startedAt: now,
    tools: [],
    prompts: [],
    toolCount: 0,
    childCount: 0,
    synthetic,
    inFlightTool: null,
    usage: emptyUsage(),
  };
  state.agents.set(id, a);
  return a;
}

/** Look up an existing subagent without creating one. Returns null if the
 *  subagent has never been announced via SubagentStart. Used by resolveOwner
 *  so a stray `parent_tool_use_id` on a Stop / PostToolUse / Notification
 *  payload can't manufacture a phantom node at end-of-life. */
function lookupSubagent(state: GraphState, sessionId: string, key: string, p: HookPayload): AgentNodeData | null {
  const id = subagentIdFor(sessionId, key);
  const a = state.agents.get(id);
  if (!a) return null;
  if (!a.cwd && p.cwd) { a.cwd = p.cwd; a.cwdBasename = basename(p.cwd); }
  const lbl = subagentLabel(p);
  if (lbl && (a.label === "subagent" || !a.label)) a.label = lbl;
  return a;
}

/** Resolve which agent owns this event:
 *  - If the payload explicitly names a subagent (agent_id / parent_tool_use_id)
 *    AND that subagent already exists, that subagent is the owner.
 *  - Otherwise, attribute to the deepest currently-active subagent of this
 *    session if any, else to the root session.
 *
 *  Critically, this never CREATES a subagent — only SubagentStart does.
 *  Earlier versions auto-created on first sight of any explicit key, which
 *  manufactured a phantom subagent every time CC included a stray
 *  parent_tool_use_id on a terminal event (Stop, PostToolUse, Notification).
 */
function resolveOwner(state: GraphState, p: HookPayload, now: number): AgentNodeData {
  const sessionId = p.session_id ?? "unknown";
  const explicit = explicitSubagentKey(p);

  if (explicit) {
    const sub = lookupSubagent(state, sessionId, explicit, p);
    if (sub) return sub;
    // Explicit key but no matching subagent — fall through to stack/root
    // attribution rather than fabricating one.
  }

  // No (resolvable) explicit subagent. Attribute to top of active stack.
  const stack = state.activeSubagentStack.get(sessionId);
  const topKey = stack && stack.length > 0 ? stack[stack.length - 1] : null;
  if (topKey) {
    const sub = state.agents.get(subagentIdFor(sessionId, topKey));
    if (sub) {
      if (!sub.cwd && p.cwd) { sub.cwd = p.cwd; sub.cwdBasename = basename(p.cwd); }
      return sub;
    }
  }
  // Fall back to root.
  const root = ensureRoot(state, sessionId, now, /*synthetic*/ false);
  if (root.synthetic) { root.synthetic = false; root.startedAt = now; }
  if (!root.cwd && p.cwd) { root.cwd = p.cwd; root.cwdBasename = basename(p.cwd); }
  if (root.label === "session" && p.cwd) root.label = basename(p.cwd) ?? "session";
  return root;
}

function ensureSubagent(state: GraphState, sessionId: string, key: string, p: HookPayload, now: number): AgentNodeData {
  const id = subagentIdFor(sessionId, key);
  // Make sure root exists; it may still be synthetic if we never saw a root event.
  const root = ensureRoot(state, sessionId, now, /*synthetic*/ true);

  let a = state.agents.get(id);
  if (a) {
    if (!a.cwd && p.cwd) { a.cwd = p.cwd; a.cwdBasename = basename(p.cwd); }
    const lbl = subagentLabel(p);
    if (lbl && (a.label === "subagent" || !a.label)) a.label = lbl;
    return a;
  }
  a = {
    id,
    sessionId,
    label: subagentLabel(p),
    kind: "subagent",
    parentId: root.id,
    state: "active",
    startedAt: now,
    tools: [],
    prompts: [],
    cwd: p.cwd,
    cwdBasename: basename(p.cwd),
    toolCount: 0,
    childCount: 0,
    inFlightTool: null,
    usage: emptyUsage(),
  };
  state.agents.set(id, a);
  root.childCount += 1;
  return a;
}

function pushActive(state: GraphState, sessionId: string, key: string): void {
  const arr = state.activeSubagentStack.get(sessionId) ?? [];
  // A SubagentStart can be delivered more than once — several live decks
  // appending to one events.jsonl, a hook retry, a replay of a log region whose
  // Stop only ever arrived live — and every copy carries a fresh seq, so the
  // epoch guard lets it through. Pushing unconditionally then stranded the
  // surplus copies: popActive removes exactly one, and each leftover kept
  // resolveOwner handing the root's own traffic (its UserPromptSubmit and all
  // its Pre/PostToolUse, none of which carries an agent_id) to a subagent that
  // had already finished — which UserPromptSubmit flipped back to 'active' with
  // endedAt cleared, past the reach of pruneOldAgents forever. A key already on
  // the stack is a re-delivery, never depth: one subagent runs once.
  if (arr.includes(key)) return;
  arr.push(key);
  state.activeSubagentStack.set(sessionId, arr);
}

function popActive(state: GraphState, sessionId: string, key: string): void {
  const arr = state.activeSubagentStack.get(sessionId);
  if (!arr) return;
  // Remove the last occurrence of this key (subagent may not be stack top if
  // multiple are running in parallel and one finishes out of order).
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === key) { arr.splice(i, 1); break; }
  }
  if (arr.length === 0) state.activeSubagentStack.delete(sessionId);
}

function shortPreview(input: any, max = 80): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > max ? input.slice(0, max - 1) + "…" : input;
  try {
    const s = JSON.stringify(input);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  } catch {
    return String(input);
  }
}

function refreshInFlight(a: AgentNodeData): void {
  // Most recently started, not-yet-ended tool.
  let latest: ToolCall | null = null;
  for (let i = a.tools.length - 1; i >= 0; i--) {
    const t = a.tools[i];
    if (t.endedAt == null) { latest = t; break; }
  }
  a.inFlightTool = latest;
}

/** How many ToolCalls we keep per agent. A root session left open all day
 *  makes thousands of calls and nothing used to drop any of them — the agent
 *  caps below only evict whole finished agents/sessions, so one long-lived
 *  session grew forever. The canvas only draws the last handful of bubbles and
 *  the detail panel renders one DOM row per entry, so a bounded window is all
 *  the UI can show anyway; `toolCount` keeps counting every call ever made, so
 *  the totals on the cards stay honest. */
export const MAX_TOOLS_PER_AGENT = 200;

/** How many of those retained calls keep their full `tool_input` /
 *  `tool_response` blobs. Those two fields are the only heavy ones — the
 *  server ingests payloads up to 5MB, so a few big Reads or a chatty Bash run
 *  are megabytes each — and the tool modal is the only reader. Everything else
 *  on a ToolCall (name, the 80-char previews, timing, ok, usage) is tiny and
 *  is kept for the whole window, so the bubbles, the activity strip, the
 *  sparkline, the recap and the search index are unaffected. */
export const TOOL_BLOB_WINDOW = 25;

/** Bound one agent's tool history in place. Drops the oldest entries once the
 *  list passes `MAX_TOOLS_PER_AGENT`, and releases the heavy input/response
 *  blobs of every entry older than `TOOL_BLOB_WINDOW`, flagging them so the
 *  modal can say the payload was dropped rather than render an empty box. */
function trimTools(state: GraphState, a: AgentNodeData): void {
  const tools = a.tools;
  if (tools.length > MAX_TOOLS_PER_AGENT) {
    const dropped = tools.splice(0, tools.length - MAX_TOOLS_PER_AGENT);
    let hadInFlight = false;
    for (const t of dropped) {
      // An evicted call can still be in-flight; leaving it in the live index
      // would strand an entry no PostToolUse or stale sweep can ever reach.
      if (state.toolIndex.delete(t.id)) hadInFlight = true;
      state.toolOwner.delete(t.id);
    }
    if (hadInFlight) refreshInFlight(a);
  }
  // Entries below the blob window are always trimmed already, so this walks
  // back only over the ones that just crossed it (normally exactly one).
  for (let i = tools.length - TOOL_BLOB_WINDOW - 1; i >= 0; i--) {
    const t = tools[i];
    if (t.trimmed) break;
    t.input = undefined;
    t.response = undefined;
    t.trimmed = true;
  }
}

/** Find the ToolCall already recorded under `id`, or null if this is the first
 *  time we see it. `toolIndex` answers for every call still in flight no matter
 *  which agent owns it; a call that has already settled (or was swept stale) is
 *  gone from the index, so fall back to the resolved owner's own history, newest
 *  first. Anything older than that window was evicted by `trimTools` and is
 *  deliberately not resurrected — it is off the board for good. */
function findTool(state: GraphState, owner: AgentNodeData, id: string): ToolCall | null {
  const live = state.toolIndex.get(id);
  if (live) return live;
  for (let i = owner.tools.length - 1; i >= 0; i--) {
    if (owner.tools[i].id === id) return owner.tools[i];
  }
  return null;
}

/** How far apart two identical prompt submissions can land and still be one
 *  submission arriving twice rather than the user typing the same thing again.
 *  Every copy is stamped by the process that handled it: a log replay carries
 *  the original writer's `receivedAt` and lands on the same millisecond, while
 *  the hook's fan-out has each deck stamp its own arrival — milliseconds apart,
 *  and bounded by the hook's own 1500ms hard cap on that whole fan-out. A
 *  genuine second submission of the same text cannot land inside this window:
 *  the turn the first one opened has to end first. */
export const PROMPT_REDELIVERY_WINDOW_MS = 2_000;

/** True when `text` is already on this agent's prompt list from a submission
 *  close enough in time to be the same one. Walks newest-first and stops at the
 *  first entry that predates the window — the list is in arrival order, so
 *  everything before it is older still. Entries *newer* than the window are
 *  skipped rather than stopped on: a boot replay re-delivers a whole log, so
 *  the copy of an old prompt arrives after every later prompt is recorded. */
function promptAlreadyRecorded(a: AgentNodeData, at: number, text: string): boolean {
  for (let i = a.prompts.length - 1; i >= 0; i--) {
    const prev = a.prompts[i];
    if (prev.at < at - PROMPT_REDELIVERY_WINDOW_MS) return false;
    if (prev.text === text && prev.at <= at + PROMPT_REDELIVERY_WINDOW_MS) return true;
  }
  return false;
}

/** Evict the oldest "done" agents when the agents map exceeds `cap`. Only
 *  considers agents whose endedAt is older than `graceMs` so freshly-done
 *  agents (still in fade-out) aren't yanked from under the user. Mutates
 *  state in place. Returns true when at least one agent was removed. */
export function pruneOldAgents(state: GraphState, now: number, cap: number, graceMs: number): boolean {
  if (state.agents.size <= cap) return false;
  const stale: Array<{ id: string; endedAt: number }> = [];
  for (const [id, a] of state.agents) {
    if (a.state === "done" && a.endedAt != null && now - a.endedAt > graceMs) {
      stale.push({ id, endedAt: a.endedAt });
    }
  }
  if (stale.length === 0) return false;
  stale.sort((x, y) => x.endedAt - y.endedAt); // oldest first
  let removed = 0;
  for (const c of stale) {
    if (state.agents.size <= cap) break;
    state.agents.delete(c.id);
    removed++;
  }
  return removed > 0;
}

/** Keep at most `cap` finished sessions on the board, dropping the ones that
 *  finished longest ago. A day of heavy use leaves hundreds of completed
 *  sessions parked on the canvas, which buries the handful that are actually
 *  current; the total-agent cap above doesn't help because it only fires at
 *  200 nodes and counts running work too.
 *
 *  Sessions are evicted whole — a session counts as finished only when every
 *  agent in it is done, so a subagent still running keeps its whole tree, and
 *  removing a root never orphans a child. `graceMs` after the last agent
 *  finishes, the session is still exempt so nothing vanishes mid-fade-out.
 *  Mutates state in place; returns true when anything was removed. */
export function pruneDoneSessions(state: GraphState, now: number, cap: number, graceMs: number): boolean {
  // sessionId -> { agent ids, latest endedAt, whether anything is still live }
  const sessions = new Map<string, { ids: string[]; endedAt: number; live: boolean }>();
  for (const [id, a] of state.agents) {
    let s = sessions.get(a.sessionId);
    if (!s) { s = { ids: [], endedAt: 0, live: false }; sessions.set(a.sessionId, s); }
    s.ids.push(id);
    if (a.state === "done" && a.endedAt != null) s.endedAt = Math.max(s.endedAt, a.endedAt);
    else s.live = true;
  }

  const finished = [...sessions.values()]
    .filter(s => !s.live && s.endedAt > 0 && now - s.endedAt > graceMs)
    .sort((x, y) => x.endedAt - y.endedAt); // oldest-finished first

  // Sessions still inside the grace period already count against the cap, so
  // the board settles at `cap` rather than briefly overshooting it.
  const finishedTotal = [...sessions.values()].filter(s => !s.live).length;
  let over = finishedTotal - cap;
  if (over <= 0) return false;

  let removed = false;
  for (const s of finished) {
    if (over <= 0) break;
    for (const id of s.ids) state.agents.delete(id);
    over--;
    removed = true;
  }
  return removed;
}

/** Sweep over every agent's tool list and finalise any tool that has been
 *  "in-flight" longer than `maxMs` — usually because a hook event was lost
 *  (session killed mid-call, PostToolUse never delivered). Without this they
 *  pulse forever in the burst layer and pollute the in-flight counter.
 *  Returns true when at least one tool was staled, so callers can trigger
 *  a re-render. Mutates state in place. */
export function sweepStaleTools(state: GraphState, now: number, maxMs: number): boolean {
  let changed = false;
  for (const a of state.agents.values()) {
    let agentTouched = false;
    for (const t of a.tools) {
      if (t.endedAt == null && now - t.startedAt > maxMs) {
        t.endedAt = t.startedAt + maxMs;
        t.ok = false;
        t.errorPreview = "stale (no PostToolUse received)";
        // Also drop it from the live tool index so a late PostToolUse won't
        // try to settle it after the fact.
        state.toolIndex.delete(t.id);
        state.toolOwner.delete(t.id);
        agentTouched = true;
        changed = true;
      }
    }
    if (agentTouched) refreshInFlight(a);
  }
  return changed;
}

export function applyEvent(state: GraphState, env: HookEnvelope): GraphState {
  // `seq` is only monotonic *within one server process*. A restart re-derives
  // the counter by replaying events.jsonl, so after a log rotation or an
  // /api/clear the fresh counter can start far below the seq this tab already
  // saw — and the tab keeps its state (and the browser its Last-Event-ID)
  // across EventSource reconnects. A bare `seq <= lastSeq` guard therefore
  // dropped every live event from the new process and froze the canvas until
  // the counter organically climbed past the old value, which can take days.
  // The server stamps a per-boot `epoch`; a new one rebases the guard instead
  // of silencing the stream. Servers too old to stamp it send no epoch, and
  // those keep the plain monotonic behaviour.
  const epoch = env.epoch ?? null;
  if (epoch !== null && epoch !== state.seqEpoch) {
    state.seqEpoch = epoch;
    state.lastSeq = 0;
  } else if (env.seq <= state.lastSeq) {
    return state;
  }

  const p = env.payload ?? {};
  const now = env.receivedAt;
  const name = p.hook_event_name ?? "Unknown";

  if (name === "__clear") {
    return { ...initialState(), lastSeq: env.seq, seqEpoch: state.seqEpoch };
  }

  state.totalEvents += 1;
  state.lastSeq = env.seq;

  const sessionId = p.session_id ?? "unknown";

  // Codex reports the session's real context window on `task_started`, and the
  // server relays it on a ModelObserved payload — the only event that carries
  // it. This has to run *before* the enrichment branches below, all of which
  // return early, otherwise the value never lands anywhere. It is a property
  // of the session, so it goes on the root; the UI prefers it over the static
  // table in pricing.ts.
  if (typeof p.model_context_window === "number" && p.model_context_window > 0) {
    const root = state.agents.get(sessionId);
    if (root) root.contextWindow = p.model_context_window;
  }

  // ModelObserved is a synthetic enrichment event emitted by the server
  // after it scans the root session's transcript file. Apply to the ROOT
  // agent only — subagents may run under a different model (Sonnet child
  // of an Opus parent etc.), and blanket-overwriting per session would
  // clobber the subagent's own model with whatever the root just used.
  // Per-subagent models arrive via `subagentModels` map when the server
  // can attribute transcript blocks via `isSidechain`/`parentToolUseID`.
  if (name === "ModelObserved") {
    const m = typeof p.model === "string" ? p.model : null;
    if (m) {
      const root = state.agents.get(sessionId);
      if (root) root.model = m;
    }
    const subs = p.subagentModels as Record<string, string> | undefined;
    if (subs && typeof subs === "object") {
      for (const [parentToolUseId, subModel] of Object.entries(subs)) {
        if (typeof subModel !== "string") continue;
        const subId = `${sessionId}::${parentToolUseId}`;
        const sub = state.agents.get(subId);
        if (sub) sub.model = subModel;
      }
    }
    return state;
  }

  // ContextObserved carries the structural breakdown of the session's context
  // window (message counts, CLAUDE.md files, current window size) that the
  // context donut and ContextModal read. Session root only.
  if (name === "ContextObserved") {
    const ctx = (p.context ?? null) as Record<string, unknown> | null;
    if (ctx) {
      const root = state.agents.get(sessionId);
      if (root) {
        root.context = {
          msgsUser: Number(ctx.msgsUser ?? 0),
          msgsAssistant: Number(ctx.msgsAssistant ?? 0),
          toolUses: Number(ctx.toolUses ?? 0),
          toolResults: Number(ctx.toolResults ?? 0),
          systemReminders: Number(ctx.systemReminders ?? 0),
          currentContextTokens: Number(ctx.currentContextTokens ?? 0),
          claudeMdFiles: Array.isArray(ctx.claudeMdFiles)
            ? (ctx.claudeMdFiles as Array<{ path: string; bytes: number }>)
            : [],
        };
      }
    }
    return state;
  }

  // UsageObserved carries cumulative session usage from the transcript.
  // Overwrite (not add) the session root's usage with the totals — the
  // server re-reads on every event, so this is always the running total.
  // Subagents stay at zero; the SessionList / SessionSummary roll up at
  // the session level so the user sees correct numbers regardless.
  if (name === "UsageObserved") {
    const u = (p.usage ?? null) as Record<string, unknown> | null;
    if (u) {
      const root = state.agents.get(sessionId);
      if (root) {
        // Codex emits `cached_input_tokens` (single underscore); Claude
        // transcripts use `cache_read_input_tokens` / `cache_creation_…`.
        // Accept both shapes — whichever provider's reader emitted this.
        root.usage.inputTokens = Number(u.input_tokens ?? 0);
        root.usage.outputTokens = Number(u.output_tokens ?? 0);
        root.usage.cacheReadTokens = Number(
          u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0,
        );
        root.usage.cacheCreateTokens = Number(u.cache_creation_input_tokens ?? 0);
        // Overwrite, not merge: these are cumulative totals for the whole
        // transcript, so a pass that saw no split must clear a stale one.
        const ttl = cacheTtlSplit(u);
        root.usage.cacheCreate1hTokens = ttl.cacheCreate1hTokens;
        root.usage.cacheCreate5mTokens = ttl.cacheCreate5mTokens;
        if (typeof u.reasoning_output_tokens === "number") {
          root.usage.reasoningOutputTokens = Number(u.reasoning_output_tokens);
        }
      }
    }
    return state;
  }

  const owner = resolveOwner(state, p, now);

  // Stamp provider on first observation. Defaults to "claude" for legacy
  // events recorded before multi-provider support.
  if (!owner.provider) {
    owner.provider = p.provider === "codex" ? "codex" : "claude";
  }

  // Snapshot model whenever it shows up in the payload — we want the most
  // recent observation per owner since either CLI can switch models mid-session.
  const observedModel = extractModel(p);
  if (observedModel) owner.model = observedModel;

  switch (name) {
    case "SessionStart": {
      const root = ensureRoot(state, sessionId, now, false);
      root.synthetic = false;
      root.state = "active";
      root.startedAt = root.startedAt || now;
      if (!root.cwd && p.cwd) { root.cwd = p.cwd; root.cwdBasename = basename(p.cwd); }
      if (root.label === "session" && p.cwd) root.label = basename(p.cwd) ?? "session";
      break;
    }
    case "UserPromptSubmit": {
      // New turn — retire done subagents from prior turns so canvas focuses
      // on the current request. Same logic works for live AND replay:
      //   - live: exitAt = wall-clock now → 600ms fade-out animation
      //   - replay: exitAt = event time (old) → already past EXIT_ANIM_MS
      //     window when first render hits → prior turns never visually
      //     appear on refresh (no flash-then-vanish)
      // The previous "exitAt-stamping causes vanish" suspicion was wrong;
      // real cause was ReactFlow wiping width/height on every setNodes (fix
      // in snapshotToFlow). With that fixed, retirement is safe.
      for (const other of state.agents.values()) {
        if (
          other.sessionId === sessionId && other.kind === "subagent" &&
          other.state === "done" && other.exitAt == null &&
          other.endedAt != null && other.endedAt < now
        ) {
          other.exitAt = now;
        }
      }
      const root = ensureRoot(state, sessionId, now, false);
      root.state = "active";
      root.endedAt = undefined;
      root.exitAt = undefined;

      const target = resolveOwner(state, p, now);
      target.state = "active";
      target.exitAt = undefined;
      target.endedAt = undefined;
      const text = (typeof p.prompt === "string" ? p.prompt : typeof p.message === "string" ? p.message : "") ?? "";
      // One submission can be delivered more than once — the hook posts it to
      // every deck whose workspace matches, a restart replays the log region it
      // already streamed live, and each copy carries a fresh seq so the
      // seq/epoch guard lets it through. Appending unconditionally recorded the
      // same turn once per copy: the detail panel counted 'Prompts 3' and listed
      // the text three times, SessionSummary's promptCount reported three times
      // the turns the session actually had, and nothing ever trims the list, so
      // every surplus copy of the full prompt text was retained for the agent's
      // lifetime. A prompt has no id of its own, so identity is its text plus
      // the moment it arrived.
      if (text && !promptAlreadyRecorded(target, now, text)) {
        target.prompts.push({ at: now, text });
        if (!target.firstPrompt) target.firstPrompt = shortPreview(text, 120);
      }
      break;
    }
    case "PreToolUse": {
      // The same tool_use_id can be delivered more than once — several live
      // decks appending to one events.jsonl, a hook retry, a log replay after a
      // restart. The seq/epoch guard at the top only rejects a replay of the
      // *same* seq, so those re-deliveries used to append a second ToolCall
      // under an id the agent already had, and the damage was permanent:
      // `toolIndex` kept only the newest copy, so PostToolUse could never
      // settle the earlier ones, `sweepStaleTools` later stamped them failed
      // (a red × on calls that actually succeeded), and both `toolCount` and
      // the in-flight backlog counted every copy. Treat a known id as the call
      // we already have and refresh it in place instead.
      const known = p.tool_use_id ? findTool(state, owner, p.tool_use_id) : null;
      if (known) {
        if (p.tool_name && known.name === "?") known.name = p.tool_name;
        // Never reopen a call that has already settled, and never re-attach a
        // payload `trimTools` released — nothing would ever drop it again.
        if (known.endedAt == null && !known.trimmed && p.tool_input !== undefined) {
          known.input = p.tool_input;
          known.inputPreview = shortPreview(p.tool_input);
        }
        break;
      }
      // Only a genuinely new call gets past here, so `toolCount` still advances
      // exactly once per pushed entry and the synthesised id below stays unique.
      const id = p.tool_use_id ?? `${owner.id}:${owner.toolCount}`;
      const tc: ToolCall = {
        id,
        name: p.tool_name ?? "?",
        input: p.tool_input,
        inputPreview: shortPreview(p.tool_input),
        agentId: owner.id,
        startedAt: now,
      };
      owner.tools.push(tc);
      owner.toolCount += 1;
      owner.state = "active";
      state.toolIndex.set(id, tc);
      state.toolOwner.set(id, owner.id);
      refreshInFlight(owner);
      trimTools(state, owner);
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const id = p.tool_use_id;
      if (!id) break;
      let tc = state.toolIndex.get(id);
      let resurrected = false;
      // If the tool isn't in the live index it may have been swept stale
      // — look it up in its owner's tools array and resurrect it. Without
      // this, a slow PostToolUse arriving after the 90s stale cutoff was
      // silently dropped and the tool stayed marked failed forever even
      // when it actually completed.
      if (!tc) {
        for (const a of state.agents.values()) {
          const found = a.tools.find(x => x.id === id);
          if (found) { tc = found; resurrected = true; break; }
        }
      }
      if (!tc) break;
      tc.endedAt = now;
      tc.ok = name === "PostToolUse";
      // A response arriving for an already-trimmed call must not re-attach the
      // blob we just released — nothing would ever drop it again.
      if (!tc.trimmed) tc.response = p.tool_response;
      if (name === "PostToolUseFailure") {
        tc.errorPreview = shortPreview(p.tool_response);
      } else if (resurrected) {
        // A late success — clear the "stale" marker the sweep wrote.
        tc.errorPreview = undefined;
      }
      const usage = extractUsage(p.tool_response);
      if (usage) tc.usage = usage;
      state.toolIndex.delete(id);
      const ownerId = state.toolOwner.get(id) ?? tc.agentId;
      state.toolOwner.delete(id);
      if (ownerId) {
        const oa = state.agents.get(ownerId);
        if (oa) {
          if (usage) addUsage(oa.usage, usage);
          refreshInFlight(oa);
        }
      }
      break;
    }
    case "SubagentStart": {
      const key = explicitSubagentKey(p);
      if (!key) break;
      const sub = ensureSubagent(state, sessionId, key, p, now);
      sub.state = "active";
      sub.startedAt = sub.startedAt || now;
      // Resurrected subagent: a prior UserPromptSubmit flagged exitAt while
      // this slot was "done". If CC reuses the key (common when Task is
      // re-invoked with the same parent_tool_use_id), the agent must come
      // back fully visible — not get filtered out after EXIT_ANIM_MS.
      sub.exitAt = undefined;
      sub.endedAt = undefined;
      const lbl = subagentLabel(p);
      if (lbl) sub.label = lbl;
      pushActive(state, sessionId, key);
      break;
    }
    case "SubagentStop": {
      const key = explicitSubagentKey(p);
      if (!key) break;
      // Lookup, don't create — a Stop without a prior Start is a no-op,
      // not a reason to manifest a phantom node.
      const sub = lookupSubagent(state, sessionId, key, p);
      if (!sub) break;
      sub.state = "done";
      sub.endedAt = now;
      refreshInFlight(sub);
      popActive(state, sessionId, key);
      break;
    }
    case "Stop":
    case "SessionEnd": {
      // Mark the root done; leave the subagent nodes alone (they have their
      // own Stop), but drop the session's attribution stack. Keys land there
      // on SubagentStart and used to come off only on SubagentStop, and hook
      // POSTs are fire-and-forget — one sent while the server was restarting
      // is gone for good. A key left behind then swallows every later event
      // that carries no agent_id, which is all the real UserPromptSubmit and
      // Pre/PostToolUse traffic: the user's next prompt and the root's tool
      // calls render under a subagent that finished long ago, and replay
      // rebuilds the same wrong state on refresh. The root's turn cannot end
      // while a Task is still running, so by here nothing on the stack is live.
      const root = ensureRoot(state, sessionId, now, false);
      root.state = "done";
      root.endedAt = now;
      refreshInFlight(root);
      state.activeSubagentStack.delete(sessionId);
      break;
    }
    case "Notification": {
      break;
    }
  }

  return state;
}

/** Deterministic per-session hue (0–360). Used to give each session a calm accent. */
export function sessionHue(sessionId: string): number {
  let h = 5381;
  for (let i = 0; i < sessionId.length; i++) h = ((h << 5) + h) ^ sessionId.charCodeAt(i);
  return Math.abs(h) % 360;
}
