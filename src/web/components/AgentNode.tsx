import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { sessionHue } from "../reducer";
import type { AgentNodeData, ToolCall } from "../types";

const MAX_CHIPS = 3;

function elapsed(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${String(rs).padStart(2, "0")}s`;
}

function chipClass(tc: ToolCall): string {
  if (tc.endedAt == null) return "tool-chip inflight";
  if (tc.ok === false) return "tool-chip err";
  return "tool-chip done";
}

export default function AgentNode({ data, selected }: NodeProps<AgentNodeData & { now: number }>) {
  const now = data.now ?? Date.now();
  const cls = [
    "agent-node",
    `state-${data.state}`,
    data.synthetic ? "synthetic" : "",
    selected ? "selected" : "",
  ].filter(Boolean).join(" ");

  const inflight = data.tools.filter(t => !t.endedAt).length;
  const recent = data.tools.slice(-MAX_CHIPS);
  const hue = sessionHue(data.sessionId);
  const accent = `hsl(${hue} 70% 60%)`;

  return (
    <div className={cls} style={{ "--accent": accent } as React.CSSProperties}>
      <span className="accent-stripe" />
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />

      <div className="head">
        <div className="title">
          <StatePill state={data.state} />
          <span className="label" title={data.cwd}>{data.label}</span>
          {data.synthetic && <span className="synth-tag" title="No SessionStart captured — synthesised">?</span>}
        </div>
        <div className="time" title={`Started ${new Date(data.startedAt).toLocaleTimeString()}`}>
          {elapsed(data.startedAt, data.endedAt, now)}
        </div>
      </div>

      <div className="sub">
        {data.kind === "root" ? "session" : "subagent"}
        {data.childCount > 0 && (
          <span className="spawn-badge" title={`${data.childCount} subagents spawned`}>→ {data.childCount}</span>
        )}
        {data.cwdBasename && data.kind === "subagent" ? ` · ${data.cwdBasename}` : ""}
      </div>

      {data.inFlightTool && (
        <div className="now-running" title={data.inFlightTool.inputPreview || data.inFlightTool.name}>
          <span className="now-dot" />
          <span className="now-label">now</span>
          <span className="now-tool">{data.inFlightTool.name}</span>
          <span className="now-time">{Math.max(0, now - data.inFlightTool.startedAt)}ms</span>
        </div>
      )}

      <div className="chips">
        {recent.length === 0 && <span className="chips-empty">no tools yet</span>}
        {recent.map(t => (
          <span key={t.id} className={chipClass(t)} title={`${t.name} · ${t.inputPreview}`}>
            {t.name}
          </span>
        ))}
        {data.tools.length > MAX_CHIPS && (
          <span className="chips-more">+{data.tools.length - MAX_CHIPS}</span>
        )}
      </div>

      <div className="meta">
        <span><b>{data.toolCount}</b> tools</span>
        {inflight > 0 && <span className="inflight-meta"><b>{inflight}</b> in-flight</span>}
        {(data.usage.inputTokens + data.usage.outputTokens) > 0 && (
          <span className="tokens-meta" title={`in:${data.usage.inputTokens}  out:${data.usage.outputTokens}  cache-r:${data.usage.cacheReadTokens}  cache-c:${data.usage.cacheCreateTokens}`}>
            <b>{fmtTok(data.usage.inputTokens + data.usage.outputTokens)}</b> tok
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}

function StatePill({ state }: { state: AgentNodeData["state"] }) {
  const label = state === "active" ? "live" : state === "done" ? "done" : "err";
  return <span className={`state-pill state-${state}`}>{label}</span>;
}

function fmtTok(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
