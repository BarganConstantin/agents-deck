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

// Chrome drawn around a session beyond its cards: outer padding on both sides,
// the label header, and the label tab that sits above the box's top edge
// (PAD 18, HEADER_H 26, LABEL_LIFT 12 in SessionClusters.tsx).
const SESSION_CHROME = 18 * 2 + 26 + 12;

// Clear space wanted between one session's box and the next one's label tab.
// Measured as what the eye sees, not as the distance between card origins —
// the chrome is added on top, so changing this changes the visible gap by the
// same amount.
const SESSION_VISIBLE_GAP = 72;
const SESSION_GAP = SESSION_CHROME + SESSION_VISIBLE_GAP;

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
  // Assign sessions to columns first, then size each column to what actually
  // landed in it. Sizing every column to the widest session in the graph made
  // one wide session set the pitch for all of them, so two columns never fit
  // and everything stacked into one very tall strip that fit-to-view then
  // shrank to nothing.
  const gap = columnGap(measured);
  const overflowAt = opts.availableHeight && opts.availableHeight > 0
    ? opts.availableHeight
    : Number.POSITIVE_INFINITY;

  const assign = (maxColumns: number) => {
    const cols: Array<Array<typeof laid[number]>> = [[]];
    let cursorY = 0;
    for (const item of laid) {
      // Wrap only when something is already in this column — a session taller
      // than the screen has to start somewhere, and moving it to a fresh
      // column would leave the previous one short and the next still over.
      if (cols.length < maxColumns && cursorY > 0 && cursorY + item.height > overflowAt) {
        cols.push([]);
        cursorY = 0;
      }
      cols[cols.length - 1].push(item);
      cursorY += item.height + SESSION_GAP;
    }
    return cols;
  };

  const widthOf = (col: Array<typeof laid[number]>) =>
    col.reduce((w, s) => Math.max(w, s.width), 0) + TOOL_LANE_W;

  // Try the wider arrangement; fall back to one column when the real widths
  // don't fit rather than letting columns run off the canvas.
  let columns = assign(opts.availableWidth ? MAX_COLUMNS : 1);
  if (columns.length > 1) {
    const total = columns.reduce((w, c) => w + widthOf(c), 0) + gap * (columns.length - 1);
    if (total > (opts.availableWidth ?? 0)) columns = assign(1);
  }

  const finalPositions = new Map<string, { x: number; y: number }>();
  let offsetX = 0;
  for (const col of columns) {
    let cursorY = 0;
    for (const { positions, height } of col) {
      for (const [id, p] of positions) finalPositions.set(id, { x: p.x + offsetX, y: p.y + cursorY });
      cursorY += height + SESSION_GAP;
    }
    offsetX += widthOf(col) + gap;
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
  // Two cards in DIFFERENT sessions need more than card clearance: each is
  // drawn inside a cluster box that extends past it — padding on every side,
  // a header strip, and a label tab above that. Cards 30px apart look fine and
  // their boxes still cross, which is what "one on another" actually was.
  const CROSS_SESSION_Y = SESSION_CHROME + SESSION_VISIBLE_GAP;
  const CROSS_SESSION_X = 18 * 2 + MARGIN;

  const sizeOf = (id: string) => {
    const m = measured.get(id);
    return { w: m?.width ?? NODE_W, h: m?.height ?? NODE_H };
  };

  // Stable order: by y, then x, then id. Same input always yields the same
  // result, so a re-render cannot make nodes drift.
  const sessionOf = new Map(nodes.map(n => [n.id, sessionOfNode(n)]));

  const placed: Array<{ x: number; y: number; w: number; h: number; sid: string }> = [];
  const ordered = nodes
    .map(n => ({ id: n.id, pos: pinned.get(n.id) ?? positions.get(n.id) }))
    .filter((n): n is { id: string; pos: { x: number; y: number } } => n.pos != null)
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.id.localeCompare(b.id));

  const moved: string[] = [];
  for (const { id, pos } of ordered) {
    const { w, h } = sizeOf(id);
    const sid = sessionOf.get(id) ?? "_default";
    // A dragged node is an obstacle for everything else but is never itself
    // relocated.
    if (pinned.has(id)) { placed.push({ x: pos.x, y: pos.y, w, h, sid }); continue; }

    let y = pos.y;
    // Re-check from the start after each shift: sliding clear of one node can
    // push into another that was already checked.
    for (let guard = 0; guard < placed.length + 1; guard++) {
      const clash = placed.find(r => {
        const mx = r.sid === sid ? MARGIN : CROSS_SESSION_X;
        const my = r.sid === sid ? MARGIN : CROSS_SESSION_Y;
        return pos.x < r.x + r.w + mx && r.x < pos.x + w + mx &&
               y     < r.y + r.h + my && r.y < y     + h + my;
      });
      if (!clash) break;
      y = clash.y + clash.h + (clash.sid === sid ? MARGIN : CROSS_SESSION_Y);
    }
    if (y !== pos.y) { positions.set(id, { x: pos.x, y }); moved.push(id); }
    placed.push({ x: pos.x, y, w, h, sid });
  }
  return moved;
}


