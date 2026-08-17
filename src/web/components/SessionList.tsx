// Left sidebar listing every session on the canvas. Click a row to
// fit-view to that session and select its root agent. State dot + label
// + model chip + cost + tool count gives a fast scan of what's running.
// Toggle visibility via the L key or the topbar button (see App.tsx).
import React, { useMemo } from "react";
import { costForUsage, fmtCost } from "../pricing";
import type { GraphState } from "../reducer";
import type { WaitingBlock } from "../types";
import { shortModel, stateLabel, waitingSentence } from "./AgentNode";

interface Row {
  sessionId: string;
  label: string;
  cwdBasename?: string;
  state: "active" | "done" | "err";
  waiting?: WaitingBlock | null;
  modelId?: string;
  toolCount: number;
  cost: number;
  startedAt: number;
  lastActivity: number;
}

/** Where a row sorts, before activity is looked at. A blocked session is the
 *  only row on this list that is asking for something, so it outranks a running
 *  one — and a permission prompt outranks an idle one, because the first is a
 *  decision a session is stalled on and the second is a turn that simply ended.
 *  Waiting is not the row's `state`: an idle_prompt sits on a session that is
 *  legitimately done and still reads `done` two columns to the left. */
function rank(r: Row): number {
  if (r.waiting) return r.waiting.kind === "permission" ? 0 : 1;
  return r.state === "active" ? 2 : 3;
}

function buildRows(state: GraphState, now: number): Row[] {
  const rows: Row[] = [];
  for (const a of state.agents.values()) {
    if (a.kind !== "root") continue;
    // `toolCount`, not `tools.length` — the reducer keeps only a bounded
    // window of recent calls, but the counter tracks every call ever made.
    let toolCount = a.toolCount;
    let cost = costForUsage(a.usage, a.model).total;
    let lastActivity = a.endedAt ?? a.startedAt;
    // Roll up subagents' tools + costs + activity into the row.
    for (const sub of state.agents.values()) {
      if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
      toolCount += sub.toolCount;
      cost += costForUsage(sub.usage, sub.model).total;
      const t = sub.endedAt ?? sub.startedAt;
      if (t > lastActivity) lastActivity = t;
    }
    rows.push({
      sessionId: a.sessionId,
      label: a.label || a.cwdBasename || "session",
      cwdBasename: a.cwdBasename,
      state: a.state,
      waiting: a.waiting,
      modelId: a.model,
      toolCount,
      cost,
      startedAt: a.startedAt,
      lastActivity,
    });
  }
  // Sort: blocked first, then active, then done by most-recent ended. Among the
  // blocked rows the LONGEST-blocked comes first — the opposite of the
  // most-recent ordering everything below uses, because on this list the number
  // that decides whether you go look is how long the session has been stuck.
  rows.sort((x, y) => {
    const rx = rank(x), ry = rank(y);
    if (rx !== ry) return rx - ry;
    if (x.waiting && y.waiting) return x.waiting.since - y.waiting.since;
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
  // Permission only, like the topbar chip and the tab strip. An idle prompt is
  // a turn that ended, not a session that is stuck: it keeps its row and its
  // place at the top of the sort, but it is not what this number is counting.
  const waitingCount = rows.filter(r => r.waiting?.kind === "permission").length;

  return (
    // Named for the topbar toggle's aria-controls — see UsagePanel.
    <aside className="session-list" id="session-list" aria-label="Sessions">
      <div className="sl-header">
        <h3>Sessions <span className="sl-count">{rows.length}</span></h3>
        {/* Beside the live count, not instead of it: the two answer different
            questions, and a session can be both (a permission prompt lands
            mid-turn). Codex sessions are counted in neither — they emit no
            notification, so their absence from this number is the absence of a
            signal rather than a claim that none of them is blocked. */}
        {waitingCount > 0 && <span className="sl-waiting-count">{waitingCount} waiting</span>}
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
              {/* The dot stays hidden and the word beside it is new (#373).
                  A row's accessible name is its contents, so this joins it in
                  DOM order — "live vcrm-core Opus 5 …" — and the state is heard
                  exactly where it is seen, which is what 1.3.1 asks of a
                  relationship carried by position. Before this the row said
                  "vcrm-core Opus 5 9 tools $3.66 waiting 19s" and the state was
                  the dot's hue alone; `waiting` was already words, and it is
                  not this fact — a permission prompt lands on a session that is
                  still live, and both are true at once.
                  Hidden text rather than the two alternatives. An aria-label on
                  the row would REPLACE that whole name, so the label, model,
                  tool count, cost and clock would have to be rebuilt inside it
                  and kept in step with the markup forever — two sources for one
                  name, and the one a reader hears is the one that silently
                  stops matching. A title is not announced here at all: the row
                  already has one, and for an element with contents `title` is
                  only the fallback the name computation never reaches — it is
                  also unreachable by keyboard and by touch. */}
              <span className={`sl-dot state-${r.state}`} aria-hidden />
              <span className="vis-hidden">{stateLabel(r.state)}</span>
              <div className="sl-row-body">
                <div className="sl-row-head">
                  <span className="sl-label">{r.label}</span>
                  {r.modelId && <span className="model-chip" title={r.modelId}>{shortModel(r.modelId)}</span>}
                </div>
                <div className="sl-row-meta">
                  <span title="tool calls"><b>{r.toolCount}</b> tools</span>
                  {r.cost > 0 && <span className="sl-cost" title="total spend"><b>{fmtCost(r.cost)}</b></span>}
                  {/* How long it has been stuck, in the slot the run time had.
                      On a blocked row that is the number worth the space: the
                      session's own age says nothing about whether to go look,
                      and "waiting 6m" says all of it. The run time is still on
                      the tooltip, where it costs nothing. */}
                  {r.waiting
                    ? (
                      <span
                        className="sl-waiting"
                        title={`${waitingSentence(r.waiting)}\nBlocked since ${new Date(r.waiting.since).toLocaleTimeString()} · started ${new Date(r.startedAt).toLocaleString()}`}
                      >waiting {elapsedShort(r.waiting.since, undefined, now)}</span>
                    )
                    : (
                      <span className="sl-elapsed" title={`Started ${new Date(r.startedAt).toLocaleString()}`}>{elapsedShort(r.startedAt, r.state === "active" ? undefined : r.lastActivity, now)}</span>
                    )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
