import React from "react";
import { useStore, useViewport, type ReactFlowState } from "reactflow";
import { sessionHue } from "../reducer";
import type { AgentNodeData } from "../types";

interface Cluster {
  sessionId: string;
  label: string;
  x: number; y: number; w: number; h: number;
}

const PAD = 28;
const HEADER_H = 30;
const LABEL_LIFT = 14; // px the label tab sits above the box's top edge

function selectClusters(s: ReactFlowState): Cluster[] {
  const bySession = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; label: string }>();
  for (const n of s.nodeInternals.values()) {
    const d = n.data as AgentNodeData;
    if (!d?.sessionId) continue;
    // Skip retiring agents — they're fading out. Including them keeps the
    // cluster card at its old size while the nodes go invisible, which looks
    // like the background "stays behind" the nodes.
    if (d.exitAt != null) continue;
    // Skip un-measured nodes (width/height still null) — falling back to a
    // default size before React Flow has measured causes one frame of wrong
    // cluster bounds.
    if (n.width == null || n.height == null) continue;
    const x1 = n.position.x;
    const y1 = n.position.y;
    const x2 = x1 + n.width;
    const y2 = y1 + n.height;
    const existing = bySession.get(d.sessionId);
    if (!existing) {
      bySession.set(d.sessionId, { minX: x1, minY: y1, maxX: x2, maxY: y2, label: rootLabel(d) ?? d.sessionId });
    } else {
      existing.minX = Math.min(existing.minX, x1);
      existing.minY = Math.min(existing.minY, y1);
      existing.maxX = Math.max(existing.maxX, x2);
      existing.maxY = Math.max(existing.maxY, y2);
      if (d.kind === "root") existing.label = rootLabel(d) ?? existing.label;
    }
  }

  const out: Cluster[] = [];
  for (const [sessionId, b] of bySession) {
    out.push({
      sessionId,
      label: b.label,
      x: b.minX - PAD,
      y: b.minY - PAD - HEADER_H,
      w: b.maxX - b.minX + PAD * 2,
      h: b.maxY - b.minY + PAD * 2 + HEADER_H,
    });
  }
  return out;
}

function rootLabel(d: AgentNodeData): string | undefined {
  if (d.kind !== "root") return undefined;
  return d.label;
}

export default function SessionClusters() {
  const { x, y, zoom } = useViewport();
  const clusters = useStore(selectClusters, shallowEqualClusters);

  if (clusters.length <= 1) return null; // no need to disambiguate one tree

  return (
    <div className="session-clusters" aria-hidden>
      {clusters.map(c => {
        const hue = sessionHue(c.sessionId);
        const boxStyle: React.CSSProperties = {
          position: "absolute",
          left: c.x * zoom + x,
          top: c.y * zoom + y,
          width: c.w * zoom,
          height: c.h * zoom,
          borderColor: `hsl(${hue} 65% 55% / 0.32)`,
          background: `hsl(${hue} 70% 50% / 0.04)`,
        };
        const labelStyle: React.CSSProperties = {
          position: "absolute",
          left: c.x * zoom + x + 16 * zoom,
          top: (c.y - LABEL_LIFT) * zoom + y,
          color: `hsl(${hue} 70% 78%)`,
          borderColor: `hsl(${hue} 65% 55% / 0.5)`,
          transform: `scale(${Math.min(1, zoom)})`,
          transformOrigin: "left top",
        };
        return (
          <React.Fragment key={c.sessionId}>
            <div className="cluster-card" style={boxStyle} />
            <div className="cluster-label" style={labelStyle}>{c.label}</div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function shallowEqualClusters(a: Cluster[], b: Cluster[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (
      x.sessionId !== y.sessionId ||
      x.label !== y.label ||
      x.x !== y.x || x.y !== y.y ||
      x.w !== y.w || x.h !== y.h
    ) return false;
  }
  return true;
}
