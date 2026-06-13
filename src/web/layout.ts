// Auto-layout helper using dagre. Pure: input nodes/edges -> positioned nodes.
//
// Each session is laid out as its own dagre subgraph and then stacked
// vertically with a fixed gap. This guarantees the per-session cluster
// boxes drawn by <SessionClusters/> never overlap, no matter how many
// sessions are live at once.
import dagre from "dagre";
import type { Node, Edge } from "reactflow";

const NODE_W = 240;
const NODE_H = 130;

// Vertical breathing room between two session subgraphs. Has to cover the
// cluster's outer padding (PAD) on both sides plus its label header
// (HEADER_H) — see SessionClusters.tsx — plus a visible gap.
const SESSION_GAP = 140;

export interface LayoutOptions {
  direction?: "LR" | "TB";
  /** Nodes the user has dragged — keep their position; don't re-layout. */
  pinned?: Map<string, { x: number; y: number }>;
  /** Real per-node sizes (measured by React Flow). Overrides defaults. */
  measured?: Map<string, { width: number; height: number }>;
}

function sessionOfNode(n: Node): string {
  const sid = (n.data as { sessionId?: string } | undefined)?.sessionId;
  return sid ?? "_default";
}

function layoutSession(
  ids: string[],
  edges: Edge[],
  direction: "LR" | "TB",
  measured: Map<string, { width: number; height: number }>,
): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    marginx: 0,
    marginy: 0,
    nodesep: 70,
    ranksep: 160,
    edgesep: 30,
  });
  const idSet = new Set(ids);
  for (const id of ids) {
    const m = measured.get(id);
    g.setNode(id, { width: m?.width ?? NODE_W, height: m?.height ?? NODE_H });
  }
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const p = g.node(id);
    if (!p) continue;
    const m = measured.get(id);
    const w = m?.width ?? NODE_W;
    const h = m?.height ?? NODE_H;
    const x = p.x - w / 2;
    const y = p.y - h / 2;
    positions.set(id, { x, y });
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  // Normalise each session to its own (0, 0) origin so vertical stacking is
  // trivial.
  if (Number.isFinite(minX) && Number.isFinite(minY)) {
    for (const [id, p] of positions) positions.set(id, { x: p.x - minX, y: p.y - minY });
  }
  const width = Number.isFinite(maxX) ? maxX - minX : 0;
  const height = Number.isFinite(maxY) ? maxY - minY : 0;
  return { positions, width, height };
}

export function autoLayout(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): Node[] {
  const direction = opts.direction ?? "LR";
  const pinned = opts.pinned ?? new Map();
  const measured = opts.measured ?? new Map();

  const sessions = new Map<string, string[]>();
  for (const n of nodes) {
    const sid = sessionOfNode(n);
    const list = sessions.get(sid);
    if (list) list.push(n.id);
    else sessions.set(sid, [n.id]);
  }

  // Lay out each session in its own dagre graph, then stack the subgraphs
  // vertically. Sessions are ordered by id so the layout is stable across
  // events.
  const sessionOrder = Array.from(sessions.keys()).sort();
  const finalPositions = new Map<string, { x: number; y: number }>();
  let cursorY = 0;
  for (const sid of sessionOrder) {
    const ids = sessions.get(sid)!;
    const { positions, height } = layoutSession(ids, edges, direction, measured);
    for (const [id, p] of positions) finalPositions.set(id, { x: p.x, y: p.y + cursorY });
    cursorY += height + SESSION_GAP;
  }

  return nodes.map(n => {
    const manual = pinned.get(n.id);
    if (manual) return { ...n, position: manual };
    const p = finalPositions.get(n.id);
    if (!p) return n;
    return { ...n, position: p };
  });
}
