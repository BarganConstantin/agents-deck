import React from "react";
import { useReactFlow, useStore, useViewport, type ReactFlowState } from "reactflow";
import { sessionHue } from "../reducer";
import type { AgentNodeData } from "../types";

/**
 * The three fields a cluster header draws, kept apart rather than joined into
 * one string, because they are not three things of one kind.
 *
 * `label` and `shortId` are the session ADDRESS: the workspace it runs in and,
 * when two sessions share that workspace, four characters of its id. `name` is
 * a DESCRIPTION — Claude Code rewrites it as the conversation moves and two
 * sessions may hold the same one, which is exactly why it cannot take the id
 * over. The sheet draws the two address fields uppercase and the name in its
 * own case, and it can only do that if they arrive here separately.
 */
export interface ClusterHeader {
  /** Workspace basename. Always present, always drawn first. */
  label: string;
  /** The session name, truncated to NAME_COLUMNS. Absent when there is none —
   *  a Codex session, or a Claude one too young to have been named. */
  name?: string;
  /** Four characters of the session id. Present ONLY when another cluster
   *  carries the same workspace label; a name never replaces it. */
  shortId?: string;
  /** The same three fields on one line with nothing truncated — the tooltip,
   *  which is where a cut name is recovered. */
  fullLabel: string;
}

export interface Cluster extends ClusterHeader {
  sessionId: string;
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
  const bySession = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; label: string; name?: string }>();
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
      bySession.set(d.sessionId, {
        minX: x1, minY: y1, maxX: x2, maxY: y2,
        label: rootLabel(d) ?? d.sessionId,
        name: rootName(d),
      });
    } else {
      existing.minX = Math.min(existing.minX, x1);
      existing.minY = Math.min(existing.minY, y1);
      existing.maxX = Math.max(existing.maxX, x2);
      existing.maxY = Math.max(existing.maxY, y2);
      if (d.kind === "root") existing.label = rootLabel(d) ?? existing.label;
      // Same rule as the label, and for the same reason: only the session root
      // speaks for the session. A subagent carries no sessionName at all, so
      // reading one off whichever node arrived first would leave the header
      // waiting on iteration order for a field the root has had all along.
      if (d.kind === "root") existing.name = rootName(d);
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
    out.push({
      sessionId,
      ...clusterHeader(b.label, b.name, sessionId, needsSuffix),
      x: b.minX - PAD,
      y: b.minY - PAD - HEADER_H,
      w: b.maxX - b.minX + PAD * 2,
      h: b.maxY - b.minY + PAD * 2 + HEADER_H,
    });
  }
  return out;
}

/** The separator between two header fields. One glyph for all of them — see
 *  the note on clusterHeader for why the fields are told apart by case. */
export const SEP = " · ";

/**
 * The most of a session name the header draws, in monospace columns.
 *
 * Measured, not picked. The card beside it already shows the name, and shows
 * it at 11px in a 240px node whose 12/16px padding leaves 210px of text —
 * 31.7 columns of a 6.62px advance before the ellipsis on `.session-name`
 * fires.
 * A header showing MORE than the card would put the only copy of a tail in a
 * tooltip; at 32 it never does, and both surfaces cut at the same word.
 *
 * What it is worth, measured in a browser against this sheet rather than
 * estimated: the longest agentName in the transcripts on this machine is 53
 * characters, "Refactor mailbox controller request response handling", and it
 * draws a 481.3px header. Capped, the same header is 350.7px. The narrowest
 * cluster there is — one 240px card plus PAD on both sides — is 276px wide and
 * the pill starts 16px inside it, so the overhang goes from 221.3px to 90.7px.
 * layout.ts leaves a full card width, 240px, of clear canvas between two
 * session columns, so a capped header stays inside that gutter and cannot
 * reach the box next door. An uncapped one could.
 *
 * The overhang itself is not new and is not the name: the pill is
 * `white-space: nowrap` in a layer that clips nothing, so it has always run
 * past the box it labels rather than wrapping, clipping or widening it — a
 * long workspace basename alone overhangs a one-card cluster by 21.2px today.
 * What the name changes is the magnitude, and the cap is the whole answer to
 * that. It is also why the cap is not tied to the cluster width: at 276px the
 * budget would be 17 columns, shorter than every name measured here, and a cap
 * that fires every time is not a cap.
 */
