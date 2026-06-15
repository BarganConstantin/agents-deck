// Pure visibility predicate shared by snapshotToFlow, ToolBursts, and
// TimelineStrip. Kept out of App.tsx so it can be unit-tested without
// pulling in React Flow / the DOM.
import type { AgentNodeData } from "./types";
import type { GraphState } from "./reducer";

export const EXIT_ANIM_MS = 600;

/** Single source of truth for "is this agent allowed on the canvas right
 *  now". Used by snapshotToFlow (drives ReactFlow nodes), ToolBursts (drives
 *  the burst overlay), and TimelineStrip (drives the bottom strip dots). */
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
