// Historical usage modal, powered by the `ccusage` CLI (via /api/ccusage).
// Shows daily cost + token usage as a stacked bar chart (one bar per day,
// segmented by model), a totals strip, a model legend, and a click-to-select
// per-day detail panel. No charting library — bars are plain divs.
//
// Inspired by the task-board project's ccusage modal, reimplemented in
// agent-dag's idiom (plain CSS, no Tailwind/framer-motion).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { fmtCost } from "../pricing";
import { commandOutput, explainCcusageFailure } from "../admin-failure";
import { createLatestGuard } from "../latest";
import { presetSince } from "../usage-range";
import { usageView } from "../usage-view";
import { fmtTokens } from "../token-format";
import { shortModel } from "../model-label";
import { useModalDismiss } from "./use-modal-dismiss";

// ── ccusage data shapes (subset we use) ────────────────────────────────────
interface ModelBreakdown {
  modelName: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}
interface DayEntry {
  period: string;            // YYYY-MM-DD
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
  metadata?: { agents?: string[] };
}
interface CcusageResp {
  ok: boolean;
  days?: DayEntry[];
  totals?: Record<string, number> | null;
  since?: string;
  reason?: string;
  error?: string;
  fetchedAt?: number;
}

/** A landed response together with the preset it was requested for. The tag is
 *  what lets the view refuse to show one range's numbers under another's tab. */
interface Landed { range: number; resp: CcusageResp; }

// ── helpers ─────────────────────────────────────────────────────────────────
// Stable per-model color. Family-based so opus/sonnet/haiku/gpt read consistently.
function modelColor(m: string): string {
  const s = m.toLowerCase();
  if (s.includes("opus")) return "#c4b5fd";   // purple
  if (s.includes("sonnet")) return "#7dd3fc"; // blue
  if (s.includes("haiku")) return "#86efac";  // green
  if (s.includes("gpt-5") || s.includes("gpt5")) return "#fcd34d"; // amber
  if (s.includes("gpt")) return "#fca5a5";    // red
  if (s.includes("gemini")) return "#a5b4fc"; // indigo
  if (s.includes("codex")) return "#fdba74";  // orange
  return "#94a3b8";                            // zinc
}

const PRESETS = [7, 14, 30, 90];

// ── data hook ─────────────────────────────────────────────────────────────
function useCcusage(rangeDays: number) {
  const [landed, setLanded] = useState<Landed | null>(null);
  const [loading, setLoading] = useState(false);

  // Responses can land out of order — a cached 7d range answers instantly while
  // an uncached 90d one runs the CLI for seconds — so only the newest request
  // is allowed to write data or clear `loading`.
  const guard = useRef(createLatestGuard()).current;

  const load = (force = false) => {
    const isCurrent = guard.begin();
    const range = rangeDays;
    setLoading(true);
    const since = presetSince(range);
    const url = `/api/ccusage?since=${since}${force ? "&refresh=1" : ""}`;
    fetch(url)
      .then(r => r.json())
      .then(resp => { if (isCurrent()) setLanded({ range, resp }); })
      // The deck itself never answered, which is a different failure from
      // ccusage failing and the only one whose remedy is about the deck.
      .catch(() => { if (isCurrent()) setLanded({ range, resp: { ok: false, reason: "unreachable" } }); })
      .finally(() => { if (isCurrent()) setLoading(false); });
  };

  useEffect(() => {
    load(false);
    return () => guard.cancel();
    /* eslint-disable-next-line */
  }, [rangeDays]);
  return { landed, loading, reload: () => load(true) };
}

// ── component ─────────────────────────────────────────────────────────────
interface Props { onClose: () => void; }

