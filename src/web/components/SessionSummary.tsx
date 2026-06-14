// Modal that pops in when a session naturally ends (Stop / SessionEnd
// hook) and shows a recap: total cost + breakdown bar, duration, model,
// agent / tool / prompt counts, top tools used. User-dismissed sessions
// don't re-open on refresh (the dismissed list is in localStorage).
import React, { useMemo } from "react";
import { costForUsage, fmtCost } from "../pricing";
import type { GraphState } from "../reducer";
import type { AgentNodeData } from "../types";
import { shortModel } from "./AgentNode";

interface Props {
  state: GraphState;
  sessionId: string;
  onClose: () => void;
}

export default function SessionSummary({ state, sessionId, onClose }: Props) {
  const summary = useMemo(() => buildSummary(state, sessionId), [state, sessionId]);
  if (!summary) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal session-summary" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ss-title">
        <div className="modal-head">
          <div className="modal-title">
            <span className="state-pill state-done" aria-hidden>done</span>
            <span id="ss-title" className="modal-tool-name" title={summary.cwd ?? summary.sessionId}>{summary.label}</span>
            <span className="modal-tool-id">· {summary.sessionId.slice(0, 8)}</span>
          </div>
          <div className="modal-actions">
            <span className="modal-dur" title="Total wall time">{summary.durationLabel}</span>
            <button className="btn" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="modal-body">
          <section className="ss-hero">
            <div className="ss-hero-left">
              <div className="ss-cost-label">total spend</div>
              <div className="ss-cost">{fmtCost(summary.cost.total)}</div>
              {summary.modelChips.length > 0 && (
                <div className="ss-models">
                  {summary.modelChips.map(m => (
                    <span className="model-chip" key={m} title={m}>{shortModel(m)}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="ss-hero-right">
              {summary.cost.total > 0 && (
                <>
                  <SsCostBar cost={summary.cost} />
                  <div className="ss-cost-legend">
                    <span className="ssl ssl-in">input <b>{fmtCost(summary.cost.input)}</b></span>
                    <span className="ssl ssl-out">output <b>{fmtCost(summary.cost.output)}</b></span>
                    <span className="ssl ssl-cr">cache r <b>{fmtCost(summary.cost.cacheRead)}</b></span>
                    <span className="ssl ssl-cw">cache w <b>{fmtCost(summary.cost.cacheWrite)}</b></span>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="ss-stats">
            <Stat label="agents" value={summary.agentCount} />
            <Stat label="subagents" value={summary.subagentCount} />
            <Stat label="tool calls" value={summary.toolCount} />
            <Stat label="prompts" value={summary.promptCount} />
            <Stat label="tokens" value={summary.tokensSum.toLocaleString()} />
            {summary.errCount > 0 && <Stat label="errors" value={summary.errCount} tone="err" />}
          </section>

          {summary.topTools.length > 0 && (
            <section className="modal-section">
              <h4>Most-used tools</h4>
              <div className="ss-top-tools">
                {summary.topTools.map(([name, count]) => (
                  <div className="ss-tt" key={name}>
                    <span className="ss-tt-name">{name}</span>
                    <span className="ss-tt-bar"><span className="ss-tt-bar-fill" style={{ width: `${(count / summary.topTools[0][1]) * 100}%` }} /></span>
                    <span className="ss-tt-count">{count}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {summary.firstPrompt && (
            <section className="modal-section">
              <h4>Opening prompt</h4>
              <div className="ss-prompt">{summary.firstPrompt}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "err" }) {
  return (
    <div className={`ss-stat${tone ? ` tone-${tone}` : ""}`}>
      <div className="ss-stat-value">{value}</div>
      <div className="ss-stat-label">{label}</div>
    </div>
  );
}

function SsCostBar({ cost }: { cost: ReturnType<typeof costForUsage> }) {
  const total = cost.total;
  if (total <= 0) return null;
  const seg = (val: number, cls: string, label: string) => {
    if (val <= 0) return null;
    const pct = (val / total) * 100;
    return <span key={cls} className={`cb-seg ${cls}`} style={{ width: `${pct}%` }} title={`${label}: ${fmtCost(val)} (${pct.toFixed(0)}%)`} />;
  };
  return (
    <div className="cost-bar cost-bar-lg" aria-label="Cost breakdown">
      {seg(cost.input, "cb-input", "input")}
      {seg(cost.output, "cb-output", "output")}
      {seg(cost.cacheRead, "cb-cache-r", "cache read")}
      {seg(cost.cacheWrite, "cb-cache-w", "cache write")}
    </div>
  );
}

interface Summary {
  sessionId: string;
  label: string;
  cwd?: string;
  durationLabel: string;
  cost: ReturnType<typeof costForUsage>;
  modelChips: string[];
  agentCount: number;
  subagentCount: number;
  toolCount: number;
  promptCount: number;
  tokensSum: number;
  errCount: number;
  topTools: Array<[string, number]>;
  firstPrompt?: string;
}

function buildSummary(state: GraphState, sessionId: string): Summary | null {
  const root = state.agents.get(sessionId);
  if (!root) return null;
  const sessionAgents: AgentNodeData[] = [];
  for (const a of state.agents.values()) if (a.sessionId === sessionId) sessionAgents.push(a);
  if (sessionAgents.length === 0) return null;

  // Aggregate cost across every agent in the session — root + subagents
  // can use different models, so sum the per-agent computations.
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const modelSet = new Set<string>();
  const toolCounts = new Map<string, number>();
  let toolCount = 0, promptCount = 0, tokensSum = 0, errCount = 0, subagentCount = 0;
  let firstPrompt: string | undefined;
  let earliestStart = Infinity;
  let latestEnd = 0;

  for (const a of sessionAgents) {
    const c = costForUsage(a.usage, a.model);
    cost.input += c.input;
    cost.output += c.output;
    cost.cacheRead += c.cacheRead;
    cost.cacheWrite += c.cacheWrite;
    cost.total += c.total;
    if (a.model) modelSet.add(a.model);
    if (a.kind === "subagent") subagentCount++;
    promptCount += a.prompts.length;
    if (!firstPrompt && a.prompts.length > 0) firstPrompt = a.prompts[0].text;
    tokensSum += a.usage.inputTokens + a.usage.outputTokens;
    toolCount += a.tools.length;
    earliestStart = Math.min(earliestStart, a.startedAt);
    latestEnd = Math.max(latestEnd, a.endedAt ?? Date.now());
    for (const t of a.tools) {
      toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1);
      if (t.ok === false) errCount++;
    }
  }

  const durationMs = Math.max(0, latestEnd - earliestStart);
  const sec = Math.floor(durationMs / 1000);
  const durationLabel = sec < 60
    ? `${sec}s`
    : sec < 3600
      ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`
      : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;

  const topTools = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return {
    sessionId,
    label: root.label || root.cwdBasename || "session",
    cwd: root.cwd,
    durationLabel,
    cost,
    modelChips: Array.from(modelSet),
    agentCount: sessionAgents.length,
    subagentCount,
    toolCount,
    promptCount,
    tokensSum,
    errCount,
    topTools,
    firstPrompt,
  };
}
