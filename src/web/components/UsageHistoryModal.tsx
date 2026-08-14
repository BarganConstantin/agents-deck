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
function fmtN(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function shortModel(m: string): string {
  return m
    .replace(/^anthropic\./, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

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

  useModalDismiss(onClose);

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
      <div className="uh-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Usage history">
        <header className="uh-head">
          <div className="uh-titlewrap">
            <div className="uh-title">Usage history</div>
            <div className="uh-sub">via ccusage · local Claude / Codex logs</div>
          </div>
          <div className="uh-range" role="tablist" aria-label="Range">
            {PRESETS.map(p => (
              <button
                key={p}
                role="tab"
                aria-selected={rangeDays === p}
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
          <button className="uh-close" onClick={onClose} aria-label="Close">×</button>
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
              <Stat label="tokens"       val={fmtN(totalTok)} />
              <Stat label="input+output" val={fmtN(inOut)} />
              <Stat label="cache reads"  val={fmtN(cacheRead)} />
            </div>

            <div className="uh-chart" role="img" aria-label="Daily cost by model">
              {days.map(d => {
                const h = maxCost > 0 ? (d.totalCost / maxCost) * 100 : 0;
                const isSel = d.period === selected;
                return (
                  <button
                    key={d.period}
                    className={`uh-bar-col${isSel ? " sel" : ""}`}
                    onClick={() => setSelected(isSel ? null : d.period)}
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

            <div className="uh-legend">
              {legend.map(([m, c]) => (
                <span key={m} className="uh-legend-item">
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
                  <MiniStat label="input"       val={fmtN(selectedDay.inputTokens)} />
                  <MiniStat label="output"      val={fmtN(selectedDay.outputTokens)} />
                  <MiniStat label="cache write" val={fmtN(selectedDay.cacheCreationTokens)} />
                  <MiniStat label="cache read"  val={fmtN(selectedDay.cacheReadTokens)} />
                </div>
                <div className="uh-detail-models">
                  {selectedDay.modelBreakdowns
                    .slice()
                    .sort((a, b) => b.cost - a.cost)
                    .map(mb => {
                      const pct = selectedDay.totalCost > 0 ? (mb.cost / selectedDay.totalCost) * 100 : 0;
                      return (
                        <div key={mb.modelName} className="uh-model-row">
                          <span className="uh-model-name">
                            <span className="uh-legend-dot" style={{ background: modelColor(mb.modelName) }} />
                            {shortModel(mb.modelName)}
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
