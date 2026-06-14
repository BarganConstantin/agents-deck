// Floating activity strip at the bottom of the canvas. Renders every
// tool call from the last WINDOW_MS as a category-colored dot positioned
// on a horizontal time axis. Clicking a dot selects its owning agent
// and opens the tool detail modal — turning time itself into a
// navigable surface for "what happened a minute ago".
import React, { useMemo } from "react";
import type { AgentNodeData } from "../types";

const WINDOW_MS = 120_000; // 2 minutes
const MAX_DOTS = 400;

type Category = "file" | "shell" | "web" | "agent" | "task" | "plan" | "mcp" | "other";
const CAT: Record<string, Category> = {
  Read: "file", Write: "file", Edit: "file", MultiEdit: "file",
  Glob: "file", Grep: "file", LS: "file", NotebookEdit: "file",
  Bash: "shell", PowerShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  TodoWrite: "task", TaskCreate: "task", TaskUpdate: "task",
  TaskList: "task", TaskGet: "task", TaskOutput: "task", TaskStop: "task",
  EnterPlanMode: "plan", ExitPlanMode: "plan", AskUserQuestion: "plan",
  Skill: "plan", Workflow: "plan",
};
function categoryFor(name: string): Category {
  if (name.startsWith("mcp__")) return "mcp";
  return CAT[name] ?? "other";
}

interface Dot {
  agentId: string;
  toolId: string;
  name: string;
  category: Category;
  startedAt: number;
  endedAt?: number;
  inflight: boolean;
  errored: boolean;
}

function collectDots(agents: Map<string, AgentNodeData>, earliest: number): Dot[] {
  const out: Dot[] = [];
  for (const a of agents.values()) {
    for (const t of a.tools) {
      if (t.startedAt < earliest) continue;
      out.push({
        agentId: a.id,
        toolId: t.id,
        name: t.name,
        category: categoryFor(t.name),
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        inflight: t.endedAt == null,
        errored: t.ok === false,
      });
    }
  }
  out.sort((x, y) => x.startedAt - y.startedAt);
  // Keep at most MAX_DOTS — newest wins when over budget.
  return out.length > MAX_DOTS ? out.slice(out.length - MAX_DOTS) : out;
}

interface Props {
  agents: Map<string, AgentNodeData>;
  now: number;
  onSelect: (agentId: string) => void;
  onOpenTool: (toolId: string) => void;
  onClose: () => void;
}

export default function TimelineStrip({ agents, now, onSelect, onOpenTool, onClose }: Props) {
  const earliest = now - WINDOW_MS;
  const dots = useMemo(() => collectDots(agents, earliest), [agents, earliest]);
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const d of dots) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, [dots]);

  return (
    <div className="timeline-strip" role="region" aria-label="Recent tool activity">
      <div className="ts-header">
        <span className="ts-title">Last 2 min</span>
        <span className="ts-total">{dots.length} tool call{dots.length === 1 ? "" : "s"}</span>
        <div className="ts-legend">
          {Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => (
              <span key={c} className={`ts-legend-item cat-${c}`} title={`${n} ${c}`}>
                <span className="ts-legend-dot" />
                {n}
              </span>
            ))}
        </div>
        <button className="btn icon-btn ts-close" onClick={onClose} title="Hide timeline" aria-label="Hide timeline">×</button>
      </div>
      <div className="ts-track" aria-hidden>
        {/* Time axis labels */}
        {[2, 1.5, 1, 0.5, 0].map(min => (
          <span key={min} className="ts-tick" style={{ left: `${((2 - min) / 2) * 100}%` }}>
            {min === 0 ? "now" : `${min}m`}
          </span>
        ))}
        {/* Vertical "now" line */}
        <span className="ts-now-line" />
        {dots.map(d => {
          const x = ((d.startedAt - earliest) / WINDOW_MS) * 100;
          const status = d.inflight ? "inflight" : d.errored ? "err" : "done";
          return (
            <button
              key={d.toolId}
              className={`ts-dot cat-${d.category} status-${status}`}
              style={{ left: `${x}%` }}
              onClick={() => { onSelect(d.agentId); onOpenTool(d.toolId); }}
              title={`${d.name} · ${new Date(d.startedAt).toLocaleTimeString()}${d.endedAt ? ` (${Math.max(0, d.endedAt - d.startedAt)}ms)` : " — running"}`}
              aria-label={`${d.name} ${status}`}
            />
          );
        })}
      </div>
    </div>
  );
}
