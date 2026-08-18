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
import AgentNode, { waitingSentence } from "./components/AgentNode";
import { shortModel } from "./model-label";
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
import { escapeOutcome, modalStack } from "./modal-dismiss";
import { canvasKeyIntent, shouldReleaseFocusOnEscape, stepTarget } from "./canvas-keys";
import { pruneStaleEntries, measuredNodeIds } from "./prune";
import { isUnplaced, needsLayout, recordPlacement, stampPlaceholder, type Provisional } from "./placement";
import { createRenderCoalescer } from "./coalesce";
import { createPauseGate } from "./pause";
import { readStored } from "./storage";
import { THEME_KEY, storedTheme, type Theme } from "./theme";
import { PRODUCT } from "./brand";
import { ambientSignal, FAVICON_HREF, type AmbientSignal } from "./ambient";
import { blockedSessions, runningSessionCount } from "./ambient-counts";
import { blockedAnnouncement, nextAnnouncement } from "./block-announce";
import { categoryFor, type ToolCategory } from "./tool-taxonomy";
import UsageHistoryModal from "./components/UsageHistoryModal";
import { autoLayout, bubblePush, fillGapsWithNewSessions, laneSignature, separateOverlaps } from "./layout";
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, sessionHue, STALE_SESSION_MS, sweepStaleSessions, sweepStaleTools, type GraphState } from "./reducer";
import { EXIT_ANIM_MS, isAgentVisible, computeVisibleIds, anyTouches } from "./visibility";
import { SESSION_GROUP_TYPE, minimapNodeColor } from "./minimap";
import { costForUsage, fmtCost, fmtCostRate } from "./pricing";
import { versionChipLabel, versionChipTitle, versionNoticeLabel } from "./version-chip";
import { emptyScope } from "./scope";
import { ASSUMED, readProviders, type Providers } from "./providers";
import { captureHints, eventsCountTitle, finishSoundTitle, sessionsCountTitle } from "./provider-copy";
import { pauseButton, statusPill } from "./status-pill";
import { searchStatus, shouldDimUnmatched } from "./search-status";
import { matchesQuery, SEARCH_PLACEHOLDER } from "./search-match";
import { promptTime, shortAgo } from "./relative-time";
import { fmtTokens } from "./token-format";
// The detail panel used to spell both of these out inline — an elapsed clock a
// tier shorter than the agent card's, and a tool duration a decimal place
// coarser than the dialog the same row opens (#374). See duration.ts.
import { elapsed, toolDuration } from "./duration";
import CostBar from "./components/CostBar";
import type { AgentNodeData, HookEnvelope, ToolCall } from "./types";

function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "";
}

const nodeTypes = { agent: AgentNode, sessionGroup: SessionGroupNode };

/** The class React Flow puts on the wrapper it renders around every node — the
 *  element it makes tabbable, not the .agent-node card AgentNode draws inside
 *  it. That distinction is the whole reason the keyboard handling lives in
 *  App.tsx: a keydown fires on the focused wrapper and bubbles UP, so an
 *  onKeyDown on AgentNode's own root would never see it. */
const RF_NODE_CLASS = "react-flow__node";

/** True when this element IS a node wrapper. Deliberately not a `closest()`
 *  walk: the context donut inside a card is a real <button> with its own
 *  Enter, and matching an ancestor would have answered the donut's keys too. */
function isCanvasNodeElement(el: Element | null | undefined): boolean {
  return !!el && el.classList?.contains?.(RF_NODE_CLASS) === true;
}

/** Move the keyboard onto an agent card. Used when j/k traverses while the
 *  keyboard is already on the canvas, so the card the selection moved to is
 *  also the card Enter and Tab now speak about.
 *
 *  preventScroll because the canvas is a transformed plane inside a fixed-size
 *  box: the browser's own "scroll it into view" would shove the whole layer
 *  sideways behind the panels, and fitView is already bringing the node on
 *  screen properly. CSS.escape because an agent id is a session id and has
 *  never been promised to be a bare identifier. */
function focusCanvasNode(id: string): void {
  try {
    const el = document.querySelector(`.${RF_NODE_CLASS}[data-id="${CSS.escape(id)}"]`);
    (el as HTMLElement | null)?.focus({ preventScroll: true });
  } catch {}
}

/** What a mouse press can put focus on: the elements the browser looks for,
 *  walking up from whatever was pressed, when it decides where a click's focus
 *  goes. Written out here because releasePointerFocus has to predict that walk
 *  before the browser makes it — a press whose nearest candidate is the canvas
 *  itself is one the canvas should not answer (#434).
 *
 *  `[tabindex]` is the entry that makes the rule work at all: <main> carries
 *  tabindex="-1" for the skip link, which is exactly what puts it in this list.
 *  The disabled controls are excluded because the browser skips them too and
 *  keeps walking — a click on a disabled button lands its focus on the nearest
 *  enabled ancestor, which on this canvas is <main>. */
const FOCUS_CANDIDATES = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "[tabindex]",
].join(",");

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
// Which old command the name notice has already been dismissed for — the name
// itself, not a boolean. Somebody who dismisses it under `agent-dag` and later
// starts the deck as `agents-deck` is a second install that has not heard this
// yet, and a flag would silence it. In the agent-dag.* namespace like every
// other key here; brand.ts explains why the rename stops at the storage layer.
const OLD_NAME_DISMISSED_KEY = "agent-dag.oldNameNoticeDismissed";
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
  /** Which of the three published commands the user typed, when the server can
   *  prove it — and null everywhere it cannot: a global install on Windows,
   *  where npm's shim swallows the name before the process starts, and a git
   *  checkout, where nothing was typed. Never guessed, so a null here means the
   *  notice below stays away rather than that it picks the likeliest name.
   *  Deliberately separate from `name` above, which is the upgrade target: for
   *  a global install that is the published package whichever bin was run. */
  invokedAs?: string | null;
  /** The second line of that notice, already written: the command to type next
   *  time under npx, and the reassurance that it is on the PATH already for an
   *  install — the same one ships all three. Null when there is nothing to say,
   *  which is every shape where `invokedAs` above is null too.
   *
   *  A string rather than a flag, and computed on the server rather than here,
   *  because the browser has no honest way to tell those two apart on its own —
   *  the field it used to guess from (`upgradeMode`) answers whether this copy
   *  may install over itself, which `AGENTS_DECK_NO_INSTALL=1` turns off for
   *  npx and global installs alike. The terminal row renders this same string
   *  from this same function, which is what keeps the two surfaces one answer. */
  renameFix?: string | null;
};

