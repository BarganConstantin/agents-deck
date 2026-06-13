// Event → graph reducer. Pure-ish: same events in any order = same end state.
import type { AgentNodeData, HookEnvelope, HookPayload, TokenUsage, ToolCall } from "./types";

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
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
}

/** Recursively look for a `model` string anywhere in the payload — CC
 *  surfaces it on Stop, PostToolUse response envelopes, message bodies, etc.,
 *  in different keys per event. Only accept ids that look like Claude models. */
function extractModel(node: unknown, depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.model === "string" && /^claude[-_]/i.test(obj.model)) {
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
  totalEvents: number;
}

export function initialState(): GraphState {
  return {
    agents: new Map(),
    toolIndex: new Map(),
    toolOwner: new Map(),
    activeSubagentStack: new Map(),
    lastSeq: 0,
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

/** Resolve which agent owns this event:
 *  - If the payload explicitly names a subagent (agent_id / parent_tool_use_id),
 *    that subagent is the owner.
 *  - Otherwise, for PreToolUse-style events that don't identify a subagent, we
 *    attribute to the deepest currently-active subagent of this session if any,
 *    else to the root session.
 */
function resolveOwner(state: GraphState, p: HookPayload, now: number): AgentNodeData {
  const sessionId = p.session_id ?? "unknown";
  const explicit = explicitSubagentKey(p);

  if (explicit) {
    return ensureSubagent(state, sessionId, explicit, p, now);
  }

  // No explicit subagent. Attribute to top of active stack if one is live.
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
  if (env.seq <= state.lastSeq) return state;

  const p = env.payload ?? {};
  const now = env.receivedAt;
  const name = p.hook_event_name ?? "Unknown";

  if (name === "__clear") {
    return { ...initialState(), lastSeq: env.seq };
  }

  state.totalEvents += 1;
  state.lastSeq = env.seq;

  const sessionId = p.session_id ?? "unknown";
  const owner = resolveOwner(state, p, now);

  // Snapshot model whenever it shows up in the payload — we want the most
  // recent observation per owner since CC can switch models mid-session.
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
      // New turn for this session. Any subagent that's already done belongs
      // to the previous turn — mark for exit so the canvas stays focused on
      // what's relevant to the new request.
      for (const other of state.agents.values()) {
        if (other.sessionId === sessionId && other.kind === "subagent" && other.state === "done" && other.exitAt == null) {
          other.exitAt = now;
        }
      }
      // Also reset session root back to active for the new request.
      const root = ensureRoot(state, sessionId, now, false);
      root.state = "active";
      root.endedAt = undefined;

      const target = resolveOwner(state, p, now);
      target.state = "active";
      const text = (typeof p.prompt === "string" ? p.prompt : typeof p.message === "string" ? p.message : "") ?? "";
      if (text) {
        target.prompts.push({ at: now, text });
        if (!target.firstPrompt) target.firstPrompt = shortPreview(text, 120);
      }
      break;
    }
    case "PreToolUse": {
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
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const id = p.tool_use_id;
      const tc = id ? state.toolIndex.get(id) : undefined;
      if (tc) {
        tc.endedAt = now;
        tc.ok = name === "PostToolUse";
        tc.response = p.tool_response;
        if (name === "PostToolUseFailure") tc.errorPreview = shortPreview(p.tool_response);
        const usage = extractUsage(p.tool_response);
        if (usage) tc.usage = usage;
        state.toolIndex.delete(id!);
        const ownerId = state.toolOwner.get(id!);
        state.toolOwner.delete(id!);
        if (ownerId) {
          const oa = state.agents.get(ownerId);
          if (oa) {
            if (usage) addUsage(oa.usage, usage);
            refreshInFlight(oa);
          }
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
      const lbl = subagentLabel(p);
      if (lbl) sub.label = lbl;
      pushActive(state, sessionId, key);
      break;
    }
    case "SubagentStop": {
      const key = explicitSubagentKey(p);
      if (!key) break;
      const sub = ensureSubagent(state, sessionId, key, p, now);
      sub.state = "done";
      sub.endedAt = now;
      refreshInFlight(sub);
      popActive(state, sessionId, key);
      break;
    }
    case "Stop":
    case "SessionEnd": {
      // Mark the root done; don't touch subagents (they have their own Stop).
      const root = ensureRoot(state, sessionId, now, false);
      root.state = "done";
      root.endedAt = now;
      refreshInFlight(root);
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
