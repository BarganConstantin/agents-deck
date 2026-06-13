import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { sessionHue } from "../reducer";
import type { AgentNodeData, ToolCall } from "../types";

function elapsed(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${String(rs).padStart(2, "0")}s`;
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
        {data.model && (
          <span className="model-chip" title={data.model}>{shortModel(data.model)}</span>
        )}
      </div>

      {data.tools.length > 0 && <ToolRateSpark tools={data.tools} now={now} />}

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

/** Sparkline of tool starts per bucket over the last 60s. Most-recent
 *  bucket lives on the right and is highlighted while it's the active one. */
function ToolRateSpark({ tools, now }: { tools: ToolCall[]; now: number }) {
  const WINDOW_MS = 60_000;
  const BUCKETS = 24;
  const BUCKET_MS = WINDOW_MS / BUCKETS;
  const counts: number[] = new Array(BUCKETS).fill(0);
  let total = 0;
  for (const t of tools) {
    const age = now - t.startedAt;
    if (age < 0 || age >= WINDOW_MS) continue;
    const idx = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
    if (idx >= 0 && idx < BUCKETS) {
      counts[idx] += 1;
      total += 1;
    }
  }
  const max = Math.max(1, ...counts);
  const W = 132;
  const H = 14;
  const barW = W / BUCKETS;
  const peakRate = max / (BUCKET_MS / 1000);
  return (
    <div className="tool-spark-row" title={`${total} tool calls in last 60s · peak ${peakRate.toFixed(1)}/s`}>
      <svg className="tool-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {counts.map((c, i) => {
          const h = c === 0 ? 1.5 : Math.max(1.5, (c / max) * H);
          const isLatest = i === BUCKETS - 1 && c > 0;
          const isActive = c > 0;
          const cls = `tool-spark-bar${isActive ? " active" : ""}${isLatest ? " latest" : ""}`;
          return (
            <rect
              key={i}
              x={i * barW + 0.4}
              y={H - h}
              width={Math.max(0.5, barW - 1)}
              height={h}
              rx={0.8}
              className={cls}
            />
          );
        })}
      </svg>
      <span className="tool-spark-label">60s</span>
    </div>
  );
}

/** Render "claude-opus-4-7-20250101" → "Opus 4.7", "claude-haiku-4-5" → "Haiku 4.5".
 *  Falls back to the raw id if the shape is unfamiliar so we never hide info. */
export function shortModel(id: string): string {
  const m = id.match(/^claude[-_](opus|sonnet|haiku|fable)[-_](\d+(?:[-_.]\d+)*)/i);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const version = m[2].replace(/[-_]/g, ".");
  return `${family} ${version}`;
}
