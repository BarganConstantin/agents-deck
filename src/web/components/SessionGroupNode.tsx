import React from "react";
import type { NodeProps } from "reactflow";

/** Invisible, full-size drag handle for a whole session.
 *
 *  This node is sized to the session's bounding box and rendered *behind* the
 *  agent nodes (negative zIndex). Because it's a real ReactFlow node it sits
 *  above the pan surface and fires ReactFlow's native drag events — so grabbing
 *  the empty canvas *behind* a session's nodes drags the whole session. The
 *  agent nodes paint on top, so clicking/dragging an individual node still
 *  hits that node, not this handle.
 *
 *  The size is applied as explicit pixels (not 100%): ReactFlow content-sizes
 *  a node, so a percentage-sized child would collapse to ~0 and only the
 *  top-left corner would be grabbable. */
export default function SessionGroupNode({ data }: NodeProps<{ w: number; h: number }>) {
  return (
    <div
      className="session-group-handle"
      style={{ width: data?.w ?? 0, height: data?.h ?? 0 }}
    />
  );
}
