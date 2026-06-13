// Overlay that renders a small "tool bubble" next to each agent for every
// tool call that is in-flight or recently completed. Bubbles fade out
// ~LIFETIME_MS after the tool finishes. They live on a layer above React
// Flow's nodes and follow the canvas pan/zoom via useViewport().
import React from "react";
import { useStore, useViewport, type ReactFlowState } from "reactflow";
import type { AgentNodeData, ToolCall } from "../types";

const LIFETIME_MS = 4000;
const FADE_MS = 600;
const MAX_PER_AGENT = 4;
const BUBBLE_VERT_GAP = 46;
const BUBBLE_HALF_H = 16; // half of the bubble's rendered height — used to centre on agent

const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Write: "💾",
  Edit: "✏️",
  MultiEdit: "✏️",
  Glob: "🌐",
  Grep: "🔎",
  Bash: "⚡",
  PowerShell: "⚡",
  Task: "🤖",
  Agent: "🤖",
  TodoWrite: "✅",
  WebFetch: "🌍",
  WebSearch: "🔭",
  LS: "📂",
  NotebookEdit: "📓",
};

function emojiFor(name: string): string {
  if (name.startsWith("mcp__")) return "🔌";
  return TOOL_EMOJI[name] ?? "⚙️";
}

type Status = "inflight" | "done" | "err";

function statusOf(t: ToolCall): Status {
  if (t.endedAt == null) return "inflight";
  return t.ok === false ? "err" : "done";
}

function fadeAt(t: ToolCall, now: number): number {
  if (t.endedAt == null) return 1;
  const since = now - t.endedAt;
  if (since < LIFETIME_MS) return 1;
  return Math.max(0, 1 - (since - LIFETIME_MS) / FADE_MS);
}

interface Burst {
  id: string;
  agentId: string;
  name: string;
  status: Status;
  fade: number;
  fading: boolean;
  // World-space (pre-viewport) positions.
  worldX: number;
  worldY: number;
  anchorX: number;
  anchorY: number;
}

function collectBursts(
  agents: Iterable<AgentNodeData>,
  nodeInternals: Map<string, { width: number | null; height: number | null; position: { x: number; y: number } }>,
  now: number,
): Burst[] {
  const out: Burst[] = [];
  for (const a of agents) {
    if (a.exitAt != null && now - a.exitAt > 600) continue;
    const ni = nodeInternals.get(a.id);
    if (!ni || ni.width == null || ni.height == null) continue;
    const visible = a.tools.filter(t => {
      if (t.endedAt == null) return true;
      return now - t.endedAt < LIFETIME_MS + FADE_MS;
    }).slice(-MAX_PER_AGENT);
    if (visible.length === 0) continue;
    const aW = ni.width;
    const aH = ni.height;
    const aX = ni.position.x;
    const aY = ni.position.y;
    const anchorX = aX + aW;
    const anchorY = aY + aH / 2;
    const lastIdx = visible.length - 1;
    visible.forEach((t, idx) => {
      const offsetX = 46;
      const offsetY = (idx - lastIdx / 2) * BUBBLE_VERT_GAP;
      const fade = fadeAt(t, now);
      out.push({
        id: t.id,
        agentId: a.id,
        name: t.name,
        status: statusOf(t),
        fade,
        fading: fade < 0.999,
        worldX: aX + aW + offsetX,
        worldY: aY + aH / 2 + offsetY - BUBBLE_HALF_H,
        anchorX,
        anchorY,
      });
    });
  }
  return out;
}

interface ToolBurstsProps {
  agents: Iterable<AgentNodeData>;
  now: number;
}

export default function ToolBursts({ agents, now }: ToolBurstsProps) {
  const { x, y, zoom } = useViewport();
  const nodeInternals = useStore((s: ReactFlowState) => s.nodeInternals);
  // The selector returns the same Map identity until React Flow internally
  // updates it (which happens on node moves / resizes / additions). That's
  // exactly when we want to recompute.
  const bursts = collectBursts(agents, nodeInternals as never, now);
  if (bursts.length === 0) return null;

  return (
    <div className="tool-bursts-layer" aria-hidden>
      <svg className="tool-bursts-svg">
        {bursts.map(b => {
          const sx = b.anchorX * zoom + x;
          const sy = b.anchorY * zoom + y;
          const tx = (b.worldX + 6) * zoom + x;
          const ty = (b.worldY + BUBBLE_HALF_H) * zoom + y;
          const cx = sx + (tx - sx) * 0.55;
          return (
            <path
              key={`l:${b.id}`}
              d={`M ${sx} ${sy} Q ${cx} ${sy}, ${tx} ${ty}`}
              className={`tool-conn status-${b.status}${b.fading ? " fading" : ""}`}
              opacity={b.fade}
            />
          );
        })}
      </svg>
      {bursts.map(b => {
        const px = b.worldX * zoom + x;
        const py = b.worldY * zoom + y;
        return (
          <div
            key={b.id}
            className="tool-burst-wrap"
            style={{ left: px, top: py, transform: `scale(${zoom})`, transformOrigin: "left top" }}
          >
            <div className={`tool-burst status-${b.status}${b.fading ? " fading" : ""}`}>
              <span className="tb-emoji">{emojiFor(b.name)}</span>
              <span className="tb-name">{b.name}</span>
              {b.status === "inflight" && <span className="tb-spin" />}
              {b.status === "done" && <span className="tb-mark done">✓</span>}
              {b.status === "err" && <span className="tb-mark err">×</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
