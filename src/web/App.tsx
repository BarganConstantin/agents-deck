import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type ReactFlowState,
} from "reactflow";
import AgentNode, { shortModel } from "./components/AgentNode";
import ToolModal from "./components/ToolModal";
import SessionClusters from "./components/SessionClusters";
import ToolBursts from "./components/ToolBursts";
import SessionSummary from "./components/SessionSummary";
import SessionList from "./components/SessionList";
import TimelineStrip from "./components/TimelineStrip";
import { autoLayout } from "./layout";
import { applyEvent, initialState, pruneOldAgents, sessionHue, sweepStaleTools, type GraphState } from "./reducer";
import { costForUsage, fmtCost, fmtCostRate } from "./pricing";
import type { AgentNodeData, HookEnvelope, ToolCall } from "./types";

function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "";
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const nodeTypes = { agent: AgentNode };

const EXIT_ANIM_MS = 600;
const STALE_TOOL_MS = 90_000;
const AGENT_CAP = 200;
const AGENT_GRACE_MS = 5 * 60_000;
const LAYOUT_STORAGE_KEY = "agent-dag.layout";
const VIEWPORT_STORAGE_KEY = "agent-dag.viewport";
const SUMMARY_DISMISSED_KEY = "agent-dag.summariesDismissed";
const SESSION_LIST_OPEN_KEY = "agent-dag.sessionListOpen";
const TIMELINE_OPEN_KEY = "agent-dag.timelineOpen";

function loadSessionListOpen(): boolean {
  if (typeof window === "undefined") return true;
  try { return window.localStorage.getItem(SESSION_LIST_OPEN_KEY) !== "0"; } catch { return true; }
}
function saveSessionListOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SESSION_LIST_OPEN_KEY, open ? "1" : "0"); } catch {}
}
function loadTimelineOpen(): boolean {
  if (typeof window === "undefined") return true;
  try { return window.localStorage.getItem(TIMELINE_OPEN_KEY) !== "0"; } catch { return true; }
}
function saveTimelineOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(TIMELINE_OPEN_KEY, open ? "1" : "0"); } catch {}
}

function loadDismissedSummaries(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SUMMARY_DISMISSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === "string") : []);
  } catch { return new Set(); }
}

function saveDismissedSummaries(set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    // Cap at 200 entries so this localStorage value can't grow unbounded
    // across thousands of sessions.
    const arr = Array.from(set);
    const trimmed = arr.length > 200 ? arr.slice(-200) : arr;
    window.localStorage.setItem(SUMMARY_DISMISSED_KEY, JSON.stringify(trimmed));
  } catch {}
}

function loadLayout(): Array<[string, { x: number; y: number }]> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return [];
    const obj = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    return Object.entries(obj).filter(([, v]) => v && typeof v.x === "number" && typeof v.y === "number");
  } catch { return []; }
}

function saveLayout(pinned: Map<string, { x: number; y: number }>): void {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of pinned) obj[id] = pos;
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(obj));
  } catch { /* quota / private mode — ignore */ }
}

function loadViewport(): { x: number; y: number; zoom: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (!raw) return null;
    const vp = JSON.parse(raw);
    if (typeof vp?.x !== "number" || typeof vp?.y !== "number" || typeof vp?.zoom !== "number") return null;
    return vp;
  } catch { return null; }
}

function saveViewport(vp: { x: number; y: number; zoom: number }): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(vp)); } catch {}
}