/**
 * Drop newly-arrived sessions into the gaps left by ones that finished.
 *
 * Sessions are pruned as they complete, which punches holes in a column while
 * new work keeps being appended below the last thing placed. Left alone the
 * canvas grows downward forever with empty bands through the middle, and the
 * fit zoom shrinks to cover space that holds nothing.
 *
 * A session is moved as a whole — its cards keep their arrangement relative to
 * each other, only the block moves — and it is only ever moved into a gap that
 * fits it outright. Anything that does not fit stays where the layout put it,
 * below everything else.
 *
 * Mutates `positions`; returns the session ids it relocated.
 */
export function fillGapsWithNewSessions(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  newIds: Set<string>,
): string[] {
  const sizeOf = (id: string) => {
    const m = measured.get(id);
    return { w: m?.width ?? NODE_W, h: m?.height ?? NODE_H };
  };
  const posOf = (id: string) => pinned.get(id) ?? positions.get(id);

  // Group the arrivals, and keep anything already placed as an obstacle.
  const arriving = new Map<string, Node[]>();
  const settled: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const n of nodes) {
    const p = posOf(n.id);
    if (!p) continue;
    const { w, h } = sizeOf(n.id);
    if (newIds.has(n.id) && !pinned.has(n.id)) {
      const sid = sessionOfNode(n);
      (arriving.get(sid) ?? arriving.set(sid, []).get(sid)!).push(n);
    } else {
      settled.push({ x: p.x, y: p.y, w, h });
    }
  }
  if (arriving.size === 0) return [];

  // Session boxes are what must not touch, so obstacles are inflated by the
  // chrome and the gap the layout would have left between two sessions.
  const PADDING = SESSION_CHROME + SESSION_VISIBLE_GAP;
  const clashes = (x: number, y: number, w: number, h: number) =>
    settled.some(r =>
      x < r.x + r.w + SESSION_CHROME && r.x < x + w + SESSION_CHROME &&
      y < r.y + r.h + PADDING        && r.y < y + h + PADDING);

  const moved: string[] = [];
  // Oldest session first, so arrival order still reads top-to-bottom among
  // the ones that land in gaps.
  for (const sid of [...arriving.keys()].sort()) {
    const members = arriving.get(sid)!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w, h } = sizeOf(n.id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
    }
    const w = maxX - minX, h = maxY - minY;

    // Candidate tops: the very top of a column, and just under everything
    // already there. Any gap big enough starts at one of those edges, so
    // there is nothing to gain from stepping pixel by pixel.
    const columns = [...new Set(settled.map(r => Math.round(r.x)))].sort((a, b) => a - b);
    const xs = columns.length ? columns : [minX];
    const ys = [0, ...settled.map(r => r.y + r.h + PADDING)].sort((a, b) => a - b);

    let target: { x: number; y: number } | null = null;
    outer: for (const x of xs) {
      for (const y of ys) {
        if (y >= minY) break;               // not a gap — that is where it already is
        if (!clashes(x, y, w, h)) { target = { x, y }; break outer; }
      }
    }

    if (target) {
      const dx = target.x - minX, dy = target.y - minY;
      for (const n of members) {
        const p = posOf(n.id)!;
        positions.set(n.id, { x: p.x + dx, y: p.y + dy });
      }
      moved.push(sid);
    }
    // Placed or not, it is an obstacle for the next arrival.
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w: nw, h: nh } = sizeOf(n.id);
      settled.push({ x: p.x, y: p.y, w: nw, h: nh });
    }
  }
  return moved;
}


