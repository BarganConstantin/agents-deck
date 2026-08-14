import React from "react";
import { useReactFlow, useStore, useViewport, type ReactFlowState } from "reactflow";
import { sessionHue } from "../reducer";
import type { AgentNodeData } from "../types";

export interface Cluster {
  sessionId: string;
  label: string;
  x: number; y: number; w: number; h: number;
}

/** The part of a React Flow node the cluster geometry reads. */
export interface ClusterNode {
  type?: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  data?: AgentNodeData;
}

// PAD must match GROUP_PAD in App.tsx so the decorative card's rim lines up
// with the invisible draggable group-handle node sitting under it — the handle
// is the cards' box plus GROUP_PAD on every side.
//
// HEADER_H and LABEL_LIFT are this file's own and are deliberately NOT part of
// the handle: the header strip is where the clickable fit-view label lives, so
// extending the handle over it would swallow the click (see the group-node
// builder in App.tsx). layout.ts folds all three into SESSION_CHROME when it
// budgets the space between two stacked sessions.
const PAD = 18;
const HEADER_H = 26;
const LABEL_LIFT = 12; // px the label tab sits above the box's top edge

function selectClusters(s: ReactFlowState): Cluster[] {
  return clusterBounds(s.nodeInternals.values());
}

/**
 * Where each session's decorative card goes, from the agent cards on screen.
 *
 * Pure so the geometry can be pinned without a store: the store is where the
 * bug came from, not the arithmetic.
 */
export function clusterBounds(nodes: Iterable<ClusterNode>): Cluster[] {
  const bySession = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; label: string }>();
  for (const n of nodes) {
    // Only agent cards define a session's bounds. The invisible per-session
    // drag handle is a React Flow node like any other and its data carries the
    // session's own sessionId, so walking the store by data alone counted the
    // handle as a member — and the handle is already the cards' box plus PAD.
    // The card then settled one PAD larger than the handle it exists to trace:
    // an 18px rim of visible session box that no session drag responds to, and
    // half the breathing room layout.ts budgets between two stacked sessions.
    if (n.type !== "agent") continue;
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

  // When multiple sessions resolve to the same label (e.g. two Claude sessions
  // running in the same cwd both pick the basename as their label), append a
  // short session-id suffix so the user can tell them apart at a glance.
  const labelCounts = new Map<string, number>();
  for (const b of bySession.values()) {
    labelCounts.set(b.label, (labelCounts.get(b.label) ?? 0) + 1);
  }

  const out: Cluster[] = [];
  for (const [sessionId, b] of bySession) {
    const needsSuffix = (labelCounts.get(b.label) ?? 0) > 1;
    const label = needsSuffix ? `${b.label} · ${shortId(sessionId)}` : b.label;
    out.push({
      sessionId,
      label,
      x: b.minX - PAD,
      y: b.minY - PAD - HEADER_H,
      w: b.maxX - b.minX + PAD * 2,
      h: b.maxY - b.minY + PAD * 2 + HEADER_H,
    });
  }
  return out;
}

function shortId(sessionId: string): string {
  // First 4 alphanumeric chars — enough to disambiguate in practice and
  // matches the visual weight of the rest of the label.
  const m = sessionId.match(/[a-zA-Z0-9]{4}/);
  return m ? m[0] : sessionId.slice(0, 4);
}

function rootLabel(d: AgentNodeData): string | undefined {
  if (d.kind !== "root") return undefined;
  return d.label;
}

export default function SessionClusters() {
  const { x, y, zoom } = useViewport();
  const rf = useReactFlow();
  const clusters = useStore(selectClusters, shallowEqualClusters);

  if (clusters.length <= 1) return null; // no need to disambiguate one tree

  const focusSession = (sessionId: string) => {
    // Build the list of nodes belonging to this session and zoom-to-fit just
    // them. Falls back gracefully if no nodes match.
    try {
      const nodes = rf.getNodes().filter(n => {
        const d = n.data as AgentNodeData | undefined;
        return d?.sessionId === sessionId;
      });
      if (nodes.length === 0) return;
      rf.fitView({ padding: 0.3, duration: 500, nodes });
    } catch {}
  };

  return (
    <div className="session-clusters">
      {clusters.map(c => {
        const hue = sessionHue(c.sessionId);
        // Only the hue. The four colours these two elements used to carry —
        // label, rim, card border, card wash — were composed here at a
        // lightness tuned for the dark canvas, which made them the one part of
        // the palette that could not answer to data-theme; the label measured
        // 1.21:1 on white across the hue circle. The hue is the half this
        // component actually knows (it is a hash of the session id); the half
        // that depends on the theme belongs to the sheet, and is there now.
        const boxStyle: React.CSSProperties = {
          position: "absolute",
          left: c.x * zoom + x,
          top: c.y * zoom + y,
          width: c.w * zoom,
          height: c.h * zoom,
          "--session-hue": hue,
        } as React.CSSProperties;
        const labelStyle: React.CSSProperties = {
          position: "absolute",
          left: c.x * zoom + x + 16 * zoom,
          top: (c.y - LABEL_LIFT) * zoom + y,
          transform: `scale(${Math.min(1, zoom)})`,
          transformOrigin: "left top",
          "--session-hue": hue,
        } as React.CSSProperties;
        return (
          <React.Fragment key={c.sessionId}>
            <div className="cluster-card" style={boxStyle} aria-hidden />
            <button
              type="button"
              className="cluster-label"
              style={labelStyle}
              title={`Fit view to ${c.label} · drag the wrapper to move the whole session`}
              onClick={() => focusSession(c.sessionId)}
            >{c.label}</button>
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
