import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { sessionHue } from "../reducer";
import { costForUsage, fmtCost, fmtCostRate, ratesForModel } from "../pricing";
import { ContextDonut } from "./ContextModal";

/** Multi-line breakdown for the cost chip tooltip — shows the actual
 *  multiplication so the user can verify pricing is sane.
 *  e.g. "input  725 × $5/M     = $0.00"  */
function costBreakdownTooltip(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }, modelId: string | undefined): string {
  const rates = ratesForModel(modelId);
  if (!rates) return "no rates for this model";
  const fmtN = (n: number) => n.toLocaleString();
  const fmtR = (r: number) => `$${r}/MTok`;
  const c = costForUsage(usage, modelId);
  return [
    `model: ${modelId}`,
    `input    ${fmtN(usage.inputTokens).padStart(14)}  × ${fmtR(rates.input).padEnd(11)} = ${fmtCost(c.input)}`,
    `output   ${fmtN(usage.outputTokens).padStart(14)}  × ${fmtR(rates.output).padEnd(11)} = ${fmtCost(c.output)}`,
    `cache r  ${fmtN(usage.cacheReadTokens).padStart(14)}  × ${fmtR(rates.cacheRead).padEnd(11)} = ${fmtCost(c.cacheRead)}`,
    `cache w  ${fmtN(usage.cacheCreateTokens).padStart(14)}  × ${fmtR(rates.cacheWrite).padEnd(11)} = ${fmtCost(c.cacheWrite)}`,
    `─────────────────────────────────────────`,
    `total                                 = ${fmtCost(c.total)}`,
  ].join("\n");
}
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

export default function AgentNode({ data, selected }: NodeProps<AgentNodeData & { now: number; onOpenContext?: (sessionId: string) => void }>) {
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
  const currentContextTokens = data.context?.currentContextTokens ?? 0;
  const hasContextSignal = data.kind === "root" && currentContextTokens > 0;

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
        <div className="head-right">
          {hasContextSignal && data.onOpenContext && (
            <ContextDonut
              currentContextTokens={currentContextTokens}
              modelId={data.model}
              onClick={() => data.onOpenContext!(data.sessionId)}
            />
          )}
          <div className="time" title={`Started ${new Date(data.startedAt).toLocaleTimeString()}`}>
            {elapsed(data.startedAt, data.endedAt, now)}
          </div>
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
          <span className="tokens-meta" title={`in:${data.usage.inputTokens}  out:${data.usage.outputTokens}  cache-r:${data.usage.cacheReadTokens}  cache-c:${data.usage.cacheCreateTokens}${(data.usage.reasoningOutputTokens ?? 0) > 0 ? `  reasoning:${data.usage.reasoningOutputTokens}` : ""}`}>
            <b>{fmtTok(data.usage.inputTokens + data.usage.outputTokens)}</b> tok
          </span>
        )}
        {data.model && ratesForModel(data.model) && (() => {
          const c = costForUsage(data.usage, data.model);
          if (c.total <= 0) return null;
          const elapsedSec = Math.max(0, ((data.endedAt ?? now) - data.startedAt) / 1000);
          const rate = data.state === "active" ? fmtCostRate(c.total, elapsedSec) : null;
          const tt = costBreakdownTooltip(data.usage, data.model) + (rate ? `\nburn: ${rate}` : "");
          return (
            <span className="cost-meta" title={tt}>
              <b>{fmtCost(c.total)}</b>
              {rate && <span className="cost-rate">{rate}</span>}
            </span>
          );
        })()}
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

/** Render model ids into compact display labels:
 *    "claude-opus-4-7-20250101" → "Opus 4.7"
 *    "claude-haiku-4-5"         → "Haiku 4.5"
 *    "gpt-5.3-codex"            → "GPT-5.3 Codex"
 *    "gpt-5"                    → "GPT-5"
 *    "o3-mini"                  → "o3-mini"
 *  Falls back to the raw id if the shape is unfamiliar so we never hide info. */
export function shortModel(id: string): string {
  const claude = id.match(/^claude[-_](opus|sonnet|haiku|fable|mythos)[-_](\d+(?:[-_.]\d+)*)/i);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    const version = claude[2].replace(/[-_]/g, ".");
    return `${family} ${version}`;
  }
  const gptCodex = id.match(/^gpt[-_](\d+(?:[-_.]\d+)*)[-_]codex\b/i);
  if (gptCodex) return `GPT-${gptCodex[1].replace(/[-_]/g, ".")} Codex`;
  const gpt = id.match(/^gpt[-_](\d+(?:[-_.]\d+)*)/i);
  if (gpt) return `GPT-${gpt[1].replace(/[-_]/g, ".")}`;
  return id;
}
