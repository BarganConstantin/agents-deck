// Event → graph reducer. Pure-ish: same events in any order = same end state.
import type { AgentNodeData, ContextBreakdown, HookEnvelope, HookPayload, TokenUsage, ToolCall, WaitingBlock } from "./types";

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

/** A breakdown that asserts nothing, for a root that has not been told anything
 *  about its context yet.
 *
 *  One function rather than two object literals because the two writers below —
 *  the `context_tokens` stamp and the `ContextObserved` branch — merge into
 *  whatever is already there, and a field that one of them forgot to seed would
 *  read `undefined` where the type promises a number and print "NaN" in the
 *  modal. Adding a field to `ContextBreakdown` should not be able to miss a
 *  starting value in one place and not the other. */
function emptyContextBreakdown(): ContextBreakdown {
  return {
    msgsUser: 0,
    msgsAssistant: 0,
    toolUses: 0,
    toolResults: 0,
    systemReminders: 0,
    currentContextTokens: 0,
    memoryFiles: [],
  };
}

function rootAgentId(sessionId: string): string {
  return sessionId;
}

function subagentIdFor(sessionId: string, agentId: string): string {
  return `${sessionId}::${agentId}`;
}

function subagentLabel(p: HookPayload): string {
  return p.agent_type ?? p.subagent_type ?? "subagent";
}

/** The key under which this event explicitly identifies a subagent, or null
 *  when it belongs to the root session. */
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
    // Seeded here as well as stamped in applyEvent, because the event that
    // creates a root is handled after the stamp has already run and found
    // nothing to write to. A root that was never stamped would read as silent
    // since epoch and be reaped on the first tick after it appeared.
    lastEventAt: now,
    tools: [],
    prompts: [],
    toolCount: 0,
    childCount: 0,
    synthetic,
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
    for (const t of dropped) {
      // An evicted call can still be in-flight; leaving it in the live index
      // would strand an entry no PostToolUse or stale sweep can ever reach.
      //
      // Only where the maps still point at THIS call, which is the guard #443
      // put on `releaseToolIds` and flagged as missing here. A `tool_use_id` does
      // not belong to one `ToolCall` for good: a `PreToolUse` re-delivered after
      // its call settled finds nothing in `toolIndex` and pushes a second call
      // under the same id, re-pointing both maps at it. Deleting by id alone
      // then let the eviction of the OLD copy — which this loop reaches on a
      // window that is 200 calls wide and says nothing about the new one — strand
      // the live call: gone from `toolIndex`, so its own `PostToolUse` could only
      // find it by the resurrection scan and the stale sweep could never settle
      // it, and gone from `toolOwner`, so its usage would be attributed by the
      // `tc.agentId` fallback instead of by the map.
      //
      // `toolIndex` decides for both maps rather than each guarding itself,
      // because the two are written and cleared as a pair and only the index
      // identifies the call itself. `releaseToolIds` can ask `toolOwner` about
      // the agent id it is evicting; here the surviving copy can sit on the very
      // agent whose history is being trimmed — `resolveOwner` hands a
      // re-delivered `PreToolUse` back to the root whenever no subagent is live —
      // so owner equality would hold for both copies and guard nothing.
      if (state.toolIndex.get(t.id) === t) {
        state.toolIndex.delete(t.id);
        state.toolOwner.delete(t.id);
      }
    }
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

/** Drop an agent's tool ids out of the two id-keyed maps, for an agent that is
 *  about to be removed from `state.agents`. Both pruners below call this
 *  immediately before their `agents.delete`, which is the symmetry `trimTools`
 *  already keeps when it evicts a call out of the per-agent window.
 *
 *  Until #443 neither pruner touched either map, so a call still in flight when
 *  its agent was evicted left an entry nothing could ever reach again: not
 *  `PostToolUse`, whose fallback resurrects from `state.agents` and so needs the
 *  agent to still be there; not either sweep, which both iterate `state.agents`;
 *  not `trimTools`, which only ever runs from its own agent's `PreToolUse`; and
 *  not the garbage collector, because the map held the last strong reference to
 *  a `ToolCall` that still carried its whole `tool_input`. `sweepStaleTools`
 *  rests part of its safety argument on this ("the bubble goes with the agent
 *  when the session is pruned") and the bubble did go — the index entry did not.
 *
 *  Worth doing, but this is tidiness rather than a leak anyone is feeling. To
 *  orphan anything, a pruner has to delete an agent that is `done` while it
 *  still holds an unsettled call, and on Claude the ordinary killed-mid-call
 *  session does not qualify: no `Stop` arrives for it, so it stays `active` and
 *  unprunable until `sweepStaleSessions` reaps it — and `sweepStaleTools` runs
 *  first on the same tick against the same window (#436), so it has already
 *  settled and released those calls by the time the root turns `done`. Replaying
 *  this machine's entire 21-hour events.jsonl with both pruners live evicted 16
 *  agents and orphaned exactly nothing. What is left over is Codex, where the
 *  sweep deliberately abstains (#397) and pruning is therefore the only bound on
 *  a call nobody ever answered the approval prompt for, and the Claude case where
 *  a `PostToolUse` went missing but the `Stop` that ends the agent still landed.
 *  One entry per such call: 244 bytes at this log's median `tool_input`, 8.5 KB
 *  at its p99.
 *
 *  WHY EACH DELETE IS CONDITIONAL RATHER THAN BY ID. A tool id does not belong
 *  to one `ToolCall` object for good. `findTool` consults `toolIndex` first and
 *  the owner's own list only after, so a re-delivered `PreToolUse` for an id that
 *  has already settled finds neither — the index entry went with the settle —
 *  and `resolveOwner` then hands it to whoever the attribution stack names NOW,
 *  which is a different agent whenever a subagent started in between. That pushes
 *  a second `ToolCall` under the same id and re-points both maps at the new
 *  owner, while the first object stays in the old agent's `tools` array. Deleting
 *  by id alone would let the pruning of a long-finished agent quietly evict a
 *  live call belonging to one that is still running, and `toolIndex` is read for
 *  precisely the calls that have NOT settled: `blockedSubagentId` walks it to
 *  decide which subagent a permission prompt is about, so the next prompt would
 *  lose the agent it belongs to (#361). Requiring the map to still point at THIS
 *  call, and at THIS agent, keeps the release to entries the departing agent
 *  actually still owns.
 *
 *  The late `PostToolUse` this file protects everywhere else is unaffected. For
 *  an agent that survives, nothing here runs at all; for one that does not, the
 *  event was already a no-op, since the resurrection scan looks through
 *  `state.agents` and the agent is gone from it — the call is off the board, and
 *  settling a bubble nothing draws is not a thing worth keeping a map for. */
