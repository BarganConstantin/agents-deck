// Left sidebar listing every session on the canvas. Click a row to
// fit-view to that session and select its root agent. State dot + label
// + model chip + cost + tool count gives a fast scan of what's running.
// Toggle visibility via the L key or the topbar button (see App.tsx).
import React, { useMemo } from "react";
import { costForUsage, fmtCost } from "../pricing";
import type { GraphState } from "../reducer";
import { shortModel } from "./AgentNode";

interface Row {
  sessionId: string;
  label: string;
  cwdBasename?: string;
  state: "active" | "done" | "err";
  modelId?: string;
  toolCount: number;
  cost: number;
  startedAt: number;
  lastActivity: number;
}

function buildRows(state: GraphState, now: number): Row[] {
  const rows: Row[] = [];
  for (const a of state.agents.values()) {
    if (a.kind !== "root") continue;
    let toolCount = a.tools.length;
    let cost = costForUsage(a.usage, a.model).total;
    let lastActivity = a.endedAt ?? a.startedAt;
    // Roll up subagents' tools + costs + activity into the row.
    for (const sub of state.agents.values()) {
      if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
      toolCount += sub.tools.length;
      cost += costForUsage(sub.usage, sub.model).total;
      const t = sub.endedAt ?? sub.startedAt;
      if (t > lastActivity) lastActivity = t;
    }
    rows.push({
      sessionId: a.sessionId,
      label: a.label || a.cwdBasename || "session",
      cwdBasename: a.cwdBasename,
      state: a.state,
      modelId: a.model,
      toolCount,
      cost,
      startedAt: a.startedAt,
      lastActivity,
    });
  }
  // Sort: active first (most recent activity), then done by most-recent ended.
  rows.sort((x, y) => {
    if (x.state !== y.state) {
      if (x.state === "active") return -1;
      if (y.state === "active") return 1;
    }
    return y.lastActivity - x.lastActivity;
  });
  return rows;
}

function elapsedShort(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface Props {
  state: GraphState;
  now: number;
  selectedIds: Set<string>;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

export default function SessionList({ state, now, selectedIds, onSelect, onClose }: Props) {
  const rows = useMemo(() => buildRows(state, now), [state, state.lastSeq, now]);
  const liveCount = rows.filter(r => r.state === "active").length;

  return (
    <aside className="session-list" aria-label="Sessions">
      <div className="sl-header">
        <h3>Sessions <span className="sl-count">{rows.length}</span></h3>
        {liveCount > 0 && <span className="sl-live-count">{liveCount} live</span>}
        <button className="btn icon-btn sl-close" onClick={onClose} title="Hide sidebar (L)" aria-label="Hide session list">‹</button>
      </div>
      <div className="sl-rows">
        {rows.length === 0 && <div className="sl-empty">No sessions yet.</div>}
        {rows.map(r => {
          const isSelected = selectedIds.has(r.sessionId);
          return (
            <button
              type="button"
              key={r.sessionId}
              className={`sl-row state-${r.state}${isSelected ? " selected" : ""}`}
              onClick={() => onSelect(r.sessionId)}
              title={`Focus ${r.label}`}
            >
              <span className={`sl-dot state-${r.state}`} aria-hidden />
              <div className="sl-row-body">
                <div className="sl-row-head">
                  <span className="sl-label">{r.label}</span>
                  {r.modelId && <span className="model-chip" title={r.modelId}>{shortModel(r.modelId)}</span>}
                </div>
                <div className="sl-row-meta">
                  <span title="tool calls"><b>{r.toolCount}</b> tools</span>
                  {r.cost > 0 && <span className="sl-cost" title="total spend"><b>{fmtCost(r.cost)}</b></span>}
                  <span className="sl-elapsed" title={`Started ${new Date(r.startedAt).toLocaleString()}`}>{elapsedShort(r.startedAt, r.state === "active" ? undefined : r.lastActivity, now)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
