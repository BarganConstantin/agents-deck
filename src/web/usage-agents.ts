// Rolling ccusage's per-day `agents` arrays up into one figure per CLI.
//
// WHY THIS IS ITS OWN MODULE. #431's complaint is that the usage-history modal
// named two CLIs in its subtitle and then showed one merged number, so "how
// much of this is Codex?" had no answer anywhere on the panel. The fix has two
// halves — ask ccusage for the split (`--by-agent`, in ccusage.mjs) and draw it
// — and the drawing half is arithmetic plus a colour, neither of which needs a
// DOM. Kept out of UsageHistoryModal.tsx for the same reason usage-view.ts,
// usage-range.ts, providers.ts and provider-copy.ts are: the branches that
// matter are the ones nobody exercises by hand — a Codex-only machine, a
// ccusage too old to report agents at all, a range where one CLI's share
// rounds to nothing — and they can be read and tested here without rendering
// React. The test environment is plain Node, so a rule that lives in a .tsx is
// a rule the suite cannot reach.
import { fmtCost } from "./pricing";
import { agentLabel } from "./provider-copy";

/** One CLI's row in a day, as ccusage's `--by-agent` reports it. The full
 *  entry carries token counts and a model breakdown too; these three are what
 *  the range roll-up reads. */
export interface AgentDay {
  agent: string;
  totalCost: number;
  totalTokens: number;
}

/** One CLI's whole share of the range on screen. */
export interface AgentTotal {
  /** ccusage's own lowercase id — "claude", "codex", "opencode", … Kept raw
   *  because it is what colours and tooltips key off; provider-copy.ts's
   *  agentLabel turns it into the name that gets printed. */
  id: string;
  cost: number;
  tokens: number;
}

/**
 * Every CLI in the range, most expensive first.
 *
 * Days with no `agents` array contribute nothing rather than being counted as
 * an unnamed agent — that is what a ccusage older than `--by-agent` produces,
 * and inventing an "unknown" row for it would put a figure on screen that no
 * CLI is responsible for. A range made entirely of such days therefore comes
 * back empty, which is the same answer as "nothing ran", and the modal draws
 * no split for either.
 *
 * Sorted by cost so the ordering is the same one the model legend already uses,
 * and by id after that so two CLIs that have spent exactly the same amount —
 * two zeroes, most plausibly — do not swap places between renders.
 */
export function agentTotals(days: readonly { agents?: readonly AgentDay[] }[]): AgentTotal[] {
  const byId = new Map<string, AgentTotal>();
  for (const day of days) {
    for (const a of day.agents ?? []) {
      if (!a || typeof a.agent !== "string" || a.agent === "") continue;
      const row = byId.get(a.agent) ?? { id: a.agent, cost: 0, tokens: 0 };
      row.cost += Number.isFinite(a.totalCost) ? a.totalCost : 0;
      row.tokens += Number.isFinite(a.totalTokens) ? a.totalTokens : 0;
      byId.set(a.agent, row);
    }
  }
  return [...byId.values()].sort((x, y) => y.cost - x.cost || x.id.localeCompare(y.id));
}

/**
 * The one selected day's CLIs, named and priced, for the detail panel's header.
 *
 * That header already had a corner for this: `metadata.agents` is a bare list
 * of ids ccusage reports with or without `--by-agent`, and the panel printed it
 * as "claude · codex" — the same merge #431 is about, one level down. The names
 * are there and the money is not, on the one surface whose entire job is
 * breaking a single day apart.
 *
 * `null` when there is nothing to say, which is both "no agents reported" and
 * "one agent" — a day with a single CLI in it is fully described by the total
 * already printed two inches to the left, and repeating it beside a name would
 * be new chrome on a machine that has nothing to split.
 *
 * Ordered by cost, so this line and the range strip above it list the same CLIs
 * in the same order and a reader can compare the two without re-reading.
 */
export function dayAgentSummary(agents: readonly AgentDay[] | undefined): string | null {
  const rows = agentTotals([{ agents }]);
  if (rows.length < 2) return null;
  return rows.map(r => `${agentLabel(r.id)} ${fmtCost(r.cost)}`).join(" · ");
}

/**
 * Stable colour per CLI, for the share bar and the key beside it.
 *
 * Drawn from the same palette UsageHistoryModal's `modelColor` uses, and
 * deliberately so: on a machine running both, Claude's models are the purple
 * band of every daily bar and Codex's are the amber and orange ones, so
 * matching those hues makes the split strip read as a summary of the chart
 * above it rather than as a second, unrelated key.
 *
 * Everything unrecognised is one zinc, and that is a real limit rather than an
 * oversight: ccusage reads sixteen CLIs and three of them at once would draw
 * three identical segments. It is left alone because the name and the figure
 * sit next to each colour in the key, so the colour is a shortcut and never the
 * only way to tell two rows apart — and inventing a hue by hashing an id would
 * put unreadable-against-the-panel colours on screen to solve a case nobody has
 * yet reported.
 */
export function agentColor(id: string): string {
  switch (id.toLowerCase()) {
    case "claude": return "#c4b5fd";  // purple, as the Claude models are drawn
    case "codex": return "#fdba74";   // orange, as the Codex models are drawn
    case "gemini": return "#a5b4fc";  // indigo, matching modelColor's gemini
    case "copilot": return "#86efac"; // green
    default: return "#94a3b8";        // zinc — the same fallback modelColor uses
  }
}

/**
 * One CLI's share of the range, as a percentage to print beside its cost.
 *
 * This exists because the bar cannot always answer the question the bar is for.
 * A real measurement from a machine running both CLIs was Claude $662.05 against
 * Codex $0.01: the segment for Codex is two thousandths of a pixel and rounds
 * to "0.0%", which reads as "none" when the honest answer is "a very small
 * amount". So a share that is genuinely zero prints "0%" and a share that is
 * merely too small to round prints "<0.1%" — the distinction between a CLI that
 * spent nothing and a CLI that spent something is exactly what a reader opening
 * this panel is trying to establish.
 *
 * A whole of zero or less has no shares in it, so every part reads "0%" rather
 * than dividing by it.
 */
export function sharePct(part: number, whole: number): string {
  if (!(whole > 0) || !(part > 0)) return "0%";
  const pct = (part / whole) * 100;
  if (pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}
