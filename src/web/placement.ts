// "No position yet" and "at {0, 0}" are different states, and the canvas used
// to store them in the same place.
//
// snapshotToFlow refuses to drop a visible node whose position has gone missing
// — a node that disappears for a frame is the worst thing this canvas does — so
// it stamps {0, 0} and renders it there. But `positions` was also the only
// record of what had been laid out, so the stamp counted as placement: the node
// left the set dagre runs for and never re-entered it. Nothing downstream asks
// where a node belongs — separateOverlaps only slides a box down until it stops
// covering another — so it stayed parked in the x=0 column at whatever y the
// overlap pass left it, unrelated to its parent or its session, looking placed
// enough that nothing retried it. The arrangement is persisted, so one stamp
// outlives the tab it happened in.
//
// The mark below is the state that was missing: real enough to render this
// frame, unreal enough that the next layout pass must redo it. The coordinate
// itself cannot carry that — every session is normalised to its own origin and
// the first column starts at zero, so {0, 0} is a position dagre legitimately
// hands out, and a canvas that read it as "unplaced" would relayout the
// top-left card forever.

/** Ids whose stored position is a placeholder, not a layout result. */
export type Provisional = Set<string>;

interface Point { x: number; y: number }

/** Just enough of a Map to answer "is there an entry for this id". */
interface Has { has(id: string): boolean }

/** True while `id` has no position, or only a placeholder one. */
export function isUnplaced(id: string, positions: Has, provisional: Provisional): boolean {
  return !positions.has(id) || provisional.has(id);
}

/**
 * Nodes the next layout pass has to place.
 *
 * A pinned node is never one of them however it got its coordinate: the user
 * dropped it there and no pass may take that back.
 */
export function needsLayout(
  id: string,
  pinned: Has,
  positions: Has,
  provisional: Provisional,
): boolean {
  return !pinned.has(id) && isUnplaced(id, positions, provisional);
}

/**
 * Render `id` at the origin for this frame, and remember it is not placed.
 *
 * Leaving the position unset would be the honest record and would also make the
 * node vanish for a frame, which is the symptom this path exists to prevent —
 * it was the "every node gone, tool bubbles still there" report, where the node
 * renderer gated on positions and the bursts did not. So the frame is served a
 * coordinate and the mark carries the truth.
 */
export function stampPlaceholder(
  id: string,
  positions: Map<string, Point>,
  provisional: Provisional,
): Point {
  const p = { x: 0, y: 0 };
  positions.set(id, p);
  provisional.add(id);
  return p;
}

/**
 * Take a coordinate a layout pass produced.
 *
 * Clearing the mark here, and only here, is also what bounds the retry: a pass
 * runs over every node it was handed, so a stamped node is reconsidered exactly
 * once and cannot hold dagre open on every render at four frames a second.
 */
export function recordPlacement(
  id: string,
  position: Point,
  positions: Map<string, Point>,
  provisional: Provisional,
): void {
  positions.set(id, position);
  provisional.delete(id);
}