export const NAME_COLUMNS = 32;

/** Code points a monospace font draws two columns wide: CJK, Hangul, kana and
 *  the fullwidth forms. Counting them as one would let a 32-character name
 *  draw 64 columns, which puts the bound above out by a factor of two. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function columns(ch: string): number {
  return WIDE.test(ch) ? 2 : 1;
}

/**
 * A name cut to NAME_COLUMNS, ellipsis included in the count.
 *
 * Walks code points rather than UTF-16 units: the names measured here are not
 * all kebab ASCII — one of them ends in U+2442 — and slicing a string in the
 * middle of a surrogate pair renders a replacement box, which looks like data
 * loss rather than truncation. Trailing separators are walked off before the
 * ellipsis so a cut never reads as a hyphen the name itself contains.
 */
export function truncateName(name: string, budget = NAME_COLUMNS): string {
  const chars = [...name];
  let total = 0;
  for (const ch of chars) total += columns(ch);
  if (total <= budget) return name;
  const kept: string[] = [];
  let used = 0;
  for (const ch of chars) {
    const w = columns(ch);
    if (used + w > budget - 1) break;
    kept.push(ch);
    used += w;
  }
  while (kept.length && /[\s\-_.:/]/.test(kept[kept.length - 1])) kept.pop();
  return `${kept.join("")}…`;
}

/**
 * The header, as three fields rather than as one string.
 *
 * Pure, and separately testable, because there are four shapes it has to draw
 * deliberately and only one of them is the common case:
 *
 *     VCRM-CORE
 *     VCRM-CORE · account-management-oauth-flow
 *     VCRM-CORE · 4EFA
 *     VCRM-CORE · account-management-oauth-flow · 4EFA
 *
 * The id keeps the condition it has always had — it appears when a second
 * cluster carries the same workspace label, and not otherwise. A name does not
 * earn it and does not excuse it: two sessions in one workspace can be named
 * the same thing, so the name cannot do the job the id is there to do.
 */
