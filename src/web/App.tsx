import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  ControlButton,
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
import SessionGroupNode from "./components/SessionGroupNode";
import ToolBursts from "./components/ToolBursts";
import SessionSummary from "./components/SessionSummary";
import ContextModal from "./components/ContextModal";
import SessionList from "./components/SessionList";
import UsagePanel from "./components/UsagePanel";
import AccountsPanel from "./components/AccountsPanel";
import { autoRestartStep, restartEndedInFailure, restartLandingStep, upgradeFailureId } from "./restart";
import { isBrowserChord, isTypingTarget, ownsKeystroke, type FocusTarget } from "./shortcuts";
import ClearConfirm from "./components/ClearConfirm";
import { clearActionFor, type ClearSource } from "./clear-confirm";
import { pruneStaleEntries, measuredNodeIds } from "./prune";
import { createRenderCoalescer } from "./coalesce";
import { createPauseGate } from "./pause";
import { readStored } from "./storage";
import UsageHistoryModal from "./components/UsageHistoryModal";
import { autoLayout, bubblePush, fillGapsWithNewSessions, laneSignature, separateOverlaps } from "./layout";
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, sessionHue, sweepStaleTools, type GraphState } from "./reducer";
import { EXIT_ANIM_MS, isAgentVisible, computeVisibleIds, anyTouches } from "./visibility";
import { SESSION_GROUP_TYPE, minimapNodeColor } from "./minimap";
import { costForUsage, fmtCost, fmtCostRate } from "./pricing";
import { versionChipLabel, versionChipTitle } from "./version-chip";
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

const nodeTypes = { agent: AgentNode, sessionGroup: SessionGroupNode };

/**
 * How long a session takes to slide out of the way of one that grew.
 *
 * Long enough to be followed — the point of animating it at all is that the
 * user sees WHY a card moved — and short enough that the canvas is settled
 * again before they act on it. Mirrored in the .bubbling rule in styles.css.
 */
const BUBBLE_MS = 420;

// Padding of the invisible session drag-handle node. Matches SessionClusters'
// PAD so the handle lines up with the card's body (the card's header strip is
// left uncovered so its label stays clickable).
const GROUP_PAD = 18;

const STALE_TOOL_MS = 90_000;
const AGENT_CAP = 200;
const AGENT_GRACE_MS = 5 * 60_000;
// How many finished sessions stay on the canvas. Small on purpose: the board
// is for what is happening now, and a day of sessions otherwise buries it.
// The 2-minute grace is shorter than AGENT_GRACE_MS — a session is a bigger,
// more obvious thing to disappear, so it should not linger once it is over.
const DONE_SESSION_CAP = 6;
const DONE_SESSION_GRACE_MS = 2 * 60_000;
const LAYOUT_STORAGE_KEY = "agent-dag.layout";
const VIEWPORT_STORAGE_KEY = "agent-dag.viewport";
const SUMMARY_DISMISSED_KEY = "agent-dag.summariesDismissed";
const SESSION_LIST_OPEN_KEY = "agent-dag.sessionListOpen";
const DETAIL_OPEN_KEY = "agent-dag.detailOpen";
const USAGE_PANEL_OPEN_KEY = "agent-dag.usagePanelOpen";
const ACCOUNTS_PANEL_OPEN_KEY = "agent-dag.accountsPanelOpen";
const VERSION_DISMISSED_KEY = "agent-dag.versionNoticeDismissed";
// How stale the last registry lookup may get before a poll asks npm again
// instead of accepting the server's cached answer. Three times the poll
// interval: often enough that a release shows up while you are looking at the
// deck, rare enough that the cost stays the one request the README advertises.
const VERSION_FORCE_MS = 15 * 60_000;

// What GET /api/version answers. `running` is the version this server process
// booted with; `installed` is what is on disk right now. They diverge the
// moment npm upgrades a deck that is already running, and Node's module cache
// means the process keeps executing the old code until it restarts.
type VersionNotice = { kind: "restart" | "upgrade"; from: string; to: string };
type VersionInfo = {
  /** The package the server asked npm about, which is the one its `command`
   *  would install — `ccdeck` for a deck started with `npx ccdeck`. */
  name: string;
  running: string | null;
  installed: string | null;
  /** npm's newest version that is confirmed installable under `name`. */
  latest: string | null;
  /** A version npm's dist-tag names that the registry cannot serve yet. Never
   *  offered: the tag moves before the version does, and a restart taken inside
   *  that window fails with ETARGET. */
  latestPending?: string | null;
  notice: VersionNotice | null;
  command: string;
  // False when nothing is supervising the process, or when --no-persist means a
  // restart would take the canvas with it.
  canRestart?: boolean;
  /** When npm was last asked, so the chip can say it. Null when the check is off. */
  checkedAt?: number | null;
  checkDisabled?: boolean;
  /** Why an in-app `npm i -g` is refused here, or null when it is allowed. */
  upgradeBlocked?: string | null;
  /** How this copy can update itself: install in place, come back through npx,
   *  or not at all — in which case the command is the whole answer. */
  upgradeMode?: "install" | "npx" | null;
  /** `at` is when the failure was recorded — the only thing that tells one
   *  failed npx relaunch from the one before it, since a retry that breaks the
   *  same way reports the same command and the same error. */
  upgrade?: { state: "idle" | "running" | "done" | "failed"; command: string | null; error: string | null; at?: number | null };
};

// Said in the UI's voice, not npm's. Each of these is a decision we made on
// purpose, so each gets a reason rather than a disabled button.
const UPGRADE_BLOCK_TEXT: Record<string, string> = {
  git_checkout: "this deck runs from a git checkout — pull instead:",
  npx: "npx runs from a cache that cannot be upgraded in place — run:",
  not_writable: "the install directory is not writable by this user — run:",
  opted_out: "installs are off (AGENTS_DECK_NO_INSTALL=1) — run:",
};

/** "just now" / "12m ago" / "3h ago" — for the version chip's tooltip. */
function shortAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const AUTO_RESTART_KEY = "agent-dag.autoRestart";
// Per-tab, not per-browser: it guards one reload, not a preference.
const BUNDLE_RELOAD_KEY = "agent-dag.bundleReloadedFor";

// First-run layout: Usage and Accounts open, everything else closed. Those two
// answer "how much have I got left, and on which account" — the questions you
// have before you have a graph worth looking at. The session list and detail
// panel are for navigating work that already exists, so they stay shut until
// asked for, and the canvas gets the width.
function loadSessionListOpen(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(SESSION_LIST_OPEN_KEY) === "1"; } catch { return false; }
}
function saveSessionListOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SESSION_LIST_OPEN_KEY, open ? "1" : "0"); } catch {}
}
function loadDetailOpen(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(DETAIL_OPEN_KEY) === "1"; } catch { return false; }
}
function saveDetailOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(DETAIL_OPEN_KEY, open ? "1" : "0"); } catch {}
}
// Reads through storage.ts rather than window.localStorage directly: this runs
// inside a useState initialiser, and the property read throws outright on a
// browser that blocks site data, which takes App's first render with it.
function loadUsagePanelOpen(): boolean {
  const stored = readStored(USAGE_PANEL_OPEN_KEY);
  return stored === null ? true : stored === "1";
}
function saveUsagePanelOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(USAGE_PANEL_OPEN_KEY, open ? "1" : "0"); } catch {}
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

/**
 * Where every node sits, and which of those the user placed by hand.
 *
 * Only drags used to be stored, so a reload re-ran dagre over everything and
 * the canvas came back rearranged — the arrangement you spent time reading is
 * not something you should have to rebuild because you hit refresh. Auto
 * positions are saved too, and `pins` records which were deliberate so a drag
 * still outranks the layout pass.
 */
interface StoredLayout {
  positions: Array<[string, { x: number; y: number }]>;
  pins: string[];
}

function loadLayout(): StoredLayout {
  const empty: StoredLayout = { positions: [], pins: [] };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return empty;
    const obj = JSON.parse(raw) as
      | Record<string, { x: number; y: number }>
      | { v: 2; positions: Record<string, { x: number; y: number }>; pins: string[] };

    // v1 stored a bare id → point map of drags only. Read it as all-pinned so
    // an upgrade keeps whatever the user had arranged.
    if (!("v" in obj)) {
      const entries = Object.entries(obj).filter(([, v]) => v && typeof v.x === "number" && typeof v.y === "number");
      return { positions: entries, pins: entries.map(([id]) => id) };
    }
    const entries = Object.entries(obj.positions ?? {})
      .filter(([, v]) => v && typeof v.x === "number" && typeof v.y === "number");
    return { positions: entries, pins: Array.isArray(obj.pins) ? obj.pins : [] };
  } catch { return empty; }
}

function saveLayout(
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
): void {
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of positions) obj[id] = pos;
    for (const [id, pos] of pinned) obj[id] = pos;   // a drag wins over the layout
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      v: 2, positions: obj, pins: Array.from(pinned.keys()),
    }));
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
  a.download = `agents-deck-${safeLabel}-${sessionId.slice(0, 8)}.json`;
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
  // Codex shell tools
  shell: "shell", exec_command: "shell", shell_command: "shell",
  write_stdin: "shell", wait: "shell",
  // Codex file-edit tool
  apply_patch: "file",
  // Codex planning tool
  update_plan: "task",
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

