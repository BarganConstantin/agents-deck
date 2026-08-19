/**
 * Which of a session's two naming records gets drawn, and which one is left for
 * the tooltip.
 *
 * Claude Code writes two whole-line records into a transcript:
 *
 *     {"type":"agent-name","agentName":"account-management-oauth-flow",…}
 *     {"type":"ai-title","aiTitle":"Create Jira task for AI copilot setup",…}
 *
 * #520 put `agentName` on the card and `aiTitle` in the tooltip, on the strength
 * of one transcript that happened to carry both. Swept across every transcript
 * under ~/.claude/projects on this machine — 7,743 files, 1.2 GB — that is
 * backwards:
 *
 *     with agent-name      18   0.2%          (transcripts over 50 KB: 1.1%)
 *     with ai-title       318   4.1%          (transcripts over 50 KB: 25.3%)
 *     name but no title     0   0.0%
 *     title but no name   300   3.9%
 *
 * `agentName` is not the field a card can be built on; it is the rarer one by a
 * factor of seventeen, and there is not a single transcript here carrying a name
 * without a title. So the SELECTION is the feature: the card shows the name when
 * there is one and the title when there is not, and it is the same row either
 * way. For 96% of the sessions that have anything to show at all, the title is
 * not a fallback — it is the only thing there is.
 *
 * Pure, and in its own module rather than inside either component, because both
 * the node card and the cluster header have to answer this question and have to
 * answer it identically: #521's 32-column cap is justified by the header never
 * showing more of the field than the card beside it does, and two components
 * choosing their own field would break that in the one case that matters.
 */

/** What the two surfaces draw, given whatever naming a session has. */
export interface SessionDisplay {
  /**
   * The string on the face of the card, and in the cluster header. Absent when
   * the session has neither record — a Codex rollout, or a Claude session too
   * young to have been named — and then NEITHER surface renders the field at
   * all. Absent, never blank: there is no empty row and no "unknown".
   */
  face?: string;
  /**
   * The string the card's name row carries as its `title`. Absent exactly when
   * `face` is.
   *
   * It is the sentence when there is one, so a session with both gets the name
   * on the card and the sentence on hover — #520's arrangement, unchanged. When
   * the two are the same string, or when there is only one of them, the tooltip
   * repeats the face, and that is the point rather than a defect: the face is
   * `text-overflow: ellipsis` at 32 columns and two thirds of the titles
   * measured here are longer than that, so the tooltip is where the tail is
   * recovered. It has something to add whenever the face was cut, and is
   * redundant only when the whole string already fits.
   */
  tooltip?: string;
}

/**
 * The name if there is one, the title otherwise — and the sentence in the
 * tooltip either way.
 *
 * Total on purpose: it takes whatever the reducer holds, including the nulls the
 * server sends for a field the transcript has not got, and never throws. The
 * reducer separately drops a title that merely repeats the name (#520), which
 * turns that pair into the name-only case before it ever arrives here; this
 * function does not depend on that having happened, because name-wins-on-the-
 * face and title-wins-in-the-tooltip already give the same answer for a pair
 * that is one string twice.
 */
export function sessionDisplay(
  name?: string | null,
  title?: string | null,
): SessionDisplay {
  const n = typeof name === "string" ? name.trim() : "";
  const t = typeof title === "string" ? title.trim() : "";
  return {
    face: n || t || undefined,
    tooltip: t || n || undefined,
  };
}
