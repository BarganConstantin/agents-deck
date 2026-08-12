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
// cluster chrome drawn around each one — outer padding on both sides, the
// label header, and the label tab that sits above the box's top edge (PAD 18,
// HEADER_H 26, LABEL_LIFT 12 in SessionClusters.tsx) — plus a visible gap.
const SESSION_CHROME = 18 * 2 + 26 + 12;
const SESSION_GAP = SESSION_CHROME + 36;

// Horizontal room between two session columns: a full card width. At 80px the
// columns read as one crowded field, with cluster boxes and their label tabs
// close enough to look joined. A whole node of clear space is where the eye
// stops trying to relate them. Measured from the widest card actually on
// screen rather than the default, so the gap holds when cards are wider.
function columnGap(measured: Map<string, { width: number; height: number }>): number {
  let widest = NODE_W;
  for (const m of measured.values()) widest = Math.max(widest, m.width);
  return widest;
}

/**
 * Width the tool-burst lane needs to the right of every agent card.
 *
 * Bursts are drawn by <ToolBursts/> as an overlay, not as React Flow nodes, so
 * dagre cannot see them and a session measured from its cards alone reports a
 * width that stops at the card's right edge. Packing columns on that number
 * puts the next column straight through this session's tool chips — which is
 * exactly what a second column made visible.
 *
 * Derived from ToolBursts: BUBBLE_OFFSET_X (60) + a primary bubble + SUB_GAP
 * (28) + a chained sub-bubble, with headroom for the long Codex labels that
 * size themselves from the label text.
 */
const TOOL_LANE_W = 420;

/**
 * Ceiling on columns. Two is enough to use a wide screen without shrinking the
 * fit-to-view zoom to the point where the cards stop being readable, which is
 * the whole reason to look at this canvas.
 */
const MAX_COLUMNS = 2;