function snapshotToFlow(
  state: GraphState,
  now: number,
  availableWidth: number,
  availableHeight: number,
  pinned: Map<string, { x: number; y: number }>,
  query: string,
  measured: Map<string, { width: number; height: number }>,
  prevSessionSize: Map<string, { w: number; h: number }>,
  onBubble: (sessions: string[]) => void,
  /** False while the page is still mounting and measuring. */
  settled: boolean,
  /**
   * A drag is in progress.
   *
   * Dragging a card out of its session makes that session's bounding box
   * bigger, which is indistinguishable from the session growing — so the push
   * fired on every pointer move and shoved the other sessions around while the
   * user was still holding the mouse down. The new size is still recorded, so
   * letting go does not then trigger a push for a change the user made by hand.
   */
  dragging: boolean,
  positions: Map<string, { x: number; y: number }>,
  layoutSig: string,
  lastLayoutSigRef: { current: string },
  selectedIds: Set<string>,
  lineage: Set<string> | null,
  visibleIds: Set<string>,
  onOpenContext: (sessionId: string) => void,
): { nodes: Node<AgentNodeData & { now: number; dim?: boolean; onOpenContext?: (sessionId: string) => void }>[]; edges: Edge[] } {
  const nodes: Node<AgentNodeData & { now: number; dim?: boolean; onOpenContext?: (sessionId: string) => void }>[] = [];
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
    // ReactFlow's createNodeInternals wipes width/height from internals on
    // every setNodes call — and we re-pass `nodes` on every `now` tick.
    // Without supplying them on the node prop, RF flips `initialized=false`
    // → `visibility:hidden` until ResizeObserver re-fires. Under live event
    // storms RO lags multiple frames → nodes persistently invisible while
    // tool bursts (which read positions directly) keep rendering. Pull
    // cached measurements through so internals survive the rewrite.
    const m = measured.get(a.id);
    nodes.push({
      id: a.id,
      type: "agent",
      position: { x: 0, y: 0 },
      data: { ...a, now, dim, onOpenContext },
      className: cls,
      ...(m ? { width: m.width, height: m.height } : null),
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
  // A structural change no longer reshuffles the canvas. Nodes that already
  // have a position keep it — the arrangement on screen is one the user has
  // been reading, and rebuilding it under them costs more than the tidier
  // result is worth. Only nodes without a position are laid out, and only
  // nodes that end up overlapping get moved. The relayout button (R) is the
  // way to ask for a full reflow.
  // How much room each agent's bubbles need. ToolBursts keeps the last four
  // tools as a permanent trail — no time-based culling — so an agent that has
  // called a tool occupies its lane for as long as it is on the canvas, and
  // every pass that places a box has to be told. Without it the next rank is
  // placed 160px away and lands on top of bubbles that reach 420px out, and
  // the repair passes — which run far more often than dagre does — pack the
  // neighbours straight back over the chips.
  const lanes = new Map<string, number>();
  for (const a of state.agents.values()) {
    if (a.tools.length > 0) lanes.set(a.id, Math.min(4, a.tools.length));
  }
  // A lane appearing is a structural change, so it invalidates the cached
  // arrangement the way a new node or a re-measured card does.
  //
  // Without this the reservation was applied on exactly one frame per node —
  // the frame it first appears, which is the frame it has just been created by
  // SessionStart and has called nothing, so its lane is zero. It then made
  // forty tool calls, grew 420px sideways, and nothing ever reconsidered its
  // neighbours. Clamping at four bubbles is what keeps this cheap: the string
  // stops changing after an agent's fourth tool call.
  const sig = `${layoutSig}#lanes:${laneSignature(lanes)}`;
  const missing = nodes.filter(n => !pinned.has(n.id) && !positions.has(n.id));
  if (missing.length > 0 || sig !== lastLayoutSigRef.current) {
    if (missing.length > 0) {
      const laidOut = autoLayout(nodes, edges, { direction: "LR", pinned, measured, availableWidth, availableHeight, lanes });
      for (const n of laidOut) if (!positions.has(n.id)) positions.set(n.id, n.position);
      // Finished sessions are pruned as they complete, so the column they were
      // in has holes while new work keeps being appended underneath. Offer the
      // arrivals those holes before letting the canvas grow downward past
      // bands that hold nothing.
      fillGapsWithNewSessions(
        nodes, positions, pinned, measured,
        new Set(missing.map(n => n.id)), lanes,
      );
    }
    separateOverlaps(nodes, positions, pinned, measured, lanes);
    lastLayoutSigRef.current = sig;
  }
  // A session that just fanned out subagents is wider and taller than it was a
  // frame ago, and is now sitting on whatever was beside it. separateOverlaps
  // would clear that by sliding the covered session down past the whole grown
  // block; this nudges the neighbours aside by the least that works, which is
  // both shorter and legible as a cause — the box grew, so the others moved.
  // Self-gating: returns immediately unless something actually grew.
  const bubbled = bubblePush(nodes, positions, pinned, measured, prevSessionSize, !settled || dragging, lanes);
  if (bubbled.length > 0) onBubble(bubbled);
  // Evict cached positions for agents that aren't in state.agents anymore.
  // Stale positions for invisible-but-still-tracked agents are KEPT so a
  // transient flicker out of visibleIds (e.g. one frame where isAgentVisible
  // is false during a state transition) doesn't lose the position and snap
  // the node to {0,0} on return — that was causing "nodes vanish on action
  // change" while bursts (which gate on visibleIds) also disappeared.
  // Like the pins below, this is guarded on a non-empty graph: positions are
  // restored from storage before the event log has replayed, so pruning them
  // against an empty agent map would wipe the whole saved arrangement on every
  // page load and re-derive it with dagre.
  pruneStaleEntries(positions, state.agents);
  // Drop pins for agents that are gone. Pinned positions are restored from
  // localStorage on every load, so without this a drag from some previous run
  // outlives the agent it belonged to and keeps claiming that spot on the
  // canvas — where a later session, laid out from the top, gets stacked
  // straight onto it.
  pruneStaleEntries(pinned, state.agents);
  // Drop measurements for nodes that no longer exist. This cache is not
  // restored from storage, but it is not rebuilt either: nothing but the Clear
  // button ever removed an id, so a tab left open for days holds a size for
  // every agent and every session that has ever been on the canvas. columnGap()
  // takes the widest measured node of all, and a session drag handle is as wide
  // as the whole session box, so a single long-gone session kept the gap
  // between columns at its width for the rest of the tab's life.
  pruneStaleEntries(measured, measuredNodeIds(state.agents.values()));
  // Never silently drop a visible node — if its position is missing, place
  // it at {0,0} for THIS frame and force a fresh layout pass on the next
  // frame by invalidating lastLayoutSigRef. The previous skip-this-frame
  // strategy caused the catastrophic "every node vanished while bursts
  // remained" symptom when, for whatever reason, positions got out of sync
  // with state.agents (the bursts gate on visibleAgentIds + positions; the
  // node renderer gated on positions only, so the two halves disagreed).
  const finalNodes: typeof nodes = [];
  let missingPosition = false;
  for (const n of nodes) {
    let p = pinned.get(n.id) ?? positions.get(n.id);
    if (!p) {
      p = { x: 0, y: 0 };
      positions.set(n.id, p);
      missingPosition = true;
    }
    finalNodes.push({ ...n, position: p });
  }
  if (missingPosition) {
    // Force the layout branch above to run again on the next render, even if
    // nothing else changed. What that buys is narrower than it looks: the
    // {0,0} written just now is a real entry in `positions`, so the node is no
    // longer in `missing` and dagre stays skipped — only separateOverlaps
    // touches it, which keeps it at x=0 and slides it down until it stops
    // covering anything. Enough to un-stick it; a true dagre placement would
    // mean leaving the position unset instead of stamping one here.
    lastLayoutSigRef.current = "";
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
  /** Session id whose context-breakdown modal is open, or null. Driven by
   *  clicking the donut on the session's root node. */
  const [contextFor, setContextFor] = useState<string | null>(null);
  const openContext = useCallback((sid: string) => setContextFor(sid), []);
  /** Whether the Clear confirmation is up. Clear truncates the server's event
   *  log, so nothing destructive happens until this dialog is answered. */
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const dismissedSummariesRef = useRef<Set<string>>(loadDismissedSummaries());
  /** Left sidebar (session list) visibility — persisted across refresh. */
  const [sessionListOpen, setSessionListOpen] = useState<boolean>(loadSessionListOpen);
  useEffect(() => { saveSessionListOpen(sessionListOpen); }, [sessionListOpen]);
  /** Right detail panel visibility — persisted across refresh. */
  const [detailOpen, setDetailOpen] = useState<boolean>(loadDetailOpen);
  useEffect(() => { saveDetailOpen(detailOpen); }, [detailOpen]);
  /** Usage panel visibility — persisted across refresh. */
  const [usagePanelOpen, setUsagePanelOpen] = useState<boolean>(loadUsagePanelOpen);
  useEffect(() => { saveUsagePanelOpen(usagePanelOpen); }, [usagePanelOpen]);
  const [accountsPanelOpen, setAccountsPanelOpen] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(ACCOUNTS_PANEL_OPEN_KEY);
      return stored === null ? true : stored === "1";
    } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(ACCOUNTS_PANEL_OPEN_KEY, accountsPanelOpen ? "1" : "0"); } catch {}
  }, [accountsPanelOpen]);

  // Finish-sound hook. `null` until the first fetch resolves, so the button
  // can stay out of the way rather than flicker through a wrong state.
  const [soundOn, setSoundOn] = useState<boolean | null>(null);
  const [soundBusy, setSoundBusy] = useState(false);
  // Hand-written sound hooks already on the Stop event. Surfaced because
  // turning ours on alongside one that works here means two sounds per turn,
  // and the cause is in a settings file the user is not looking at.
  const [soundClash, setSoundClash] = useState(0);
  // The user's own sound hooks that the toggle has set aside. Surfaced so
  // "moved, not deleted" is something they can see and act on.
  const [soundParked, setSoundParked] = useState(0);
  useEffect(() => {
    fetch("/api/sound-hook")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.ok) return;
        setSoundOn(d.enabled === true);
        setSoundClash((d.foreign ?? []).filter((f: { worksHere?: boolean }) => f.worksHere).length);
        setSoundParked(typeof d.parked === "number" ? d.parked : 0);
      })
      .catch(() => {});
  }, []);
  const toggleSound = useCallback(async () => {
    setSoundBusy(true);
    try {
      const res = await fetch("/api/sound-hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !soundOn }),
      });
      const out = await res.json().catch(() => null);
      if (out?.ok) setSoundOn(out.enabled === true);
      // Re-read: toggling parks or unparks the user's own hooks.
      fetch("/api/sound-hook").then(r => r.ok ? r.json() : null).then(d => {
        if (!d?.ok) return;
        setSoundClash((d.foreign ?? []).filter((f: { worksHere?: boolean }) => f.worksHere).length);
        setSoundParked(typeof d.parked === "number" ? d.parked : 0);
      }).catch(() => {});
    } catch { /* server unreachable */ }
    finally { setSoundBusy(false); }
  }, [soundOn]);

  // ── version drift ─────────────────────────────────────────────────────────
  // A deck upgraded while it was running keeps executing the old code, silently
  // and indefinitely. Nothing else in the product can tell you that, so this
  // asks the server which version it actually booted with.
  // Declared here because the version check keys off it: a restart ends with
  // the SSE stream reconnecting.
  const [live, setLive] = useState(false);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [versionDismissed, setVersionDismissed] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(VERSION_DISMISSED_KEY) ?? ""; } catch { return ""; }
  });
  const [cmdCopied, setCmdCopied] = useState(false);
  // `force` asks npm now instead of reusing the answer cached on disk. Used by
  // the chip, because "no banner" and "no check ran" look identical from here.
  const lastForcedRef = useRef(0);
  // A forced check is a round-trip to the registry, and on a slow line that is
  // seconds during which the chip would otherwise not move at all — clicking it
  // felt like clicking nothing. Only forced checks are shown: the unforced
  // polls are answered from a marker on disk and would just make the chip
  // flicker for no reason the user could act on.
  const [versionChecking, setVersionChecking] = useState(false);
  const loadVersion = useCallback((force = false) => {
    if (force) { lastForcedRef.current = Date.now(); setVersionChecking(true); }
    fetch(force ? "/api/version?refresh=1" : "/api/version")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setVersion(d as VersionInfo); })
      .catch(() => {})
      .finally(() => { if (force) setVersionChecking(false); });
  }, []);
  // Every unforced poll is answered from the server's on-disk marker, so once a
  // deck had checked, nothing it could do would ever learn about a release
  // published afterwards until that marker's hour was up — reported as seven
  // releases shipping with no banner on any of four running decks. The client is
  // the right place to decide how fresh the answer has to be, so the periodic
  // poll forces on a slower cadence of its own rather than never.
  //
  // Gated on the ref rather than forced every time, because forcing skips the
  // server's window entirely: the ~20-byte registry GET still happens at most
  // once per interval per deck, whether the trigger was the poll, a tab
  // regaining focus, or the chip — all of them stamp the same ref.
  const forceVersionIfStale = useCallback(() => {
    loadVersion(Date.now() - lastForcedRef.current >= VERSION_FORCE_MS);
  }, [loadVersion]);
  useEffect(() => {
    // Unforced: the server asks npm on the first call of its own process, so a
    // deck the user has just started is already answering with a fresh number.
    loadVersion();
    const iv = window.setInterval(forceVersionIfStale, 5 * 60_000);
    // Coming back to this tab is exactly the moment after someone ran the
    // upgrade in another window, and exactly the moment to be right — cheaper
    // and far more timely than waiting out the interval.
    const onVis = () => { if (document.visibilityState === "visible") forceVersionIfStale(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadVersion, forceVersionIfStale]);
  // The stream coming back is the end of a restart, and the only moment the
  // answer is known to have changed. Without this the banner sat on
  // "restarting…" until the five-minute poll came round — and in a background
  // tab, where visibilitychange never fires, that was the only thing left.
  useEffect(() => { if (live) loadVersion(); }, [live, loadVersion]);
  const notice = version?.notice ?? null;
  // Keyed to the version it is about, so dismissing today's notice does not
  // silence next month's release.
  const noticeKey = notice ? `${notice.kind}:${notice.to}` : "";
  const noticeOpen = notice != null && versionDismissed !== noticeKey;
  const toggleNotice = useCallback(() => {
    if (!notice) return;
    const next = versionDismissed === noticeKey ? "" : noticeKey;
    setVersionDismissed(next);
    try { window.localStorage.setItem(VERSION_DISMISSED_KEY, next); } catch { /* private mode */ }
  }, [notice, noticeKey, versionDismissed]);
  // Installing runs on the server and reports back through /api/version, so the
  // only thing the click owns is starting it and polling a little faster while
  // it runs — an npm install is a minute, not five.
  const upgradeState = version?.upgrade?.state ?? "idle";
  // A string, not the object, so an effect can key off it: /api/version answers
  // with a fresh object every poll, and only its identity would ever change.
  const upgradeFailure = upgradeFailureId(version?.upgrade);
  const startUpgrade = useCallback(async () => {
    try { await fetch("/api/upgrade", { method: "POST" }); } catch { /* reported via /api/version */ }
    loadVersion();
  }, [loadVersion]);
  useEffect(() => {
    if (upgradeState !== "running") return;
    const iv = window.setInterval(loadVersion, 3000);
    return () => window.clearInterval(iv);
  }, [upgradeState, loadVersion]);

  const copyCommand = useCallback(async () => {
    const cmd = version?.command;
    if (!cmd) return;
    // navigator.clipboard is undefined outside a secure context and can sit
    // unresolved while the browser decides on permission, which would leave the
    // button silently dead. Race it, and fall back to the old selection trick.
    let ok = false;
    try {
      ok = await Promise.race([
        navigator.clipboard?.writeText(cmd).then(() => true) ?? Promise.resolve(false),
        new Promise<boolean>(r => window.setTimeout(() => r(false), 500)),
      ]);
    } catch { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = cmd;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch { ok = false; }
    }
    if (!ok) return; // the command stays on screen and selectable
    setCmdCopied(true);
    window.setTimeout(() => setCmdCopied(false), 1600);
  }, [version?.command]);

  // One left column, two things that want it. Opening either evicts the other
  // rather than fighting over the same grid slot.
  const toggleSessionList = useCallback(() => {
    setSessionListOpen(open => {
      if (!open) setAccountsPanelOpen(false);
      return !open;
    });
  }, []);
  const toggleAccountsPanel = useCallback(() => {
    setAccountsPanelOpen(open => {
      if (!open) setSessionListOpen(false);
      return !open;
    });
  }, []);
  // ccusage history modal — transient (not persisted), opened from the toolbar.
  const [usageHistoryOpen, setUsageHistoryOpen] = useState(false);
  /** Bumped on each group-drag move so snapshotToFlow recomputes immediately
   *  (reads the freshly-pinned positions) rather than waiting for the 250ms
   *  tick. A plain counter — value is irrelevant, only the change matters. */
  const [dragTick, setDragTick] = useState(0);

  // ── the filter bar stepping out of the way ─────────────────────────────────
  // The bar floats over the top-left of the canvas, which is fine until you pan:
  // then cards and tool bubbles slide underneath it and stay there, because
  // nothing re-frames a viewport the user chose. Reported with a screenshot of a
  // Bash bubble half-eaten by the bar, and a workaround — pressing Clear after
  // every update — that throws away the canvas to move one toolbar.
  //
  // So the bar yields instead. When anything is beneath it the bar drops to a
  // fifth of its opacity, and hovering or focusing it brings it straight back.
  // Measured rather than derived: bubbles are positioned by the burst layer in
  // screen space, so the DOM is the only place both live in the same
  // coordinates. A 300ms poll of a bounded set of rects is cheaper than it
  // sounds and stops entirely when the tab is hidden or the bar is absent.
  const catBarRef = useRef<HTMLDivElement | null>(null);
  const [catBarOccluded, setCatBarOccluded] = useState(false);

  /**
   * Live positions of whatever is being dragged, applied over the rendered
   * array. Held in a ref and paired with a counter: the values change on every
   * pointer move, and putting them in state would deep-compare a Map on each
   * one for no benefit.
   */
  const dragPatchRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const [dragMoveTick, setDragMoveTick] = useState(0);
  // Pause freezes the canvas; it does not drop the connection. The gate owns
  // both the flag and the held events so the SSE handler can read the current
  // pause state out of a ref — see pause.ts for why closing over the state
  // variable instead made every toggle replay the server's whole ring buffer.
  // `paused` mirrors the gate for rendering; the gate stays the source of truth.
  const pauseRef = useRef(createPauseGate<HookEnvelope>());
  const [paused, setPaused] = useState(false);
  const togglePause = useCallback(() => {
    const gate = pauseRef.current;
    const held = gate.setPaused(!gate.paused);
    for (const env of held) stateRef.current = applyEvent(stateRef.current, env);
    setPaused(gate.paused);
  }, []);
  const [now, setNow] = useState(Date.now());

  // ── restart ───────────────────────────────────────────────────────────────
  // The server cannot restart itself without racing its own listener onto a
  // random fallback port, so the supervisor owns it and this only asks.
  const [autoRestart, setAutoRestart] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { return window.localStorage.getItem(AUTO_RESTART_KEY) !== "0"; } catch { return true; }
  });
  const toggleAutoRestart = useCallback(() => {
    setAutoRestart(v => {
      const next = !v;
      try { window.localStorage.setItem(AUTO_RESTART_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  }, []);
  const [restarting, setRestarting] = useState(false);
  // "npx" gets its own word everywhere, because it is a download and not a
  // process restart: it takes tens of seconds, and a banner that says
  // "restarting…" for a minute reads as a hang.
  const [restartMode, setRestartMode] = useState<"restart" | "npx">("restart");
  const [restartedTo, setRestartedTo] = useState<string | null>(null);
  const restartAskedRef = useRef(false);
  // The failure the server was already reporting when this attempt started, so
  // the one it reports afterwards can be told apart from it. Without that, the
  // note left by the previous failed npx relaunch — still on disk until the
  // supervisor clears it at the top of the next one — would read as this
  // attempt's own outcome the moment the retry was clicked.
  const askedFailureRef = useRef<string | null>(null);
  // Counts asks, so a timeout only ever hands back the state of the attempt
  // that armed it. Now that a failure ends an attempt early, a retry can be
  // running while its predecessor's three minutes are still on the clock.
  const restartAttemptRef = useRef(0);
  const askRestart = useCallback(async (opts?: { upgrade?: boolean }) => {
    if (restartAskedRef.current) return;
    const upgrade = opts?.upgrade === true;
    restartAskedRef.current = true;
    askedFailureRef.current = upgradeFailure;
    const attempt = ++restartAttemptRef.current;
    setRestartMode(upgrade ? "npx" : "restart");
    setRestarting(true);
    // Remembered across the reconnect so the deck can confirm what it landed
    // on rather than claiming success the moment the request was accepted.
    try { window.sessionStorage.setItem("agent-dag.restartPending", notice?.to ?? ""); } catch {}
    // The socket dying IS the restart, so a rejection here is a success signal
    // as often as a failure one — neither is worth acting on.
    try {
      await fetch("/api/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upgrade }),
      });
    } catch { /* expected */ }
    // Nothing came back. Rather than leave a disabled button and a banner
    // frozen mid-sentence, hand the control back so it can be tried again —
    // after long enough that an npx fetch on a slow line is not cut short.
    window.setTimeout(() => {
      if (restartAttemptRef.current !== attempt) return; // a later ask owns the state now
      if (!restartAskedRef.current) return;
      restartAskedRef.current = false;
      setRestarting(false);
      try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    }, upgrade ? 180_000 : 30_000);
  }, [notice?.to, upgradeFailure]);

  // Nothing running for a sustained stretch is the only safe moment: a restart
  // mid-turn silently drops the hook events fired during the gap, leaving tools
  // stuck in flight on the canvas until the stale sweeper reaps them. The rule
  // itself lives in restart.ts, where it can be tested.
  const idleSinceRef = useRef<number | null>(null);
  useEffect(() => {
    let busy = false;
    for (const a of stateRef.current.agents.values()) {
      if (a.state === "active") { busy = true; break; }
    }
    const step = autoRestartStep({
      enabled: autoRestart,
      kind: notice?.kind,
      canRestart: version?.canRestart === true,
      busy,
      idleSince: idleSinceRef.current,
      now,
    });
    idleSinceRef.current = step.idleSince;
    if (step.restart) askRestart();
  }, [autoRestart, notice?.kind, version?.canRestart, now, askRestart]);

  // Landed — here, or in the bundle that is about to replace this one. The page
  // is code too and nothing else reloads it, so both outcomes hang off the same
  // move of `running` and have to be decided together: as two effects they were
  // flushed in one synchronous pass, and since location.reload() only schedules
  // the navigation the second one still deleted the pending marker that was
  // supposed to carry the confirmation across it. The rule lives in restart.ts.
  useEffect(() => {
    const running = version?.running;
    let pending: string | null = null;
    let lastTried: string | null = null;
    try {
      pending = window.sessionStorage.getItem("agent-dag.restartPending");
      lastTried = window.sessionStorage.getItem(BUNDLE_RELOAD_KEY);
    } catch { return; }
    const step = restartLandingStep({ bundle: __APP_VERSION__, running, pending, lastTried });
    if (step === "reload") {
      try { window.sessionStorage.setItem(BUNDLE_RELOAD_KEY, running ?? ""); } catch { return; }
      window.location.reload();
      return; // the marker stays put; the new bundle is the one that can show it
    }
    if (step !== "confirm") return;
    try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    restartAskedRef.current = false;
    setRestarting(false);
    setRestartedTo(running ?? null);
    const t = window.setTimeout(() => setRestartedTo(null), 6000);
    return () => window.clearTimeout(t);
  }, [version?.running]);

  // Didn't land. A failed `npx -y <spec>@latest` comes back on the OLD version
  // and the same port, so `running` never moves and the check above waits for a
  // version that is not coming — leaving the retry button disabled and reading
  // "fetching…" for the full three minutes, beside a banner already spelling
  // out why the update failed. The supervisor's note is the end of the attempt,
  // and this is the tab hearing it. The rule lives in restart.ts.
  useEffect(() => {
    if (!restarting) return;
    if (!restartEndedInFailure({ asked: askedFailureRef.current, reported: upgradeFailure })) return;
    try { window.sessionStorage.removeItem("agent-dag.restartPending"); } catch {}
    restartAskedRef.current = false;
    setRestarting(false);
  }, [restarting, upgradeFailure]);

  // Restore pinned positions synchronously on first render so they're
  // applied before snapshotToFlow runs autoLayout. Sessions outlast a
  // browser refresh (their session_id is stable), so dragged positions
  // come back where you left them.
  const storedLayout = useRef(loadLayout()).current;
  const positionsSeeded = useRef(false);
  const pinnedRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(storedLayout.positions.filter(([id]) => storedLayout.pins.includes(id))),
  );
  /** Active session group-drag: the handle node's start position + each
   *  member's start position, captured at drag start. */
  const groupDragRef = useRef<{ start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null);
  const restoredViewport = useState(() => loadViewport())[0];
  const [query, setQuery] = useState("");
  /** Categories the user has muted via the filter chips. Bursts whose
   *  category is in this set don't render. Reset only by toggling them
   *  back on (R / clear don't touch it — filters are user intent). */
  const [hiddenCats, setHiddenCats] = useState<Set<DetailCategory>>(() => new Set());
  // Guarded the same way as the panel loaders: an initialiser is the one place
  // a store the browser won't hand over blanks the deck instead of a preference.
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (readStored("agent-dag.theme") as "dark" | "light" | null) ?? "dark",
  );
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

  // SSE subscription.
  //
  // Replay handling: on connect the server drains its ring buffer over the
  // same SSE channel before live events. Each replayed envelope is tagged
  // `replay: true`; a `replay-end` sentinel marks the boundary. We do two
  // things differently for replay traffic:
  //   1) the reducer sees the flag and skips turn-cleanup side effects
  //      (UserPromptSubmit stamping exitAt with a stale receivedAt, which
  //      collided with the wall-clock visibility gate and made prior-turn
  //      subagents flash visible then vanish);
  //   2) the SSE handler coalesces renders during replay — one render at
  //      replay-end.
  //
  // Live traffic is coalesced too, but leading-edge (see coalesce.ts): the
  // first event of a quiet stream still renders in its own task, while a tool
  // storm — eight subagents each firing PreToolUse/PostToolUse arrives as
  // dozens of separate macrotasks that React cannot batch — collapses into one
  // render per window instead of one full canvas rebuild per event. Every
  // envelope is still applied to the reducer the instant it lands, in order,
  // so coalescing costs redraws and never state.
  //
  // Fallback heuristic (`Date.now() - receivedAt > 30s`) covers older
  // servers without the replay flag.
  const replayActiveRef = useRef<boolean>(true);
  useEffect(() => {
    const es = new EventSource("/events");
    const coalescer = createRenderCoalescer(rerender, {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    });
    es.addEventListener("open", () => { setLive(true); setEverConnected(true); });
    es.addEventListener("error", () => setLive(false));
    es.addEventListener("replay-end", () => {
      replayActiveRef.current = false;
      coalescer.flush();
    });
    es.addEventListener("hook", (e) => {
      try {
        const env: HookEnvelope = JSON.parse((e as MessageEvent).data);
        if (!pauseRef.current.accept(env)) return; // paused: held for the resume
        stateRef.current = applyEvent(stateRef.current, env);
        const isReplay = env.replay === true
          || replayActiveRef.current
          || Date.now() - env.receivedAt > 30_000;
        if (isReplay) coalescer.replay();
        else coalescer.live();
      } catch { /* ignore */ }
    });
    return () => {
      es.close();
      coalescer.cancel();
    };
    // Deliberately not keyed on `paused`: a pause must not tear this stream
    // down, because the reconnect carries no Last-Event-ID and the server
    // answers with a full replay of its ring buffer. The gate handles pausing.
  }, [rerender]);

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
      // Keep the canvas to the last few finished sessions, so a long day of
      // work doesn't bury the running ones under everything already done.
      if (pruneDoneSessions(stateRef.current, t, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS)) changed = true;
      if (changed) rerender();
    }, 250);
    return () => clearInterval(id);
  }, [rerender]);

  // Auto-fit-related refs (see effect after layoutSig is computed below).
  const fitTimerRef = useRef<number | null>(null);
  const lastFitTimeRef = useRef(0);
  // Matches TOOL_LANE_W in layout.ts — the burst lane drawn beside each card.
  const TOOL_LANE_ALLOWANCE = 420;

  /**
   * Frame the graph against the left edge of the canvas.
   *
   * React Flow's fitView centres, and there is no asymmetric-padding option,
   * so this measures what is actually drawn and sets the viewport outright.
   * Left-anchored because a graph parked mid-canvas leaves dead space on the
   * side the eye starts from.
   */
  const fitLeft = useCallback((duration = 500) => {
    // MAX_ZOOM 1: cards are drawn at their natural size, so magnifying past
    // 1:1 only makes a small graph look coarse. FILL leaves the frame a little
    // loose — a fit that touches the margins reads as "already too big" and
    // gives the eye nowhere to land when the next session appears.
    const MARGIN = 80, MAX_ZOOM = 1, MIN_ZOOM = 0.2, FILL = 0.86;
    try {
      const pane = document.querySelector(".canvas-wrap");
      const drawn = Array.from(document.querySelectorAll(".react-flow__node"))
        .filter(el => (el as HTMLElement).offsetWidth > 0);
      if (!pane || drawn.length === 0) return;

      const paneRect = pane.getBoundingClientRect();
      const vp = rf.getViewport();
      if (!Number.isFinite(vp.zoom) || vp.zoom <= 0) return;

      // Screen rects back through the current viewport into flow space, so
      // this works from any starting zoom and never consults the node store —
      // which also holds the invisible per-session drag handles.
      const fx = (sx: number) => (sx - paneRect.left - vp.x) / vp.zoom;
      const fy = (sy: number) => (sy - paneRect.top - vp.y) / vp.zoom;
      const rects = drawn.map(el => el.getBoundingClientRect());
      const minX = Math.min(...rects.map(r => fx(r.left)));
      const maxX = Math.max(...rects.map(r => fx(r.right)));
      const minY = Math.min(...rects.map(r => fy(r.top)));
      const maxY = Math.max(...rects.map(r => fy(r.bottom)));
      const w = maxX - minX, h = maxY - minY;
      if (!(w > 0 && h > 0)) return;

      // Tool bursts are an overlay rather than nodes, so they are absent from
      // these rects — leave room or the last column's chips get clipped.
      const zoom = Math.max(MIN_ZOOM, Math.min(
        MAX_ZOOM,
        ((paneRect.width - MARGIN * 2) / (w + TOOL_LANE_ALLOWANCE)) * FILL,
        ((paneRect.height - MARGIN * 2) / h) * FILL,
      ));

      rf.setViewport({
        x: MARGIN - minX * zoom,
        y: Math.max(MARGIN, (paneRect.height - h * zoom) / 2) - minY * zoom,
        zoom,
      }, { duration });
      lastFitTimeRef.current = Date.now();
      // An animated setViewport runs through d3's transition, which is driven
      // by requestAnimationFrame — so it lands late, or not at all if the tab
      // is in the background when the fit is requested. Check afterwards and,
      // if nothing moved, set the same viewport without animation. Not
      // fitView: that centres, which is the one thing this function exists to
      // avoid.
      window.setTimeout(() => {
        try {
          const want = { x: MARGIN - minX * zoom, y: Math.max(MARGIN, (paneRect.height - h * zoom) / 2) - minY * zoom, zoom };
          const vpNow = rf.getViewport();
          if (Math.abs(vpNow.zoom - zoom) > 0.01 || Math.abs(vpNow.x - want.x) > 2) {
            rf.setViewport(want, { duration: 0 });
          }
        } catch { /* ignore */ }
      }, duration + 60);
    } catch { /* viewport not ready */ }
  }, [rf]);
  const lastLayoutSigForFitRef = useRef("");
  // Debounce timer for persisting the viewport on pan/zoom.
  const vpSaveTimerRef = useRef<number | null>(null);

  // Auto-recover from "drifted off-screen": every 1.5s check whether ANY
  // agent's bounding box intersects the visible viewport. If none have at
  // all, fit-view immediately. Skipped only when the user is actively
  // interacting (pan/zoom/drag in the last 800ms) so we don't yank the view
  // mid-gesture. This is the failsafe that recovers from layout reflows
  // when a new session arrives and dagre shifts everything off-screen.
  const lastInteractRef = useRef(0);
  const markInteract = useCallback(() => { lastInteractRef.current = Date.now(); }, []);
  // Sticky "user took the wheel" flag. Once the user manually pans, zooms,
  // or drags a node, autofitting is suspended until they hit the recenter
  // button. Persisted so a refresh respects the user's preference.
  const AUTOFIT_KEY = "agent-dag.autoFitDisabled";
  const autoFitDisabledRef = useRef<boolean>((() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(AUTOFIT_KEY) === "1"; } catch { return false; }
  })());
  const [autoFitDisabled, setAutoFitDisabled] = useState<boolean>(autoFitDisabledRef.current);
  const disableAutoFit = useCallback(() => {
    if (autoFitDisabledRef.current) return;
    autoFitDisabledRef.current = true;
    setAutoFitDisabled(true);
    try { window.localStorage.setItem(AUTOFIT_KEY, "1"); } catch {}
  }, []);
  const enableAutoFitAndRefit = useCallback(() => {
    autoFitDisabledRef.current = false;
    setAutoFitDisabled(false);
    try { window.localStorage.removeItem(AUTOFIT_KEY); } catch {}
    fitLeft(400);
  }, [rf, fitLeft]);
  useEffect(() => {
    const id = setInterval(() => {
      if (autoFitDisabledRef.current) return;
      if (Date.now() - lastInteractRef.current < 800) return;
      const state = stateRef.current;
      const t = Date.now();
      const liveAgents: { id: string }[] = [];
      for (const a of state.agents.values()) {
        // Mirror isAgentVisible — was inline `exitAt + EXIT_ANIM_MS` only,
        // which skipped the ghost-session filter and disagreed with the node
        // renderer when stale-exitAt replays excluded subagents that the
        // canvas was still showing. Use the single source of truth.
        if (!isAgentVisible(a, t)) continue;
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
        fitLeft(600);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [rf]);

  // True for the length of a drag gesture. A ref as well as state: the
  // measurement effect below reads it without wanting to re-run when it
  // changes, and the layout memo needs the state to recompute.
  const draggingRef = useRef(false);

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
  const [domSizeVersion, setDomSizeVersion] = useState(0);

  // Measure the rendered cards directly, as a source that does not depend on
  // React Flow's store holding on to them.
  //
  // It does not: createNodeInternals rebuilds every entry as `{...node}` from
  // the incoming `nodes` prop, carrying over handleBounds but NOT width and
  // height. This canvas replaces that prop on every tick, so a measurement
  // taken by the ResizeObserver survives until the next render and is then
  // dropped. That closed a loop — the store lost the sizes, so the selector
  // above read null and skipped, so the map stayed empty, so the nodes we
  // passed carried no sizes for the store to keep. fitView needs dimensions
  // to compute bounds and silently returns false without them, which is why
  // nothing was ever framed.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const map = measuredRef.current;
      let changed = false;
      for (const el of document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
        const id = el.getAttribute("data-id");
        if (!id) continue;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) continue;
        const prev = map.get(id);
        // Same 4px deadband as the store selector: sub-pixel jitter must not
        // trigger a relayout.
        if (!prev || Math.abs(prev.width - w) > 4 || Math.abs(prev.height - h) > 4) {
          map.set(id, { width: w, height: h });
          changed = true;
        }
      }
      if (changed) setDomSizeVersion(v => v + 1);
    };
    // After paint, so the cards have their final size — except in a background
    // tab, where requestAnimationFrame never fires at all. The deck is a thing
    // people leave open on a second monitor or behind their editor, so an
    // rAF-only schedule means sizes stop updating exactly when nobody is
    // looking, and the layout they come back to was computed from stale ones.
    // offsetWidth/offsetHeight on every card forces a synchronous layout, and
    // a drag re-renders on every pointer move. Cards do not change size while
    // one is being dragged, so the whole pass is skipped for the gesture.
    if (draggingRef.current) return;
    let timer = 0;
    if (document.visibilityState === "hidden") {
      timer = window.setTimeout(measure, 32);
    } else {
      raf = requestAnimationFrame(measure);
    }
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  });

  // Position cache + structural signature. Layout reruns only when the set
  // of visible agents OR sizes OR pin-set changes — NOT on every event.
  // Seeded from storage so a reload resumes the arrangement that was on screen
  // rather than re-deriving one. Anything without a stored position — a new
  // agent, or one whose position was evicted — still gets laid out.
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map(storedLayout.positions));
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
    return `${ids.join("|")}#sv${sizeVersion}.${domSizeVersion}`;
  }, [stateRef.current, stateRef.current.lastSeq, now, sizeVersion, domSizeVersion]);

  // Persist the arrangement whenever it changes, not only when the user drags.
  // Auto-placed nodes are part of what gets restored on reload, so a session
  // that was never touched still comes back where it was. Debounced: layoutSig
  // moves on every structural change and localStorage writes are synchronous.
  const layoutSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (layoutSaveTimerRef.current != null) window.clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = window.setTimeout(() => {
      saveLayout(positionsRef.current, pinnedRef.current);
    }, 1500);
    return () => { if (layoutSaveTimerRef.current != null) window.clearTimeout(layoutSaveTimerRef.current); };
  }, [layoutSig]);

  // Auto-fit on layout-signature changes — the single source of truth for
  // structural shifts: agent added/removed, parent relationship changed, or
  // a measurement that moved a node. Catches the "14 agents in state but
  // none visible" case where count is stable but the layout reflowed.
  // Suspended entirely when the user has taken manual control of the
  // viewport (see autoFitDisabledRef + recenter button in Controls).
  useEffect(() => {
    if (lastLayoutSigForFitRef.current === layoutSig) return;
    const prev = lastLayoutSigForFitRef.current;
    lastLayoutSigForFitRef.current = layoutSig;
    if (!prev) return; // first render — let initial fitView prop handle it
    if (autoFitDisabledRef.current) return;
    const tnow = Date.now();
    if (tnow - lastFitTimeRef.current > 1200) {
      fitLeft(400);
    }
    if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => {
      if (autoFitDisabledRef.current) return;
      fitLeft(500);
    }, 280);
  }, [layoutSig, rf, fitLeft]);

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

  // Width of the canvas column, not the window: the side panels come and go,
  // and a layout packed for the whole window would run under them. Measured
  // rather than derived from the panel flags so it stays right however the
  // grid is configured.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      // Quantised so a one-pixel resize doesn't reflow the canvas.
      setCanvasSize(prev =>
        (Math.abs(prev.w - r.width) > 40 || Math.abs(prev.h - r.height) > 40)
          ? { w: r.width, h: r.height } : prev);
    });
    ro.observe(el);
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // How big each session was last frame, so a session that fans out subagents
  // can be told apart from one that merely re-rendered. Owned here rather than
  // in layout.ts because it is memory, not geometry.
  const prevSessionSizeRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  // Sizes only mean something once the cards have all mounted and measured.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  // While true, node movement is animated instead of instant. Held only for
  // the length of the transition: a permanent transition would make dragging
  // lag behind the cursor.
  const [bubbling, setBubbling] = useState(false);
  const bubbleTimerRef = useRef<number | null>(null);
  // True for the length of any drag gesture. React Flow marks the node under
  // the cursor with .dragging, and the stylesheet drops its transition — but
  // dragging a SESSION moves its member cards through state rather than
  // through the gesture, so they keep the transition and trail the cursor by
  // its full duration. That is the "dragging isn't smooth" everyone notices
  // and nobody can point at. A flag on the pane covers every node a gesture
  // can move, whichever way it moves them.
  const [dragging, setDragging] = useState(false);
  const endBubble = useCallback(() => {
    if (bubbleTimerRef.current) { window.clearTimeout(bubbleTimerRef.current); bubbleTimerRef.current = null; }
    setBubbling(false);
  }, []);
  const onBubble = useCallback((movedSessions: string[]) => {
    if (movedSessions.length === 0) return;
    // Raised from inside a useMemo, so the state change has to leave the
    // render pass before React sees it.
    queueMicrotask(() => {
      setBubbling(true);
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbling(false), BUBBLE_MS + 80);
    });
  }, []);
  useEffect(() => () => { if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current); }, []);

  const availableWidth = canvasSize.w > 0 ? canvasSize.w * 0.92 : 0;
  // A column is filled to one screen before the next one starts. An earlier
  // version allowed 1.6 screens on the theory that a fitted graph zooms out
  // and shows more — true, but it meant a column had to run well past the
  // viewport before wrapping, so the second column almost never appeared and
  // the width stayed empty. One screen is the threshold that actually fills
  // the canvas.
  const availableHeight = canvasSize.h > 0 ? canvasSize.h : 0;

  // Rebuilt on every render, drags included.
  //
  // Freezing it during a drag was tried and reverted: it looks like an obvious
  // win — the rebuild is the most expensive thing here — but the node under the
  // cursor then stopped moving until the mouse came up. React Flow is given
  // `nodes` with no onNodesChange, so this array and React Flow's own store
  // both believe they own positions, and holding this one still meant the
  // stale one won. Anything done here has to keep the two in agreement.
  const { nodes, edges } = useMemo(
    () => {
      const flow = snapshotToFlow(
      stateRef.current, now, availableWidth, availableHeight, pinnedRef.current, query,
      measuredRef.current, prevSessionSizeRef.current, onBubble, settled, dragging,
      positionsRef.current, layoutSig, lastLayoutSigRef,
      selectedIds, spotlightSet, visibleAgentIds, openContext,
      );
      return flow;
    },
    [stateRef.current, stateRef.current.lastSeq, now, availableWidth, availableHeight, settled, dragging, query, layoutSig, selectedIds, spotlightSet, visibleAgentIds, openContext, dragTick],
  );

  // Invisible per-session drag-handle nodes. One per session, sized to the
  // bounding box of that session's agent nodes and rendered behind them
  // (negative zIndex). Grabbing the empty canvas behind a session drags the
  // whole session; the agent nodes stay on top and individually draggable.
  const groupNodes = useMemo(() => {
    const bySession = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const n of nodes) {
      const d = n.data as AgentNodeData | undefined;
      if (!d?.sessionId || d.exitAt != null) continue;
      const w = n.width, h = n.height;
      if (w == null || h == null) continue; // unmeasured — skip this frame
      const x1 = n.position.x, y1 = n.position.y, x2 = x1 + w, y2 = y1 + h;
      const b = bySession.get(d.sessionId);
      if (!b) bySession.set(d.sessionId, { minX: x1, minY: y1, maxX: x2, maxY: y2 });
      else {
        b.minX = Math.min(b.minX, x1); b.minY = Math.min(b.minY, y1);
        b.maxX = Math.max(b.maxX, x2); b.maxY = Math.max(b.maxY, y2);
      }
    }
    const out: typeof nodes = [];
    for (const [sid, b] of bySession) {
      // Cover the nodes + padding, but NOT the header strip above them — that
      // area holds SessionClusters' clickable label (fit-view), which must stay
      // hittable above this handle.
      const w = b.maxX - b.minX + GROUP_PAD * 2;
      const h = b.maxY - b.minY + GROUP_PAD * 2;
      out.push({
        id: `group:${sid}`,
        type: SESSION_GROUP_TYPE,
        position: { x: b.minX - GROUP_PAD, y: b.minY - GROUP_PAD },
        // w/h handed to the node component so it can size itself in explicit
        // pixels (a 100% child would collapse under RF's content sizing).
        data: { sessionId: sid, w, h } as unknown as AgentNodeData & { now: number },
        width: w,
        height: h,
        style: { width: w, height: h },
        zIndex: -1,
        draggable: true,
        selectable: false,
        focusable: false,
        deletable: false,
        connectable: false,
      });
    }
    return out;
  }, [nodes, now]);

  /**
   * The array React Flow renders, with the in-flight drag applied on top.
   *
   * React Flow is given `nodes` without `onNodesChange`. That makes it fully
   * controlled: it does not move nodes itself, it reports the position changes
   * it would make and expects them to be applied. Nothing applied them, so the
   * only thing that has ever moved a node here is this array being rebuilt —
   * and that happens on the clock tick, four times a second.
   *
   * Hence the shape of the bug: a slow drag looked fine because four updates a
   * second is enough to look continuous, and a fast one visibly stepped and
   * trailed, because the gap between updates is however far the cursor got in
   * 250ms.
   *
   * So the drag is applied here instead, on every pointer move: the base array
   * is left to rebuild at its own pace, and the positions of the nodes being
   * dragged are patched over it. A patch is one shallow copy per node, which
   * is nothing next to rebuilding the graph from the event log — and it is the
   * whole reason the previous two attempts failed. Both tried to make the
   * rebuild happen less often, when the rebuild was the only thing moving the
   * node; the node then did not move at all until the mouse came up.
   */
  const allNodes = useMemo(() => {
    const base = [...groupNodes, ...nodes];
    const patch = dragPatchRef.current;
    if (!patch || patch.size === 0) return base;
    return base.map(nd => {
      const p = patch.get(nd.id);
      return p ? { ...nd, position: p } : nd;
    });
  }, [groupNodes, nodes, dragMoveTick]);


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
  useEffect(() => {
    if (presentCats.length <= 1) { setCatBarOccluded(false); return; }
    let timer = 0;
    const tick = () => {
      const bar = catBarRef.current;
      if (bar && !document.hidden) {
        const b = bar.getBoundingClientRect();
        // Cards and bubbles both — a bubble is what the report showed, and it
        // lives in a different layer from the nodes.
        const boxes = Array.from(document.querySelectorAll(".react-flow__node, .tool-burst"))
          .map(el => el.getBoundingClientRect());
        const hit = anyTouches(b, boxes, 8);
        setCatBarOccluded(prev => (prev === hit ? prev : hit));
      }
      timer = window.setTimeout(tick, 300);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [presentCats.length]);

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

  // The keydown listener below is registered once and must stay that way, so
  // the gate reads what is on screen through refs rather than closing over it.
  // Assigned during render, the way nodesRef is, so a keystroke in the same
  // commit sees the dialogs that were just drawn.
  const clearConfirmOpenRef = useRef(clearConfirmOpen);
  clearConfirmOpenRef.current = clearConfirmOpen;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = openedTool != null || usageHistoryOpen || contextFor != null || summaryFor != null;

  /** The single door to Clear. Both the toolbar button and the "c" shortcut
   *  come through here, so the confirmation cannot hold for one and not the
   *  other, and only the dialog's own button reaches handleClear. */
  const requestClear = useCallback((source: ClearSource) => {
    const action = clearActionFor(source, {
      confirmOpen: clearConfirmOpenRef.current,
      modalOpen: modalOpenRef.current,
    });
    if (action === "confirm") setClearConfirmOpen(true);
    else if (action === "clear") { setClearConfirmOpen(false); handleClear(); }
  }, [handleClear]);

  const handleRelayout = useCallback(() => {
    pinnedRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    clearStoredLayout();
    rerender();
    // After dagre runs on the next render, fit-view so the user sees the
    // result. 80ms gives React + RF one paint to settle the new positions.
    window.setTimeout(() => fitLeft(500), 80);
  }, [rerender, rf, fitLeft]);

  // Same anchoring as relayout — F and the fit button land where it does.
  const handleFit = useCallback(() => fitLeft(500), [fitLeft]);

  // `nodes` is rebuilt by the snapshotToFlow memo on every 250ms tick, so a
  // callback that closes over it is a new function four times a second — and
  // the keydown effect below, which lists that callback in its deps, would
  // unsubscribe and resubscribe the window listener at the same rate. Read
  // both the node array and the current selection through refs (the pattern
  // stateRef already uses) so stepAgent is created once and the listener is
  // registered once. Assigned during render so a keystroke in the same commit
  // sees the array that was just drawn.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const primarySelectedIdRef = useRef(primarySelectedId);
  primarySelectedIdRef.current = primarySelectedId;

  /** Step through visible agents in render order. `direction` is +1 for
   *  next (j) or -1 for previous (k). Selecting moves the canvas to keep
   *  the chosen agent in view. */
  const stepAgent = useCallback((direction: 1 | -1) => {
    const current = nodesRef.current;
    if (current.length === 0) return;
    // Use the same order ReactFlow's nodes prop has — left-to-right by
    // worldspace position then top-to-bottom. That matches what the eye
    // expects when pressing j.
    const ordered = current
      .slice()
      .sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x));
    const selectedId = primarySelectedIdRef.current;
    const currentIdx = selectedId
      ? ordered.findIndex(n => n.id === selectedId)
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
  }, [selectAgent, rf]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The listener is on window in the bubble phase, so it sees every
      // keystroke aimed at every focused control on the page. Read the four
      // things the rules need off the target — getAttribute rather than the
      // reflected .role property, which older browsers do not expose.
      const el = e.target as (HTMLElement & { type?: string }) | null;
      const target: FocusTarget = {
        tagName: el?.tagName,
        isContentEditable: el?.isContentEditable,
        role: el?.getAttribute?.("role"),
        type: el?.type,
      };
      if (e.key === "Escape") {
        if (isTypingTarget(target)) el?.blur();
        else clearSelection();
        return;
      }
      // A focused control owns its own keys: Space presses a button, letters
      // run a <select>'s type-ahead. Answering them stole the button's
      // activation key and let a bare "c" from a dropdown wipe the event log.
      if (ownsKeystroke(target)) return;
      // Ctrl/Cmd/Alt chords are the browser's, not ours — Ctrl+C is copy and
      // Ctrl+R is reload, and both arrive here as the bare letter.
      if (isBrowserChord(e)) return;
      if (e.key === "/") { e.preventDefault(); searchInputRef.current?.focus(); return; }
      if (e.key === " ") { e.preventDefault(); togglePause(); }
      if (e.key === "c" || e.key === "C") requestClear("shortcut");
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "f" || e.key === "F") handleFit();
      if (e.key === "l" || e.key === "L") toggleSessionList();
      if (e.key === "h" || e.key === "H") setUsageHistoryOpen(o => !o);
      if (e.key === "u" || e.key === "U") setUsagePanelOpen(o => !o);
      if (e.key === "a" || e.key === "A") toggleAccountsPanel();
      if (e.key === "j" || e.key === "J") stepAgent(1);
      if (e.key === "k" || e.key === "K") stepAgent(-1);
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClear, handleRelayout, handleFit, clearSelection, stepAgent, togglePause]);

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
          agents-deck
          {/* The server's own version, not the bundle's — an upgrade replaces
              dist/ too, so a reloaded page can show a number the running
              process never had. Stale → the chip stays lit even after the
              banner is dismissed, and clicking it brings the banner back. */}
          {notice ? (
            <button
              type="button"
              className="v stale"
              onClick={toggleNotice}
              title={notice.kind === "restart"
                ? `Running v${notice.from}; v${notice.to} is installed on disk. Restart to pick it up.`
                : `Running v${notice.from}; v${notice.to} is on npm.`}
            >
              v{notice.from}
              <span className="v-dot" aria-hidden />
            </button>
          ) : (
            // Not decoration: "no banner" and "the check never ran" look the
            // same from a chair, and on a machine that only ever runs
            // `npx ccdeck` the difference is the whole feature. Clicking asks
            // npm now, ahead of the poll — so it has to look like a control and
            // say so out loud, which a dim version number does neither of.
            (() => {
              const copy = {
                running: version?.running ?? __APP_VERSION__,
                latest: version?.latest,
                latestPending: version?.latestPending,
                checkedAgo: version?.checkedAt ? shortAgo(now - version.checkedAt) : null,
                checkDisabled: version?.checkDisabled,
                checking: versionChecking,
              };
              return (
                <button
                  type="button"
                  className={versionChecking ? "v checking" : "v"}
                  onClick={() => loadVersion(true)}
                  aria-busy={versionChecking || undefined}
                  aria-label={versionChipLabel(copy)}
                  title={versionChipTitle(copy)}
                >
                  v{copy.running}
                </button>
              );
            })()
          )}
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
          <button className={`btn ${paused ? "warn" : ""}`} onClick={togglePause} title="Pause/resume live updates (Space)">
            {paused ? `Resume${pauseRef.current.size ? ` · ${pauseRef.current.size}` : ""}` : "Pause"}
          </button>
          <button
            className={`btn icon-btn ${usagePanelOpen ? "primary" : ""}`}
            onClick={() => setUsagePanelOpen(o => !o)}
            title={`${usagePanelOpen ? "Hide" : "Show"} usage panel (U)`}
            aria-label="Toggle usage panel"
          >$</button>
          {soundOn !== null && (
            <button
              className={`btn icon-btn ${soundOn ? "primary" : ""}`}
              onClick={(e) => {
                // Shift-click restores the user's own hooks. A modifier rather
                // than another button: it is a one-off recovery, not a control
                // that earns permanent space in the toolbar.
                if (e.shiftKey && soundParked > 0) {
                  setSoundBusy(true);
                  fetch("/api/sound-hook", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "restore" }),
                  }).then(() => fetch("/api/sound-hook"))
                    .then(r => r.ok ? r.json() : null)
                    .then(d => { if (d?.ok) { setSoundOn(d.enabled === true); setSoundParked(d.parked ?? 0); } })
                    .catch(() => {})
                    .finally(() => setSoundBusy(false));
                  return;
                }
                toggleSound();
              }}
              disabled={soundBusy}
              title={
                (soundOn
                  ? "Sound on turn finish: on — click to remove the hook"
                  : "Sound on turn finish: off — click to add a Stop hook") +
                (soundClash > 0
                  ? `\n\n${soundClash} sound hook${soundClash > 1 ? "s" : ""} of your own in settings.json also run${soundClash > 1 ? "" : "s"} here.`
                  : "") +
                (soundParked > 0
                  ? `\n\n${soundParked} of your own sound hook${soundParked > 1 ? "s were" : " was"} set aside so this switch actually controls the sound. Nothing was deleted — shift-click to put ${soundParked > 1 ? "them" : "it"} back.`
                  : "")
              }
              aria-label="Toggle finish sound"
              aria-pressed={soundOn}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z" />
                {soundOn
                  ? <><path d="M9.8 5.4a2.4 2.4 0 0 1 0 3.2" /><path d="M11.3 3.9a4.6 4.6 0 0 1 0 6.2" /></>
                  : <><path d="M10 5.6l2.6 2.8" /><path d="M12.6 5.6L10 8.4" /></>}
              </svg>
            </button>
          )}
          <button
            className={`btn icon-btn ${accountsPanelOpen ? "primary" : ""}`}
            onClick={toggleAccountsPanel}
            title={`${accountsPanelOpen ? "Hide" : "Show"} accounts (A)`}
            aria-label="Toggle accounts panel"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="7" cy="4.6" r="2.4" />
              <path d="M2.4 12c0-2.3 2.1-3.7 4.6-3.7s4.6 1.4 4.6 3.7" />
            </svg>
          </button>
          <button
            className={`btn icon-btn ${sessionListOpen ? "primary" : ""}`}
            onClick={toggleSessionList}
            title={`${sessionListOpen ? "Hide" : "Show"} session list (L)`}
            aria-label="Toggle session list"
          >☰</button>
          <button
            className={`btn icon-btn ${usageHistoryOpen ? "primary" : ""}`}
            onClick={() => setUsageHistoryOpen(o => !o)}
            title="Usage history — ccusage (H)"
            aria-label="Open usage history"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <line x1="3" y1="11.5" x2="3" y2="7" />
              <line x1="7" y1="11.5" x2="7" y2="3" />
              <line x1="11" y1="11.5" x2="11" y2="8.5" />
            </svg>
          </button>
          <button className="btn" onClick={handleRelayout} title="Auto-arrange — clear pins (R)">Re-layout</button>
          <button
            className="btn"
            onClick={() => requestClear("button")}
            title="Clear the canvas and the server's event log — asks first (C)"
          >Clear</button>
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

      {restartedTo ? (
        // Outranks both: it is the shortest-lived of the three and it answers
        // the question the other two just raised.
        <div className="ver-banner done" role="status">
          <span className="ver-dot" />
          <strong>Restarted — now running v{restartedTo}.</strong>
          <span className="ver-sub">The canvas replayed from the event log.</span>
        </div>
      ) : everConnected && !live ? (
        <div className="conn-banner" role="alert">
          <span className="conn-dot" />
          {restarting
            ? restartMode === "npx"
              ? "Fetching the new version with npx — this can take a minute…"
              : "Restarting agents-deck…"
            : "Lost connection to agents-deck server. Reconnecting…"}
        </div>
      ) : noticeOpen && notice && (
        // Both banners want grid row 2, and a dead connection is the more
        // urgent of the two — the version notice waits its turn.
        <div className={`ver-banner ${notice.kind}`} role="status">
          <span className="ver-dot" />
          {notice.kind === "restart" ? (
            <>
              <strong>v{notice.to} is installed — this deck still runs v{notice.from}.</strong>
              {version?.canRestart ? (
                <>
                  <button type="button" className="ver-act" onClick={() => askRestart()} disabled={restarting}
                    title="Stop this process and bring it back on the same port. The canvas replays from the event log.">
                    {restarting ? "restarting…" : "Restart now"}
                  </button>
                  <button type="button" className={`ver-auto${autoRestart ? " on" : ""}`}
                    role="switch" aria-checked={autoRestart} onClick={toggleAutoRestart}
                    title={autoRestart
                      ? "Restarts on its own once nothing has been running for 30 seconds. Click to require a click instead."
                      : "Only restarts when you click. Click to let it restart itself while idle."}>
                    <i aria-hidden />auto when idle
                  </button>
                </>
              ) : (
                <span
                  className="ver-sub"
                  title="Node loads every module once, at startup. An upgrade replaces the files on disk but not the code already in memory, so this process keeps running the old version until it is restarted."
                >Restart it to pick up the new code.</span>
              )}
            </>
          ) : (
            <>
              <strong>agents-deck v{notice.to} is out — you are on v{notice.from}.</strong>
              {/* One button when we can actually install; the command, always,
                  because the button can fail and the command never does. */}
              {version?.upgradeMode === "install" && upgradeState !== "failed" && (
                <button type="button" className="ver-act" onClick={startUpgrade}
                  disabled={upgradeState === "running" || upgradeState === "done"}
                  title={`Runs ${version?.upgrade?.command ?? "npm install -g agents-deck@latest"} here, then restarts once nothing is running.`}>
                  {upgradeState === "running" ? "installing…"
                    : upgradeState === "done" ? "installed"
                    : "Update now"}
                </button>
              )}
              {/* npx never installs anything — there is nothing here to install
                  over. The update IS the restart: the supervisor re-runs the
                  spec, npx unpacks a fresh copy, and it takes this port. */}
              {version?.upgradeMode === "npx" && version?.canRestart && (
                <button type="button" className="ver-act" onClick={() => askRestart({ upgrade: true })}
                  disabled={restarting}
                  title={`Runs ${version?.command} and hands it this port. Nothing is installed globally — npx unpacks its own copy.`}>
                  {restarting ? "fetching…"
                    /* A retry after a failure must not look like the first
                       click: the last one already came back on the same
                       version, and the label is where that shows. */
                    : upgradeState === "failed" ? "Retry update"
                    : "Update & restart"}
                </button>
              )}
              {upgradeState === "failed" ? (
                <span className="ver-sub fail" title={version?.upgrade?.error ?? ""}>
                  {/* npx installs nothing — its failure is a fetch that came
                      back on the old version, not a broken install. */}
                  {version?.upgradeMode === "npx" ? "update failed" : "install failed"}
                  : {version?.upgrade?.error ?? "unknown error"} — run it yourself:
                </span>
              ) : version?.upgradeMode === "npx" ? (
                <span className="ver-sub">
                  {version?.canRestart
                    ? "npx cannot upgrade in place, so the deck re-runs:"
                    : UPGRADE_BLOCK_TEXT.npx}
                </span>
              ) : version?.upgradeBlocked ? (
                <span className="ver-sub">
                  {UPGRADE_BLOCK_TEXT[version.upgradeBlocked] ?? "cannot install from here"}
                </span>
              ) : null}
              <button type="button" className="ver-cmd" onClick={copyCommand} title="Copy to clipboard">
                <code>{version?.command}</code>
                <span className="ver-cmd-hint">{cmdCopied ? "copied" : "copy"}</span>
              </button>
            </>
          )}
          <span role="button" tabIndex={0} aria-label="Dismiss" className="ver-close"
            onClick={toggleNotice}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleNotice(); } }}
          >×</span>
        </div>
      )}

      {usagePanelOpen && (
        <UsagePanel
          state={stateRef.current}
          now={now}
          onClose={() => setUsagePanelOpen(false)}
        />
      )}

      {accountsPanelOpen && (
        <AccountsPanel onClose={() => setAccountsPanelOpen(false)} />
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
      <div
        className={`canvas-wrap${bubbling ? " bubbling" : ""}${dragging ? " dragging-any" : ""}`}
        ref={canvasRef}
      >
        {agentCount === 0 && <EmptyHero live={live} everConnected={everConnected} />}
        {presentCats.length > 1 && (
          <div
            ref={catBarRef}
            className={`cat-filter-bar${catBarOccluded ? " occluded" : ""}`}
            role="toolbar"
            aria-label="Filter tools by category"
          >
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
          nodes={allNodes}
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
          // Without a threshold React Flow begins a drag on pointerdown, so a
          // plain click ran onNodeDragStart/onNodeDragStop at zero delta: it
          // pinned the card — every card of the session, for the group handle —
          // and switched auto-fit off for good. The distance is measured in
          // flow units, so it scales with the zoom; 5 is roughly the slop a
          // mouse, a trackpad or a finger has to beat before the gesture counts
          // as a drag instead of a click.
          nodeDragThreshold={5}
          onNodeClick={(e, n) => {
            if (n.type === "sessionGroup") { clearSelection(); return; }
            selectAgent(n.id, e.shiftKey);
          }}
          onPaneClick={() => clearSelection()}
          onMoveStart={() => {
            // React Flow fires this for animated programmatic viewport
            // changes too, not just user gestures — so our own fit was
            // switching auto-fit off the first time it ran, permanently and
            // silently. Ignore anything that lands during a fit we started.
            if (Date.now() - lastFitTimeRef.current < 1200) return;
            disableAutoFit();
          }}
          onMove={(_, vp) => {
            markInteract();
            // Debounce viewport persistence — pan/zoom fires many times
            // per gesture, but we only need the final state.
            if (vpSaveTimerRef.current) window.clearTimeout(vpSaveTimerRef.current);
            vpSaveTimerRef.current = window.setTimeout(() => saveViewport(vp), 250);
          }}
          onNodeDragStart={(_, n) => {
            // A drag must never inherit the push animation. The node under the
            // cursor is excluded by CSS, but a session drag moves its members
            // through state instead of the drag itself, and those would follow
            // the cursor 420ms late. Ending the animation outright is simpler
            // than enumerating which nodes a gesture will end up moving.
            endBubble();
            draggingRef.current = true;
            dragPatchRef.current = new Map();
            setDragging(true);
            markInteract();
            disableAutoFit();
            if (n.type === "sessionGroup") {
              // Snapshot every member's start position so each move applies the
              // gesture delta to a fixed origin (the group node's own start).
              const sid = (n.data as { sessionId?: string })?.sessionId;
              const members = new Map<string, { x: number; y: number }>();
              if (sid) {
                for (const m of nodes) {
                  const d = m.data as AgentNodeData | undefined;
                  if (d?.sessionId === sid) members.set(m.id, { x: m.position.x, y: m.position.y });
                }
              }
              groupDragRef.current = { start: { x: n.position.x, y: n.position.y }, members };
              return;
            }
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
          }}
          onNodeDrag={(_, n) => {
            markInteract();
            if (n.type === "sessionGroup") {
              const g = groupDragRef.current;
              if (!g) return;
              const dx = n.position.x - g.start.x;
              const dy = n.position.y - g.start.y;
              // Move every member by the delta. Writing pinned/positions is the
              // source of truth snapshotToFlow reads; the nonce forces an
              // immediate recompute so the nodes follow this frame.
              for (const [id, p0] of g.members) {
                const p = { x: p0.x + dx, y: p0.y + dy };
                pinnedRef.current.set(id, p);
                positionsRef.current.set(id, p);
              }
              // Patch the members and the box itself, rather than rebuilding
              // the whole graph on every pointer move as this used to.
              const patch = dragPatchRef.current;
              if (patch) {
                for (const [id, p0] of g.members) patch.set(id, { x: p0.x + dx, y: p0.y + dy });
                patch.set(n.id, { x: n.position.x, y: n.position.y });
              }
              setDragMoveTick(t => t + 1);
              return;
            }
            // Live-pin during drag so an incoming event re-render doesn't
            // snap the node back to its dagre slot mid-motion.
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            // And render it now, rather than whenever the next rebuild happens.
            dragPatchRef.current?.set(n.id, { x: n.position.x, y: n.position.y });
            setDragMoveTick(t => t + 1);
          }}
          onNodeDragStop={(_, n) => {
            markInteract();
            draggingRef.current = false;
            dragPatchRef.current = null;
            setDragging(false);
            setDragTick(t => t + 1);   // one rebuild, from the refs, at the end
            if (n.type === "sessionGroup") {
              const g = groupDragRef.current;
              if (g) {
                const dx = n.position.x - g.start.x;
                const dy = n.position.y - g.start.y;
                for (const [id, p0] of g.members) {
                  const p = { x: p0.x + dx, y: p0.y + dy };
                  pinnedRef.current.set(id, p);
                  positionsRef.current.set(id, p);
                }
              }
              groupDragRef.current = null;
              saveLayout(positionsRef.current, pinnedRef.current);
              setDragTick(t => t + 1);
              return;
            }
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
            saveLayout(positionsRef.current, pinnedRef.current);
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
          <Controls showInteractive={false}>
            <ControlButton
              onClick={enableAutoFitAndRefit}
              title={autoFitDisabled
                ? "Recenter view + re-enable autofit"
                : "Recenter view (autofit already on)"}
              aria-label="Recenter view"
              style={autoFitDisabled ? { color: "var(--accent)" } : undefined}
            >
              {/* crosshair / target — recenter affordance */}
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </ControlButton>
          </Controls>
          <MiniMap
            zoomable
            pannable
            nodeColor={n => minimapNodeColor(n, cssVar)}
            nodeStrokeWidth={2}
            maskColor={cssVar("--minimap-mask")}
            style={{ background: cssVar("--panel"), border: `1px solid ${cssVar("--line")}`, borderRadius: 8 }}
          />
        </ReactFlow>
      </div>

      {detailOpen ? (
        <aside className="detail">
          <button
            type="button"
            className="detail-close"
            title="Close panel"
            aria-label="Close detail panel"
            onClick={() => setDetailOpen(false)}
          >×</button>
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
      ) : (
        <button
          type="button"
          className="detail-reopen"
          title="Show detail panel"
          aria-label="Show detail panel"
          onClick={() => setDetailOpen(true)}
        >‹</button>
      )}

      {openedTool && <ToolModal tool={openedTool} onClose={() => setOpenedToolId(null)} />}
      {usageHistoryOpen && <UsageHistoryModal onClose={() => setUsageHistoryOpen(false)} />}
      {contextFor && (() => {
        const root = stateRef.current.agents.get(contextFor);
        if (!root) return null;
        return <ContextModal agent={root} onClose={() => setContextFor(null)} />;
      })()}
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
      {/* Last, so it sits above a session summary that pops in from a Stop
          hook while the user is still deciding. The gate keeps it from opening
          over a modal, but a modal can still arrive over it. */}
      {clearConfirmOpen && (
        <ClearConfirm
          agentCount={agentCount}
          onConfirm={() => requestClear("confirmation")}
          onCancel={() => setClearConfirmOpen(false)}
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
            <code>agents-deck</code> is still running in your terminal, then this
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
      <h2>Waiting for Claude Code or Codex</h2>
      <p>
        Run <code>claude</code> or <code>codex</code> in any folder. As soon as
        a session sends an event, a node appears here and grows as subagents
        fork and tools are called.
      </p>
      <p className="hint-row">
        Not seeing anything? Make sure <code>agents-deck</code> is running and that
        hooks are installed in your Claude settings (<code>$CLAUDE_CONFIG_DIR</code>{" "}
        if you set it, otherwise <code>~/.claude/settings.json</code>) and{" "}
        <code>~/.codex/hooks.json</code>. (Codex requires{" "}
        <code>/hooks</code> trust on first run.)
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
          No data yet. Start a Claude Code or Codex session anywhere on this
          machine — agents-deck is in <code>--all</code> mode and listens to every
          workspace.
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
        <div className="sc"><kbd>H</kbd><span>usage history</span></div>
        <div className="sc"><kbd>U</kbd><span>usage panel</span></div>
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