function releaseToolIds(state: GraphState, a: AgentNodeData): void {
  for (const t of a.tools) {
    if (state.toolIndex.get(t.id) === t) state.toolIndex.delete(t.id);
    if (state.toolOwner.get(t.id) === a.id) state.toolOwner.delete(t.id);
  }
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
    // #443: the agent's in-flight ids go with it. See `releaseToolIds`.
    const a = state.agents.get(c.id);
    if (a) releaseToolIds(state, a);
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
    for (const id of s.ids) {
      // #443: the session is evicted whole, so every agent in it releases the
      // tool ids it still holds open. See `releaseToolIds`.
      const a = state.agents.get(id);
      if (a) releaseToolIds(state, a);
      state.agents.delete(id);
    }
    over--;
    removed = true;
  }
  return removed;
}

/** Finalise every in-flight tool call belonging to a CLAUDE session that has
 *  gone completely silent for `maxMs` — the session was killed mid-call and the
 *  PostToolUse that would have settled the call is never coming. Without this
 *  those calls pulse forever in the burst layer and pollute the in-flight
 *  counter. Codex agents are skipped, because there a missing result means the
 *  call has not finished rather than that its result was lost — see the note
 *  inside. The clock is the SESSION's last event and never the call's own age;
 *  see the note on the guard below for why that distinction is the whole point.
 *  Returns true when at least one tool was staled, so callers can trigger
 *  a re-render. Mutates state in place. */
