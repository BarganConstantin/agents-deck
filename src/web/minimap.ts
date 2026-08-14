// Pure paint rule for the minimap. Kept out of App.tsx so it can be
// unit-tested without pulling in React Flow / the DOM.
import type { AgentNodeData } from "./types";

/**
 * React Flow type of the invisible per-session drag handle.
 *
 * App registers it in `nodeTypes` and stamps it on every handle it builds, and
 * every pass that has to tell a handle from an agent card already asks this
 * one question. Re-deriving it here from the `group:<sessionId>` id prefix
 * would be a second definition of the same thing, free to drift from the
 * first — which is how the handles got into the column-gap arithmetic.
 */
export const SESSION_GROUP_TYPE = "sessionGroup";

/** Just enough of a React Flow node for the rule below to decide. */
export interface MinimapNode {
  type?: string;
  data?: Partial<AgentNodeData>;
}

/**
 * Fill colour @reactflow/minimap paints a node's rect with.
 *
 * The minimap draws EVERY node it can measure — its selector is
 * `!node.hidden && node.width && node.height`, with no notion of node type and
 * no z-index filter — so the per-session drag handles reached it exactly like
 * the cards. A handle's data is `{sessionId, w, h}`, so the state tests below
 * both fell through and it was painted the finished green: one solid block per
 * session covering its ranksep gaps and its whole burst lane, with the real,
 * correctly coloured agent rects sitting on top.
 *
 * A handle is invisible on the canvas, so it is invisible here too. Transparent
 * rather than skipped because the colour is the only lever the minimap gives —
 * and nothing outlines the rect, since `nodeStrokeColor` defaults to
 * transparent.
 */
export function minimapNodeColor(
  node: MinimapNode,
  cssVar: (name: string) => string,
): string {
  if (node.type === SESSION_GROUP_TYPE) return "transparent";
  const state = node.data?.state;
  if (state === "err") return cssVar("--err");
  if (state === "active") return cssVar("--inflight");
  return cssVar("--ok");
}
