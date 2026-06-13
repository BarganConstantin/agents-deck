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
import AgentNode from "./components/AgentNode";
import ToolModal from "./components/ToolModal";
import SessionClusters from "./components/SessionClusters";
import ToolBursts from "./components/ToolBursts";
import { autoLayout } from "./layout";
import { applyEvent, initialState, sessionHue, sweepStaleTools, type GraphState } from "./reducer";
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

function snapshotToFlow(
  state: GraphState,
  now: number,
  pinned: Map<string, { x: number; y: number }>,
  query: string,
  measured: Map<string, { width: number; height: number }>,
  positions: Map<string, { x: number; y: number }>,
  layoutSig: string,
  lastLayoutSigRef: { current: string },
): { nodes: Node<AgentNodeData & { now: number; dim?: boolean }>[]; edges: Edge[] } {
  const nodes: Node<AgentNodeData & { now: number; dim?: boolean }>[] = [];
  const edges: Edge[] = [];
  const matchSet = new Set<string>();
  if (query) {
    for (const a of state.agents.values()) if (matchesQuery(a, query)) matchSet.add(a.id);
  }

  const visibleIds = new Set<string>();
  for (const a of state.agents.values()) {
    if (a.exitAt != null && now - a.exitAt > EXIT_ANIM_MS) continue;
    visibleIds.add(a.id);
  }

  for (const a of state.agents.values()) {
    if (!visibleIds.has(a.id)) continue;
    const dim = query ? !matchSet.has(a.id) : false;
    const exiting = a.exitAt != null;
    const cls = [dim ? "rf-dim" : "", exiting ? "rf-exiting" : ""].filter(Boolean).join(" ") || undefined;
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
      edges.push({
        id: `e:${a.parentId}->${a.id}`,
        source: a.parentId,
        target: a.id,
        animated: a.state === "active" && !edgeDim && !fading,
        type: "smoothstep",
        // No edge label — the target node already displays the agent name,
        // and repeating it on every edge produced overlapping chips when a
        // parent spawned several siblings of the same type.
        style: { stroke, strokeWidth: a.state === "active" ? 2 : 1.5, opacity: edgeDim || fading ? 0.2 : 1, transition: "opacity 500ms ease" },
        className: fading ? "rf-edge-exiting" : undefined,
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
  const finalNodes = nodes.map(n => {
    const p = pinned.get(n.id) ?? positions.get(n.id) ?? { x: 0, y: 0 };
    return { ...n, position: p };
  });
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openedToolId, setOpenedToolId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const queueRef = useRef<HookEnvelope[]>([]);
  const [now, setNow] = useState(Date.now());
  const pinnedRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [query, setQuery] = useState("");
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
      if (sweepStaleTools(stateRef.current, t, STALE_TOOL_MS)) rerender();
    }, 250);
    return () => clearInterval(id);
  }, [rerender]);

  // Auto-fit when agent count grows. Two-stage so we react fast to the
  // first new agent in a quiet window AND still fit again ~250ms later when
  // dagre's reflow has settled and measurements are stable.
  const lastAgentCountRef = useRef(0);
  const fitTimerRef = useRef<number | null>(null);
  const lastFitTimeRef = useRef(0);
  useEffect(() => {
    const count = stateRef.current.agents.size;
    if (count > lastAgentCountRef.current) {
      lastAgentCountRef.current = count;
      const tnow = Date.now();
      // First growth in 1.5s+ → fit immediately so existing agents stay in
      // view while dagre repositions everything for the newcomer.
      if (tnow - lastFitTimeRef.current > 1500) {
        try { rf.fitView({ padding: 0.25, duration: 400 }); } catch {}
        lastFitTimeRef.current = tnow;
      }
      // Trailing fit covers the case where the new node only gets measured
      // (and therefore properly positioned) on the next frame.
      if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
      fitTimerRef.current = window.setTimeout(() => {
        try { rf.fitView({ padding: 0.25, duration: 500 }); } catch {}
        lastFitTimeRef.current = Date.now();
      }, 250);
    } else if (count < lastAgentCountRef.current) {
      lastAgentCountRef.current = count;
    }
  });

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
      if (a.exitAt != null && now - a.exitAt > EXIT_ANIM_MS) continue;
      ids.push(a.id + (a.parentId ? `>${a.parentId}` : ""));
    }
    ids.sort();
    return `${ids.join("|")}#sv${sizeVersion}`;
  }, [stateRef.current, stateRef.current.lastSeq, now, sizeVersion]);

  const { nodes, edges } = useMemo(
    () => snapshotToFlow(
      stateRef.current, now, pinnedRef.current, query,
      measuredRef.current, positionsRef.current, layoutSig, lastLayoutSigRef,
    ),
    [stateRef.current, stateRef.current.lastSeq, now, query, layoutSig],
  );

  const selected = selectedId ? stateRef.current.agents.get(selectedId) : null;
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
    setSelectedId(null);
    rerender();
  }, [rerender]);

  const handleRelayout = useCallback(() => {
    pinnedRef.current.clear();
    positionsRef.current.clear();
    lastLayoutSigRef.current = "";
    rerender();
  }, [rerender]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.tagName === "INPUT";
      if (e.key === "Escape") {
        if (inInput) (e.target as HTMLInputElement).blur();
        else setSelectedId(null);
        return;
      }
      if (inInput) return;
      if (e.key === "/") { e.preventDefault(); searchInputRef.current?.focus(); return; }
      if (e.key === " ") { e.preventDefault(); setPaused(p => !p); }
      if (e.key === "c" || e.key === "C") handleClear();
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClear, handleRelayout]);

  const agentCount = stateRef.current.agents.size;
  const sessionCount = new Set(Array.from(stateRef.current.agents.values()).map(a => a.sessionId)).size;
  const totalTokens = useMemo(() => {
    let inT = 0, outT = 0, cacheR = 0, cacheC = 0;
    for (const a of stateRef.current.agents.values()) {
      inT += a.usage.inputTokens;
      outT += a.usage.outputTokens;
      cacheR += a.usage.cacheReadTokens;
      cacheC += a.usage.cacheCreateTokens;
    }
    return { inT, outT, cacheR, cacheC, sum: inT + outT };
  }, [stateRef.current, stateRef.current.lastSeq]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          agent-dag <span className="v">v{__APP_VERSION__}</span>
        </div>
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
          </span>
          <button className={`btn ${paused ? "warn" : ""}`} onClick={() => setPaused(p => !p)} title="Pause/resume live updates (Space)">
            {paused ? `Resume${queueRef.current.length ? ` · ${queueRef.current.length}` : ""}` : "Pause"}
          </button>
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

      <div className="canvas-wrap">
        {agentCount === 0 && <EmptyHero live={live} everConnected={everConnected} />}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.25, duration: 400 }}
          minZoom={0.2}
          maxZoom={1.6}
          panOnScroll
          nodesDraggable
          nodesConnectable={false}
          selectionOnDrag={false}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          onMove={markInteract}
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
          }}
        >
          <Background gap={28} size={1} color={cssVar("--grid-line")} />
          <SessionClusters />
          <ToolBursts agents={stateRef.current.agents} now={now} onOpenTool={setOpenedToolId} />
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
      </div>

      <aside className="detail">
        {selected
          ? <Detail agent={selected} now={now} onOpenTool={setOpenedToolId} />
          : <EmptyDetail count={agentCount} />}
      </aside>

      {openedTool && <ToolModal tool={openedTool} onClose={() => setOpenedToolId(null)} />}
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
        <div className="sc"><kbd>R</kbd><span>re-arrange</span></div>
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
}: {
  agent: AgentNodeData;
  now: number;
  onOpenTool: (toolId: string) => void;
}) {
  const elapsedSec = Math.max(0, Math.floor(((agent.endedAt ?? now) - agent.startedAt) / 1000));
  return (
    <>
      <h3>{agent.label}</h3>
      <div>
        <div className="row"><span className="k">kind</span><span className="v">{agent.kind}</span></div>
        <div className="row"><span className="k">state</span><span className="v">{agent.state}</span></div>
        <div className="row"><span className="k">elapsed</span><span className="v">{elapsedSec}s</span></div>
        <div className="row"><span className="k">tools</span><span className="v">{agent.toolCount}</span></div>
        {agent.cwd && <div className="row"><span className="k">cwd</span><span className="v" title={agent.cwd}>{agent.cwd}</span></div>}
        <div className="row"><span className="k">session</span><span className="v">{agent.sessionId.slice(0, 8)}…</span></div>
      </div>

      {(agent.usage.inputTokens + agent.usage.outputTokens) > 0 && (
        <>
          <h3>Tokens</h3>
          <div className="tokens-grid">
            <div><span className="k">in</span><b>{agent.usage.inputTokens.toLocaleString()}</b></div>
            <div><span className="k">out</span><b>{agent.usage.outputTokens.toLocaleString()}</b></div>
            <div><span className="k">cache r</span><b>{agent.usage.cacheReadTokens.toLocaleString()}</b></div>
            <div><span className="k">cache c</span><b>{agent.usage.cacheCreateTokens.toLocaleString()}</b></div>
          </div>
        </>
      )}

      {agent.prompts.length > 0 && (
        <>
          <h3>Prompts ({agent.prompts.length})</h3>
          <div className="prompts">
            {agent.prompts.map((pr, i) => (
              <div className="prompt-entry" key={i}>
                <div className="prompt-time">{new Date(pr.at).toLocaleTimeString()}</div>
                <div className="prompt-text">{pr.text}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>Tool calls ({agent.tools.length})</h3>
      {agent.tools.length === 0 && <div className="empty">No tool calls yet.</div>}
      <div>
        {agent.tools.slice().reverse().map(t => (
          <ToolRow key={t.id} t={t} now={now} onClick={() => onOpenTool(t.id)} />
        ))}
      </div>
    </>
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