function clearStoredLayout(): void {
  if (typeof window === "undefined") return;
  // Per-key try/catch so a failure removing one (quota / locked store)
  // doesn't strand the other.
  try { window.localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch {}
  try { window.localStorage.removeItem(VIEWPORT_STORAGE_KEY); } catch {}
}

/** Build a portable JSON snapshot of a single session (root + every
 *  subagent) and trigger a browser download. Useful for offline analysis,
 *  bug reports, or just keeping a record of a noteworthy run. */
function exportSessionJson(state: GraphState, sessionId: string): void {
  const root = state.agents.get(sessionId);
  if (!root) return;
  const agents: AgentNodeData[] = [];
  for (const a of state.agents.values()) {
    if (a.sessionId === sessionId) agents.push(a);
  }
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sessionId,
    label: root.label,
    cwd: root.cwd,
    startedAt: root.startedAt,
    endedAt: root.endedAt,
    model: root.model,
    agents: agents.map(a => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      parentId: a.parentId,
      state: a.state,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      model: a.model,
      cwd: a.cwd,
      usage: a.usage,
      prompts: a.prompts,
      // Strip the heavy `input`/`response` fields by default to keep the
      // file portable. Tool name + timing + ok flag are usually enough.
      tools: a.tools.map(t => ({
        id: t.id,
        name: t.name,
        inputPreview: t.inputPreview,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        ok: t.ok,
        errorPreview: t.errorPreview,
        usage: t.usage,
      })),
    })),
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeLabel = (root.label || "session").replace(/[^a-z0-9._-]/gi, "_");
  a.href = url;
  a.download = `agent-dag-${safeLabel}-${sessionId.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Tool categories used both by the detail-panel strip and the canvas
// filter chips. Same buckets ToolBursts uses internally (kept in sync
// manually — small enough that a shared module isn't worth it).
type DetailCategory = "file" | "shell" | "web" | "agent" | "task" | "plan" | "mcp" | "other";
const DETAIL_CAT_EMOJI: Record<DetailCategory, string> = {
  file: "📁", shell: "⚡", web: "🌐", agent: "🤖",
  task: "📋", plan: "🧭", mcp: "🔌", other: "✨",
};
const DETAIL_CAT_LABEL: Record<DetailCategory, string> = {
  file: "file", shell: "shell", web: "web", agent: "agent",
  task: "task", plan: "plan", mcp: "mcp", other: "other",
};
const DETAIL_TOOL_CAT: Record<string, DetailCategory> = {
  Read: "file", Write: "file", Edit: "file", MultiEdit: "file",
  Glob: "file", Grep: "file", LS: "file", NotebookEdit: "file",
  Bash: "shell", PowerShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  TodoWrite: "task", TaskCreate: "task", TaskUpdate: "task",
  TaskList: "task", TaskGet: "task", TaskOutput: "task", TaskStop: "task",
  EnterPlanMode: "plan", ExitPlanMode: "plan", AskUserQuestion: "plan",
  Skill: "plan", Workflow: "plan",
};
function detailCategoryFor(name: string): DetailCategory {
  if (name.startsWith("mcp__")) return "mcp";
  return DETAIL_TOOL_CAT[name] ?? "other";
}

function matchesQuery(a: AgentNodeData, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (a.label.toLowerCase().includes(needle)) return true;
  if (a.cwd?.toLowerCase().includes(needle)) return true;
  if (a.cwdBasename?.toLowerCase().includes(needle)) return true;
  if (a.sessionId.toLowerCase().includes(needle)) return true;
  if (a.firstPrompt?.toLowerCase().includes(needle)) return true;
  for (const t of a.tools) if (t.name.toLowerCase().includes(needle)) return true;
  return false;
}

/** Compute the spotlight lineage for an agent — itself plus every ancestor
 *  (chain of parentIds) and every descendant (transitive). When no agent
 *  is selected this returns null (no spotlight). */
function spotlightLineage(state: GraphState, selectedId: string | null): Set<string> | null {
  if (!selectedId) return null;
  const set = new Set<string>([selectedId]);
  // Walk up ancestors
  let cursor: string | undefined = selectedId;
  while (cursor) {
    const a = state.agents.get(cursor);
    if (!a?.parentId) break;
    if (set.has(a.parentId)) break;
    set.add(a.parentId);
    cursor = a.parentId;
  }
  // Walk down descendants (BFS over parentId)
  let added = true;
  while (added) {
    added = false;
    for (const a of state.agents.values()) {
      if (a.parentId && set.has(a.parentId) && !set.has(a.id)) {
        set.add(a.id);
        added = true;
      }
    }
  }
  return set;
}

/** Single source of truth for "is this agent allowed on the canvas right
 *  now". Used by both snapshotToFlow (drives ReactFlow nodes) and
 *  ToolBursts (drives the burst overlay). Previously each had its own
 *  inline check and they could disagree — most notably leaving orphan
 *  bursts when an agent was excluded by one path but not the other. */
function isAgentVisible(a: AgentNodeData, now: number): boolean {
  // Past the exit animation — fully retired subagent from a prior turn.
  if (a.exitAt != null && now - a.exitAt > EXIT_ANIM_MS) return false;
  // Ghost session: a done root with 0 tools and <3s lifespan is a hook
  // test / aborted invocation, not real work.
  if (
    a.kind === "root" && a.state === "done" && a.tools.length === 0 &&
    a.endedAt != null && (a.endedAt - a.startedAt) < 3000
  ) return false;
  return true;
}

function computeVisibleIds(state: GraphState, now: number): Set<string> {
  const set = new Set<string>();
  for (const a of state.agents.values()) {
    if (isAgentVisible(a, now)) set.add(a.id);
  }
  return set;
}

function snapshotToFlow(
  state: GraphState,
  now: number,
  pinned: Map<string, { x: number; y: number }>,
  query: string,
  measured: Map<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>,
  layoutSig: string,
  lastLayoutSigRef: { current: string },
  selectedIds: Set<string>,
  lineage: Set<string> | null,
  visibleIds: Set<string>,
): { nodes: Node<AgentNodeData & { now: number; dim?: boolean }>[]; edges: Edge[] } {
  const nodes: Node<AgentNodeData & { now: number; dim?: boolean }>[] = [];
  const edges: Edge[] = [];
  const matchSet = new Set<string>();
  if (query) {
    for (const a of state.agents.values()) if (matchesQuery(a, query)) matchSet.add(a.id);
  }

  for (const a of state.agents.values()) {
    if (!visibleIds.has(a.id)) continue;
    const dim = query ? !matchSet.has(a.id) : false;
    const exiting = a.exitAt != null;
    // Spotlight: out-of-lineage agents fade hard when a selection is active.
    const spotlitOut = lineage != null && !lineage.has(a.id);
    const cls = [
      dim ? "rf-dim" : "",
      exiting ? "rf-exiting" : "",
      spotlitOut ? "rf-spotlit-out" : "",
    ].filter(Boolean).join(" ") || undefined;
    nodes.push({
      id: a.id,
      type: "agent",
      position: { x: 0, y: 0 },
      data: { ...a, now, dim },
      className: cls,
    });
    if (a.parentId && visibleIds.has(a.parentId)) {
      const hue = sessionHue(a.sessionId);
      const stroke = a.state === "active" ? `hsl(${hue} 80% 72%)` : `hsl(${hue} 50% 55%)`;
      const edgeDim = query && (!matchSet.has(a.id) && !matchSet.has(a.parentId));
      const fading = exiting;
      // Selected-edge emphasis: thicker stroke + animated for edges that
      // touch any selected agent (multi-select: any in the set counts).
      const isSelectedEdge = selectedIds.size > 0 && (selectedIds.has(a.id) || selectedIds.has(a.parentId));
      // Spotlight: edges entirely outside the lineage fade too.
      const spotlitOutEdge = lineage != null && !lineage.has(a.id) && !lineage.has(a.parentId);
      const baseWidth = a.state === "active" ? 2 : 1.5;
      const selectedWidth = isSelectedEdge ? baseWidth + 1.5 : baseWidth;
      const effectiveOpacity = edgeDim || fading
        ? 0.2
        : spotlitOutEdge ? 0.12 : 1;
      const cls = [
        fading ? "rf-edge-exiting" : "",
        isSelectedEdge ? "rf-edge-selected" : "",
      ].filter(Boolean).join(" ") || undefined;
      edges.push({
        id: `e:${a.parentId}->${a.id}`,
        source: a.parentId,
        target: a.id,
        animated: (a.state === "active" || isSelectedEdge) && !edgeDim && !fading,
        type: "smoothstep",
        // No edge label — the target node already displays the agent name.
        style: { stroke, strokeWidth: selectedWidth, opacity: effectiveOpacity, transition: "opacity 500ms ease, stroke-width 200ms ease" },
        className: cls,
      });
    }
  }
  // Only rerun dagre when the structure or measured sizes actually change.
  // Between layouts, reuse cached positions so per-event renders don't shift
  // nodes — that was the source of canvas flicker + drag-snap-back.
  if (layoutSig !== lastLayoutSigRef.current) {
    const laidOut = autoLayout(nodes, edges, { direction: "LR", pinned, measured });
    for (const n of laidOut) positions.set(n.id, n.position);
    lastLayoutSigRef.current = layoutSig;
  } else {
    // Lay out any brand-new nodes whose position is still missing.
    const missing = nodes.filter(n => !pinned.has(n.id) && !positions.has(n.id));
    if (missing.length > 0) {
      const laidOut = autoLayout(nodes, edges, { direction: "LR", pinned, measured });
      for (const n of laidOut) if (!positions.has(n.id)) positions.set(n.id, n.position);
    }
  }
  // Evict cached positions for agents that aren't in state.agents anymore.
  // Stale positions for invisible-but-still-tracked agents are KEPT so a
  // transient flicker out of visibleIds (e.g. one frame where isAgentVisible
  // is false during a state transition) doesn't lose the position and snap
  // the node to {0,0} on return — that was causing "nodes vanish on action
  // change" while bursts (which gate on visibleIds) also disappeared.
  for (const id of Array.from(positions.keys())) {
    if (!state.agents.has(id)) positions.delete(id);
  }
  // For brand-new visible agents that ended up at {0,0} (no measurement yet,
  // dagre placed at origin), defer rendering them until the next frame when
  // measurements / layout settle. Returning them at {0,0} caused the
  // overlap-at-origin visual where many nodes piled at the canvas corner.
  const finalNodes: typeof nodes = [];
  for (const n of nodes) {
    const p = pinned.get(n.id) ?? positions.get(n.id);
    if (!p) continue; // skip this frame — node will appear once laid out
    finalNodes.push({ ...n, position: p });
  }
  return { nodes: finalNodes, edges };
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}

function Inner() {
  const rf = useReactFlow();
  const stateRef = useRef<GraphState>(initialState());
  const [, force] = useState(0);
  const rerender = useCallback(() => force(x => x + 1), []);
  // Selection model: a set of agent ids contributes to spotlight lineage.
  // The primary selection (last clicked) drives the right-hand detail
  // panel and the topbar ribbon — multi-select extends the spotlight but
  // doesn't try to show N agents in the side panel at once.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [primarySelectedId, setPrimarySelectedId] = useState<string | null>(null);
  const [openedToolId, setOpenedToolId] = useState<string | null>(null);

  const selectAgent = useCallback((id: string, additive: boolean) => {
    setSelectedIds(prev => {
      if (!additive) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setPrimarySelectedId(prev => {
      if (!additive) return id;
      // Shift+click: if we just added, this becomes primary; if we just
      // removed primary, fall back to "any other selected" or null.
      if (prev === id) return prev;
      return id;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setPrimarySelectedId(null);
  }, []);
  /** Session ID for which we're showing the end-of-session recap modal,
   *  or null when no modal is open. Triggered by Stop / SessionEnd hooks
   *  (gated against dismissedSummariesRef to avoid re-opening on refresh). */
  const [summaryFor, setSummaryFor] = useState<string | null>(null);
  const dismissedSummariesRef = useRef<Set<string>>(loadDismissedSummaries());
  /** Left sidebar (session list) visibility — persisted across refresh. */
  const [sessionListOpen, setSessionListOpen] = useState<boolean>(loadSessionListOpen);
  useEffect(() => { saveSessionListOpen(sessionListOpen); }, [sessionListOpen]);
  /** Bottom timeline strip visibility — persisted across refresh. */
  const [timelineOpen, setTimelineOpen] = useState<boolean>(loadTimelineOpen);
  useEffect(() => { saveTimelineOpen(timelineOpen); }, [timelineOpen]);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const queueRef = useRef<HookEnvelope[]>([]);
  const [now, setNow] = useState(Date.now());
  // Restore pinned positions synchronously on first render so they're
  // applied before snapshotToFlow runs autoLayout. Sessions outlast a
  // browser refresh (their session_id is stable), so dragged positions
  // come back where you left them.
  const pinnedRef = useRef<Map<string, { x: number; y: number }>>(new Map(loadLayout()));
  const restoredViewport = useState(() => loadViewport())[0];
  const [query, setQuery] = useState("");
  /** Categories the user has muted via the filter chips. Bursts whose
   *  category is in this set don't render. Reset only by toggling them
   *  back on (R / clear don't touch it — filters are user intent). */
  const [hiddenCats, setHiddenCats] = useState<Set<DetailCategory>>(() => new Set());
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return (window.localStorage.getItem("agent-dag.theme") as "dark" | "light") ?? "dark";
  });
  const [everConnected, setEverConnected] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("agent-dag.theme", theme); } catch {}
  }, [theme]);

  // Apply restored viewport once ReactFlow's instance is ready. We skip
  // the initial fitView in that case (see <ReactFlow fitView={…}/> below).
  useEffect(() => {
    if (!restoredViewport) return;
    const id = window.setTimeout(() => {
      try { rf.setViewport(restoredViewport, { duration: 0 }); } catch {}
    }, 60);
    return () => window.clearTimeout(id);
  }, [rf, restoredViewport]);

  // SSE subscription
  useEffect(() => {
    const es = new EventSource("/events");
    es.addEventListener("open", () => { setLive(true); setEverConnected(true); });
    es.addEventListener("error", () => setLive(false));
    es.addEventListener("hook", (e) => {
      try {
        const env: HookEnvelope = JSON.parse((e as MessageEvent).data);
        if (paused) { queueRef.current.push(env); return; }
        stateRef.current = applyEvent(stateRef.current, env);
        // Session recap modal is opt-in only — user opens it by clicking
        // the "summary" button on a done root node. Auto-opening on
        // Stop/SessionEnd interrupted live work too aggressively.
        rerender();
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [paused, rerender]);

  // Drain queue when un-paused
  useEffect(() => {
    if (paused) return;
    if (queueRef.current.length === 0) return;
    for (const env of queueRef.current) stateRef.current = applyEvent(stateRef.current, env);
    queueRef.current.length = 0;
    rerender();
  }, [paused, rerender]);

  // Tick clock so elapsed-time fields refresh smoothly + exit animations
  // clean up. Same tick also reaps in-flight tools whose PostToolUse never
  // arrived (e.g. the session was killed mid-call) so they don't pulse
  // forever in the burst layer.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      let changed = sweepStaleTools(stateRef.current, t, STALE_TOOL_MS);
      // Prune long-finished agents so memory doesn't grow over multi-day
      // sessions. Keeps most-recent AGENT_CAP — past 5 minutes since done.
      if (pruneOldAgents(stateRef.current, t, AGENT_CAP, AGENT_GRACE_MS)) changed = true;
      // Sample total cost every ~1s for the timeline chart. Cheaper than
      // ticking every 250ms and detailed enough for a smooth area.
      if (t - lastCostSampleAtRef.current >= 1000) {
        lastCostSampleAtRef.current = t;
        let total = 0;
        for (const a of stateRef.current.agents.values()) {
          total += costForUsage(a.usage, a.model).total;
        }
        const buf = costSamplesRef.current;
        buf.push({ t, cost: total });
        if (buf.length > 240) buf.shift();
      }
      if (changed) rerender();
    }, 250);
    return () => clearInterval(id);
  }, [rerender]);

  // Auto-fit-related refs (see effect after layoutSig is computed below).
  const fitTimerRef = useRef<number | null>(null);
  const lastFitTimeRef = useRef(0);
  const lastLayoutSigForFitRef = useRef("");
  // Debounce timer for persisting the viewport on pan/zoom.
  const vpSaveTimerRef = useRef<number | null>(null);
  /** Rolling buffer of {t, total} cost samples, snapshotted ~1/sec. Powers
   *  the timeline's "$" mode (smooth area chart of cumulative spend over
   *  the last minute or so). Capped at 240 samples (~4 minutes). */
  const costSamplesRef = useRef<Array<{ t: number; cost: number }>>([]);
  const lastCostSampleAtRef = useRef(0);

  // Auto-recover from "drifted off-screen": every 1.5s check whether ANY
  // agent's bounding box intersects the visible viewport. If none have at
  // all, fit-view immediately. Skipped only when the user is actively
  // interacting (pan/zoom/drag in the last 800ms) so we don't yank the view
  // mid-gesture. This is the failsafe that recovers from layout reflows
  // when a new session arrives and dagre shifts everything off-screen.
  const lastInteractRef = useRef(0);
  const markInteract = useCallback(() => { lastInteractRef.current = Date.now(); }, []);
  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - lastInteractRef.current < 800) return;
      const state = stateRef.current;
      const t = Date.now();
      const liveAgents: { id: string }[] = [];
      for (const a of state.agents.values()) {
        if (a.exitAt != null && t - a.exitAt > EXIT_ANIM_MS) continue;
        liveAgents.push({ id: a.id });
      }
      if (liveAgents.length === 0) return;
      const vp = rf.getViewport();
      const canvasW = window.innerWidth - 360; // detail panel
      const canvasH = window.innerHeight - 52; // topbar
      let anyInView = false;
      let anyMeasured = false;
      for (const { id } of liveAgents) {
        const size = measuredRef.current.get(id);
        const pos = pinnedRef.current.get(id) ?? positionsRef.current.get(id);
        if (!size || !pos) continue;
        anyMeasured = true;
        const sl = pos.x * vp.zoom + vp.x;
        const st = pos.y * vp.zoom + vp.y;
        const sr = (pos.x + size.width) * vp.zoom + vp.x;
        const sb = (pos.y + size.height) * vp.zoom + vp.y;
        if (sr > 0 && sl < canvasW && sb > 0 && st < canvasH) {
          anyInView = true;
          break;
        }
      }
      // Only attempt a fit if at least one agent is measured AND none of the
      // measured ones intersect the viewport — that's the genuine drift case.
      if (anyMeasured && !anyInView) {
        try { rf.fitView({ padding: 0.25, duration: 600 }); } catch {}
      }
    }, 1500);
    return () => clearInterval(id);
  }, [rf]);

  // Real per-node sizes — read from RF's internal store via a selector that
  // returns a monotonic counter. Counter only ticks when a measurement
  // actually changed (delta > 4px) or a new node was measured. No
  // recursion: stable input → stable output → no extra render.
  const measuredRef = useRef<Map<string, { width: number; height: number }>>(new Map());
  const measuredVersionRef = useRef(0);
  const measuredSelector = useCallback((s: ReactFlowState) => {
    const map = measuredRef.current;
    let changed = false;
    for (const n of s.nodeInternals.values()) {
      const w = n.width, h = n.height;
      if (w == null || h == null) continue;
      const prev = map.get(n.id);
      if (!prev) {
        map.set(n.id, { width: w, height: h });
        changed = true;
      } else if (Math.abs(prev.height - h) > 4 || Math.abs(prev.width - w) > 4) {
        map.set(n.id, { width: w, height: h });
        changed = true;
      }
    }
    if (changed) measuredVersionRef.current += 1;
    return measuredVersionRef.current;
  }, []);
  const sizeVersion = useStore(measuredSelector);

  // Position cache + structural signature. Layout reruns only when the set
  // of visible agents OR sizes OR pin-set changes — NOT on every event.
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const lastLayoutSigRef = useRef<string>("");
  const layoutSig = useMemo(() => {
    const ids: string[] = [];
    for (const a of stateRef.current.agents.values()) {
      // Mirror isAgentVisible exactly — layoutSig and visibleAgentIds must
      // agree, otherwise dagre re-runs for agents that never render and
      // the cached positions drift relative to what's actually on canvas.
      if (!isAgentVisible(a, now)) continue;
      ids.push(a.id + (a.parentId ? `>${a.parentId}` : ""));
    }
    ids.sort();
    return `${ids.join("|")}#sv${sizeVersion}`;
  }, [stateRef.current, stateRef.current.lastSeq, now, sizeVersion]);

  // Auto-fit on layout-signature changes — the single source of truth for
  // structural shifts: agent added/removed, parent relationship changed, or
  // a measurement that moved a node. Catches the "14 agents in state but
  // none visible" case where count is stable but the layout reflowed.
  useEffect(() => {
    if (lastLayoutSigForFitRef.current === layoutSig) return;
    const prev = lastLayoutSigForFitRef.current;
    lastLayoutSigForFitRef.current = layoutSig;
    if (!prev) return; // first render — let initial fitView prop handle it
    const tnow = Date.now();
    if (tnow - lastFitTimeRef.current > 1200) {
      try { rf.fitView({ padding: 0.25, duration: 400 }); } catch {}
      lastFitTimeRef.current = tnow;
    }
    if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => {
      try { rf.fitView({ padding: 0.25, duration: 500 }); } catch {}
      lastFitTimeRef.current = Date.now();
    }, 280);
  }, [layoutSig, rf]);

  // Union spotlight set — lineage of every selected agent merged. Multi-
  // select widens the spotlight without losing the "follow the chain"
  // semantics for a single click.
  const spotlightSet = useMemo<Set<string> | null>(() => {
    if (selectedIds.size === 0) return null;
    const union = new Set<string>();
    for (const id of selectedIds) {
      const l = spotlightLineage(stateRef.current, id);
      if (l) for (const x of l) union.add(x);
    }
    return union.size > 0 ? union : null;
  }, [stateRef.current, stateRef.current.lastSeq, selectedIds]);

  // The visibility set drives BOTH the React Flow nodes prop and the
  // burst overlay's render gate — single source of truth so the two
  // can never disagree (which previously left orphan bursts on screen
  // when an agent was filtered out via one path but not the other).
  const visibleAgentIds = useMemo<Set<string>>(
    () => computeVisibleIds(stateRef.current, now),
    [stateRef.current, stateRef.current.lastSeq, now],
  );

  const { nodes, edges } = useMemo(
    () => snapshotToFlow(
      stateRef.current, now, pinnedRef.current, query,
      measuredRef.current, positionsRef.current, layoutSig, lastLayoutSigRef,
      selectedIds, spotlightSet, visibleAgentIds,
    ),
    [stateRef.current, stateRef.current.lastSeq, now, query, layoutSig, selectedIds, spotlightSet, visibleAgentIds],
  );

  // Set of agent ids that match the current /-search query, or null when
  // there's no query (= no dimming). Passed to ToolBursts so its bubbles
  // dim in lockstep with the agent nodes — consistent visual filter.
  const matchedAgentIds = useMemo<Set<string> | null>(() => {
    if (!query) return null;
    const set = new Set<string>();
    for (const a of stateRef.current.agents.values()) if (matchesQuery(a, query)) set.add(a.id);
    return set;
  }, [stateRef.current, stateRef.current.lastSeq, query]);

  // Which categories currently have at least one tool on the canvas — the
  // filter row only shows chips for active categories so users aren't
  // staring at empty toggle buttons.
  const presentCats = useMemo<DetailCategory[]>(() => {
    const set = new Set<DetailCategory>();
    for (const a of stateRef.current.agents.values()) {
      for (const t of a.tools) set.add(detailCategoryFor(t.name));
    }
    // Stable order: same as DETAIL_CAT_EMOJI declaration order.
    return (Object.keys(DETAIL_CAT_EMOJI) as DetailCategory[]).filter(c => set.has(c));
  }, [stateRef.current, stateRef.current.lastSeq]);

  // MCP server legend — unique servers observed across all tool calls,
  // each with a count. ToolBursts gives unknown servers a hash-based hue
  // accent; we mirror that here so the legend dot color matches the
  // burst's stripe color for the same server.
  const mcpServers = useMemo<Array<{ server: string; count: number; hue: number }>>(() => {
    const counts = new Map<string, number>();
    for (const a of stateRef.current.agents.values()) {
      for (const t of a.tools) {
        if (!t.name.startsWith("mcp__")) continue;
        const rest = t.name.slice(5);
        const idx = rest.indexOf("__");
        const server = idx > 0 ? rest.slice(0, idx) : rest;
        counts.set(server, (counts.get(server) ?? 0) + 1);
      }
    }
    const out: Array<{ server: string; count: number; hue: number }> = [];
    for (const [server, count] of counts) {
      // Same djb2-ish hash ToolBursts uses for unknown server hue.
      let h = 5381;
      for (let i = 0; i < server.length; i++) h = ((h << 5) + h) ^ server.charCodeAt(i);
      out.push({ server, count, hue: Math.abs(h) % 360 });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }, [stateRef.current, stateRef.current.lastSeq]);

  const toggleCat = useCallback((c: DetailCategory) => {
    setHiddenCats(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }, []);

  const selected = primarySelectedId ? stateRef.current.agents.get(primarySelectedId) : null;
  const openedTool = openedToolId
    ? Array.from(stateRef.current.agents.values())
        .flatMap(a => a.tools)
        .find(t => t.id === openedToolId) ?? null
    : null;

  const handleClear = useCallback(async () => {
    try { await fetch("/api/clear", { method: "POST" }); } catch {}
    stateRef.current = initialState();
    pinnedRef.current.clear();
    measuredRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    clearSelection();
    rerender();
  }, [rerender, clearSelection]);

  const handleRelayout = useCallback(() => {
    pinnedRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    rerender();
    // After dagre runs on the next render, fit-view so the user sees the
    // result. 80ms gives React + RF one paint to settle the new positions.
    window.setTimeout(() => {
      try { rf.fitView({ padding: 0.25, duration: 500 }); } catch {}
      lastFitTimeRef.current = Date.now();
    }, 80);
  }, [rerender, rf]);

  const handleFit = useCallback(() => {
    try { rf.fitView({ padding: 0.25, duration: 500 }); } catch {}
    lastFitTimeRef.current = Date.now();
  }, [rf]);

  /** Step through visible agents in render order. `direction` is +1 for
   *  next (j) or -1 for previous (k). Selecting moves the canvas to keep
   *  the chosen agent in view. */
  const stepAgent = useCallback((direction: 1 | -1) => {
    if (nodes.length === 0) return;
    // Use the same order ReactFlow's nodes prop has — left-to-right by
    // worldspace position then top-to-bottom. That matches what the eye
    // expects when pressing j.
    const ordered = nodes
      .slice()
      .sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x));
    const currentIdx = primarySelectedId
      ? ordered.findIndex(n => n.id === primarySelectedId)
      : -1;
    let next: number;
    if (currentIdx === -1) {
      next = direction === 1 ? 0 : ordered.length - 1;
    } else {
      next = (currentIdx + direction + ordered.length) % ordered.length;
    }
    const target = ordered[next];
    if (!target) return;
    selectAgent(target.id, false);
    // Fit-view to the chosen node so it lands on screen even if the user
    // had panned away.
    window.setTimeout(() => {
      try { rf.fitView({ padding: 0.35, duration: 350, nodes: [target] }); } catch {}
      lastFitTimeRef.current = Date.now();
    }, 30);
  }, [nodes, primarySelectedId, selectAgent, rf]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.tagName === "INPUT";
      if (e.key === "Escape") {
        if (inInput) (e.target as HTMLInputElement).blur();
        else clearSelection();
        return;
      }
      if (inInput) return;
      if (e.key === "/") { e.preventDefault(); searchInputRef.current?.focus(); return; }
      if (e.key === " ") { e.preventDefault(); setPaused(p => !p); }
      if (e.key === "c" || e.key === "C") handleClear();
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "f" || e.key === "F") handleFit();
      if (e.key === "l" || e.key === "L") setSessionListOpen(o => !o);
      if (e.key === "h" || e.key === "H") setTimelineOpen(o => !o);
      if (e.key === "j" || e.key === "J") stepAgent(1);
      if (e.key === "k" || e.key === "K") stepAgent(-1);
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClear, handleRelayout, handleFit, clearSelection, stepAgent]);

  const agentCount = stateRef.current.agents.size;
  const sessionCount = new Set(Array.from(stateRef.current.agents.values()).map(a => a.sessionId)).size;
  const totalTokens = useMemo(() => {
    let inT = 0, outT = 0, cacheR = 0, cacheC = 0;
    let costSum = 0, costInput = 0, costOutput = 0, costCacheR = 0, costCacheW = 0;
    for (const a of stateRef.current.agents.values()) {
      inT += a.usage.inputTokens;
      outT += a.usage.outputTokens;
      cacheR += a.usage.cacheReadTokens;
      cacheC += a.usage.cacheCreateTokens;
      const c = costForUsage(a.usage, a.model);
      costSum += c.total;
      costInput += c.input;
      costOutput += c.output;
      costCacheR += c.cacheRead;
      costCacheW += c.cacheWrite;
    }
    return { inT, outT, cacheR, cacheC, sum: inT + outT, cost: { total: costSum, input: costInput, output: costOutput, cacheRead: costCacheR, cacheWrite: costCacheW } };
  }, [stateRef.current, stateRef.current.lastSeq]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          agent-dag <span className="v">v{__APP_VERSION__}</span>
        </div>
        {selected && (() => {
          const c = costForUsage(selected.usage, selected.model);
          const elapsedSec = Math.max(0, ((selected.endedAt ?? now) - selected.startedAt) / 1000);
          const rate = selected.state === "active" ? fmtCostRate(c.total, elapsedSec) : null;
          const extra = selectedIds.size - 1;
          return (
            <button
              type="button"
              className="selected-ribbon"
              title={`Fit view to ${selected.label}`}
              onClick={() => {
                try {
                  const node = nodes.find(n => n.id === selected.id);
                  if (node) rf.fitView({ padding: 0.35, duration: 500, nodes: [node] });
                  lastFitTimeRef.current = Date.now();
                } catch {}
              }}
            >
              <span className={`state-pill state-${selected.state}`}>
                {selected.state === "active" ? "live" : selected.state}
              </span>
              <span className="selected-label">{selected.label}</span>
              {c.total > 0 && <span className="selected-cost">{fmtCost(c.total)}{rate ? <span className="selected-rate"> · {rate}</span> : null}</span>}
              {extra > 0 && <span className="selected-extra">+{extra}</span>}
              <span
                role="button"
                aria-label="Deselect"
                className="selected-close"
                onClick={(e) => { e.stopPropagation(); clearSelection(); }}
              >×</span>
            </button>
          );
        })()}
        <div className="actions">
          <div className="search">
            <span className="search-icon" aria-hidden>⌕</span>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search agents, cwd, tools…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              aria-label="Filter the graph"
            />
            {query
              ? <button className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>
              : <kbd className="search-kbd" aria-hidden>/</kbd>}
          </div>
          <span className="status" role="status">
            <span className={`pill ${live ? "live" : "dead"}`} title={live ? "Receiving events" : "SSE disconnected"}>
              {live ? "live" : "offline"}
            </span>
            <span className="stat" title="Distinct CC sessions"><span className="count">{sessionCount}</span><span className="lbl">sessions</span></span>
            <span className="stat" title="Total agents (root + subagents)"><span className="count">{agentCount}</span><span className="lbl">agents</span></span>
            <span className="stat" title="Total hook events received"><span className="count">{stateRef.current.totalEvents}</span><span className="lbl">events</span></span>
            {totalTokens.sum > 0 && (
              <span className="stat" title={`in:${totalTokens.inT.toLocaleString()}  out:${totalTokens.outT.toLocaleString()}  cache-r:${totalTokens.cacheR.toLocaleString()}  cache-c:${totalTokens.cacheC.toLocaleString()}`}>
                <span className="count">{fmtTokens(totalTokens.sum)}</span><span className="lbl">tokens</span>
              </span>
            )}
            {mcpServers.length > 0 && (
              <span
                className="stat mcp-legend"
                title={`MCP servers seen this session:\n${mcpServers.map(s => `  ${s.server}: ${s.count} call${s.count === 1 ? "" : "s"}`).join("\n")}`}
              >
                {mcpServers.slice(0, 6).map(s => (
                  <span
                    key={s.server}
                    className="mcp-dot"
                    style={{ background: `hsl(${s.hue} 65% 65%)` }}
                  />
                ))}
                {mcpServers.length > 6 && <span className="mcp-more">+{mcpServers.length - 6}</span>}
                <span className="lbl">mcp</span>
              </span>
            )}
            {totalTokens.cost.total > 0 && (() => {
              // Active-agent aggregate burn rate — only counts agents whose
              // state is "active" so finished sessions don't dilute the
              // current ticker. Falls back to overall avg if nothing's live.
              let liveCost = 0, liveSec = 0;
              for (const a of stateRef.current.agents.values()) {
                if (a.state !== "active") continue;
                const c = costForUsage(a.usage, a.model);
                liveCost += c.total;
                liveSec = Math.max(liveSec, ((a.endedAt ?? now) - a.startedAt) / 1000);
              }
              const rate = liveSec > 0 ? fmtCostRate(liveCost, liveSec) : null;
              const tt = `input ${fmtCost(totalTokens.cost.input)} + output ${fmtCost(totalTokens.cost.output)} + cache r ${fmtCost(totalTokens.cost.cacheRead)} + cache w ${fmtCost(totalTokens.cost.cacheWrite)}${rate ? `\nactive burn: ${rate}` : ""}`;
              return (
                <span className="stat" title={tt}>
                  <span className="count">{fmtCost(totalTokens.cost.total)}</span>
                  <span className="lbl">cost{rate ? ` · ${rate}` : ""}</span>
                </span>
              );
            })()}
          </span>
          <button className={`btn ${paused ? "warn" : ""}`} onClick={() => setPaused(p => !p)} title="Pause/resume live updates (Space)">
            {paused ? `Resume${queueRef.current.length ? ` · ${queueRef.current.length}` : ""}` : "Pause"}
          </button>
          <button
            className={`btn icon-btn ${sessionListOpen ? "primary" : ""}`}
            onClick={() => setSessionListOpen(o => !o)}
            title={`${sessionListOpen ? "Hide" : "Show"} session list (L)`}
            aria-label="Toggle session list"
          >☰</button>
          <button
            className={`btn icon-btn ${timelineOpen ? "primary" : ""}`}
            onClick={() => setTimelineOpen(o => !o)}
            title={`${timelineOpen ? "Hide" : "Show"} activity timeline (H)`}
            aria-label="Toggle activity timeline"
          >⏱</button>
          <button className="btn" onClick={handleRelayout} title="Auto-arrange — clear pins (R)">Re-layout</button>
          <button className="btn" onClick={handleClear} title="Clear canvas (C)">Clear</button>
          <button
            className="btn icon-btn"
            onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode (T)`}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      {everConnected && !live && (
        <div className="conn-banner" role="alert">
          <span className="conn-dot" />
          Lost connection to agent-dag server. Reconnecting…
        </div>
      )}

      {sessionListOpen && (
        <SessionList
          state={stateRef.current}
          now={now}
          selectedIds={selectedIds}
          onSelect={(sid) => {
            selectAgent(sid, false);
            // After a frame so the selected node is settled, fit-view to it.
            window.setTimeout(() => {
              try {
                const node = nodes.find(n => n.id === sid);
                if (node) rf.fitView({ padding: 0.3, duration: 500, nodes: [node] });
                lastFitTimeRef.current = Date.now();
              } catch {}
            }, 60);
          }}
          onClose={() => setSessionListOpen(false)}
        />
      )}
      <div className="canvas-wrap">
        {agentCount === 0 && <EmptyHero live={live} everConnected={everConnected} />}
        {presentCats.length > 1 && (
          <div className="cat-filter-bar" role="toolbar" aria-label="Filter tools by category">
            {presentCats.map(c => {
              const off = hiddenCats.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  className={`cat-filter${off ? " off" : ""}`}
                  onClick={() => toggleCat(c)}
                  title={`${off ? "Show" : "Hide"} ${DETAIL_CAT_LABEL[c]} tools`}
                >
                  <span className="cat-emoji">{DETAIL_CAT_EMOJI[c]}</span>
                  <span className="cat-name">{DETAIL_CAT_LABEL[c]}</span>
                </button>
              );
            })}
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView={!restoredViewport}
          fitViewOptions={{ padding: 0.25, duration: 400 }}
          minZoom={0.2}
          maxZoom={1.6}
          panOnScroll
          nodesDraggable
          nodesConnectable={false}
          selectionOnDrag={false}
          onNodeClick={(e, n) => selectAgent(n.id, e.shiftKey)}
          onPaneClick={() => clearSelection()}
          onMove={(_, vp) => {
            markInteract();
            // Debounce viewport persistence — pan/zoom fires many times
            // per gesture, but we only need the final state.
            if (vpSaveTimerRef.current) window.clearTimeout(vpSaveTimerRef.current);
            vpSaveTimerRef.current = window.setTimeout(() => saveViewport(vp), 250);
          }}
          onNodeDragStart={(_, n) => {
            markInteract();
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
          }}
          onNodeDrag={(_, n) => {
            // Live-pin during drag so an incoming event re-render doesn't
            // snap the node back to its dagre slot mid-motion.
            markInteract();
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
          }}
          onNodeDragStop={(_, n) => {
            markInteract();
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            saveLayout(pinnedRef.current);
          }}
        >
          <Background gap={28} size={1} color={cssVar("--grid-line")} />
          <SessionClusters />
          <ToolBursts
            agents={stateRef.current.agents}
            visibleAgentIds={visibleAgentIds}
            positions={positionsRef.current}
            pinned={pinnedRef.current}
            measured={measuredRef.current}
            dimUnmatched={matchedAgentIds}
            spotlight={spotlightSet}
            hiddenCategories={hiddenCats}
            now={now}
            onOpenTool={setOpenedToolId}
          />
          <Controls showInteractive={false} />
          <MiniMap
            zoomable
            pannable
            nodeColor={n => {
              const d = n.data as AgentNodeData;
              if (d.state === "err") return cssVar("--err");
              if (d.state === "active") return cssVar("--inflight");
              return cssVar("--ok");
            }}
            nodeStrokeWidth={2}
            maskColor={cssVar("--minimap-mask")}
            style={{ background: cssVar("--panel"), border: `1px solid ${cssVar("--line")}`, borderRadius: 8 }}
          />
        </ReactFlow>
        {timelineOpen && agentCount > 0 && (
          <TimelineStrip
            agents={stateRef.current.agents}
            now={now}
            costSamples={costSamplesRef.current}
            onSelect={(id) => selectAgent(id, false)}
            onOpenTool={setOpenedToolId}
            onClose={() => setTimelineOpen(false)}
          />
        )}
      </div>

      <aside className="detail">
        {selected
          ? <Detail
              agent={selected}
              now={now}
              onOpenTool={setOpenedToolId}
              onShowSummary={(sid) => {
                if (dismissedSummariesRef.current.has(sid)) {
                  dismissedSummariesRef.current.delete(sid);
                  saveDismissedSummaries(dismissedSummariesRef.current);
                }
                setSummaryFor(sid);
              }}
              onExportSession={(sid) => exportSessionJson(stateRef.current, sid)}
            />
          : <EmptyDetail count={agentCount} />}
      </aside>

      {openedTool && <ToolModal tool={openedTool} onClose={() => setOpenedToolId(null)} />}
      {summaryFor && (
        <SessionSummary
          state={stateRef.current}
          sessionId={summaryFor}
          onClose={() => {
            dismissedSummariesRef.current.add(summaryFor);
            saveDismissedSummaries(dismissedSummariesRef.current);
            setSummaryFor(null);
          }}
        />
      )}
    </div>
  );
}

function EmptyHero({ live, everConnected }: { live: boolean; everConnected: boolean }) {
  const offline = !live;
  return (
    <div className="empty-hero">
      <div className="orbit-stack" aria-hidden>
        <div className="core" />
        <div className="orbit r1"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r2"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r3"><span className="dot" /><span className="dot b" /></div>
      </div>
      {offline ? (
        <>
          <h2>{everConnected ? "Disconnected from server" : "Server unreachable"}</h2>
          <p>
            The browser cannot reach <code>/events</code>. Check that
            <code>agent-dag</code> is still running in your terminal, then this
            page will resume automatically.
          </p>
        </>
      ) : agentNoneCopy()}
    </div>
  );
}

function agentNoneCopy() {
  return (
    <>
      <h2>Waiting for Claude Code</h2>
      <p>
        Run <code>claude</code> in any folder. As soon as a session sends an
        event, a node appears here and grows as subagents fork and tools are
        called.
      </p>
      <p className="hint-row">
        Not seeing anything? Make sure <code>agent-dag</code> is running and that
        the hook is installed in <code>~/.claude/settings.json</code>.
      </p>
    </>
  );
}

function EmptyDetail({ count }: { count: number }) {
  return (
    <>
      <h3>Detail</h3>
      {count === 0 ? (
        <div className="hint">
          No data yet. Start a Claude Code session anywhere on this machine —
          agent-dag is in <code>--all</code> mode and listens to every workspace.
        </div>
      ) : (
        <div className="empty">Click an agent to see its tools.</div>
      )}
      <h3 style={{ marginTop: 4 }}>Shortcuts</h3>
      <div className="shortcuts">
        <div className="sc"><kbd>drag</kbd><span>move a node</span></div>
        <div className="sc"><kbd>/</kbd><span>focus search</span></div>
        <div className="sc"><kbd>space</kbd><span>pause / resume</span></div>
        <div className="sc"><kbd>J</kbd><span>next agent</span></div>
        <div className="sc"><kbd>K</kbd><span>previous agent</span></div>
        <div className="sc"><kbd>R</kbd><span>re-arrange</span></div>
        <div className="sc"><kbd>F</kbd><span>fit view</span></div>
        <div className="sc"><kbd>L</kbd><span>session list</span></div>
        <div className="sc"><kbd>H</kbd><span>activity timeline</span></div>
        <div className="sc"><kbd>C</kbd><span>clear canvas</span></div>
        <div className="sc"><kbd>T</kbd><span>toggle theme</span></div>
        <div className="sc"><kbd>Esc</kbd><span>deselect</span></div>
      </div>
    </>
  );
}

function Detail({
  agent,
  now,
  onOpenTool,
  onShowSummary,
  onExportSession,
}: {
  agent: AgentNodeData;
  now: number;
  onOpenTool: (toolId: string) => void;
  onShowSummary?: (sessionId: string) => void;
  onExportSession?: (sessionId: string) => void;
}) {
  const elapsedMs = (agent.endedAt ?? now) - agent.startedAt;
  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m ${String(elapsedSec % 60).padStart(2, "0")}s`;

  const cost = costForUsage(agent.usage, agent.model);
  const hasCost = cost.total > 0;
  const totalTokens = agent.usage.inputTokens + agent.usage.outputTokens;

  // Bucket tools by category for the activity strip
  const catCounts = new Map<DetailCategory, number>();
  for (const t of agent.tools) {
    const c = detailCategoryFor(t.name);
    catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const errCount = agent.tools.filter(t => t.ok === false).length;
  const inflight = agent.tools.filter(t => !t.endedAt).length;
  const catEntries = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1]);

  return (
    <>
      <header className="detail-hero">
        <div className="hero-line">
          <span className={`state-pill state-${agent.state}`}>
            {agent.state === "active" ? "live" : agent.state}
          </span>
          <h2 className="hero-title" title={agent.cwd ?? agent.label}>{agent.label}</h2>
        </div>
        <div className="hero-meta">
          <span className="hero-meta-item">{agent.kind}</span>
          <span className="hero-sep">·</span>
          <span className="hero-meta-item" title={`started ${new Date(agent.startedAt).toLocaleString()}`}>
            {elapsedLabel}
          </span>
          {agent.model && (
            <>
              <span className="hero-sep">·</span>
              <span className="model-chip" title={agent.model}>{shortModel(agent.model)}</span>
            </>
          )}
        </div>
        {hasCost && (
          <div className="hero-cost">
            <div className="hero-cost-headline">
              <span className="hero-cost-value">{fmtCost(cost.total)}</span>
              <span className="hero-cost-label">spend</span>
            </div>
            <CostBar cost={cost} />
          </div>
        )}
        <div className="hero-actions">
          {agent.kind === "root" && agent.state === "done" && onShowSummary && (
            <button
              type="button"
              className="btn hero-action-btn"
              onClick={() => onShowSummary(agent.sessionId)}
              title="Reopen the end-of-session recap modal"
            >Show recap</button>
          )}
          {onExportSession && (
            <button
              type="button"
              className="btn hero-action-btn"
              onClick={() => onExportSession(agent.sessionId)}
              title="Download this session as JSON"
            >Export JSON</button>
          )}
        </div>
      </header>

      {agent.tools.length > 0 && (
        <section className="detail-section">
          <h3>Activity</h3>
          <div className="activity-row">
            <div className="activity-counters">
              <span className="ac-item"><b>{agent.toolCount}</b> calls</span>
              {inflight > 0 && <span className="ac-item ac-live"><b>{inflight}</b> live</span>}
              {errCount > 0 && <span className="ac-item ac-err"><b>{errCount}</b> err</span>}
            </div>
            <div className="cat-strip">
              {catEntries.map(([c, n]) => (
                <span className={`cat-chip cat-${c}`} key={c} title={`${n} ${DETAIL_CAT_LABEL[c]} call${n === 1 ? "" : "s"}`}>
                  <span className="cat-emoji">{DETAIL_CAT_EMOJI[c]}</span>
                  <span className="cat-count">{n}</span>
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {totalTokens > 0 && (
        <section className="detail-section">
          <h3>Tokens</h3>
          <div className="tokens-grid">
            <div><span className="k">in</span><b>{agent.usage.inputTokens.toLocaleString()}</b></div>
            <div><span className="k">out</span><b>{agent.usage.outputTokens.toLocaleString()}</b></div>
            <div><span className="k">cache r</span><b>{agent.usage.cacheReadTokens.toLocaleString()}</b></div>
            <div><span className="k">cache c</span><b>{agent.usage.cacheCreateTokens.toLocaleString()}</b></div>
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Identity</h3>
        <div>
          {agent.cwd && <div className="row"><span className="k">cwd</span><span className="v" title={agent.cwd}>{agent.cwd}</span></div>}
          <div className="row"><span className="k">session</span><span className="v">{agent.sessionId.slice(0, 12)}…</span></div>
          {agent.parentId && <div className="row"><span className="k">parent</span><span className="v">{agent.parentId.slice(0, 12)}…</span></div>}
        </div>
      </section>

      {agent.prompts.length > 0 && (
        <section className="detail-section">
          <h3>Prompts <span className="section-count">{agent.prompts.length}</span></h3>
          <div className="prompts">
            {agent.prompts.slice().reverse().map((pr, i) => (
              <div className="prompt-entry" key={i}>
                <div className="prompt-time">{new Date(pr.at).toLocaleTimeString()}</div>
                <div className="prompt-text">{pr.text}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Tool calls <span className="section-count">{agent.tools.length}</span></h3>
        {agent.tools.length === 0 && <div className="empty">No tool calls yet.</div>}
        <div>
          {agent.tools.slice().reverse().map(t => (
            <ToolRow key={t.id} t={t} now={now} onClick={() => onOpenTool(t.id)} />
          ))}
        </div>
      </section>
    </>
  );
}

/** Stacked bar showing the cost split across input / output / cache-read /
 *  cache-write. Each segment width = its share of the total. Hides
 *  zero-width segments. */
function CostBar({ cost }: { cost: ReturnType<typeof costForUsage> }) {
  const total = cost.total;
  if (total <= 0) return null;
  const seg = (val: number, cls: string, label: string) => {
    if (val <= 0) return null;
    const pct = (val / total) * 100;
    return <span key={cls} className={`cb-seg ${cls}`} style={{ width: `${pct}%` }}
      title={`${label}: ${fmtCost(val)} (${pct.toFixed(0)}%)`} />;
  };
  return (
    <div className="cost-bar" aria-label="Cost breakdown">
      {seg(cost.input, "cb-input", "input")}
      {seg(cost.output, "cb-output", "output")}
      {seg(cost.cacheRead, "cb-cache-r", "cache read")}
      {seg(cost.cacheWrite, "cb-cache-w", "cache write")}
    </div>
  );
}

function ToolRow({ t, now, onClick }: { t: ToolCall; now: number; onClick: () => void }) {
  const status = t.endedAt == null ? "inflight" : t.ok === false ? "err" : "done";
  const dur = (t.endedAt ?? now) - t.startedAt;
  const durLabel = t.endedAt == null ? "…" : dur < 1000 ? `${dur}ms` : `${(dur / 1000).toFixed(1)}s`;
  return (
    <button className="tool clickable" title={t.inputPreview || t.name} onClick={onClick}>
      <span className="name">
        <span className={`status-dot ${status}`} />
        {t.name}
      </span>
      <span style={{ color: "var(--muted)" }}>{durLabel}</span>
    </button>
  );
}
