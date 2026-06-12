import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  ReactFlowProvider,
  useReactFlow,
} from "reactflow";
import AgentNode from "./components/AgentNode";
import ToolModal from "./components/ToolModal";
import SessionClusters from "./components/SessionClusters";
import { autoLayout } from "./layout";
import { applyEvent, initialState, sessionHue, type GraphState } from "./reducer";
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
): { nodes: Node<AgentNodeData & { now: number; dim?: boolean }>[]; edges: Edge[] } {
  const nodes: Node<AgentNodeData & { now: number; dim?: boolean }>[] = [];
  const edges: Edge[] = [];
  const matchSet = new Set<string>();
  if (query) {
    for (const a of state.agents.values()) if (matchesQuery(a, query)) matchSet.add(a.id);
  }

  for (const a of state.agents.values()) {
    const dim = query ? !matchSet.has(a.id) : false;
    nodes.push({
      id: a.id,
      type: "agent",
      position: { x: 0, y: 0 },
      data: { ...a, now, dim },
      className: dim ? "rf-dim" : undefined,
    });
    if (a.parentId && state.agents.has(a.parentId)) {
      const hue = sessionHue(a.sessionId);
      const stroke = a.state === "active" ? `hsl(${hue} 80% 72%)` : `hsl(${hue} 50% 55%)`;
      const edgeDim = query && (!matchSet.has(a.id) && !matchSet.has(a.parentId));
      edges.push({
        id: `e:${a.parentId}->${a.id}`,
        source: a.parentId,
        target: a.id,
        animated: a.state === "active" && !edgeDim,
        type: "smoothstep",
        label: a.label,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
        labelStyle: { fontSize: 10, fill: stroke, fontFamily: "ui-monospace, monospace", opacity: edgeDim ? 0.3 : 1 },
        labelBgStyle: { fill: "var(--bg-soft)", fillOpacity: edgeDim ? 0.4 : 0.85, stroke, strokeWidth: 0.5 },
        style: { stroke, strokeWidth: a.state === "active" ? 2 : 1.5, opacity: edgeDim ? 0.25 : 1 },
      });
    }
  }
  return { nodes: autoLayout(nodes, edges, { direction: "LR", pinned }), edges };
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
    return (window.localStorage.getItem("ccgraph.theme") as "dark" | "light") ?? "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("ccgraph.theme", theme); } catch {}
  }, [theme]);

  // SSE subscription
  useEffect(() => {
    const es = new EventSource("/events");
    es.addEventListener("open", () => setLive(true));
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

  // Tick clock so elapsed-time fields refresh smoothly.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-fit when agent count grows (debounced).
  const lastAgentCountRef = useRef(0);
  const fitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const count = stateRef.current.agents.size;
    if (count > lastAgentCountRef.current) {
      lastAgentCountRef.current = count;
      if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
      fitTimerRef.current = window.setTimeout(() => {
        try { rf.fitView({ padding: 0.25, duration: 600 }); } catch {}
      }, 400);
    } else if (count < lastAgentCountRef.current) {
      lastAgentCountRef.current = count;
    }
  });

  const { nodes, edges } = useMemo(
    () => snapshotToFlow(stateRef.current, now, pinnedRef.current, query),
    [stateRef.current, stateRef.current.lastSeq, now, query],
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
    setSelectedId(null);
    rerender();
  }, [rerender]);

  const handleRelayout = useCallback(() => {
    pinnedRef.current.clear();
    rerender();
  }, [rerender]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === " ") { e.preventDefault(); setPaused(p => !p); }
      if (e.key === "c" || e.key === "C") handleClear();
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
      if (e.key === "Escape") setSelectedId(null);
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
          ccgraph <span className="v">v0.2</span>
        </div>
        <div className="actions">
          <div className="search">
            <span className="search-icon">⌕</span>
            <input
              type="text"
              placeholder="search agent / cwd / tool…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              spellCheck={false}
            />
            {query && (
              <button className="search-clear" aria-label="Clear" onClick={() => setQuery("")}>×</button>
            )}
          </div>
          <span className="status">
            <span className={`pill ${live ? "live" : "dead"}`}>{live ? "live" : "disconnected"}</span>
            <span><span className="count">{sessionCount}</span> sessions</span>
            <span><span className="count">{agentCount}</span> agents</span>
            <span><span className="count">{stateRef.current.totalEvents}</span> events</span>
            {totalTokens.sum > 0 && (
              <span title={`in:${totalTokens.inT}  out:${totalTokens.outT}  cache-r:${totalTokens.cacheR}  cache-c:${totalTokens.cacheC}`}>
                <span className="count">{fmtTokens(totalTokens.sum)}</span> tokens
              </span>
            )}
          </span>
          <button className="btn" onClick={() => setPaused(p => !p)} title="Space">
            {paused ? `Resume${queueRef.current.length ? ` (${queueRef.current.length})` : ""}` : "Pause"}
          </button>
          <button className="btn" onClick={handleRelayout} title="R — auto-arrange">Re-layout</button>
          <button className="btn" onClick={handleClear} title="C">Clear</button>
          <button
            className="btn icon-btn"
            onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}
            title="Toggle theme (T)"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <div className="canvas-wrap">
        {agentCount === 0 && <EmptyHero />}
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
          onNodeDragStop={(_, n) => {
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
          }}
        >
          <Background gap={28} size={1} color={cssVar("--grid-line")} />
          <SessionClusters />
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

function EmptyHero() {
  return (
    <div className="empty-hero">
      <div className="orbit-stack" aria-hidden>
        <div className="core" />
        <div className="orbit r1"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r2"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r3"><span className="dot" /><span className="dot b" /></div>
      </div>
      <h2>Waiting for Claude Code</h2>
      <p>
        Run <code>claude</code> in any folder. As soon as a session sends an event,
        a node appears here and grows as subagents fork and tools are called.
      </p>
    </div>
  );
}

function EmptyDetail({ count }: { count: number }) {
  return (
    <>
      <h3>Detail</h3>
      {count === 0 ? (
        <div className="hint">
          No data yet. Start a Claude Code session anywhere on this machine —
          ccgraph is in <code>--all</code> mode and listens to every workspace.
        </div>
      ) : (
        <div className="empty">Click an agent to see its tools.</div>
      )}
      <h3 style={{ marginTop: 4 }}>Shortcuts</h3>
      <div className="row"><span className="k">drag</span><span className="v">move a node</span></div>
      <div className="row"><span className="k">space</span><span className="v">pause / resume</span></div>
      <div className="row"><span className="k">r</span><span className="v">re-arrange (clear pins)</span></div>
      <div className="row"><span className="k">c</span><span className="v">clear canvas</span></div>
      <div className="row"><span className="k">t</span><span className="v">toggle theme</span></div>
      <div className="row"><span className="k">esc</span><span className="v">deselect node</span></div>
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