export function sweepStaleTools(state: GraphState, now: number, maxMs: number): boolean {
  let changed = false;
  for (const a of state.agents.values()) {
    // #397: not Codex, because on Codex the premise of this sweep is false.
    //
    // The sweep reads "no PostToolUse after 90s" as "the event was lost", and on
    // Claude that inference is sound: Claude emits PostToolUse for every call it
    // completes, so a missing one really does mean a session that died mid-call.
    // Codex does not work that way. It appends the CALL line to its rollout at
    // request time, before the tool has run — proven by the events that land
    // strictly between a call line and its output line, and by the call/output
    // gap tracking the command's real duration (117 windows on this machine,
    // 0 unanswered, p50 134ms, max 3936ms). So a Codex call sitting here with no
    // output line is not a call whose result went missing. It is a call that has
    // not produced one yet: a long command still running, or — the case this
    // costs the most — one parked on an approval prompt, waiting for the human.
    //
    // Ninety seconds later this used to stamp that call `ok = false` with
    // `errorPreview = "stale (no PostToolUse received)"`, and the deck told the
    // user a command had errored while Codex was politely waiting for them to
    // say yes. Both halves were wrong: nothing failed, and the cause named is an
    // internal one that never applied to this provider. Leaving the call alone
    // leaves it in-flight, which is the one description of it that is true, and
    // if the human approves at minute five the output line settles it normally
    // through `toolIndex` with its real outcome.
    //
    // Nothing runs away as a result. `trimTools` evicts an in-flight call from
    // `toolIndex` once it falls out of the 200-per-agent window, and the bubble
    // goes with the agent when the session is pruned — as, since #443, do that
    // agent's entries in `toolIndex` and `toolOwner`, which is what this
    // sentence had been claiming for two releases while both pruners deleted the
    // agent and left the maps alone. Codex is where that mattered: this `continue`
    // is what makes pruning the only bound left here. Only an explicit "codex"
    // is exempt — an event recorded before `provider` existed replays without
    // one and must keep the Claude behaviour it was swept with.
    if (a.provider === "codex") continue;

    // #436: the clock is the SESSION's silence, not the call's age.
    //
    // Claude does emit a PostToolUse for every call it completes, so a call that
    // will never get one is a real thing to draw. But "no PostToolUse yet" and
    // "no PostToolUse ever" are not the same state, and a timestamp on the call
    // alone cannot tell them apart: at any age, a silent call is either a session
    // that died mid-call or a command that is simply still running. Judged on age
    // this sweep guessed "died", and on this machine's log it guessed wrong far
    // more often than right — of the 16 Claude calls it would have stamped failed
    // at the old ninety seconds, 13 went on to return normally (12 `Bash`, one
    // `AskUserQuestion`; longest 776.2s, drawn red and counted as an error for
    // 686.2s of that) and only 3 were genuinely lost. Four in five of its verdicts
    // were false, and a call drawn as failed while it is still working is a lie
    // the user acts on — they go and kill the build the deck says already broke.
    //
    // No threshold on the call's own age can fix that, which is why this is not
    // simply a bigger number. Ninety seconds sat below Claude Code's own Bash
    // timeout (120s default, up to 600s), so the sweep fired inside the CLI's
    // documented operating range; but 600s does not save it either — two of the
    // measured honest calls ran past that, because PreToolUse fires before the
    // permission decision, so a call parked on a human is unbounded in exactly the
    // way #397's Codex approval prompt is. There is no number that is above every
    // legitimate call and below every dead one, because the two overlap.
    //
    // The discriminator that does separate them is a different fact entirely, and
    // it is already on the node: `lastEventAt` (#350) is when this session was
    // last heard from at all. A session still emitting events is alive, so its
    // quiet call is slow; a session that has emitted nothing is the case this
    // sweep was built for. That is the same judgement `sweepStaleSessions` makes
    // one level up, so it is made here on the same clock and the same window
    // rather than on a second, shorter one that contradicts it — the deck used to
    // call a session dead enough to fail its tools at ninety seconds while still
    // calling it alive at ninety minutes.
    //
    // Both halves are load-bearing, and swapping the clock WITHOUT also adopting
    // that window would have fixed nothing. A foreground tool call is the whole of
    // what its session is doing, so the session is silent for the length of the
    // call by construction: all 13 false positives above ran on sessions whose
    // longest silence inside the call window was the call itself (776.2s of call,
    // 769.9s of silence). Read against a ninety-second window, `lastEventAt` would
    // have condemned every one of them exactly as `startedAt` did. What it buys is
    // the case the age clock cannot see at all — a session whose subagents are
    // still reporting is alive no matter how old one of its calls is — and, more
    // than that, it makes the window mean something: ninety minutes is not a
    // bigger guess, it is the number this file already defends for "presumed
    // dead", and this sweep is now asking that question and no other.
    //
    // The direction this is now wrong in is the cheap one. A genuinely lost call
    // stays drawn in-flight until its session goes quiet for the full window
    // instead of settling at ninety seconds — a spinner that lingers rather than a
    // failure that never happened. Nothing is lost by waiting: all 3 genuinely
    // orphaned calls measured here belong to sessions that did eventually fall
    // silent, so every one of them still settles, just later and only once there is
    // evidence for it. #397 made the same trade for Codex.
    //
    // Falling back to the call's own start when the root is gone keeps a subagent
    // orphaned by `pruneOldAgents` from holding an in-flight call forever; a
    // session whose root has already been pruned is over by definition.
    const root = state.agents.get(rootAgentId(a.sessionId));
    const heardAt = root?.lastEventAt ?? root?.startedAt;

    for (const t of a.tools) {
      // `heardAt` cannot precede the call's own PreToolUse in practice — that
      // event stamped it — but `Math.max` makes the guard hold anyway rather than
      // depending on an invariant enforced somewhere else in the file.
      const silentSince = Math.max(t.startedAt, heardAt ?? t.startedAt);
      if (t.endedAt == null && now - silentSince > maxMs) {
        // Stamped at the last moment there is any evidence the call was running,
        // exactly as `sweepStaleSessions` stamps the session's own `endedAt`, so
        // the call and the session it died with agree about when that was. The
        // old `startedAt + maxMs` was a duration invented by the sweep.
        t.endedAt = silentSince;
        t.ok = false;
        // Says what was observed rather than naming an internal mechanism the
        // reader has never heard of. The old string — "stale (no PostToolUse
        // received)" — described the sweep's own plumbing and was untrue in every
        // false positive above; #397 settled the same wording question for Codex
        // by not asserting a cause at all, and this is the Claude equivalent for
        // the one case where a cause is actually known.
        t.errorPreview = "session ended before this call returned";
        // Also drop it from the live tool index, so the id is not held open by a
        // session that is gone. This does NOT make the call unsettleable: the
        // PostToolUse handler falls back to scanning the owner's tool list and
        // resurrects it, which is what happens when the sweep guessed wrong and
        // the session comes back — the same un-reap `lastEventAt` performs for
        // the root above.
        state.toolIndex.delete(t.id);
        state.toolOwner.delete(t.id);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * How long a session may go COMPLETELY silent before the deck stops believing
 * it is there.
 *
 * The clock is the session's last event, never a block's own `since`. Those are
 * different numbers and only one of them is about being alive: `since` is when
 * the permission prompt arrived, and the session it arrived on may be working
 * the entire time the human takes to answer — the other tool calls of the same
 * turn, a subagent still running underneath. Measured against `since`, any
 * threshold shorter than the longest a human might take cancels blocks that are
 * real. Measured against the last event, a session that is still moving is never
 * touched at all, however long it has been blocked.
 *
 * Ninety minutes is what is left once the workloads that produce genuine silence
 * are ruled out. A single foreground tool call is the longest of the mechanical
 * ones and CC caps Bash at 600_000ms, so ten minutes already covers the longest
 * build or `sleep` one call can hold; a slower MCP tool with no cap of its own is
 * still minutes rather than hours, and a subagent doing long work emits its own
 * Pre/PostToolUse under the same session id throughout. The long pole is not a
 * tool at all, it is the human: a permission prompt left standing through a
 * meeting is an hour of silence on a session that is entirely alive, which is
 * the case #350 explicitly warns against cancelling. Ninety minutes clears that
 * hour by half again.
 *
 * It is deliberately not longer. No finite number survives a session left
 * overnight, so every threshold here is only choosing which way to be wrong, and
 * past roughly two hours the choice stops buying anything while the cost keeps
 * rising: the tab title, the favicon and the topbar chip are worth having only
 * while they are rare AND true, and a dead session holding all three through a
 * working day is the exact failure #348 was built to avoid. Being wrong this way
 * is also the cheap direction — a reaped session is not a lost one, because the
 * next event from it puts it straight back (see `reaped` in types.ts).
 */
export const STALE_SESSION_MS = 90 * 60_000;

/**
 * Settle every session that has not been heard from in `maxMs`, and drop its
 * waiting block with it. Returns true when anything changed, so the caller can
 * re-render. Mutates state in place.
 *
 * This is the sweep the other three decline. `sweepStaleTools` finalises
 * ToolCalls and never looks above them; `pruneOldAgents` wants `state === "done"`
 * and `pruneDoneSessions` wants a session with nothing live in it — and the
 * session this exists for is `active`, because a permission prompt arrives
 * mid-turn and the event that would have ended that turn is the one that never
 * came. So it sat there forever, and since #348 a `permission` block is what
 * lights the tab title and the favicon: two surfaces with no age printed on them
 * that a killed session could hold indefinitely.
 *
 * Staleness is fixed here rather than by giving `waiting` a TTL of its own,
 * because the stale block and the stale `active` beside it are one bug and not
 * two. Settling the state clears the block on the way past, so the alarm counts
 * fall out for free — #348 reads `kind` off a block that is gone.
 *
 * `endedAt` is stamped at the last event rather than at `now`: that is the last
 * moment there is any evidence the session existed, and it lets the two pruners
 * treat a two-hour-dead session as the oldest thing on the board, which it is.
 * Only `active` agents are settled — an `err` node keeps its error — and the
 * subagents go with the root, since a session nothing has been heard from has no
 * live children either.
 *
 * The session's attribution stack goes with them, for the reason `Stop` gives
 * for dropping it there (#442). See the note at the delete below.
 */
export function sweepStaleSessions(state: GraphState, now: number, maxMs: number): boolean {
  let changed = false;
  for (const root of state.agents.values()) {
    if (root.kind !== "root") continue;
    // `startedAt` is the fallback for a root built before this field existed —
    // a replayed log, a tab that survived an upgrade — and it is the right one:
    // a session with no stamped event has been heard from exactly once.
    const heardAt = root.lastEventAt ?? root.startedAt;
    if (now - heardAt <= maxMs) continue;

    // The block goes whether or not there is any state left to settle, so an
    // idle_prompt parked on a session that stopped hours ago stops claiming to
    // be news. One rule — "a session nobody has heard from is not current" —
    // rather than a rule for the state and a second one for the badge.
    if (root.waiting) { root.waiting = null; changed = true; }

    if (root.state === "active") {
      root.state = "done";
      root.endedAt = heardAt;
      root.reaped = true;
      changed = true;
    }
    for (const a of state.agents.values()) {
      if (a.sessionId !== root.sessionId || a.kind === "root" || a.state !== "active") continue;
      a.state = "done";
      a.endedAt = heardAt;
      changed = true;
    }

    // #442: the attribution stack goes with the nodes the loop above just
    // settled. This sweep is the stand-in for a `Stop` that never arrived, and
    // `Stop` drops the stack for a reason that applies here word for word: keys
    // land on it at `SubagentStart` and come off only at `SubagentStop`, hook
    // POSTs are fire-and-forget, and one sent while the server was restarting is
    // gone for good. A key left behind is not inert — `resolveOwner` reads the
    // stack top for every event that carries no `agent_id`, which is all the real
    // `UserPromptSubmit` and `Pre`/`PostToolUse` traffic, so the human's next
    // prompt and every root-level tool call of that turn render under a subagent
    // that finished two hours ago.
    //
    // Nothing downstream repairs it, which is why this has to happen here.
    // `UserPromptSubmit` makes it worse rather than better: its retirement loop
    // stamps `exitAt` on the settled subagent and the `resolveOwner` call four
    // lines later clears `exitAt`, `endedAt` and `state` on the very same node in
    // the very same event, so the zombie is un-retired by the act of typing. Both
    // pruners then decline it at cap 0 and grace 0 because it is `active` again,
    // and `popActive` only ever removes its own key — so the stale one sits
    // UNDERNEATH any later `SubagentStart` and resurfaces as stack top the moment
    // that newer, legitimate subagent stops. It is not confined to one turn.
    //
    // Clearing is safe on the premise this sweep is built on, and the premise is
    // stronger here than at `Stop`. A subagent doing long work emits its own
    // Pre/PostToolUse under this same session id, and every one of those stamps
    // `lastEventAt` on this root — so a session that reached `maxMs` of TOTAL
    // silence has no subagent still working under it by construction, whatever
    // the stack still says.
    //
    // It is also the only choice that agrees with the un-reap in `applyEvent`
    // (#350). A late event puts the ROOT back — `reaped` cleared, `state` active,
    // `endedAt` undone — and deliberately leaves the settled subagents `done`,
    // because a subagent that was mid-flight when its session went quiet is
    // genuinely over and `SubagentStart` is the documented way one comes back.
    // Restoring the stack alongside the root would therefore hand a `done` node
    // the whole of the resumed session's traffic: exactly the zombie above, now
    // re-created by the recovery path. The stack stays empty, the resumed session
    // attributes to its root, and a subagent that really did survive re-announces
    // itself and is pushed back on by `pushActive` as usual.
    //
    // `changed` is not touched: the stack is attribution state for events that
    // have not arrived yet, and nothing on screen is drawn from it, so removing a
    // key is not a reason to re-render this tick. `Map.delete` on a session that
    // never had a stack — the common case — is a no-op, so the sweep stays free
    // for the sessions this is not about.
    state.activeSubagentStack.delete(root.sessionId);
  }
  return changed;
}

/** The two `notification_type` values Claude Code emits, as the chore each one
 *  actually is. Anything else is a kind nobody here has seen and would have no
 *  wording for, so it sets no block rather than a badge that says nothing. */
function waitingKind(notificationType: unknown): WaitingBlock["kind"] | null {
  if (notificationType === "permission_prompt") return "permission";
  if (notificationType === "idle_prompt") return "idle";
  return null;
}

/** Events that are NOT proof the session moved, and so must leave a waiting
 *  block standing whoever they are attributed to. `Notification` is the one that
 *  sets it. The three *Observed events are the server's own transcript scans,
 *  not session traffic: it starts one for every hook payload that carries a
 *  `transcript_path`, the notification included, so treating them as movement
 *  would clear the block a second or two after it was set and no badge would
 *  ever survive long enough to be read. Everything else — a prompt, a tool call,
 *  a subagent, a Stop — is the session moving again; `clearsWaiting` below
 *  decides whether that movement is also evidence the HUMAN moved. */
const WAITING_KEEPERS = new Set([
  "Notification", "ModelObserved", "ContextObserved", "UsageObserved",
]);

/**
 * Which subagent a permission prompt landing right now is about, or undefined
 * when the root asked (or when we cannot tell, which is the same answer as far
 * as the clear rule is concerned).
 *
 * `Notification` names nobody — no agent_id, no tool_name, no tool_use_id — so
 * the only thing left to read is where it sits in the stream. CC runs the
 * PreToolUse hook BEFORE it asks the human for permission, so the call that is
 * about to block is the newest one still in flight on this session, and whoever
 * that call's payload named is the one waiting on an answer.
 *
 * Deliberately NOT the top of `activeSubagentStack`, which is the attribution
 * rule everything else here uses: with three Tasks running in parallel the stack
 * top is a one-in-three guess about which of them asked, whereas the newest
 * in-flight call is the one whose PreToolUse fired milliseconds ago. The only
 * way it picks wrong is another agent starting a call inside that gap, and both
 * ways of being wrong are bounded by what the deck did before #361: attribute to
 * a sibling and that sibling's traffic clears the block early (today's bug, now
 * needing a millisecond race to happen at all), attribute to nobody and only
 * root-level traffic clears it (the plain #361 rule).
 *
 * The call's own `explicitSubagentId` decides whose it is, not the node it was
 * drawn under. Those differ for exactly the case that matters here: while a Task
 * is live, the root's own tool calls carry no agent_id and are attributed to the
 * subagent by the stack heuristic — so reading the owner would hand a prompt the
 * ROOT raised to whichever Task happened to be running, and let that Task's
 * traffic clear it. Payload attribution both ways, or the rule contradicts
 * itself.
 */
function blockedSubagentId(state: GraphState, sessionId: string): string | undefined {
  let newest: ToolCall | null = null;
  for (const tc of state.toolIndex.values()) {
    // `toolIndex` spans every session on the board, and holds exactly the calls
    // that have not settled — PostToolUse and the stale sweep both delete.
    const owner = tc.agentId ? state.agents.get(tc.agentId) : undefined;
    if (!owner || owner.sessionId !== sessionId) continue;
    if (!newest || tc.startedAt > newest.startedAt) newest = tc;
  }
  // A call whose payload named nobody is the root's own, and root-level traffic
  // already clears the block — there is nothing to name.
  return newest?.explicitSubagentId;
}

/** A fresh block, attributed. Only a `permission` block is ever about one agent:
 *  an idle prompt is the session's own input box sitting empty, which belongs to
 *  nobody underneath it. The field is left off entirely rather than set to
 *  undefined so a block with no subagent behind it is the same object it has
 *  always been. */
function waitingBlock(
  state: GraphState, sessionId: string, kind: WaitingBlock["kind"], message: string, now: number,
): WaitingBlock {
  const subagentId = kind === "permission" ? blockedSubagentId(state, sessionId) : undefined;
  return subagentId ? { kind, message, since: now, subagentId } : { kind, message, since: now };
}

/**
 * Is this event evidence the human dealt with `w`?
 *
 * #361: it used to be enough that the event was not a keeper, keyed on nothing
 * but `hook_event_name` and `session_id`. A subagent's tool call carries the
 * ROOT's session_id — and on a real log 79% of PreToolUse and PostToolUse
 * events are subagent-attributed — so in any session running a Task the alarm
 * was wiped milliseconds after it was raised, while the human was still looking
 * at the prompt in the terminal. Nothing re-raises it: the notification is not
 * re-sent, and since #348 the idle_prompt that follows is not an alarm.
 *
 * The two kinds are different claims and are answered by different evidence:
 *
 *  - `permission` says a specific agent is stopped until the human answers. Only
 *    the root's own traffic, or traffic from the very subagent that asked, can
 *    mean the answer arrived; a sibling Task working away means nothing at all.
 *  - `idle` says nothing is happening — the input box has been empty for a
 *    minute. ANY traffic on the session falsifies that directly, including a
 *    subagent's, so it keeps the old rule. Being wrong in that direction is also
 *    the cheap one: an idle block is not an alarm post-#348, it only sorts the
 *    sidebar and prints "waiting 3m", and printing that over a session whose
 *    subagents are visibly working is the lie worth avoiding.
 */
function clearsWaiting(w: WaitingBlock, p: HookPayload, sessionId: string): boolean {
  if (w.kind !== "permission") return true;
  const key = explicitSubagentKey(p);
  // Root-level traffic — every UserPromptSubmit, Stop, SessionStart, SessionEnd
  // and the root's own tool calls, none of which carries an agent_id or a
  // parent_tool_use_id. This is the whole of what used to clear it correctly.
  if (key == null) return true;
  // Subagent-attributed traffic clears only the block that subagent itself
  // raised, which is what the human answering a subagent's prompt produces:
  // its PostToolUse if they approved, its next call or its SubagentStop if they
  // denied. Siblings, and every subagent when the root is the one asking, leave
  // it standing.
  return w.subagentId != null && subagentIdFor(sessionId, key) === w.subagentId;
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

  // Clear the waiting block here rather than adding a line to eight cases. A
  // badge that outlives the block is worse than no badge — it teaches the user
  // to distrust the one signal the deck exists to give — and a per-case list is
  // a list somebody forgets to extend the next time an event is added. This
  // also carries the whole idempotency story: a replayed log re-delivers every
  // notification, and each one is cleared again by whatever the session did
  // next, so a tab that opens mid-block ends up blocked and a tab that opens
  // after it was answered does not.
  //
  // WHOSE traffic it is decides it, not just what the event is called: a
  // subagent's tool call carries the root's session_id and used to land here as
  // the session "moving again", which erased the alarm while the human was still
  // being asked. `clearsWaiting` holds that rule.
  if (!WAITING_KEEPERS.has(name)) {
    const blocked = state.agents.get(rootAgentId(sessionId));
    if (blocked?.waiting && clearsWaiting(blocked.waiting, p, sessionId)) blocked.waiting = null;
  }

  // Note that we heard from this session, which is a different question from
  // what the event says. It runs above the branches on purpose: the three
  // *Observed events return early, the switch below ignores several names
  // outright, and every one of them is still the session's id arriving from a
  // process that is running. Attribution is irrelevant for the same reason — a
  // subagent's PreToolUse proves the session is there as surely as the root's.
  //
  // Kept on the root because that is where `sweepStaleSessions` reads it, and
  // guarded on being NEWER rather than stamped unconditionally: order
  // independence is this reducer's contract, so a copy of an old event arriving
  // late from another deck's fan-out must not make the session look fresher than
  // its newest event. That guard is also what makes the un-reap below safe —
  // "newer than anything we had" is exactly "newer than the moment we gave up".
  const heard = state.agents.get(rootAgentId(sessionId));
  if (heard && now > (heard.lastEventAt ?? 0)) {
    heard.lastEventAt = now;
    if (heard.reaped) {
      // The sweep guessed and the guess was wrong: the terminal was alive all
      // along, the human just took their time. Put it back the way a late
      // PostToolUse resurrects a tool the stale sweep had marked failed. Only
      // the root — a subagent that was mid-flight when the session went quiet is
      // genuinely over, and SubagentStart is what brings one of those back.
      heard.reaped = false;
      heard.state = "active";
      heard.endedAt = undefined;
    }
  }

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

  // The session's approval policy, for the same reason and in the same place:
  // Codex restates it on every `turn_context` and the watcher spreads it onto
  // every payload, so it lands here above the branches that return early.
  //
  // Guarded on being a non-empty string rather than assigned unconditionally,
  // because the field is absent from a Claude payload and from a Codex payload
  // emitted before the first `turn_context` of the session was read — and
  // absence there means "not known yet", not "the policy was withdrawn". A
  // session that really does change policy mid-flight restates it on the next
  // turn's `turn_context`, which is the write that supersedes this one.
  //
  // It goes on the ROOT and not on `owner`: the policy governs the session, and
  // stamping it on whichever agent happened to own the event would leave the
  // answer on a subagent that gets pruned. `resolveOwner` has not run yet in any
  // case — this sits above the early-returning enrichment branches on purpose.
  if (typeof p.approval_policy === "string" && p.approval_policy) {
    const root = state.agents.get(sessionId);
    if (root) root.approvalPolicy = p.approval_policy;
  }

  // How much of that window is occupied right now, from the same Codex
  // `token_count` record that reports the window itself — and in the same place,
  // above the branches that return early, for the same reason (#399).
  //
  // It rides on `UsageObserved` rather than arriving as its own event because it
  // is measured at the same instant as the usage totals and by the same record:
  // splitting one record into two events would let the deck show a spend and an
  // occupancy that disagree about which request they describe.
  //
  // WHY THIS DOES NOT REPLACE root.context WHOLESALE. The rest of the breakdown
  // comes from somewhere else entirely — a transcript scan on the Claude side, a
  // filesystem scan for memory files on the Codex one — and arrives on its own
  // schedule. Merging is what lets the two land in either order; assigning a
  // fresh breakdown here would erase the file list every 1.5 seconds.
  //
  // Zero is a legitimate value and is written, not skipped: a session whose
  // context was just cleared really is at zero, and the donut is gated on
  // `> 0` at the card so it disappears rather than drawing an empty ring.
  if (typeof p.context_tokens === "number" && p.context_tokens >= 0) {
    const root = state.agents.get(sessionId);
    if (root) {
      root.context = { ...(root.context ?? emptyContextBreakdown()), currentContextTokens: p.context_tokens };
    }
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
  // window (message counts, memory files, current window size) that the
  // context donut and ContextModal read. Session root only.
  //
  // FIELD-BY-FIELD, KEEPING WHAT IT DOES NOT MENTION. This used to rebuild the
  // whole breakdown from one payload, defaulting every absent key to 0 and an
  // empty list, which made the event destructive rather than additive. Three
  // producers now write into this one object and none of them knows everything:
  // the Claude transcript scan (counts + occupancy), the Claude memory scan, and
  // the Codex memory scan, which has file paths and nothing else. The old shape
  // was already lossy on the Claude side too — `maybeResolveContext` sends the
  // file list with no breakdown whenever the transcript has not been folded yet,
  // and that zeroed every count the previous pass had established.
  //
  // An absent key therefore means "this producer has nothing to say about it",
  // never "it is zero". A producer that means zero sends the number zero.
  if (name === "ContextObserved") {
    const ctx = (p.context ?? null) as Record<string, unknown> | null;
    if (ctx) {
      const root = state.agents.get(sessionId);
      if (root) {
        const prev = root.context ?? emptyContextBreakdown();
        const num = (key: string, fallback: number): number =>
          typeof ctx[key] === "number" ? (ctx[key] as number) : fallback;
        // `claudeMdFiles` is the name this list shipped under before it also
        // held AGENTS.md paths, and it is still read here because the deck
        // replays its own persisted JSONL at boot: a log written by an older
        // build is exactly where the old key still appears.
        const files = Array.isArray(ctx.memoryFiles) ? ctx.memoryFiles
          : Array.isArray(ctx.claudeMdFiles) ? ctx.claudeMdFiles
          : null;
        root.context = {
          msgsUser: num("msgsUser", prev.msgsUser),
          msgsAssistant: num("msgsAssistant", prev.msgsAssistant),
          toolUses: num("toolUses", prev.toolUses),
          toolResults: num("toolResults", prev.toolResults),
          systemReminders: num("systemReminders", prev.systemReminders),
          currentContextTokens: num("currentContextTokens", prev.currentContextTokens),
          memoryFiles: (files ?? prev.memoryFiles) as Array<{ path: string; bytes: number }>,
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
        //
        // The cache-WRITE line took both spellings only from #400 on. Codex has
        // carried `cache_write_input_tokens` in every `total_token_usage` object
        // this machine holds, and it arrives here verbatim from the rollout, but
        // the read below asked for Claude's spelling alone and so dropped it —
        // which mattered because gpt-5.6 is the first OpenAI family to publish a
        // separate cache-write price ($6.25/Mtok on sol), and a rate with no
        // token count to multiply is a line item pinned at $0.00 forever.
        root.usage.inputTokens = Number(u.input_tokens ?? 0);
        root.usage.outputTokens = Number(u.output_tokens ?? 0);
        root.usage.cacheReadTokens = Number(
          u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0,
        );
        root.usage.cacheCreateTokens = Number(
          u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? 0,
        );
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
      // `explicitSubagentId` records what the payload said rather than where
      // `owner` came from, and is derived from the key rather than from the
      // resolved node so it still names the right subagent when that subagent
      // never announced itself — which is the same id `clearsWaiting` compares
      // against. See its declaration in types.ts.
      const explicit = explicitSubagentKey(p);
      const tc: ToolCall = {
        id,
        name: p.tool_name ?? "?",
        input: p.tool_input,
        inputPreview: shortPreview(p.tool_input),
        agentId: owner.id,
        explicitSubagentId: explicit ? subagentIdFor(sessionId, explicit) : undefined,
        startedAt: now,
      };
      owner.tools.push(tc);
      owner.toolCount += 1;
      owner.state = "active";
      state.toolIndex.set(id, tc);
      state.toolOwner.set(id, owner.id);
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
      // Everything below this line runs exactly once per call, because a second
      // copy of one outcome is not a second outcome.
      //
      // This event is the only one of the four the file hardens against
      // re-delivery that does ARITHMETIC. `PreToolUse` refreshes a known id in
      // place so `toolCount` advances once, `UserPromptSubmit` declines to
      // re-append a prompt it already has, and `pushActive` declines to re-push
      // a key — but `addUsage` at the bottom of this block is `+=`, so every
      // surplus copy added the call's tokens to its owner again, and cost is
      // computed from those tokens. `UsageObserved` overwrites the root with
      // cumulative totals and does eventually correct one, but it needs a
      // `transcript_path` and is throttled per session, and it never touches a
      // subagent at all — so on a subagent, or on a session whose hooks have
      // stopped, the inflated figure is what the deck bills forever.
      //
      // The discriminator is `outcomeApplied` and it has to be, because every
      // cheaper test is wrong. `endedAt != null` is what the sweep writes too,
      // so refusing on it would delete the whole resurrection path #436 depends
      // on: a call the sweep gave up on is the case where a late outcome MUST
      // land and un-say the failure. Absence from `toolIndex` is what both the
      // sweep and the first delivery of this event leave behind, so `resurrected`
      // is true for a late outcome and for a duplicate alike and separates
      // nothing. Keeping the entry in `toolIndex` to recognise the second copy is
      // not available either — #361 reads that map as "exactly the calls that
      // have not settled" to decide which subagent a permission prompt belongs
      // to, and a settled call left in it outranks the blocked one. What is left
      // is to record that an outcome was applied, on the call, at the moment it
      // is applied, which is what the sweep by construction never does.
      //
      // It is the OBJECT that carries the flag and not the id, which matters
      // because one `tool_use_id` can name two `ToolCall`s: a `PreToolUse`
      // re-delivered after its call settled finds nothing in `toolIndex` and
      // pushes a fresh call on whichever agent is live by then (#443). An id-keyed
      // "already seen" set would swallow the second object's first real outcome;
      // a flag on the object cannot.
      if (tc.outcomeApplied) break;
      tc.outcomeApplied = true;
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
      if (ownerId && usage) {
        const oa = state.agents.get(ownerId);
        if (oa) addUsage(oa.usage, usage);
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
      state.activeSubagentStack.delete(sessionId);
      break;
    }
    case "Notification": {
      // The deck has always received these and always dropped them, which is
      // why "which of the five agents is stuck on me" was the one question the
      // canvas could not answer. Two kinds arrive and both mean the session is
      // blocked on a human; nothing else in the payload is worth keeping (the
      // `model.subsSig` blob alone runs to ~5KB, and there is no tool_name, no
      // tool_input and no tool_use_id to say what the block is ON).
      const kind = waitingKind(p.notification_type);
      if (!kind) break;
      // Straight to the root the way Stop does, never through resolveOwner:
      // that function exists to attribute tool traffic to the deepest live
      // subagent and would hang the badge on whichever Task happened to be
      // running. The payload names no subagent, and the block is on the session
      // as a whole in any case.
      const root = ensureRoot(state, sessionId, now, false);
      const message = typeof p.message === "string" ? p.message : "";
      const prev = root.waiting;
      // One notification is delivered more than once — a copy per deck sharing
      // events.jsonl, plus the whole history again on every tab that opens —
      // and each copy carries its own seq, so the seq/epoch guard lets it
      // through. Re-stamping `since` would restart the "waiting 4m" readout
      // every time a duplicate landed. Math.min rather than "keep whichever
      // arrived first" so a copy delivered out of order settles on the same
      // answer: order-independence is this reducer's stated contract.
      //
      // A duplicate keeps the attribution the first copy computed, for the same
      // reason it keeps the earliest `since`: the block belongs to the moment it
      // was raised, and a copy landing later sees a session that has moved on —
      // the blocked call may have settled by then, leaving nothing in flight to
      // read. Re-deriving per copy would let a re-delivery quietly widen or
      // narrow what is allowed to clear the block.
      root.waiting = prev && prev.kind === kind && prev.message === message
        ? { ...prev, since: Math.min(prev.since, now) }
        : waitingBlock(state, sessionId, kind, message, now);
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