/**
 * Make room for a session that just got bigger by pushing its neighbours aside.
 *
 * Eight subagents spawning at once is the case this exists for. The session's
 * cards fan out, its cluster box grows in every direction, and it swallows
 * whatever was next to it. `separateOverlaps` will clear that, but only by
 * sliding the covered session straight down until it is past the obstacle —
 * which throws a session that was sitting perfectly well half a screen away
 * because something beside it grew by 60px.
 *
 * This displaces by the smallest amount that resolves the overlap instead. For
 * each overlapping pair it finds the shallower axis of penetration and pushes
 * along that one, splitting the push between the two sessions by mass. The
 * session that grew is heavy, so it keeps its ground and its neighbours give
 * way; a session holding a node the user dragged is immovable, so the push
 * routes around it rather than undoing their placement.
 *
 * Whole sessions move, never individual cards — a session's internal
 * arrangement is what makes it readable, and shoving one card out of a cluster
 * to resolve a collision destroys more than the collision did.
 *
 * `prevSessionSize` is the caller's memory of how big each session was last
 * time; it is read to decide what grew and written back before returning. The
 * first call only records, so nothing jumps on load.
 *
 * Mutates `positions`. Returns the session ids it moved — empty when nothing
 * grew, which is almost every call.
 */
export function bubblePush(
  nodes: Node[],
  positions: Map<string, { x: number; y: number }>,
  pinned: Map<string, { x: number; y: number }>,
  measured: Map<string, { width: number; height: number }>,
  prevSessionSize: Map<string, { w: number; h: number }>,
  /**
   * Record the sizes and move nothing.
   *
   * Cards are measured as they mount, so during the first moment of a page
   * load a session's box grows every frame — from one measured card, to three,
   * to all of them. That is measurement catching up, not a session fanning
   * out, and pushing on it rearranges a board the user asked to have preserved
   * across refresh.
   */
  recordOnly = false,
): string[] {
  // Clearance between two session boxes — the same numbers separateOverlaps
  // uses, so the two agree on what "overlapping" means.
  // Relaxation approaches the constraint from inside and stops a hair short of
  // it, so it solves for a fraction more clearance than is actually required
  // and the converged result clears the real gap outright.
  const SOLVE_SLACK = 1;
  const GAP_X = 18 * 2 + 24 + SOLVE_SLACK;
  const GAP_Y = SESSION_CHROME + SESSION_VISIBLE_GAP + SOLVE_SLACK;

  // A session has to gain real size to count. Sub-pixel measurement noise and
  // a card gaining a digit are not worth moving the canvas for.
  const GROWTH_EPS = 8;

  // Resolving on the shallower axis alone would push sideways as readily as
  // down, and sessions are packed into columns — a sideways push breaks the
  // column, a downward one only stretches it. So horizontal penetration has to
  // be clearly the cheaper way out before it wins.
  const X_BIAS = 1.75;

  // Jacobi relaxation: collect every pair's push, then apply once. Applying
  // each pair as it is found makes the result depend on pair order and lets
  // three mutually-overlapping sessions oscillate.
  // Convergence is geometric — each pass removes DAMPING of what is left — so
  // the iteration count is about the worst mutually-overlapping case, not the
  // common one, and at a dozen sessions the whole thing is a few thousand
  // comparisons.
  const ITERATIONS = 200;
  const DAMPING = 0.7;
  const SETTLED = 0.01;     // px of total movement below which we stop

  const sizeOf = (id: string) => {
    const m = measured.get(id);
    return { w: m?.width ?? NODE_W, h: m?.height ?? NODE_H };
  };
  const posOf = (id: string) => pinned.get(id) ?? positions.get(id);

  interface Box {
    sid: string;
    members: string[];
    x: number; y: number; w: number; h: number;
    anchored: boolean;      // holds a node the user dragged — never moves
    mass: number;
  }

  // ── build one box per session ────────────────────────────────────────────
  const bySession = new Map<string, Node[]>();
  for (const n of nodes) {
    if (!posOf(n.id)) continue;
    const sid = sessionOfNode(n);
    const list = bySession.get(sid);
    if (list) list.push(n); else bySession.set(sid, [n]);
  }

  const boxes: Box[] = [];
  const grew = new Set<string>();
  const seen = new Set<string>();

  // Sorted so the relaxation is deterministic: same input, same output.
  for (const sid of [...bySession.keys()].sort()) {
    const members = bySession.get(sid)!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let anchored = false;
    for (const n of members) {
      const p = posOf(n.id)!;
      const { w, h } = sizeOf(n.id);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      if (pinned.has(n.id)) anchored = true;
    }
    const w = maxX - minX, h = maxY - minY;
    seen.add(sid);

    const before = prevSessionSize.get(sid);
    // Unknown sessions are recorded, not treated as growth: on first load every
    // session would qualify and the whole canvas would shove itself apart.
    if (before && (w > before.w + GROWTH_EPS || h > before.h + GROWTH_EPS)) grew.add(sid);
    prevSessionSize.set(sid, { w, h });

    boxes.push({ sid, members: members.map(n => n.id), x: minX, y: minY, w, h, anchored, mass: 1 });
  }
  for (const sid of [...prevSessionSize.keys()]) if (!seen.has(sid)) prevSessionSize.delete(sid);

  if (recordOnly || grew.size === 0) return [];

  // The session that grew holds its ground; everything else yields to it.
  for (const b of boxes) if (grew.has(b.sid)) b.mass = 8;

  // ── relax ────────────────────────────────────────────────────────────────
  const startX = new Map(boxes.map(b => [b.sid, b.x]));
  const startY = new Map(boxes.map(b => [b.sid, b.y]));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const dx = new Map<string, number>();
    const dy = new Map<string, number>();
    let total = 0;

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.anchored && b.anchored) continue;

        const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        const overlapX = (a.w + b.w) / 2 + GAP_X - Math.abs(acx - bcx);
        const overlapY = (a.h + b.h) / 2 + GAP_Y - Math.abs(acy - bcy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // Everything above and left of the origin is off the canvas, so a box
        // already against it cannot absorb a push that heads further out.
        const freeX = (box: Box, dir: number) => !box.anchored && !(dir < 0 && box.x <= 0);
        const freeY = (box: Box, dir: number) => !box.anchored && !(dir < 0 && box.y <= 0);

        /**
         * Which way to separate on one axis.
         *
         * Normally: apart, along the line between the centres. When the centres
         * sit on top of each other there is no such line, and the id decides so
         * the result is stable rather than left to floating-point noise — but
         * then the choice is arbitrary, so if it points somewhere neither box
         * can go, the opposite is just as valid and is tried instead. Without
         * that, a session against the top-left corner whose only neighbour is
         * pinned reports itself wedged while a clear direction was available.
         */
        const pick = (ca: number, cb: number, free: (box: Box, dir: number) => boolean) => {
          const tied = ca === cb;
          const first = tied ? (a.sid < b.sid ? -1 : 1) : Math.sign(ca - cb);
          if (free(a, first) || free(b, -first)) return first;
          if (tied && (free(a, -first) || free(b, first))) return -first;
          return 0;
        };

        const dirX = pick(acx, bcx, freeX);
        const dirY = pick(acy, bcy, freeY);
        const canX = dirX !== 0, canY = dirY !== 0;
        if (!canX && !canY) continue;   // genuinely wedged; nothing to be done

        // Prefer the shallower axis, but only among the ones that can actually
        // take the push. Without this a session against the top edge whose only
        // neighbour is pinned resolves nowhere: the cheap axis is blocked, the
        // open one is never tried, and the two just stay on top of each other.
        const useX = canX && (!canY || overlapX * X_BIAS < overlapY);

        const [dir, overlap, delta, free] = useX
          ? [dirX, overlapX, dx, freeX] as const
          : [dirY, overlapY, dy, freeY] as const;

        // Share by mass, but only across the boxes that can move on this axis —
        // a partner that is pinned or against the edge takes none of it, and
        // its share goes to the other one rather than being lost.
        const aFree = free(a, dir), bFree = free(b, -dir);
        const ma = a.mass, mb = b.mass;
        const shareA = aFree ? (bFree ? mb / (ma + mb) : 1) : 0;
        const shareB = bFree ? (aFree ? ma / (ma + mb) : 1) : 0;

        const push = overlap * DAMPING;
        delta.set(a.sid, (delta.get(a.sid) ?? 0) + dir * push * shareA);
        delta.set(b.sid, (delta.get(b.sid) ?? 0) - dir * push * shareB);
        total += push;
      }
    }

    for (const b of boxes) {
      if (b.anchored) continue;
      // A session pushed off the top-left corner is not "out of the way", it
      // is gone. freeX/freeY above keep the solver from relying on a push the
      // clamp would have swallowed.
      b.x = Math.max(0, b.x + (dx.get(b.sid) ?? 0));
      b.y = Math.max(0, b.y + (dy.get(b.sid) ?? 0));
    }
    if (total < SETTLED) break;
  }

  // ── write back ───────────────────────────────────────────────────────────
  const moved: string[] = [];
  for (const b of boxes) {
    const shiftX = b.x - startX.get(b.sid)!;
    const shiftY = b.y - startY.get(b.sid)!;
    if (Math.abs(shiftX) < 1 && Math.abs(shiftY) < 1) continue;
    for (const id of b.members) {
      if (pinned.has(id)) continue;
      const p = positions.get(id);
      if (!p) continue;
      positions.set(id, { x: p.x + shiftX, y: p.y + shiftY });
    }
    moved.push(b.sid);
  }
  return moved;
}