export interface LayoutOptions {
  /**
   * Canvas height available, in flow units. A column is filled to this before
   * the next one is started; omitted or 0 keeps everything in one column.
   */
  availableHeight?: number;
  direction?: "LR" | "TB";
  /** Nodes the user has dragged — keep their position; don't re-layout. */
  pinned?: Map<string, { x: number; y: number }>;
  /** Real per-node sizes (measured by React Flow). Overrides defaults. */
  measured?: Map<string, { width: number; height: number }>;
  /**
   * Canvas width available for the graph, in flow units. Sessions are packed
   * into as many columns as fit; omitted or 0 keeps the single column.
   */
  availableWidth?: number;
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
  pinned: Map<string, { x: number; y: number }>,
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
  // A dragged node is not part of the flow — it renders wherever the user
  // dropped it. Handing it to dagre anyway makes the session reserve an empty
  // slot at a position the node has already left, so the rest of the session
  // is laid out around a phantom and the real node lands on whatever is at
  // its saved coordinate. Lay out only what still flows.
  const free = ids.filter(id => !pinned.has(id));
  const idSet = new Set(free);
  for (const id of free) {
    const m = measured.get(id);
    g.setNode(id, { width: m?.width ?? NODE_W, height: m?.height ?? NODE_H });
  }
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of free) {
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
  let width = Number.isFinite(maxX) ? maxX - minX : 0;
  let height = Number.isFinite(maxY) ? maxY - minY : 0;

  // The session's cluster box is drawn around every member, pinned ones
  // included, so the space it claims has to account for them too — otherwise
  // the next session is stacked under the flowing content and straight
  // through a node that was dragged below it.
  for (const id of ids) {
    const p = pinned.get(id);
    if (!p) continue;
    const m = measured.get(id);
    width  = Math.max(width,  p.x + (m?.width  ?? NODE_W));
    height = Math.max(height, p.y + (m?.height ?? NODE_H));
  }
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

  // Lay out each session in its own dagre graph, then pack the subgraphs into
  // columns. Sessions are ordered by id so the layout is stable across events.
  const sessionOrder = Array.from(sessions.keys()).sort();
  const laid = sessionOrder.map(sid => ({
    sid,
    ...layoutSession(sessions.get(sid)!, edges, direction, measured, pinned),
  }));

  // One column per session-width that fits the canvas. Columns are as wide as
  // the widest session so a session is never split across the boundary, which
  // wastes some room when widths vary but keeps every session readable as one
  // block — the thing the canvas exists to show.
  const widest = laid.reduce((w, s) => Math.max(w, s.width), 0);
  const columnWidth = widest + TOOL_LANE_W + columnGap(measured);
  const columnCount = (opts.availableWidth && columnWidth > 0)
    ? Math.min(MAX_COLUMNS, Math.max(1, Math.floor(opts.availableWidth / columnWidth)))
    : 1;

  // Fill a column before starting the next one, rather than balancing the two.
  // Balancing keeps the columns level but scatters consecutive sessions across
  // them; filling top-to-bottom means the canvas reads in the order sessions
  // started, and a second column only appears once the first has run past the
  // bottom of the screen.
  const overflowAt = opts.availableHeight && opts.availableHeight > 0
    ? opts.availableHeight
    : Number.POSITIVE_INFINITY;

  const finalPositions = new Map<string, { x: number; y: number }>();
  let col = 0;
  let cursorY = 0;
  for (const { positions, height } of laid) {
    // Wrap only when something is already in this column — a session taller
    // than the screen has to start somewhere, and pushing it to a fresh column
    // would just leave the previous one short and the next one still over.
    if (col < columnCount - 1 && cursorY > 0 && cursorY + height > overflowAt) {
      col++;
      cursorY = 0;
    }
    const offsetX = col * columnWidth;
    for (const [id, p] of positions) finalPositions.set(id, { x: p.x + offsetX, y: p.y + cursorY });
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


/**
 * Push apart only the nodes that overlap, leaving everything else where it is.
 *
 * The layout pass runs once per node and then never again, so an arrangement
 * survives reloads and structural changes. The cost of that is that a newly
 * placed node can land on an older one, and two sessions can drift together.
 * This is the repair: it walks the nodes in a stable order, and the first time
 * a node covers ground already taken it slides down until it is clear.
 *
 * Deliberately minimal. Re-running the full layout would fix more and move
 * everything; this fixes the specific thing that is wrong and touches nothing
 * else, which is what makes it safe to run on every structural change.
 *
 * Pinned nodes are obstacles but never move — the user put them there. Mutates
 * `positions`; returns the ids it had to move.
 */
export function separateOverlaps(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
): string[] {
  const MARGIN = 24;

  const sizeOf = (id: string) => {
    const m = measured.get(id);
    return { w: m?.width ?? NODE_W, h: m?.height ?? NODE_H };
  };

  // Stable order: by y, then x, then id. Same input always yields the same
  // result, so a re-render cannot make nodes drift.
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const ordered = nodes
    .map(n => ({ id: n.id, pos: pinned.get(n.id) ?? positions.get(n.id) }))
    .filter((n): n is { id: string; pos: { x: number; y: number } } => n.pos != null)
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));

  const moved: string[] = [];
  for (const { id, pos } of ordered) {
    const { w, h } = sizeOf(id);
    // A dragged node is an obstacle for everything else but is never itself
    // relocated.
    if (pinned.has(id)) { placed.push({ x: pos.x, y: pos.y, w, h }); continue; }

    let y = pos.y;
    // Re-check from the start after each shift: sliding clear of one node can
    // push into another that was already checked.
    for (let guard = 0; guard < placed.length + 1; guard++) {
      const clash = placed.find(r =>
        pos.x < r.x + r.w + MARGIN && r.x < pos.x + w + MARGIN &&
        y     < r.y + r.h + MARGIN && r.y < y     + h + MARGIN);
      if (!clash) break;
      y = clash.y + clash.h + MARGIN;
    }
    if (y !== pos.y) { positions.set(id, { x: pos.x, y }); moved.push(id); }
    placed.push({ x: pos.x, y, w, h });
  }
  return moved;
}