export default function UsageHistoryModal({ onClose }: Props) {
  const [rangeDays, setRangeDays] = useState(30);
  const [selected, setSelected] = useState<string | null>(null);
  const { landed, loading, reload } = useCcusage(rangeDays);

  // The × rather than the first control: this header opens with a four-button
  // range strip, and a dialog that hands the keyboard "7d" as its greeting
  // reads as a setting to change rather than a thing to read or leave. Every
  // other modal on the deck starts on its dismiss control too.
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });

  const view = usageView({
    loading,
    want: rangeDays,
    answer: landed && { range: landed.range, ok: landed.resp.ok === true, days: landed.resp.days?.length ?? 0 },
  });
  // Only a "chart" verdict means a non-empty response for the range on screen,
  // so nothing below can render another range's bars, totals or legend.
  const days = view.phase === "chart" ? landed!.resp.days ?? [] : [];
  const maxCost = useMemo(() => days.reduce((m, d) => Math.max(m, d.totalCost), 0), [days]);

  // Aggregate totals + per-model cost across the range.
  const { totalCost, totalTok, inOut, cacheRead, modelCosts } = useMemo(() => {
    let totalCost = 0, totalTok = 0, inOut = 0, cacheRead = 0;
    const modelCosts = new Map<string, number>();
    for (const d of days) {
      totalCost += d.totalCost;
      totalTok  += d.totalTokens;
      inOut     += d.inputTokens + d.outputTokens;
      cacheRead += d.cacheReadTokens;
      for (const mb of d.modelBreakdowns) {
        modelCosts.set(mb.modelName, (modelCosts.get(mb.modelName) ?? 0) + mb.cost);
      }
    }
    return { totalCost, totalTok, inOut, cacheRead, modelCosts };
  }, [days]);

  const legend = useMemo(
    () => Array.from(modelCosts.entries()).sort((a, b) => b[1] - a[1]),
    [modelCosts],
  );

  const selectedDay = selected ? days.find(d => d.period === selected) ?? null : null;

  return (
    <div className="uh-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="uh-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Usage history">
        <header className="uh-head">
          <div className="uh-titlewrap">
            <div className="uh-title">Usage history</div>
            <div className="uh-sub">via ccusage · local Claude / Codex logs</div>
          </div>
          {/* Not a tablist (#381). role="tab" is a promise about keyboard
              behaviour — one tab stop for the whole strip, arrow keys between
              the members, and each tab pointing at a tabpanel it controls —
              and this strip implements none of the three: every button is its
              own tab stop and there is no panel, only the same chart redrawn
              over a different range. A screen reader told to expect arrow keys
              that do nothing is worse off than one told nothing.
              Not a radiogroup either, which is the obvious swap and carries
              exactly the same unmet contract: radio in a radiogroup is arrow
              keys and a roving tabindex too. group + aria-pressed is the shape
              the canvas category chips already use, for the reason spelled out
              at that bar in App.tsx — it names the set, states each member, and
              promises no keyboard model that is not here. */}
          <div className="uh-range" role="group" aria-label="Range">
            {PRESETS.map(p => (
              <button
                key={p}
                type="button"
                aria-pressed={rangeDays === p}
                className={`uh-range-btn${rangeDays === p ? " on" : ""}`}
                onClick={() => { setRangeDays(p); setSelected(null); }}
              >{p}d</button>
            ))}
          </div>
          <button
            className="btn icon-btn uh-reload"
            onClick={reload}
            disabled={loading}
            title="Re-run ccusage"
            aria-label="Reload"
          >{loading ? "…" : "↻"}</button>
          <button ref={closeRef} className="uh-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {view.phase === "busy" ? (
          <div className="uh-status" aria-busy="true">
            {landed ? "running ccusage…" : "running ccusage… (first run downloads the package)"}
          </div>
        ) : view.phase === "error" ? (
          // The reason map says what happened; ccusage's own line is evidence,
          // one hover away, because it is what the user pastes into an issue.
          <div className="uh-status uh-err" title={commandOutput(landed!.resp) || undefined}>
            {explainCcusageFailure(landed!.resp, "ccusage did not report usage")}
            <div>
              <button className="btn uh-retry" onClick={reload} disabled={loading}>
                {loading ? "trying…" : "Try again"}
              </button>
            </div>
          </div>
        ) : view.phase === "empty" ? (
          <div className={`uh-status${view.stale ? " uh-stale" : ""}`} aria-busy={view.stale || undefined}>
            no usage in this range
          </div>
        ) : (
          // One wrapper so the whole answer dims together while a newer run for
          // this same range is in flight: these are the right range's numbers,
          // but they are not the final word yet.
          <div className={view.stale ? "uh-stale" : undefined} aria-busy={view.stale || undefined}>
            <div className="uh-totals">
              <Stat label="total cost"   val={fmtCost(totalCost)} accent />
              <Stat label="tokens"       val={fmtTokens(totalTok)} />
              <Stat label="input+output" val={fmtTokens(inOut)} />
              <Stat label="cache reads"  val={fmtTokens(cacheRead)} />
            </div>

            {/* role="group", not role="img" (#381). role="img" declares that
                the subtree is one graphic, so every descendant is pruned from
                the accessibility tree — but pruning the tree does not empty the
                tab order, so what this actually produced was up to ninety
                focusable buttons that announced nothing at all when they took
                focus. That is the same shape as the tool-bubble finding in
                #367: reachable and silent, which is worse than either being
                unreachable or being read out.
                group keeps the only thing the role was really being used for —
                the bars are named as one set rather than as loose controls —
                and leaves each day to speak for itself below. */}
            <div className="uh-chart" role="group" aria-label="Daily cost by model">
              {days.map(d => {
                const h = maxCost > 0 ? (d.totalCost / maxCost) * 100 : 0;
                const isSel = d.period === selected;
                // The bar's only text is `06-14`, a day with no month and no
                // figure. The tooltip has carried the whole answer all along;
                // this is that same sentence where a name is read from, and it
                // is built from the same two values rather than a second copy.
                const dayLabel = `${d.period}, ${fmtCost(d.totalCost)}`;
                return (
                  <button
                    key={d.period}
                    className={`uh-bar-col${isSel ? " sel" : ""}`}
                    onClick={() => setSelected(isSel ? null : d.period)}
                    /* A toggle, and pressed is the honest word for it: clicking
                       the selected day clears the breakdown below rather than
                       navigating anywhere, exactly like the canvas category
                       chips this deck already models. */
                    aria-pressed={isSel}
                    aria-label={dayLabel}
                    title={`${d.period} · ${fmtCost(d.totalCost)}`}
                    style={{ flexBasis: `${100 / days.length}%` }}
                  >
                    <div className="uh-bar" style={{ height: `${Math.max(h, d.totalCost > 0 ? 2 : 0)}%` }}>
                      {d.modelBreakdowns
                        .slice()
                        .sort((a, b) => b.cost - a.cost)
                        .map(mb => {
                          const seg = d.totalCost > 0 ? (mb.cost / d.totalCost) * 100 : 0;
                          return (
                            <div
                              key={mb.modelName}
                              className="uh-bar-seg"
                              style={{ height: `${seg}%`, background: modelColor(mb.modelName) }}
                            />
                          );
                        })}
                    </div>
                    <span className="uh-bar-label">{d.period.slice(5)}</span>
                  </button>
                );
              })}
            </div>

            {/* The raw id in a `title`, on both surfaces here, matching what
                UsagePanel and AgentNode already do. #462 found these two were
                the only places printing a model label with no way back to the
                id — and they are the two whose whole job is comparing spend
                across models, so a reader who wants to know exactly which
                `gpt-5.4-*` a row is has to be able to ask. The label is
                unambiguous again as of that fix; the tooltip is what makes the
                exact id, dates and namespace included, recoverable without it. */}
            <div className="uh-legend">
              {legend.map(([m, c]) => (
                <span key={m} className="uh-legend-item" title={m}>
                  <span className="uh-legend-dot" style={{ background: modelColor(m) }} />
                  {shortModel(m)} <span className="uh-legend-cost">{fmtCost(c)}</span>
                </span>
              ))}
            </div>

            {selectedDay && (
              <div className="uh-detail">
                <div className="uh-detail-head">
                  <span className="uh-detail-date">{selectedDay.period}</span>
                  <span className="uh-detail-cost">{fmtCost(selectedDay.totalCost)}</span>
                  {selectedDay.metadata?.agents?.length ? (
                    <span className="uh-detail-agents">{selectedDay.metadata.agents.join(" · ")}</span>
                  ) : null}
                </div>
                <div className="uh-detail-mini">
                  <MiniStat label="input"       val={fmtTokens(selectedDay.inputTokens)} />
                  <MiniStat label="output"      val={fmtTokens(selectedDay.outputTokens)} />
                  <MiniStat label="cache write" val={fmtTokens(selectedDay.cacheCreationTokens)} />
                  <MiniStat label="cache read"  val={fmtTokens(selectedDay.cacheReadTokens)} />
                </div>
                <div className="uh-detail-models">
                  {selectedDay.modelBreakdowns
                    .slice()
                    .sort((a, b) => b.cost - a.cost)
                    .map(mb => {
                      const pct = selectedDay.totalCost > 0 ? (mb.cost / selectedDay.totalCost) * 100 : 0;
                      return (
                        <div key={mb.modelName} className="uh-model-row" title={mb.modelName}>
                          <span className="uh-model-name">
                            <span className="uh-legend-dot" style={{ background: modelColor(mb.modelName) }} />
                            {/* The label is in a span of its own so it can
                                ellipsise: this column is a hard 130px and the
                                text used to be an anonymous flex item, which
                                `text-overflow` cannot reach — a label wider than
                                the column wrapped onto a second line and pushed
                                the bar out of the row. Nothing in the known
                                corpus is that wide (see model-label.ts), and the
                                point is that the next qualifier to arrive
                                degrades to an ellipsis over a `title` rather
                                than to a broken row. */}
                            <span className="uh-model-label">{shortModel(mb.modelName)}</span>
                          </span>
                          <span className="uh-model-bar">
                            <span className="uh-model-bar-fill" style={{ width: `${pct}%`, background: modelColor(mb.modelName) }} />
                          </span>
                          <span className="uh-model-cost">{fmtCost(mb.cost)}</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, val, accent }: { label: string; val: string; accent?: boolean }) {
  return (
    <div className="uh-stat">
      <span className={`uh-stat-val${accent ? " accent" : ""}`}>{val}</span>
      <span className="uh-stat-label">{label}</span>
    </div>
  );
}
function MiniStat({ label, val }: { label: string; val: string }) {
  return (
    <div className="uh-ministat">
      <span className="uh-ministat-val">{val}</span>
      <span className="uh-ministat-label">{label}</span>
    </div>
  );
}
