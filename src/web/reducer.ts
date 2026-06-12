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

export interface GraphState {
  agents: Map<string, AgentNodeData>;
  toolIndex: Map<string, ToolCall>;
  /** tool_use_id → owning agent.id, so PostToolUse can settle the right agent's tool. */
  toolOwner: Map<string, string>;
  lastSeq: number;
  totalEvents: number;
}

export function initialState(): GraphState {
  return {
    agents: new Map(),
    toolIndex: new Map(),
    toolOwner: new Map(),
    lastSeq: 0,
    totalEvents: 0,
  };
}

function basename(p?: string): string | undefined {
  if (!p) return undefined;
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function agentIdFor(p: HookPayload): string {
  const session = p.session_id ?? "unknown";
  const parent = p.parent_tool_use_id;
  return parent ? `${session}::${parent}` : session;
}

function rootAgentId(sessionId: string): string {
  return sessionId;
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

function ensureAgent(state: GraphState, p: HookPayload, now: number): AgentNodeData {
  const sessionId = p.session_id ?? "unknown";
  const id = agentIdFor(p);
  const isSub = !!p.parent_tool_use_id;

  // Always make sure the root for this session exists.
  const root = ensureRoot(state, sessionId, now, /*synthetic*/ isSub);
  if (root.synthetic && !isSub) {
    // First non-subagent event for this session — mark it real.
    root.synthetic = false;
    root.startedAt = now;
  }
  if (!isSub) {
    if (!root.cwd && p.cwd) { root.cwd = p.cwd; root.cwdBasename = basename(p.cwd); }
    if (root.label === "session" && p.cwd) root.label = basename(p.cwd) ?? "session";
    return root;
  }

  // Subagent path.
  let a = state.agents.get(id);
  if (a) {
    if (!a.cwd && p.cwd) { a.cwd = p.cwd; a.cwdBasename = basename(p.cwd); }
    if (p.subagent_type && (a.label === "subagent" || !a.label)) a.label = p.subagent_type;
    return a;
  }
  a = {
    id,
    sessionId,
    label: p.subagent_type ?? "subagent",
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

  const a = ensureAgent(state, p, now);

  switch (name) {
    case "SessionStart": {
      a.state = "active";
      a.startedAt = a.startedAt || now;
      break;
    }
    case "UserPromptSubmit": {
      a.state = "active";
      const text = (typeof p.prompt === "string" ? p.prompt : typeof p.message === "string" ? p.message : "") ?? "";
      if (text) {
        a.prompts.push({ at: now, text });
        if (!a.firstPrompt) a.firstPrompt = shortPreview(text, 120);
      }
      break;
    }
    case "PreToolUse": {
      const id = p.tool_use_id ?? `${a.id}:${a.toolCount}`;
      const tc: ToolCall = {
        id,
        name: p.tool_name ?? "?",
        input: p.tool_input,
        inputPreview: shortPreview(p.tool_input),
        agentId: a.id,
        startedAt: now,
      };
      a.tools.push(tc);
      a.toolCount += 1;
      a.state = "active";
      state.toolIndex.set(id, tc);
      state.toolOwner.set(id, a.id);
      refreshInFlight(a);
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
          const owner = state.agents.get(ownerId);
          if (owner) {
            if (usage) addUsage(owner.usage, usage);
            refreshInFlight(owner);
          }
        }
      }
      break;
    }
    case "SubagentStart": {
      a.state = "active";
      a.startedAt = a.startedAt || now;
      if (p.subagent_type) a.label = p.subagent_type;
      break;
    }
    case "SubagentStop": {
      a.state = "done";
      a.endedAt = now;
      refreshInFlight(a);
      break;
    }
    case "Stop":
    case "SessionEnd": {
      a.state = "done";
      a.endedAt = now;
      refreshInFlight(a);
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