export function clusterHeader(
  workspace: string,
  name: string | undefined,
  sessionId: string,
  collides: boolean,
): ClusterHeader {
  const named = name?.trim() ?? "";
  const id = collides ? shortId(sessionId) : undefined;
  const fields = [workspace, named || undefined, id].filter(Boolean) as string[];
  return {
    label: workspace,
    name: named ? truncateName(named) : undefined,
    shortId: id,
    fullLabel: fields.join(SEP),
  };
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

function rootName(d: AgentNodeData): string | undefined {
  if (d.kind !== "root") return undefined;
  return d.sessionName;
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

  // The camera, applied once to the layer, instead of folded into every number
  // underneath it. This is the same transform React Flow writes to
  // .react-flow__viewport to carry the real nodes, built from the same three
  // viewport values, so the decorative layer and the nodes it decorates move as
  // one thing rather than as two things that agree most of the time.
  //
  // Before #353 every box below composed the camera into its own left, top,
  // width and height — and .cluster-card eases all four over 320ms, so a pan
  // rewrote four eased layout properties sixty times a second and the box
  // trailed its own nodes by up to 94px on a pan and 1014px of width on a zoom.
  // Moving the camera up here is what makes those four honest: see the note on
  // boxStyle.
  //
  // transformOrigin lives in the sheet with the rest of the layer's geometry.
  const cameraStyle: React.CSSProperties = {
    transform: `translate(${x}px, ${y}px) scale(${zoom})`,
  };

  return (
    <div className="session-clusters" style={cameraStyle}>
      {clusters.map(c => {
        const hue = sessionHue(c.sessionId);
        // Only the hue. The four colours these two elements used to carry —
        // label, rim, card border, card wash — were composed here at a
        // lightness tuned for the dark canvas, which made them the one part of
        // the palette that could not answer to data-theme; the label measured
        // 1.21:1 on white across the hue circle. The hue is the half this
        // component actually knows (it is a hash of the session id); the half
        // that depends on the theme belongs to the sheet, and is there now.
        //
        // Layout coordinates, straight out of clusterBounds, with no camera in
        // them. clusterBounds already works in the same space React Flow keeps
        // node positions in, so these four change when — and only when — the
        // layout changes, which is the single event .cluster-card's 320ms
        // easing was written for.
        //
        // They read `c.x * zoom + x`, `c.y * zoom + y`, `c.w * zoom` and
        // `c.h * zoom` before #353. Folding the camera in is what made that
        // easing fire on every pan and zoom frame as well, and once it was
        // folded in no rule in the sheet could tell a camera move from a layout
        // move ever again, because by then they were the same number.
        const boxStyle: React.CSSProperties = {
          position: "absolute",
          left: c.x,
          top: c.y,
          width: c.w,
          height: c.h,
          "--session-hue": hue,
        } as React.CSSProperties;
        // The label is the one child that must not scale with the camera: it is
        // text, and a session name drawn at 0.2× is a smudge. It used to sit in
        // screen space and take `scale(min(1, zoom))` to shrink with a zoom-out
        // while never growing past its natural size on a zoom-in. It sits in
        // layout space now like the box, so the layer's own scale(zoom) has to
        // be divided back out to leave exactly that same size on screen.
        //
        // `|| 1` guards a zoom of zero, which would make this Infinity and put
        // the label nowhere. React Flow clamps to minZoom (0.2 on this canvas)
        // and never hands one out, so this is a fallback rather than a case.
        const labelStyle: React.CSSProperties = {
          position: "absolute",
          left: c.x + 16,
          top: c.y - LABEL_LIFT,
          transform: `scale(${Math.min(1, zoom) / (zoom || 1)})`,
          transformOrigin: "left top",
          "--session-hue": hue,
        } as React.CSSProperties;
        // Three fields, one pill, and only the middle one in a span of its own.
        // The separators stay the same glyph on purpose: what differs between
        // these fields is their KIND, not their rank, and the sheet says so by
        // leaving the name in its own case while the workspace and the id are
        // drawn uppercase. Two glyphs would have added a second rhythm without
        // saying which of its neighbours it binds to.
        //
        // The pill is content-width and transitions neither width nor left, so
        // a rename repaints one edge with no easing anywhere. The four eased
        // properties on .cluster-card are the node bounds above and no name
        // reaches them.
        //
        // The tooltip carries the whole thing untruncated, on the line above
        // the sentence rather than after another separator: with three fields
        // now joined by the same glyph, a fourth would have read as a fourth
        // field. The label is not a drag surface — the gesture belongs to the
        // sessionGroup node behind the cards, and this button sits above the
        // handle by LABEL_LIFT precisely so a click reaches it — so a title
        // here has no drag to fight.
        return (
          <React.Fragment key={c.sessionId}>
            <div className="cluster-card" style={boxStyle} aria-hidden />
            <button
              type="button"
              className="cluster-label"
              style={labelStyle}
              title={`Fit view to ${c.fullLabel}\ndrag the wrapper to move the whole session`}
              onClick={() => focusSession(c.sessionId)}
            >
              {c.label}
              {c.name ? <>{SEP}<span className="cluster-label-name">{c.name}</span></> : null}
              {c.shortId ? SEP + c.shortId : null}
            </button>
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
      // Both halves of the name. Two different names can truncate to the same
      // shown text, and only fullLabel would notice — that is the string the
      // tooltip serves, so skipping it would hold a stale one behind a header
      // that had already settled.
      x.name !== y.name ||
      x.shortId !== y.shortId ||
      x.fullLabel !== y.fullLabel ||
      x.x !== y.x || x.y !== y.y ||
      x.w !== y.w || x.h !== y.h
    ) return false;
  }
  return true;
}
