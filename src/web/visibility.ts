// Pure visibility predicate shared by snapshotToFlow and ToolBursts.
// Kept out of App.tsx so it can be unit-tested without pulling in
// React Flow / the DOM.
import type { AgentNodeData } from "./types";
import type { GraphState } from "./reducer";

export const EXIT_ANIM_MS = 600;

/** Single source of truth for "is this agent allowed on the canvas right
 *  now". Used by snapshotToFlow (drives ReactFlow nodes) and ToolBursts
 *  (drives the burst overlay). */
export function isAgentVisible(a: AgentNodeData, now: number): boolean {
  if (a.exitAt != null && now - a.exitAt > EXIT_ANIM_MS) return false;
  if (
    a.kind === "root" && a.state === "done" && a.tools.length === 0 &&
    a.endedAt != null && (a.endedAt - a.startedAt) < 3000
  ) return false;
  return true;
}

export function computeVisibleIds(state: GraphState, now: number): Set<string> {
  const set = new Set<string>();
  for (const a of state.agents.values()) {
    if (isAgentVisible(a, now)) set.add(a.id);
  }
  return set;
}

/** Minimal rectangle, in whatever coordinate space both arguments share. */
export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Do these two boxes touch, allowing `pad` of slack on every side?
 *
 * Used to decide whether the category filter bar has canvas content under it.
 * The pad exists so the bar yields just BEFORE something reaches it: dimming at
 * the exact moment of contact reads as a glitch, dimming a few pixels early
 * reads as the bar getting out of the way.
 */
export function boxesTouch(a: Box, b: Box, pad = 0): boolean {
  return a.right + pad > b.left
    && a.left - pad < b.right
    && a.bottom + pad > b.top
    && a.top - pad < b.bottom;
}

/** Whether any box in the list touches the target. Same slack rule. */
export function anyTouches(target: Box | null, boxes: Iterable<Box>, pad = 0): boolean {
  if (!target) return false;
  for (const b of boxes) if (boxesTouch(target, b, pad)) return true;
  return false;
}