// Said in the UI's voice, not npm's. Each of these is a decision we made on
// purpose, so each gets a reason rather than a disabled button.
const UPGRADE_BLOCK_TEXT: Record<string, string> = {
  git_checkout: "this deck runs from a git checkout — pull instead:",
  npx: "npx runs from a cache that cannot be upgraded in place — run:",
  not_writable: "the install directory is not writable by this user — run:",
  opted_out: "installs are off (AGENTS_DECK_NO_INSTALL=1) — run:",
};

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
  a.download = `${PRODUCT}-${safeLabel}-${sessionId.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Tool categories used both by the detail-panel strip and the canvas filter
// chips. These are the buckets ToolBursts tints its bubbles by, and they used
// to be a second copy of that table living here, "kept in sync manually —
// small enough that a shared module isn't worth it". It was not: when Codex
// renamed its shell tool to `exec` the copy here went on filing it under
// "other" while the canvas coloured it grey, and the two were only ever going
// to drift again (#417). Both now read the one table in tool-taxonomy.ts.
type DetailCategory = ToolCategory;
const DETAIL_CAT_EMOJI: Record<DetailCategory, string> = {
  file: "📁", shell: "⚡", web: "🌐", agent: "🤖",
  task: "📋", plan: "🧭", mcp: "🔌", other: "✨",
};
const DETAIL_CAT_LABEL: Record<DetailCategory, string> = {
  file: "file", shell: "shell", web: "web", agent: "agent",
  task: "task", plan: "plan", mcp: "mcp", other: "other",
};
/** The detail panel's name for the shared bucket lookup. Kept as a local alias
 *  purely so the call sites below read the way they always have. */
const detailCategoryFor = categoryFor;

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
  /** Ids in `positions` that hold a placeholder rather than a laid-out spot. */
  provisional: Provisional,
  layoutSig: string,
  lastLayoutSigRef: { current: string },
  selectedIds: Set<string>,
  lineage: Set<string> | null,
  visibleIds: Set<string>,
  onOpenContext: (sessionId: string) => void,
): { nodes: Node<AgentNodeData & { now: number; onOpenContext?: (sessionId: string) => void }>[]; edges: Edge[] } {
  const nodes: Node<AgentNodeData & { now: number; onOpenContext?: (sessionId: string) => void }>[] = [];
  const edges: Edge[] = [];
  // Visible agents only, so the size below counts the same population the
  // toolbar's "3 of 11" does — an exited agent still in state must not be the
  // reason the whole board dims.
  const matchSet = new Set<string>();
  if (query) {
    for (const a of state.agents.values()) {
      if (visibleIds.has(a.id) && matchesQuery(a, query)) matchSet.add(a.id);
    }
  }
  // A query nothing matched dims nothing: see search-status.ts. The zero-result
  // line on the canvas says it instead.
  const dimming = shouldDimUnmatched(query, matchSet.size);

  for (const a of state.agents.values()) {
    if (!visibleIds.has(a.id)) continue;
    const dim = dimming && !matchSet.has(a.id);
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
      data: { ...a, now, onOpenContext },
      className: cls,
      ...(m ? { width: m.width, height: m.height } : null),
    });
    if (a.parentId && visibleIds.has(a.parentId)) {
      const hue = sessionHue(a.sessionId);
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
      // The class picks the tier, the tier picks the lightness. Which of the
      // two an edge wears is a state this loop owns; how bright that state has
      // to be to survive its canvas is the sheet's, and used to be decided
      // here at a value tuned for #0b0c10 (1.19:1 on white at its worst hue).
      const cls = [
        "sess-edge",
        a.state === "active" ? "sess-live" : "sess-idle",
        fading ? "rf-edge-exiting" : "",
        isSelectedEdge ? "rf-edge-selected" : "",
      ].filter(Boolean).join(" ");
      edges.push({
        id: `e:${a.parentId}->${a.id}`,
        source: a.parentId,
        target: a.id,
        animated: (a.state === "active" || isSelectedEdge) && !edgeDim && !fading,
        type: "smoothstep",
        // No edge label — the target node already displays the agent name.
        // The transition is named here and valued in the stylesheet. An inline
        // style outranks every selector, so the literal string this used to
        // carry could not be answered by a `prefers-reduced-motion` rule at
        // all (#357) — a reader who asked for less motion still got 200ms of
        // stroke-width travel on every edge that gained or lost a selection.
        // `--edge-transition` moves that decision into styles.css, where the
        // media query drops the stroke-width half and keeps the opacity fade,
        // and it costs this component nothing: no hook, no listener, and no
        // re-render of the canvas when the preference changes.
        style: { "--session-hue": hue, strokeWidth: selectedWidth, opacity: effectiveOpacity, transition: "var(--edge-transition)" } as React.CSSProperties,
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
  // A node holding a placeholder counts as missing however real its entry in
  // `positions` looks — see placement.ts. Without that, the one write that
  // exists to keep a node on screen for a frame was also the write that told
  // this filter the node had been laid out.
  const missing = nodes.filter(n => needsLayout(n.id, pinned, positions, provisional));
  if (missing.length > 0 || sig !== lastLayoutSigRef.current) {
    if (missing.length > 0) {
      const laidOut = autoLayout(nodes, edges, { direction: "LR", pinned, measured, availableWidth, availableHeight, lanes });
      for (const n of laidOut) if (isUnplaced(n.id, positions, provisional)) recordPlacement(n.id, n.position, positions, provisional);
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
  // A mark normally lives one frame — the pass it asks for clears it — but an
  // agent that leaves between the stamp and that pass would leave its id in the
  // set for the life of the tab, which is the leak the size cache below had.
  pruneStaleEntries(provisional, state.agents);
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
      p = stampPlaceholder(n.id, positions, provisional);
      missingPosition = true;
    }
    finalNodes.push({ ...n, position: p });
  }
  if (missingPosition) {
    // Force the layout branch above to run again on the next render, even if
    // nothing else changed. The stamp is recorded as provisional, so that pass
    // sees the node in `missing` and hands it to dagre — which is what the
    // invalidation was always meant to buy and never did while a placeholder
    // was indistinguishable from a placement, leaving separateOverlaps as the
    // only thing that ever touched the node and the x=0 column as the only
    // place it could be.
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

  // Which sessions this deck is even allowed to see — "" for machine-wide, a
  // path when it was started with --workspace/--scope. Null until health
  // answers, and null forever against a server too old to report it; the empty
  // state says nothing about scope in that case rather than guessing, which is
  // how it came to claim a dead `--all` flag in the first place. Re-asked when
  // the stream reconnects, because that is the far end of a restart and the
  // only point the answer can have changed.
  const [workspace, setWorkspace] = useState<string | null>(null);
  // Which CLIs this deck watches, from the same request. Claude-only surfaces
  // are drawn only when Claude Code is here and Codex-only surfaces only when
  // Codex is — see providers.ts, which also owns what to believe when the
  // server does not say. Re-asked on reconnect with the scope, because a
  // restart is exactly when --no-claude or a newly installed CLI takes effect.
  const [providers, setProviders] = useState<Providers>(ASSUMED);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return;
        // Read before the workspace guard below, not after: `workspace` is a
        // separate field with its own reason to be missing, and letting it
        // decide whether providers are read would hide the panels of anyone
        // whose deck reports one and not the other.
        setProviders(readProviders(d));
        if (!d || typeof d.workspace !== "string") return;
        setWorkspace(d.workspace);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [live]);
  // The keydown handler below is bound once and reads its world through refs;
  // `A` has to see today's answer rather than the one that shipped with the
  // first render, when nothing had come back from /api/health yet.
  const providersRef = useRef(providers);
  providersRef.current = providers;
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

  // ── the name this deck was started under ──────────────────────────────────
  // Three npm names reach this same deck, every surface it draws says ccdeck,
  // and the name most people type is one of the other two. So it is said here
  // once per old name — in the shape of the banner above, never as an error.
  // Nothing is broken and nothing is being taken away, and a red alarm over a
  // name preference would be a lie about severity.
  //
  // The server reports `invokedAs` only where it can prove what was typed, so
  // this stays silent for a global install on Windows and for a git checkout
  // instead of guessing at either. Seeing this over a deck you started as
  // `ccdeck` is the one failure that would make it worth ignoring.
  const [oldNameDismissed, setOldNameDismissed] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(OLD_NAME_DISMISSED_KEY) ?? ""; } catch { return ""; }
  });
  // PRODUCT is both halves of the comparison on purpose: the name the deck
  // calls itself and the command we ask people to type are the same string
  // since the rename (#324), and display-name.test.ts is what holds them there.
  const oldName = version?.invokedAs && version.invokedAs !== PRODUCT ? version.invokedAs : null;
  const oldNameOpen = oldName != null && oldNameDismissed !== oldName;
  const dismissOldName = useCallback(() => {
    if (!oldName) return;
    setOldNameDismissed(oldName);
    try { window.localStorage.setItem(OLD_NAME_DISMISSED_KEY, oldName); } catch { /* private mode */ }
  }, [oldName]);
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
  // The same call index.html's bootstrap already made before the first paint,
  // so React starts out agreeing with what is on screen. Guarded the way the
  // panel loaders are: an initialiser is the one place a store the browser
  // won't hand over blanks the deck instead of costing a preference.
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [everConnected, setEverConnected] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // On the FIRST run this is redundant and known to be: the bootstrap wrote the
  // same attribute from the same stored value before anything painted, and the
  // write-back stores the value it just read. It is left unguarded anyway,
  // because the only way to skip it is a "have we mounted yet" ref — a second
  // answer to a question the DOM already holds, and one that goes wrong the day
  // someone reorders the effects. Re-asserting an identical attribute is free.
  // Every later run is the T toggle, which is the reason the effect exists.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
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
      // Both sweeps run on STALE_SESSION_MS because they are asking the same
      // question — is this session still there? — about two things that die
      // together. #436: the tool sweep used to ask it on a ninety-second clock of
      // its own, which meant the deck failed a session's tool calls an hour and a
      // half before it was willing to call that session gone, and stamped a red ×
      // on every `Bash` slower than a minute and a half. Order between the two is
      // immaterial: neither writes `lastEventAt`, which is what both read.
      let changed = sweepStaleTools(stateRef.current, t, STALE_SESSION_MS);
      // And the session above those tools, when nothing at all has been heard
      // from it in STALE_SESSION_MS. A terminal killed while a permission prompt
      // was up sends no final event, so its root stays `active` and its
      // `waiting` block stays lit — on the tab title and the favicon, which have
      // no age printed on them to give the staleness away. Runs on this tick
      // rather than one of its own: the periodic mechanism the three sweeps
      // below already share is the whole of what this needed.
      if (sweepStaleSessions(stateRef.current, t, STALE_SESSION_MS)) changed = true;
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
  // Which of those positions are placeholders. Deliberately not persisted: the
  // retry runs on the next render, at most a 250ms tick away, and the save
  // below is debounced 1500ms — so a placeholder is overwritten by a real
  // coordinate long before anything writes it to storage, and a mark restored
  // from a previous run would only relayout a node that has been settled since.
  const provisionalRef = useRef<Provisional>(new Set());
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
  // HTMLElement rather than HTMLDivElement: the canvas is a <main> now (#381),
  // and nothing here reads a property a <div> has and a <main> does not.
  const canvasRef = useRef<HTMLElement | null>(null);
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
  /** The pointer half of the skip link's focus target (#434).
   *
   *  `tabIndex={-1}` is on <main> so the skip link has somewhere to land, and
   *  it buys a second thing nobody asked for: an element a MOUSE can focus. A
   *  click on empty canvas parked focus on the canvas with nothing on screen to
   *  say so, and the next keystroke — any keystroke, including the ones the
   *  deck has no shortcut for — made the browser change its mind about
   *  `:focus-visible` for the element that was already focused. Selectors 4
   *  allows exactly that, and Chrome does it: the ring the skip link needs lit
   *  up around the whole window on a press the user reads as re-layout or a
   *  theme swap, and stayed until focus moved.
   *
   *  So the fix is here and not in the stylesheet, which cannot reach this.
   *  `:focus-visible` is the browser's own judgement, re-made AFTER focus has
   *  landed, so no selector can tell the two arrivals apart — CSS could only
   *  overrule the ring with `outline: none`, and the sheet is allowed exactly
   *  one of those (#368 pins the count, because a rule that quietly removes a
   *  focus ring is how the search field lost its own). Dropping the ring
   *  altogether is not on offer either: #381 put it there because landing
   *  somewhere with no sign you landed is the failure the skip link exists to
   *  fix. What is left is to take away the arrival that was never wanted. The
   *  ring is untouched, and the one path that can still reach it is the
   *  programmatic focus it was written for.
   *
   *  Capture phase, which is a measurement and not a preference: React Flow's
   *  pan handler calls stopImmediatePropagation() on the pane's mousedown, so a
   *  bubbling handler on <main> never sees the click that causes this at all.
   *  Cancelling the default costs the canvas nothing — panning, node drags,
   *  onPaneClick and the context menu all run off events of their own, and none
   *  of them is a default action. */
  const releasePointerFocus = useCallback((e: React.MouseEvent<HTMLElement>) => {
    // What the browser is about to focus: the nearest focus candidate at or
    // above the press. <main> is one of them — that is what tabindex="-1"
    // means — so a press that finds anything else found a real control, and a
    // real control keeps the click-to-focus every other control on the page
    // has. Asked with closest() rather than from a list of our own, because
    // the browser's own answer is the one that has to be predicted here.
    const target = e.target as Element | null;
    if (!target?.closest || target.closest(FOCUS_CANDIDATES) !== e.currentTarget) return;
    e.preventDefault();
    // And the other half: clicking empty canvas has always been how the mouse
    // puts focus down — canvas-keys.ts calls it the only route back to <body>
    // that existed before Escape learned to release one. Cancelling the
    // default focus on its own would leave the search box or a card still
    // holding it, so the click would stop meaning what it has always meant.
    (document.activeElement as HTMLElement | null)?.blur?.();
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
      positionsRef.current, provisionalRef.current, layoutSig, lastLayoutSigRef,
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
  //
  // Counted over the visible set only. It used to walk every agent in state,
  // including ones that have exited and are no longer drawn, so its size was
  // not a number that could be shown to anyone: the readout below would have
  // claimed matches for agents that are not on the canvas, and the "nothing
  // matched" branch would disagree with the dimming, which only ever touches
  // what is drawn.
  const matchedAgentIds = useMemo<Set<string> | null>(() => {
    if (!query) return null;
    const set = new Set<string>();
    for (const a of stateRef.current.agents.values()) {
      if (visibleAgentIds.has(a.id) && matchesQuery(a, query)) set.add(a.id);
    }
    return set;
  }, [stateRef.current, stateRef.current.lastSeq, query, visibleAgentIds]);

  // The one readout the search never had. `dim` is part of it because "dim
  // everything" is a claim that something else is lit.
  const search = useMemo(
    () => searchStatus(query, matchedAgentIds?.size ?? 0, visibleAgentIds.size),
    [query, matchedAgentIds, visibleAgentIds],
  );

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
   *  the chosen agent in view.
   *
   *  The order and the wrap-around live in canvas-keys.ts, where they can be
   *  tested without a canvas; what stays here is the two things that need one,
   *  the fit and the focus. */
  const stepAgent = useCallback((direction: 1 | -1) => {
    const current = nodesRef.current;
    const targetId = stepTarget(
      current.map(n => ({ id: n.id, x: n.position.x, y: n.position.y })),
      primarySelectedIdRef.current,
      direction,
    );
    const target = targetId ? current.find(n => n.id === targetId) : undefined;
    if (!target) return;
    // Traversal takes the keyboard with it, but only when the keyboard was
    // already on a card. j from <body> is the shortcut it has always been —
    // it selects, and every other single-key shortcut stays live because
    // nothing is focused. j from a card is navigation, and leaving focus
    // behind on the card the user just stepped off would make the next Enter
    // re-select the one they left rather than the one they moved to.
    const follow = isCanvasNodeElement(document.activeElement);
    selectAgent(target.id, false);
    // Fit-view to the chosen node so it lands on screen even if the user
    // had panned away.
    window.setTimeout(() => {
      try { rf.fitView({ padding: 0.35, duration: 350, nodes: [target] }); } catch {}
      lastFitTimeRef.current = Date.now();
      if (follow) focusCanvasNode(target.id);
    }, 30);
  }, [selectAgent, rf]);

  /** Select a session's root and bring it on screen. Reads `nodesRef` rather
   *  than the render-scope array so callers can be memoised: the array is
   *  rebuilt every render and would otherwise re-create every handler that
   *  closes over it. The frame of delay is for the same reason the session list
   *  has always needed one — the node has to be laid out before fitView can
   *  have anything to fit to. */
  const focusSession = useCallback((sessionId: string) => {
    selectAgent(sessionId, false);
    window.setTimeout(() => {
      try {
        const node = nodesRef.current.find(n => n.id === sessionId);
        if (node) rf.fitView({ padding: 0.3, duration: 500, nodes: [node] });
        lastFitTimeRef.current = Date.now();
      } catch {}
    }, 60);
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
        // One press, one owner. This branch used to clear the canvas selection
        // while whichever modal was on screen closed itself on the same event
        // — every modal listened on window too, so the tool modal shut and the
        // selection behind it vanished with it. The modals queue in
        // modal-dismiss.ts now and only the topmost answers.
        const outcome = escapeOutcome({ overlayOpen: modalStack.depth() > 0, typing: isTypingTarget(target) });
        if (outcome === "dismiss") modalStack.dismissTop();
        else if (outcome === "blur") el?.blur();
        else {
          // And the branch that gave the keyboard its way back. Every control
          // on this deck is a <button> or a role="button", so the gate below
          // — which is right to leave a focused control its own keys — killed
          // all thirteen single-key shortcuts the moment the first Tab landed,
          // for the rest of the session: tabbing off the end of the document
          // wraps to the first control rather than to <body>, and Escape only
          // released focus when the user was typing, which a button never is.
          // Releasing it here is what makes the next j, /, space or l work.
          // The selection still clears on the same press, so nothing about the
          // mouse's Escape changes.
          if (shouldReleaseFocusOnEscape(target)) el?.blur();
          clearSelection();
        }
        return;
      }
      // Ctrl/Cmd/Alt chords are the browser's, not ours — Ctrl+C is copy and
      // Ctrl+R is reload, and both arrive here as the bare letter. Asked before
      // the canvas branch below rather than after the gate it used to sit
      // behind, so that Cmd+Enter on a focused card stays the browser's too.
      if (isBrowserChord(e)) return;
      // An agent card is the one focusable thing here that is not really a
      // control: React Flow makes every node a tabbable role="button" and then
      // answers Enter itself through a store write that a controlled `nodes`
      // prop skips, so the card announced itself as a button and did nothing at
      // all. This is where the keyboard gets the click's behaviour — including
      // Shift for additive, the way Shift+click already works in onNodeClick.
      // Checked against the array React Flow is rendering rather than trusted
      // from the DOM: the invisible per-session drag handles are wrappers with
      // a data-id too, and they are not agents. They are focusable={false} so
      // no keystroke should ever arrive from one, but selecting an id that is
      // not on the canvas would leave a selection nothing can show or clear.
      const focusedId = isCanvasNodeElement(el) ? el?.getAttribute?.("data-id") : null;
      const focusedNodeId = focusedId && nodesRef.current.some(n => n.id === focusedId) ? focusedId : null;
      const intent = canvasKeyIntent(e, focusedNodeId);
      if (intent.kind === "activate") {
        e.preventDefault();
        selectAgent(intent.nodeId, intent.additive);
        return;
      }
      // Arrows and Delete belong to the card, whatever React Flow does or does
      // not do with them.
      if (intent.kind === "node") return;
      // A focused control owns its own keys: Space presses a button, letters
      // run a <select>'s type-ahead. Answering them stole the button's
      // activation key and let a bare "c" from a dropdown wipe the event log.
      //
      // A card is exempt. It wears role="button" because React Flow put it
      // there, not because it is a control the user typed into, and the two
      // keys it genuinely owns were answered above — so j still traverses and
      // / still reaches the search box while a card holds focus, which is the
      // whole point of being able to tab onto one.
      if (intent.nodeId == null && ownsKeystroke(target)) return;
      if (e.key === "/") { e.preventDefault(); searchInputRef.current?.focus(); return; }
      if (e.key === " ") { e.preventDefault(); togglePause(); }
      if (e.key === "c" || e.key === "C") requestClear("shortcut");
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "f" || e.key === "F") handleFit();
      if (e.key === "l" || e.key === "L") toggleSessionList();
      if (e.key === "h" || e.key === "H") setUsageHistoryOpen(o => !o);
      if (e.key === "u" || e.key === "U") setUsagePanelOpen(o => !o);
      // Nothing to disclose on a deck with no Claude Code: the button is not
      // rendered and the panel is not mounted, so an unguarded `A` would only
      // toggle a persisted flag nobody can see the effect of.
      if (e.key === "a" || e.key === "A") { if (providersRef.current.claude) toggleAccountsPanel(); }
      if (e.key === "j" || e.key === "J") stepAgent(1);
      if (e.key === "k" || e.key === "K") stepAgent(-1);
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClear, handleRelayout, handleFit, clearSelection, selectAgent, stepAgent, togglePause]);

  const agentCount = stateRef.current.agents.size;
  const sessionCount = new Set(Array.from(stateRef.current.agents.values()).map(a => a.sessionId)).size;
  /** The two numbers the topbar chip and the tab strip are driven from —
   *  sessions blocked on a human, longest-blocked first, and sessions with an
   *  agent still moving. Both are recomputed from the agents map on every frame
   *  rather than kept as a tally, because the map is the thing that forgets;
   *  ambient-counts.ts holds that reasoning along with why only a `permission`
   *  block is an alarm.
   *
   *  In a module rather than inline here because a rule that is spelled out
   *  inside a React component is a rule a bare-node suite cannot call, and what
   *  cannot be called gets copied instead. It was, twice, and #348 reached the
   *  original and not the copies — so the suite spent thirty releases asserting
   *  the superseded counting as correct (#377). The tests now import these two
   *  functions, which is what makes a change to the rule a failing test rather
   *  than a passing one. */
  const waitingSessions = useMemo(
    () => blockedSessions(stateRef.current.agents.values()),
    [stateRef.current, stateRef.current.lastSeq],
  );
  const runningSessions = useMemo(
    () => runningSessionCount(stateRef.current.agents.values()),
    [stateRef.current, stateRef.current.lastSeq],
  );
  // The tab strip — the only surface of this deck that is on screen while the
  // deck is not. The rule lives in ambient.ts, where it can be tested; this is
  // the DOM write the rule is not allowed to own.
  //
  // Comparing before writing is not defensive tidiness. This runs on the SSE
  // path and `running` churns under a title that is standing still: every
  // subagent that spawns or finishes moves it while the tab still says plain
  // ccdeck and still wears the blue mark. Assigning `document.title` rewrites
  // the <title> node and hands the browser a fresh tab label whether or not the
  // string changed, and a fresh icon href is a data URI to parse and rasterise
  // again. Both cost nothing on the frames where nothing moved, which is nearly
  // all of them.
  const ambientRef = useRef<AmbientSignal | null>(null);
  useEffect(() => {
    const next = ambientSignal({ waiting: waitingSessions.length, running: runningSessions });
    const prev = ambientRef.current;
    ambientRef.current = next;
    if (prev?.title !== next.title) document.title = next.title;
    if (prev?.icon !== next.icon) {
      // Mutating href on the existing <link>, not swapping the node. Chrome,
      // Firefox and Safari all re-read the attribute; the replace-the-whole-
      // element dance is a workaround for browsers none of them still are, and
      // it costs a fresh parse of the data URI every time. If some browser in
      // the matrix is ever found ignoring this, THAT is the moment to adopt the
      // heavier version — not before.
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (link) link.href = FAVICON_HREF[next.icon];
    }
  }, [waitingSessions.length, runningSessions]);
  // The same fact as the two lines above, on the one channel that had it from
  // neither: spoken.
  //
  // A blocked session reached the tab title, the favicon, the amber topbar chip
  // and the card's own row, and every one of those four is a thing you have to
  // look at. #372: the deck's one alarm-worthy event was announced nowhere,
  // while the stat strip beside it was a live region wrapped around a counter
  // that moves on every hook event. Both halves are the same mistake — a live
  // region spent on what changes rather than on what matters — and the second
  // half is the more expensive one, because a region that talks through a tool
  // storm is a region the user switches off before the first real alarm.
  //
  // `blockedAnnouncement` is pure and runs on the render path; `nextAnnouncement`
  // is the reducer that decides whether that sentence is news. Both live in
  // block-announce.ts, where a suite with no DOM can call them — see the file
  // for why the all-clear string is load-bearing and why this is a reducer over
  // committed state rather than a latch advanced during render.
  //
  // The effect depends on the SENTENCE, not on the session list. `waitingSessions`
  // is rebuilt on every event by way of `lastSeq`, so a list-shaped dependency
  // would re-run this on every event of every tool storm to discover each time
  // that nothing had changed. A string dependency runs it only when the words
  // move, and React's own bail-out on an identical state value means even that
  // costs no render.
  const [blockedSaid, setBlockedSaid] = useState("");
  const blockedNow = blockedAnnouncement(waitingSessions);
  useEffect(() => {
    setBlockedSaid(said => nextAnnouncement(said, blockedNow));
  }, [blockedNow]);
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
      {/* The deck's regions, and why each one is the element it is (#381).
          Before this the whole page was <div>s apart from the topbar, so a
          screen reader's landmark rotor listed one entry — Banner — for an
          application with five regions, and there was no way to move between
          them except Tab.
          Four landmarks, each of which is a region a reader would actually
          jump to: the topbar is the banner it already was, the canvas is
          <main> because it is this page's subject and everything else on
          screen is beside it, and the three panels are <aside>s because each
          one is commentary on the canvas that comes and goes without changing
          what the canvas shows. None of them is invented for the rotor's sake:
          the two that were already <aside> — the session list and the detail
          panel — are unchanged in shape here and only gained the name one of
          them was missing.
          Deliberately NOT added: a <nav>, because this deck has no navigation
          — the session list moves the camera, it does not move the user
          between documents — and a role="search" around the filter box, which
          would be a landmark wrapped around a single input that the rotor
          already lists under Form Controls by its own aria-label. A landmark
          list padded with regions nobody would navigate to is the same defect
          as no landmarks at all, one direction over.
          The panels are conditional (#402 made the accounts one conditional on
          Claude Code being installed at all), so the rotor's contents change
          with what is open. That is correct: an <aside> that is not rendered
          is not a region that is empty, and the toggles that mount them
          already carry aria-expanded. */}
      {/* First in the DOM so it is the first Tab of the page, and out of flow
          so it is not a grid item — .app auto-places its children, and a link
          that took a cell would push the topbar into row 2.
          It exists because there are ~166 focusable controls between the top
          of the document and the canvas once the panels are open, and until
          now a keyboard user had to walk every one of them to reach the thing
          the deck is for. WCAG 2.4.1. The target is <main> rather than the
          first card: cards come and go with the sessions, main is always
          there, and landing on it puts the deck's own single-key shortcuts
          back in play (ownsKeystroke() leaves a <main> alone). */}
      <a className="skip-link" href="#canvas">Skip to the canvas</a>
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          {/* The page's <h1>, and the wordmark that was already here rather
              than a second copy of it hidden off screen (#381). The document
              had no h1 at all, so its heading outline began at h3 and every
              level below was a skip.
              A visually-hidden heading was the other option and is the wrong
              one HERE: the name it would carry is the word printed two pixels
              to the right of it, so a screen reader would hear "ccdeck,
              heading level 1" and then "ccdeck" again from the wordmark. A
              hidden heading earns its keep when a region has no visible title;
              this region has one, and marking up what is already on the page
              is what 1.3.1 asks for. It is also the same string as the
              document's <title>, from the same constant, so the tab, the
              wordmark and the outline cannot drift.
              The version chip stays a sibling and not a child: it is a button
              whose accessible name is a whole sentence about npm, and inside
              the heading that sentence would become part of the heading's
              name. */}
          <h1>{PRODUCT}</h1>
          {/* The server's own version, not the bundle's — an upgrade replaces
              dist/ too, so a reloaded page can show a number the running
              process never had. Stale → the chip stays lit even after the
              banner is dismissed, and clicking it brings the banner back. */}
          {notice ? (
            <button
              type="button"
              className="v stale"
              onClick={toggleNotice}
              /* The healthy branch below has carried an accessible name since it
                 was written; this one did not, so its name was its text — the
                 same bare version string, which made the chip that HAS news
                 indistinguishable from the chip that has none. See
                 versionNoticeLabel for the rest of the reasoning (#381). */
              aria-label={versionNoticeLabel({ ...notice, open: noticeOpen })}
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
              {/* A mouse shortcut, not a control. It sits inside the ribbon's
                  own <button>, so it can never be a button itself — nesting one
                  is invalid, and it carried no tabIndex, which left a
                  role="button" labelled "Deselect" that no keyboard could ever
                  reach or operate. The keyboard has the same verb on Escape
                  from anywhere on the page, so the honest markup is decoration
                  with a click on it. */}
              <span
                aria-hidden
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
              placeholder={SEARCH_PLACEHOLDER}
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
              aria-label="Filter the graph"
            />
            {query
              ? <button className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>
              : <kbd className="search-kbd" aria-hidden>/</kbd>}
            {/* The filter's own state, the way the category chips and the
                selection ribbon show theirs. aria-live so a screen reader hears
                the result change without leaving the field. */}
            {search.count && (
              <span
                className={`search-count${search.empty ? " none" : ""}`}
                aria-live="polite"
                title={`${search.count} agents on the canvas match “${query}”`}
              >{search.count}</span>
            )}
          </div>
          {/* NOT a live region, and #372 is the issue that took the
              `role="status"` off it. Nothing in this strip is a status
              *message*: it is a permanently visible readout the user can read
              whenever they want one, and every number in it moves on its own —
              `totalEvents` increments once per hook event, which on a fan-out is
              tens per second. `role="status"` also carries an implicit
              `aria-atomic="true"`, so what a screen reader actually did with
              each of those increments was re-read the whole strip, sessions and
              agents and tokens and cost together, rather than the one number
              that moved. Continuous speech of numbers nobody asked for is how a
              page teaches its user to turn the screen reader off, and it was
              being spent on the least urgent thing in the topbar.
              WCAG 4.1.3 was satisfied here — for the wrong content. The alarm
              that is worth a live region has one of its own, below. */}
          <span className="status">
            {/* Three states, not two. Read through the gate rather than a
                counter of its own: the queue is the thing being reported. */}
            {(() => {
              const pill = statusPill({ connected: live, paused, held: pauseRef.current.size });
              return (
                <span className={`pill ${pill.tone}`} title={pill.title}>{pill.label}</span>
              );
            })()}
            {/* Both counters have always counted both providers; only their
                tooltips said otherwise. "Distinct CC sessions" and "Total hook
                events received" were written when the deck watched Claude Code
                alone, and a Codex user reading them sees a correct number
                labelled as a count of a product they are not running (#404).
                Named from `providers` rather than trimmed to "sessions" and
                "events" — see provider-copy.ts. */}
            <span className="stat" title={sessionsCountTitle(providers)}><span className="count">{sessionCount}</span><span className="lbl">sessions</span></span>
            <span className="stat" title="Total agents (root + subagents)"><span className="count">{agentCount}</span><span className="lbl">agents</span></span>
            <span className="stat" title={eventsCountTitle(providers)}><span className="count">{stateRef.current.totalEvents}</span><span className="lbl">events</span></span>
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
                    style={{ "--mcp-hue": s.hue } as React.CSSProperties}
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
          {/* The deck's one alarm, said out loud — and the only live region in
              the topbar (#372).
              MOUNTED UNCONDITIONALLY, which is the half that looks redundant and
              is not. A screen reader registers a live region when the region
              enters the accessibility tree, and text that arrives in the same
              tick as the region itself is routinely never announced at all. The
              chip below is mounted only while something is blocked, so wrapping
              THAT in a role="status" would have put the region and its first
              words on screen together — the one announcement that matters, on
              the one delivery screen readers are least reliable about. It would
              also have taken the region away again with the chip, leaving
              nowhere to say the block had cleared. So the region is always here
              and only its text moves.
              POLITE, not assertive, and that was a decision rather than a
              default. `role="alert"` interrupts whatever is being spoken, which
              buys at most the length of one utterance — and a blocked session
              waits indefinitely, so nothing is lost by arriving a sentence
              later. What assertive would cost is concrete: a deck reloaded while
              a session is already blocked replays that block during mount, and
              an assertive region firing there talks over the screen reader's own
              announcement of the page the user just opened. The connection
              banner keeps role="alert" because its failure is the other kind —
              once the stream is dead every number on this page is stale and the
              deck is quietly lying, so a deferred announcement is a user acting
              on dead data.
              role="status" carries an implicit aria-atomic="true"; it is written
              out because this sentence only means anything whole, and because a
              partial reading of it is exactly the failure the strip above was
              guilty of. */}
          <div className="vis-hidden" role="status" aria-atomic="true">{blockedSaid}</div>
          {/* Outside the .status strip on purpose: that strip is a readout and
              this is a control, the only number in the bar the user is meant to
              act on — click goes to the session that has been stuck longest,
              which is both the one the deck was left open for and the one the
              region above names. It says nothing when nothing is blocked, and it
              never speaks for Codex: those sessions emit no notification, so
              counting them would turn "we have no signal" into "they are fine".
              It carries no live region of its own; the div above is where the
              speaking happens, for the mounting reason given there. */}
          {waitingSessions.length > 0 && (
            <button
              type="button"
              className="waiting-stat"
              onClick={() => focusSession(waitingSessions[0].id)}
              title={`Blocked waiting for you — click to go to the one that has been stuck longest:\n${
                waitingSessions.map(w => `  ${w.label}: ${waitingSentence(w.waiting)} (${shortAgo(now - w.waiting.since)})`).join("\n")
              }`}
              aria-label={`${waitingSessions.length} session${waitingSessions.length === 1 ? "" : "s"} waiting for you`}
            >
              <span className="ap-pulse" aria-hidden />
              <b>{waitingSessions.length}</b> waiting
            </button>
          )}
          {(() => {
            const btn = pauseButton({ paused, held: pauseRef.current.size });
            return (
              <button className={`btn ${paused ? "warn" : ""}`} onClick={togglePause} title={btn.title}>
                {btn.label}
              </button>
            );
          })()}
          {/* aria-expanded, not aria-pressed. This shows and hides a region
              that follows it in the DOM and it leaves focus exactly where it
              was — the disclosure pattern, which is what the accounts panel's
              ⋯ menu already models below. "Pressed" would claim the button is
              a setting that stays on; what it actually reports is whether the
              thing it points at is on screen.
              aria-controls only while the panel is mounted, for the reason
              AccountsPanel spells out: an IDREF that resolves to nothing is a
              dangling pointer rather than a relationship, and closed is exactly
              when there is nothing to point at.
              The `primary` class is gone from all five of these. The state is
              the ARIA attribute now and the stylesheet reads it there, so the
              pixels and the accessibility tree cannot drift apart. */}
          <button
            className="btn icon-btn"
            onClick={() => setUsagePanelOpen(o => !o)}
            title={`${usagePanelOpen ? "Hide" : "Show"} usage panel (U)`}
            aria-label="Toggle usage panel"
            aria-expanded={usagePanelOpen}
            aria-controls={usagePanelOpen ? "usage-panel" : undefined}
          >$</button>
          {/* The one genuine aria-pressed of the five, and it was already
              carrying it. This installs or removes a Stop hook on disk: there
              is no region it discloses and nothing on screen appears when it
              goes on, so "expanded" would be a promise of content that does not
              exist. A setting that is on or off is what "pressed" means.

              Gone without Claude Code, by the same rule the accounts button
              below states: this switch is one entry in Claude Code's
              settings.json, so on a machine that has no Claude Code it is a
              control whose only effect is to write a hook nothing will ever
              execute. Where Claude Code IS here it stays, and the tooltip says
              which turns it covers — see finishSoundTitle, which also records
              the two ways of making Codex audible that were considered and why
              neither is this fix (#394). */}
          {providers.claude && soundOn !== null && (
            <button
              className="btn icon-btn"
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
              title={finishSoundTitle(providers, { on: soundOn, clash: soundClash, parked: soundParked })}
              /* The name a screen reader announces, and it names the CLI too.
                 `title` reaches assistive tech only as a description, which is
                 announced later than the name and by no means everywhere — so
                 the one qualification a Codex user needs cannot live only
                 there. Static rather than derived from `providers` because the
                 button does not render at all without Claude Code, which makes
                 "Claude Code" true every time this string is read. */
              aria-label="Toggle Claude Code finish sound"
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
          {/* Same disclosure as the usage panel — a sidebar that opens beside
              the canvas and takes no focus with it.
              Gone entirely without Claude Code, rather than present and inert.
              A disabled control is a promise that something could be enabled;
              there is no account to switch to on a machine whose only CLI is
              Codex, which has exactly one logged-in account and no store. */}
          {providers.claude && (
          <button
            className="btn icon-btn"
            onClick={toggleAccountsPanel}
            title={`${accountsPanelOpen ? "Hide" : "Show"} accounts (A)`}
            aria-label="Toggle accounts panel"
            aria-expanded={accountsPanelOpen}
            aria-controls={accountsPanelOpen ? "accounts-panel" : undefined}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="7" cy="4.6" r="2.4" />
              <path d="M2.4 12c0-2.3 2.1-3.7 4.6-3.7s4.6 1.4 4.6 3.7" />
            </svg>
          </button>
          )}
          {/* And the third, sharing the left slot with accounts. */}
          <button
            className="btn icon-btn"
            onClick={toggleSessionList}
            title={`${sessionListOpen ? "Hide" : "Show"} session list (L)`}
            aria-label="Toggle session list"
            aria-expanded={sessionListOpen}
            aria-controls={sessionListOpen ? "session-list" : undefined}
          >☰</button>
          {/* The odd one out, and deliberately given neither aria-pressed nor
              aria-expanded. What this opens is a modal — role="dialog"
              aria-modal="true" behind a full-screen scrim, with the focus trap
              #371 added — so while it is open this button cannot be clicked,
              cannot be tabbed to, and aria-modal has removed the whole topbar
              from the accessibility tree. A state whose `true` no reader can
              ever reach is worse than no state: it would be a value announced
              only in the one case it is not needed. The label already says
              "Open" rather than "Toggle"; aria-haspopup is the part that was
              missing, and it says what kind of thing opens. */}
          <button
            className="btn icon-btn"
            onClick={() => setUsageHistoryOpen(o => !o)}
            title="Usage history — ccusage (H)"
            aria-label="Open usage history"
            aria-haspopup="dialog"
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
              : `Restarting ${PRODUCT}…`
            : `Lost connection to the ${PRODUCT} server. Reconnecting…`}
        </div>
      ) : noticeOpen && notice ? (
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
              {/* The product's name, not the `name` /api/version reports: that
                  one is the npm package the registry was asked about, and it is
                  `ccdeck`, `agents-deck` or `agent-dag` depending on how this
                  deck was started. A release announcement whose subject changes
                  with the install method names three products where there is
                  one, and contradicts the wordmark directly above it. The
                  package belongs where it is actionable — the button's title
                  below, which is the command that actually installs. */}
              <strong>{PRODUCT} v{notice.to} is out — you are on v{notice.from}.</strong>
              {/* One button when we can actually install; the command, always,
                  because the button can fail and the command never does.

                  The tooltip's fallback matters more than it looks:
                  `upgrade.command` is the vector npm was actually spawned with
                  and exists only once an install has started, so before the
                  first click the fallback is the whole of what it says — and a
                  hardcoded `agents-deck` was wrong for every `npm i -g ccdeck`,
                  where the install names the stub instead. `version.command` is
                  the server's own answer to the same question, correct in every
                  install shape, and the same string the copy button carries. */}
              {version?.upgradeMode === "install" && upgradeState !== "failed" && (
                <button type="button" className="ver-act" onClick={startUpgrade}
                  disabled={upgradeState === "running" || upgradeState === "done"}
                  title={`Runs ${version?.upgrade?.command ?? version?.command ?? "npm i -g"} here, then restarts once nothing is running.`}>
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
                  {/* hasOwn, not `??` — see categoryFor (#474). The reason is a
                      string off /api/version, so a build that sends one naming
                      an Object.prototype member would put a function here. */}
                  {Object.hasOwn(UPGRADE_BLOCK_TEXT, version.upgradeBlocked)
                    ? UPGRADE_BLOCK_TEXT[version.upgradeBlocked]
                    : "cannot install from here"}
                </span>
              ) : null}
              <button type="button" className="ver-cmd" onClick={copyCommand} title="Copy to clipboard">
                <code>{version?.command}</code>
                <span className="ver-cmd-hint">{cmdCopied ? "copied" : "copy"}</span>
              </button>
            </>
          )}
          {/* A real button, like the five controls beside it. As a
              role="button" span this re-implemented Enter and Space by hand —
              and its Space branch existed only to undo the global preventDefault
              this handler now never reaches, since ownsKeystroke() leaves a
              focused <button> alone. */}
          <button type="button" aria-label="Dismiss" className="ver-close" onClick={toggleNotice}>×</button>
        </div>
      ) : oldNameOpen && oldName ? (
        // Last of the four, because it is the only one nobody has to act on
        // today: a dropped connection, a restart and a release all outrank a
        // name. It comes back the moment the row above it is dismissed.
        <div className="ver-banner" role="status">
          <span className="ver-dot" />
          <strong>{oldName} still works — the deck is called {PRODUCT} now.</strong>
          {/* The half people do not expect, and the half this must not get
              wrong: a global install already put a ccdeck on the PATH — the
              same install ships all three commands — so there is nothing to
              fetch and nothing to uninstall, only a different word to type,
              while under npx there is no such install and `npx ccdeck` is the
              whole answer. Telling the second group the first line sends them
              to a `command not found`.

              So it is not decided here. This branch used to read
              `upgradeMode === "npx"`, which sounds like the same question and
              is a different one — it says whether an in-app `npm i -g` is
              allowed, and `AGENTS_DECK_NO_INSTALL=1` makes it null for npx runs
              too, at which point every npx user who opted out of installs got
              the global-install line (#363). The server sends the sentence the
              terminal prints, from the same function, and no string here can
              drift from it. Rendered only when it is there: a missing field is
              a server that could not say, and silence beats a guess. */}
          {version?.renameFix ? <span className="ver-sub">{version.renameFix}</span> : null}
          <button type="button" aria-label="Dismiss" className="ver-close" onClick={dismissOldName}>×</button>
        </div>
      ) : null}

      {usagePanelOpen && (
        <UsagePanel
          state={stateRef.current}
          now={now}
          providers={providers}
          onClose={() => setUsagePanelOpen(false)}
        />
      )}

      {/* Claude-only, and now conditional on Claude Code actually being here.
          Every account in it is a Claude account, the store behind it is
          claude-swap's, and both of its empty states end at `claude auth login`
          — which on a Codex-only machine dead-ends at "the claude CLI could not
          be run: not on PATH". The panel is also open by default, so that was
          the first thing such a user saw. */}
      {accountsPanelOpen && providers.claude && (
        <AccountsPanel onClose={() => setAccountsPanelOpen(false)} />
      )}

      {sessionListOpen && (
        <SessionList
          state={stateRef.current}
          now={now}
          selectedIds={selectedIds}
          onSelect={focusSession}
          onClose={() => setSessionListOpen(false)}
        />
      )}
      {/* <main>, because the canvas is what this page is: everything else on
          screen — the toolbar above it, the panels beside it — exists to
          describe or steer what is drawn here. One per document, and this is
          the one.
          tabIndex={-1} makes it a focus target for the skip link above without
          adding a tab stop of its own. Focus landing here is also harmless to
          the keyboard rules #367 settled: MAIN is not in shortcuts.ts's
          KEY_OWNING_TAGS and carries no interactive role, so ownsKeystroke()
          returns false and the deck's single-key shortcuts keep working from
          it, and Escape releases it back to the document like any other
          non-typing target.
          What tabIndex={-1} must NOT do is make the canvas a thing the mouse
          focuses, which it also is by default and which lit the skip link's
          ring for every click on empty canvas one keystroke later (#434).
          releasePointerFocus is where that half is taken back, and it has to be
          the capture phase: React Flow stops the pane's mousedown dead before
          it can bubble this far. */}
      <main
        id="canvas"
        tabIndex={-1}
        className={`canvas-wrap${bubbling ? " bubbling" : ""}${dragging ? " dragging-any" : ""}`}
        ref={canvasRef}
        onMouseDownCapture={releasePointerFocus}
      >
        {agentCount === 0 && <EmptyHero live={live} everConnected={everConnected} providers={providers} />}
        {/* Said out loud rather than implied by a grey canvas: a query that
            matches nothing is indistinguishable from every session having aged
            out, and the dimming that was carrying the message on its own is
            itself masked by the spawn animations (#316). */}
        {search.empty && agentCount > 0 && (
          <div className="search-empty" role="status">
            <span className="search-empty-text">{search.message}</span>
            <button
              type="button"
              className="btn"
              onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}
            >Clear search</button>
          </div>
        )}
        {presentCats.length > 1 && (
          /* role="group", not role="toolbar". A toolbar is a promise about
             keyboard behaviour — one tab stop for the whole set, arrow keys
             between the members — and this bar implements none of it: every
             chip is its own tab stop, which is the right shape for a handful
             of independent filters and the wrong shape to call a toolbar.
             Claiming the role told a screen reader to expect arrow keys that
             do nothing, which is a worse answer than not claiming it. group
             keeps the thing the role was actually being used for: the set is
             named, so the chips are heard as one control and not seven. */
          <div
            ref={catBarRef}
            className={`cat-filter-bar${catBarOccluded ? " occluded" : ""}`}
            role="group"
            aria-label="Filter tools by category"
          >
            {presentCats.map(c => {
              const off = hiddenCats.has(c);
              return (
                /* aria-pressed, because a chip really is a toggle: it does not
                   reveal anything, it turns a filter on and off. Pressed means
                   the category is showing, which is the state the chip's own
                   name and emoji describe — the label is "edit", not "hide
                   edit", so pressed has to mean "edit is on". */
                <button
                  key={c}
                  type="button"
                  className={`cat-filter${off ? " off" : ""}`}
                  onClick={() => toggleCat(c)}
                  aria-pressed={!off}
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
            dimUnmatched={search.dim ? matchedAgentIds : null}
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
      </main>

      {detailOpen ? (
        // Already the right element and still an unnamed one: the rotor listed
        // it as a bare "complementary" beside the session list's "Sessions",
        // which is the entry a reader cannot tell from the next. The name is
        // fixed rather than the selected agent's label — the panel keeps its
        // identity when nothing is selected, and a landmark whose name changes
        // under the reader is a landmark they cannot come back to. The agent's
        // name is the panel's <h2>, which is where a changing title belongs.
        <aside className="detail" aria-label="Detail">
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
            : <EmptyDetail count={agentCount} workspace={workspace} />}
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
      {/* `providers` is what the modal's subtitle falls back to until a ccusage
          run has said whose logs are actually in the figures (#431). It is not
          a gate: ccusage reads the logs on this machine rather than this deck's
          flags, so a deck started with --no-codex can still be shown Codex
          spend, and the subtitle follows the data when there is any. */}
      {usageHistoryOpen && <UsageHistoryModal providers={providers} onClose={() => setUsageHistoryOpen(false)} />}
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

function EmptyHero({ live, everConnected, providers }: { live: boolean; everConnected: boolean; providers: Providers }) {
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
            <code>{PRODUCT}</code> is still running in your terminal, then this
            page will resume automatically.
          </p>
        </>
      ) : agentNoneCopy(providers)}
    </div>
  );
}

function agentNoneCopy(providers: Providers) {
  return (
    <>
      <h2>Waiting for Claude Code or Codex</h2>
      <p>
        Run <code>claude</code> or <code>codex</code> in any folder. As soon as
        a session sends an event, a node appears here and grows as subagents
        fork and tools are called.
      </p>
      {/* This used to be one sentence for both CLIs, and it sent Codex users to
          install `~/.codex/hooks.json` and grant it `/hooks` trust — work the
          deck stopped doing before it ever shipped, on a file it opens only to
          uninstall (#404). One line per capture path now, each naming what that
          path really depends on, and each able to say the deck is not watching
          that CLI at all. The words live in provider-copy.ts so the branches can
          be tested without a DOM. */}
      <p className="hint-row">
        Not seeing anything? Make sure <code>{PRODUCT}</code> is running.
      </p>
      {captureHints(providers).map(hint => (
        <p className="hint-row" key={hint.provider}>
          {hint.spans.map((span, i) =>
            span.code
              ? <code key={i}>{span.text}</code>
              : <span key={i}>{span.text}</span>,
          )}
        </p>
      ))}
    </>
  );
}

function EmptyDetail({ count, workspace }: { count: number; workspace: string | null }) {
  const scope = emptyScope(workspace);
  return (
    <>
      {/* The detail panel's own title, at the level the panel sits at (#381).
          Every persistent region of the deck now heads itself with an h2 under
          the topbar's h1 — Usage, Accounts, Sessions, and the agent's name when
          one is selected — and this is the same slot in the empty state. The
          `Shortcuts` block below stays an h3, because it is a section inside
          this panel rather than a second panel. */}
      <h2>Detail</h2>
      {count === 0 ? (
        <div className="hint">
          {scope.lead}
          {scope.workspace !== null && <> <code>{scope.workspace}</code>{scope.tail}</>}
        </div>
      ) : (
        <div className="empty">Click an agent to see its tools.</div>
      )}
      <h3 style={{ marginTop: 4 }}>Shortcuts</h3>
      <div className="shortcuts">
        <div className="sc"><kbd>drag</kbd><span>move a node</span></div>
        {/* Two rows the keyboard needed and the list never had: Tab reaches the
            cards and Enter is what a click on one does, and Esc is the way back
            out of any control to where the letters below work again. */}
        <div className="sc"><kbd>tab</kbd><span>reach the cards</span></div>
        <div className="sc"><kbd>enter</kbd><span>select the focused card</span></div>
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
        <div className="sc"><kbd>Esc</kbd><span>deselect, release focus</span></div>
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
  // The panel and the card it was opened from are on screen together, so this
  // is the card's clock rather than a second one written out here (#374). The
  // only value that moves is a span under a second, which used to read "0s"
  // beside a card reading "437ms" for the same agent.
  const elapsedLabel = elapsed(agent.startedAt, agent.endedAt, now);

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
            {agent.prompts.slice().reverse().map((pr, i) => {
              const t = promptTime(pr.at, now);
              return (
                <div className="prompt-entry" key={i}>
                  <div className="prompt-time" title={t.title}>{t.label}</div>
                  <div className="prompt-text">{pr.text}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Tool calls <span className="section-count">{agent.tools.length}</span></h3>
        {agent.tools.length === 0 && <div className="empty">No tool calls yet.</div>}
        <div>
          {agent.tools.slice().reverse().map(t => (
            <ToolRow key={t.id} t={t} onClick={() => onOpenTool(t.id)} />
          ))}
        </div>
      </section>
    </>
  );
}

/** What a tool call's outcome is called, in the words this app already prints
 *  for one: ToolModal writes `in-flight…` where the duration goes while a call
 *  is open and tags its Response section `error` when it failed. A tool call is
 *  not a session, so this is deliberately not stateLabel's vocabulary — `err`
 *  is the word on a session card and `error` is the word on a tool, and those
 *  two surfaces already said it that way before #373 touched either. */
const TOOL_STATUS_LABEL = { inflight: "in-flight", done: "done", err: "error" } as const;

// No `now` prop any more. It only ever fed the duration, and the duration only
// ever used it on the branch it then threw away — an open call prints a
// sentinel, and a finished one carries both of its own timestamps. The row is
// not memoised, so the tick that re-renders the panel still re-renders it.
function ToolRow({ t, onClick }: { t: ToolCall; onClick: () => void }) {
  const status = t.endedAt == null ? "inflight" : t.ok === false ? "err" : "done";
  // This row is the button that opens ToolModal for this exact call, and the
  // two used to round the same milliseconds differently — "1.2s" here and
  // "1.24s" one click later (#374). The sentinel is the only thing that still
  // differs, because a list cell has no room for the word the dialog writes.
  const durLabel = toolDuration(t, "…");
  return (
    <button className="tool clickable" title={t.inputPreview || t.name} onClick={onClick}>
      <span className="name">
        {/* The dot said nothing here — an empty <span> that was not even marked
            decorative — so a failed call and a finished one both announced
            "Bash 1.24s" and differed by red against green, the one pair a
            red-green CVD cannot separate at all (#373). The dot is explicitly
            decoration now, because the stylesheet draws its ✓ and × with
            `content:` and generated content IS spoken by some readers: without
            aria-hidden the row would say the mark and then the word.
            The word leads, where the dot is, for the reason the session list
            gives — the accessible name is the contents in DOM order, so
            "error Bash 1.24s" is read in the order it is seen. */}
        <span className={`status-dot ${status}`} aria-hidden />
        <span className="vis-hidden">{TOOL_STATUS_LABEL[status]}</span>
        {t.name}
      </span>
      <span style={{ color: "var(--muted)" }}>{durLabel}</span>
    </button>
  );
}
