// UsagePanel — floating panel showing aggregated token usage and cost
// across all sessions, by model and by session. Toggled via $ button
// in the topbar or the U keyboard shortcut.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { costForUsage, fmtCost, fmtCostRate, ratesForModel, UNPRICED_LABEL, type CostBreakdown } from "../pricing";
import { PRODUCT } from "../brand";
import type { GraphState } from "../reducer";
import type { AgentState } from "../types";
import { fmtTokens } from "../token-format";
import type { Providers } from "../providers";
import { shortModel, stateLabel } from "./AgentNode";

// ── Quota types ────────────────────────────────────────────────────────────
interface QuotaData {
  ok: boolean;
  session5hPct?: number;
  session5hReset?: string;
  session5hResetAt?: number;   // unix seconds
  session5hWindowSec?: number;
  week7dPct?: number;
  week7dReset?: string;
  week7dResetAt?: number;      // unix seconds
  week7dWindowSec?: number;
  weekSonnetPct?: number;
  weekOpusPct?: number;
  source?: string;
  fetchedAt?: number;
}

/** "just now" / "40s ago" / "17m ago" / "2h ago", or null when never fetched. */
function ageLabel(ms: number | undefined, nowSec: number): string | null {
  if (!ms) return null;
  const s = nowSec - Math.floor(ms / 1000);
  if (s < 10)   return "just now";
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Which of the three sources answered, in words. */
function quotaSourceHint(source?: string): string {
  if (source === "claude-swap") return "Read from claude-swap's last collection — costs no request against your usage-endpoint budget";
  if (source === "api")         return "Fetched from Anthropic's usage endpoint, at most once every 5 minutes";
  if (source === "cli")         return "Parsed from `claude /usage`, at most once every 5 minutes";
  return "Last update";
}

interface ModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: CostBreakdown;
  agentCount: number;
  /** False when this build holds no rate for the model — the row's tokens are
   *  real and its dollars are unknowable, which is not the same as zero. */
  priced: boolean;
}

interface SessionRow {
  sessionId: string;
  label: string;
  state: AgentState;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens on this session that no rate could be applied to. Non-zero and a
   *  `cost` of zero is a session nothing here can price; non-zero beside a
   *  non-zero cost is a mixed session whose figure is a floor, not a total. */
  unpricedTokens: number;
}

/** The model key for an agent that has not reported one yet. Kept out of the
 *  display: the map needs a key and the reader needs a word, and `__unknown__`
 *  is only the first of those. */
const UNKNOWN_MODEL = "__unknown__";

function CostBar({ cost }: { cost: CostBreakdown }) {
  const total = cost.total;
  if (total <= 0) return null;
  const seg = (val: number, cls: string, label: string) => {
    if (val <= 0) return null;
    const pct = (val / total) * 100;
    return (
      <span
        key={cls}
        className={`cb-seg ${cls}`}
        style={{ width: `${pct}%` }}
        title={`${label}: ${fmtCost(val)} (${pct.toFixed(0)}%)`}
      />
    );
  };
  return (
    // role="img", and it is what makes the aria-label beside it exist at all
    // (#381). #381 reported this defect on two panel roots; a sweep of every
    // aria-label in the bundle found it three more times, all of them this bar,
    // which is written out three times in three files (that duplication is
    // #374's). A <div> with no role resolves to `generic`, and a generic
    // element cannot be named — the label has been dropped on the floor here
    // since the bar was written.
    // img is the right role for THIS one and the wrong role for the usage
    // history's chart, which looks identical and is not: img makes the whole
    // subtree presentational, which is a lie when the subtree holds focusable
    // buttons and the plain truth when it holds four coloured spans that
    // nothing can reach. See UsageHistoryModal for the other half of that.
    // What the label SAYS — a category rather than the figures the segments
    // are drawn from — is a separate question and a copy one; this is the
    // change that makes it possible for it to say anything.
    <div className="cost-bar" role="img" aria-label="Cost breakdown">
      {seg(cost.input, "cb-input", "input")}
      {seg(cost.output, "cb-output", "output")}
      {seg(cost.cacheRead, "cb-cache-r", "cache read")}
      {seg(cost.cacheWrite, "cb-cache-w", "cache write")}
    </div>
  );
}

// ── Countdown + pace helpers ───────────────────────────────────────────────
function fmtCountdown(resetAtSec: number, nowSec: number): string | null {
  const diff = resetAtSec - nowSec;
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (h > 23) {
    const d = Math.floor(diff / 86400);
    const rh = Math.floor((diff % 86400) / 3600);
    return `${d}d ${rh}h`;
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface PaceInfo {
  label: string;
  color: string;
  expectedPct: number;  // where usage "should" be now — the green-line marker position
  isDeficit: boolean;   // true when burning faster than sustainable
  runsOutIn?: string;   // set when deficit and ETA < window remaining
}

function computePace(pct: number, resetAtSec: number, windowSec: number, nowSec: number): PaceInfo | null {
  const remainSec  = Math.max(0, resetAtSec - nowSec);
  const elapsedSec = Math.max(0, windowSec - remainSec);
  if (elapsedSec < 120) return null; // too early to judge
  const expectedPct = Math.min(100, (elapsedSec / windowSec) * 100);
  const delta = pct - expectedPct;

  if (Math.abs(delta) < 3) {
    return { label: "on pace", color: "var(--ok)", expectedPct, isDeficit: false };
  }

  if (delta > 0) {
    // using more than expected → deficit (burning too fast)
    const remainPct = 100 - pct;
    const ratePerSec = elapsedSec > 0 ? pct / elapsedSec : 0;
    const runsOutSec = ratePerSec > 0 ? remainPct / ratePerSec : Infinity;
    const info: PaceInfo = {
      label: `${Math.round(delta)}% ahead`, color: "var(--warn)",
      expectedPct, isDeficit: true,
    };
    if (runsOutSec < remainSec && runsOutSec < 86400) {
      const h = Math.floor(runsOutSec / 3600);
      const m = Math.floor((runsOutSec % 3600) / 60);
      info.runsOutIn = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    return info;
  }
  // under-using → reserve (safe, will last until reset)
  return { label: `${Math.round(-delta)}% reserve`, color: "var(--ok)", expectedPct, isDeficit: false };
}

// ── Quota bar ──────────────────────────────────────────────────────────────
interface QuotaBarProps {
  pct: number;
  label: string;
  reset?: string;
  resetAt?: number;    // unix seconds — enables live countdown
  windowSec?: number;  // enables pace calculation
  limitReached?: boolean;
  nowSec: number;      // current time in seconds (for countdown + pace)
}
function QuotaBar({ pct, label, reset, resetAt, windowSec, limitReached, nowSec }: QuotaBarProps) {
  const capped   = Math.min(100, Math.max(0, pct));
  const isErr    = limitReached || capped >= 90;
  const color    = isErr ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  const pctLabel = capped === 0 ? "< 1%" : `${capped}%`;
  // minimum 2% visual fill so a 0% bar is still visible as a thin sliver
  const fillW    = capped === 0 ? 2 : capped;

  const countdown = resetAt ? fmtCountdown(resetAt, nowSec) : null;
  const pace = (resetAt && windowSec) ? computePace(capped, resetAt, windowSec, nowSec) : null;

  return (
    <div className="qb-row">
      <div className="qb-meta">
        <span className="qb-label">
          {label}
          {limitReached && <span className="qb-limit-badge" title="Rate limit reached">⛔</span>}
        </span>
        <span className="qb-pct" style={{ color }}>{pctLabel}</span>
      </div>
      <div className="qb-track">
        <div className="qb-fill" style={{ width: `${fillW}%`, background: color, opacity: capped === 0 ? 0.4 : 1 }} />
        {/* Pace marker ("green line"): where usage should be now to last until
            reset. Green when you have reserve / on pace, red when in deficit. */}
        {pace && (
          <div
            className="qb-pace-marker"
            style={{ left: `${pace.expectedPct}%`, background: pace.isDeficit ? "var(--err)" : "var(--ok)" }}
            title={`To last until reset, stay near ${Math.round(pace.expectedPct)}% by now`}
          />
        )}
      </div>
      <div className="qb-reset-row">
        {countdown
          ? <span className="qb-reset">resets in {countdown}</span>
          : reset
            ? <span className="qb-reset">resets {reset}</span>
            : null}
        {pace && (
          <span className="qb-pace" style={{ color: pace.color }}>
            {pace.runsOutIn ? `runs out in ${pace.runsOutIn}` : pace.label}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Quota fetch hook ───────────────────────────────────────────────────────
const QUOTA_POLL_MS = 60_000;

/**
 * @param enabled whether this deck watches Claude Code at all. False stops the
 *   poll rather than only hiding its output: /api/quota is not a cheap read —
 *   it can spawn `claude --print /usage` — and a machine with no Claude Code
 *   would pay for that once a minute forever to render nothing.
 */
function useQuota(enabled: boolean) {
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async (forceRefresh = false) => {
    if (forceRefresh) setLoading(true);
    try {
      const url = forceRefresh ? "/api/quota?refresh=1" : "/api/quota";
      const res = await fetch(url);
      if (res.ok) setQuota(await res.json());
    } catch { /* server unreachable */ }
    finally { if (forceRefresh) setLoading(false); }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_(true); // force on mount — avoids stale ok:false cache from prior run
    timerRef.current = window.setInterval(() => fetch_(false), QUOTA_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  const refresh = () => { if (enabled) fetch_(true); };
  return { quota, loading, refresh };
}

// ── Codex quota types + hook ───────────────────────────────────────────────
// Lanes arrive as a list rather than fixed 5h/7d slots: which windows an
// account has depends on its plan (free plans get weekly only, some get a
// 30-day cap), and the server labels each one from the duration the API
// reported instead of from its position in the payload.
interface CodexLane {
  id: string;
  key: "session" | "weekly" | "monthly" | "unknown";
  label: string;
  pct: number;
  windowSec: number | null;
  resetAt: number | null;
  reset: string | null;
}

interface CodexCreditLimit {
  limit: number;
  used: number;
  usedPct: number;
  remaining: number;
  source: string | null;
  resetAt: number | null;
  reset: string | null;
}

interface CodexQuotaData {
  ok: boolean;
  limitReached?: boolean;
  windows?: CodexLane[];
  extraWindows?: CodexLane[];
  plan?: string | null;
  planLabel?: string | null;
  creditsBalance?: string | null;
  creditsUnlimited?: boolean;
  overageReached?: boolean;
  creditLimit?: CodexCreditLimit | null;
  spendControlReached?: boolean;
  reachedType?: string | null;
  promo?: string | null;
  partial?: boolean;
  resetCredits?: { availableCount: number; nextExpiryAt: number | null } | null;
  reason?: string;
  fetchedAt?: number;
}

/** Why the Codex section is empty, in words that say what to do about it. */
function codexHint(reason?: string): string {
  switch (reason) {
    case "no_token":         return "Run codex login to authenticate.";
    case "api_key_mode":     return "API-key login — ChatGPT quota is only available for codex login.";
    case "refresh_rejected": return "Codex session expired — run codex login.";
    case "refresh_failed":   return "Couldn't refresh the Codex token — click ↻ to retry.";
    // The deck will not put a live ChatGPT token on the wire to somewhere it
    // read out of a config file it does not own, so it says which file.
    case "untrusted_base_url": return "chatgpt_base_url in ~/.codex/config.toml is not an https OpenAI host, so the token was not sent.";
    default:                 return "ChatGPT API unreachable — click ↻ to retry.";
  }
}

// ── Codex usage types + hook (token aggregation fallback) ─────────────────
interface CodexWindow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  sessionCount: number;
}
interface CodexUsageData {
  ok: boolean;
  window5h?: CodexWindow;
  window7d?: CodexWindow;
  fetchedAt?: number;
}

const CODEX_POLL_MS = 60_000;

/** @param enabled whether this deck watches Codex — see useQuota above, which
 *   states the same rule for the other side. A Codex poll refreshes an OAuth
 *   token against OpenAI, which is not work to do on a machine with no Codex. */
function useCodexQuota(enabled: boolean) {
  const [data, setData] = useState<CodexQuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async (forceRefresh = false) => {
    if (forceRefresh) setLoading(true);
    try {
      const url = forceRefresh ? "/api/codex-quota?refresh=1" : "/api/codex-quota";
      const res = await fetch(url);
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
    finally { if (forceRefresh) setLoading(false); }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_(true); // force on mount — get fresh data immediately
    timerRef.current = window.setInterval(() => fetch_(false), CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  const refresh = () => { if (enabled) fetch_(true); };
  return { data, loading, refresh };
}

function useCodexUsage(enabled: boolean) {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async () => {
    try {
      const res = await fetch("/api/codex-usage");
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
  };

  useEffect(() => {
    if (!enabled) return;
    fetch_();
    timerRef.current = window.setInterval(fetch_, CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [enabled]);

  return { data };
}

interface Props {
  state: GraphState;
  now: number;
  /** Which CLIs this deck watches — see src/web/providers.ts. */
  providers: Providers;
  onClose: () => void;
}

export default function UsagePanel({ state, now, providers, onClose }: Props) {
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useQuota(providers.claude);
  const { data: codexQuota, loading: codexLoading, refresh: refreshCodex } = useCodexQuota(providers.codex);
  const { data: codexUsage } = useCodexUsage(providers.codex);

  // Tick every 30s so countdowns + pace stay live without parent re-render
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const { byModel, totalCost, totalTokens, burnRate } = useMemo(() => {
    const modelMap = new Map<string, ModelRow>();
    const totalCostAcc: CostBreakdown = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheC = 0;

    for (const a of state.agents.values()) {
      const key = a.model ?? UNKNOWN_MODEL;
      const c = costForUsage(a.usage, a.model);
      const row = modelMap.get(key);
      if (row) {
        row.inputTokens        += a.usage.inputTokens;
        row.outputTokens       += a.usage.outputTokens;
        row.cacheReadTokens    += a.usage.cacheReadTokens;
        row.cacheCreateTokens  += a.usage.cacheCreateTokens;
        row.cost.total         += c.total;
        row.cost.input         += c.input;
        row.cost.output        += c.output;
        row.cost.cacheRead     += c.cacheRead;
        row.cost.cacheWrite    += c.cacheWrite;
        row.agentCount++;
      } else {
        modelMap.set(key, {
          model: key,
          inputTokens:       a.usage.inputTokens,
          outputTokens:      a.usage.outputTokens,
          cacheReadTokens:   a.usage.cacheReadTokens,
          cacheCreateTokens: a.usage.cacheCreateTokens,
          cost: { ...c },
          agentCount: 1,
          priced: ratesForModel(a.model) != null,
        });
      }
      totalCostAcc.total     += c.total;
      totalCostAcc.input     += c.input;
      totalCostAcc.output    += c.output;
      totalCostAcc.cacheRead += c.cacheRead;
      totalCostAcc.cacheWrite += c.cacheWrite;
      totalIn    += a.usage.inputTokens;
      totalOut   += a.usage.outputTokens;
      totalCacheR += a.usage.cacheReadTokens;
      totalCacheC += a.usage.cacheCreateTokens;
    }

    // Cost first, then tokens. Every unpriced row costs exactly zero, so
    // without the tiebreak they arrive at the bottom of the table in Map
    // insertion order — which is the order their agents happened to be observed
    // in, and reads as no order at all. Tokens are the only magnitude those
    // rows have.
    const byModel = Array.from(modelMap.values()).sort((a, b) =>
      (b.cost.total - a.cost.total)
      || ((b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)));

    let liveCost = 0, liveSec = 0;
    for (const a of state.agents.values()) {
      if (a.state !== "active") continue;
      const c = costForUsage(a.usage, a.model);
      liveCost += c.total;
      liveSec = Math.max(liveSec, ((a.endedAt ?? now) - a.startedAt) / 1000);
    }
    const burnRate = liveSec > 0 ? fmtCostRate(liveCost, liveSec) : null;

    return {
      byModel,
      totalCost: totalCostAcc,
      totalTokens: { in: totalIn, out: totalOut, cacheR: totalCacheR, cacheC: totalCacheC },
      burnRate,
    };
  }, [state, state.lastSeq, now]);

  const bySessions = useMemo((): SessionRow[] => {
    const roots: SessionRow[] = [];
    /** A session's tokens that no rate could be applied to, counted per agent
     *  because a session can mix providers — a Claude root that spawned a Codex
     *  subagent prices one and not the other. */
    const unpriced = (a: { usage: { inputTokens: number; outputTokens: number }; model?: string }) =>
      ratesForModel(a.model) == null ? a.usage.inputTokens + a.usage.outputTokens : 0;

    for (const a of state.agents.values()) {
      if (a.kind !== "root") continue;
      let cost = costForUsage(a.usage, a.model).total;
      let inT = a.usage.inputTokens, outT = a.usage.outputTokens;
      let unpricedT = unpriced(a);
      for (const sub of state.agents.values()) {
        if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
        cost += costForUsage(sub.usage, sub.model).total;
        inT  += sub.usage.inputTokens;
        outT += sub.usage.outputTokens;
        unpricedT += unpriced(sub);
      }
      roots.push({
        sessionId: a.sessionId,
        label: a.label || a.cwdBasename || "session",
        state: a.state,
        cost,
        inputTokens: inT,
        outputTokens: outT,
        unpricedTokens: unpricedT,
      });
    }
    // Same tiebreak as byModel, and it matters more here: this list is cut at
    // twelve, so before the fallback an unpriced session — however large — sat
    // at cost zero among every other zero and could be cut for a row with
    // fewer tokens than it.
    return roots
      .sort((a, b) => (b.cost - a.cost)
        || ((b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)))
      .slice(0, 12);
  }, [state, state.lastSeq]);

  const hasCost = totalCost.total > 0;
  const totalTokenSum = totalTokens.in + totalTokens.out;
  // Rows worth a line, which is not the same question as rows worth a dollar.
  // Both tables used to filter on `cost > 0`, and in a deck holding one priced
  // Claude session and any number of unpriced Codex ones that filter was
  // invisible: `hasCost` was true, so the tables rendered, and every Codex row
  // was dropped out of them while its tokens stayed in the strip above. The
  // panel's own headline number then matched no visible row — the arithmetic
  // was right and there was nothing on screen to reconcile it against.
  const modelRows   = byModel.filter(m => m.cost.total > 0 || (m.inputTokens + m.outputTokens) > 0);
  const sessionRows = bySessions.filter(s => s.cost > 0 || (s.inputTokens + s.outputTokens) > 0);
  const hasUnpriced = modelRows.some(m => !m.priced);

  const anyLoading = quotaLoading || codexLoading;
  // Per section, not per panel. The two quotas come from different places and
  // now age at very different rates — Codex is fetched here, Claude is usually
  // read from claude-swap's last collection, which can be half an hour old.
  // One combined "just now" in the header took the fresher of the two and
  // stamped it on both.
  const claudeAge = ageLabel(quota?.fetchedAt, nowSec);
  const codexAge  = ageLabel(codexQuota?.fetchedAt, nowSec);

  const refreshAll = () => { refreshQuota(); refreshCodex(); };

  // One string, used as both the ↻'s tooltip and its accessible name (#381).
  // The button's whole content is a single glyph, so `title` was the only name
  // it had — a valid last-resort source, and one that touch users never see and
  // that some screen readers are configured never to read. Sharing the string
  // rather than writing a second one also keeps 2.5.3 satisfied by
  // construction: the name a voice-control user says is the words the tooltip
  // shows, per provider, and cannot drift into promising a section that is not
  // rendered.
  const refreshLabel = providers.claude && providers.codex
    ? "Refresh Claude + Codex quota"
    : providers.codex ? "Refresh Codex quota"
      : "Refresh Claude quota";

  return (
    // The id is the target of the topbar toggle's aria-controls. It is spelled
    // the same as the class on purpose: one name for the region, so the button
    // that opens it cannot point somewhere else after a rename.
    //
    // <aside>, not <div> (#381). The aria-label below has been here since the
    // panel was written and did nothing at all: a <div> with no role resolves
    // to `generic`, and the accessibility tree drops the name off a generic
    // element rather than exposing an unnamed nameless box. #373 saw this shape
    // and called it a naming defect rather than a state one, which is what it
    // is — the label was never wrong, it had nothing to attach to. An <aside>
    // outside any sectioning content is a `complementary` landmark, which does
    // take a name, and complementary is what this panel is: spend beside the
    // canvas, openable and closable without changing what the canvas shows.
    <aside className="usage-panel" id="usage-panel" aria-label="Usage">
      <div className="up-header">
        {/* h2, under the topbar's h1 (#381). Same level as the other panels'
            titles, and the four `up-section-title`s below stepped from h4 to h3
            with it, so the panel reads h1 → h2 → h3 with nothing skipped. */}
        <h2>Usage</h2>
        {burnRate && <span className="up-rate">{burnRate}</span>}
        <div className="up-header-right">
          {/* Named after what is actually below it, and gone when neither
              section is. On a Codex-only deck "Refresh Claude + Codex quota"
              promises a section that is not there, which is the same lie in
              miniature as the panel this change removed; with both CLIs absent
              the control refreshes nothing at all. */}
          {(providers.claude || providers.codex) && (
          <button
            type="button"
            className="btn up-refresh-btn"
            onClick={refreshAll}
            disabled={anyLoading}
            aria-label={refreshLabel}
            title={refreshLabel}
          >{anyLoading ? "…" : "↻"}</button>
          )}
          <button
            type="button"
            className="btn icon-btn up-close"
            onClick={onClose}
            aria-label="Close usage panel"
            title="Close (U)"
          >×</button>
        </div>
      </div>

      {/* ── Claude quota ── */}
      {providers.claude && (
      <section className="up-section up-quota-section">
        <h3 className="up-section-title">
          Claude quota
          {/* Where the numbers came from, on hover. Anthropic's usage endpoint
              allows ~28-30 calls an hour per account, shared by every tool on
              the machine, so when claude-swap is already collecting them the
              deck reads its store instead of spending a second call — which is
              why this age is minutes rather than seconds. */}
          {claudeAge && !quotaLoading && (
            <span className="up-section-age" title={quotaSourceHint(quota?.source)}>{claudeAge}</span>
          )}
        </h3>
        {quota?.ok ? (
          <div className="up-quota-bars">
            {quota.session5hPct != null && (
              <QuotaBar
                label="5-hour window"
                pct={quota.session5hPct}
                reset={quota.session5hReset}
                resetAt={quota.session5hResetAt}
                windowSec={quota.session5hWindowSec}
                nowSec={nowSec}
              />
            )}
            {quota.week7dPct != null && (
              <QuotaBar
                label="7-day window"
                pct={quota.week7dPct}
                reset={quota.week7dReset}
                resetAt={quota.week7dResetAt}
                windowSec={quota.week7dWindowSec}
                nowSec={nowSec}
              />
            )}
            {quota.weekSonnetPct != null && (
              <QuotaBar label="Sonnet (7d)" pct={quota.weekSonnetPct} nowSec={nowSec} />
            )}
            {quota.weekOpusPct != null && (
              <QuotaBar label="Opus (7d)" pct={quota.weekOpusPct} nowSec={nowSec} />
            )}
          </div>
        ) : quota?.ok === false ? (
          <div className="up-quota-na">
            <span>Quota unavailable.</span>
            <span className="up-quota-hint">Run <code>/usage</code> in a claude session, then click ↻</span>
          </div>
        ) : (
          <div className="up-quota-na up-quota-loading">Checking…</div>
        )}
      </section>
      )}

      {/* ── Codex quota ──
          The mirror of the accounts panel, and fixed by the same fact arriving
          from /api/health: a Claude-only machine used to carry "Quota
          unavailable. / Run codex login to authenticate." permanently, for a
          CLI it has no reason to install. */}
      {providers.codex && (
      <section className="up-section up-quota-section">
        <h3 className="up-section-title">
          Codex quota
          {codexQuota?.ok && codexQuota.planLabel && (
            <span className="up-plan-badge">{codexQuota.planLabel}</span>
          )}
          {codexAge && !codexLoading && (
            <span className="up-section-age" title="Fetched from the Codex usage endpoint">{codexAge}</span>
          )}
        </h3>
        {codexQuota?.ok ? (
          <div className="up-quota-bars">
            {codexQuota.windows?.map(w => (
              <QuotaBar
                key={w.id}
                label={w.label}
                pct={w.pct}
                reset={w.reset ?? undefined}
                resetAt={w.resetAt ?? undefined}
                windowSec={w.windowSec ?? undefined}
                limitReached={codexQuota.limitReached && w.pct >= 100}
                nowSec={nowSec}
              />
            ))}

            {/* Per-model families (Codex Spark and friends) — separate caps
                that run out independently of the account-wide lanes. */}
            {codexQuota.extraWindows?.map(w => (
              <QuotaBar
                key={w.id}
                label={w.label}
                pct={w.pct}
                reset={w.reset ?? undefined}
                resetAt={w.resetAt ?? undefined}
                windowSec={w.windowSec ?? undefined}
                nowSec={nowSec}
              />
            ))}

            {/* Spend cap (team/enterprise, or a personal monthly credit limit).
                Denominated in dollars, so it gets its own bar rather than
                pretending to be a rate-limit lane. */}
            {codexQuota.creditLimit && (
              <QuotaBar
                label={`spend cap · $${Math.round(codexQuota.creditLimit.used)} of $${Math.round(codexQuota.creditLimit.limit)}`}
                pct={codexQuota.creditLimit.usedPct}
                reset={codexQuota.creditLimit.reset ?? undefined}
                resetAt={codexQuota.creditLimit.resetAt ?? undefined}
                limitReached={codexQuota.spendControlReached}
                nowSec={nowSec}
              />
            )}

            {codexQuota.creditsBalance && !codexQuota.creditsUnlimited && (
              <div className="up-quota-sub up-credits">
                credits: ${codexQuota.creditsBalance}
                {codexQuota.overageReached && " · overage limit reached"}
              </div>
            )}
            {codexQuota.creditsUnlimited && (
              <div className="up-quota-sub up-credits">credits: unlimited</div>
            )}
            {codexQuota.resetCredits && codexQuota.resetCredits.availableCount > 0 && (
              <div className="up-quota-sub up-reset-credits" title={`Redeem in the Codex CLI or ChatGPT — ${PRODUCT} only reports them`}>
                {codexQuota.resetCredits.availableCount} rate-limit reset
                {codexQuota.resetCredits.availableCount !== 1 ? "s" : ""} available
                {codexQuota.resetCredits.nextExpiryAt &&
                  ` · expires ${new Date(codexQuota.resetCredits.nextExpiryAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
              </div>
            )}
            {codexQuota.promo && (
              <div className="up-quota-sub">{codexQuota.promo}</div>
            )}
            {codexQuota.partial && (
              <div className="up-quota-sub up-quota-hint">
                Partial data — OpenAI returned limits this build doesn't recognise.
              </div>
            )}
          </div>
        ) : codexQuota?.ok === false ? (
          <div className="up-quota-na">
            <span>Quota unavailable.</span>
            <span className="up-quota-hint">{codexHint(codexQuota.reason)}</span>
          </div>
        ) : (
          <div className="up-quota-na up-quota-loading">Checking…</div>
        )}

        {/* The 7-day token count, from the rollout files on this disk. It sits
            OUTSIDE the three quota branches above, which is the whole point:
            until #400 it was nested in the success branch, so the one number in
            this section that needs no token, no account and no network was
            withheld whenever the network call failed — on `no_token`, on
            `api_key_mode`, on an expired refresh, on blocked egress. The poll
            ran every 60s regardless and its answer was thrown away.
            Measured on this machine, cold cache, three rounds: /api/codex-usage
            takes 2-4ms and makes zero outbound requests; /api/codex-quota takes
            991-1299ms across two authenticated HTTPS GETs to chatgpt.com. The
            fast local number was waiting on the slow remote one for permission
            to render.
            The 5h window goes in the title rather than on the line: the server
            has computed it since this file was written and nothing has ever
            read it, and this panel is 280px wide (#369) — a second visible
            figure costs more than it says. */}
        {codexUsage?.ok && codexUsage.window7d && codexUsage.window7d.sessionCount > 0 && (
          <div
            className="up-quota-sub"
            title={`Counted from the rollout files under CODEX_HOME — no network, no account${
              codexUsage.window5h ? `\nlast 5h: ${fmtTokens(codexUsage.window5h.totalTokens)} tokens · ${codexUsage.window5h.sessionCount} session${codexUsage.window5h.sessionCount !== 1 ? "s" : ""}` : ""
            }`}
          >
            {fmtTokens(codexUsage.window7d.totalTokens)} tokens · {codexUsage.window7d.sessionCount} session
            {codexUsage.window7d.sessionCount !== 1 ? "s" : ""} (7d)
          </div>
        )}
      </section>
      )}

      {/* ── Cost + tokens ──
          Gated on TOKENS, not on cost. The two tables used to live inside a
          `hasCost` branch, which meant a deck of nothing but unpriced sessions
          fell through to a two-number strip and a hint, with no per-model and
          no per-session breakdown at all — the reader could see that 4.2M
          tokens existed and nothing about where they went. Cost is what is
          conditional now: the headline and the bar appear when there is money
          to report, and the breakdown appears whenever there is anything to
          break down. */}
      {totalTokenSum > 0 ? (
        <>
          {hasCost && (
            <>
              <div className="up-total">
                <span className="up-total-value">{fmtCost(totalCost.total)}</span>
                <span className="up-total-label">total spend</span>
              </div>
              <CostBar cost={totalCost} />
            </>
          )}

          <div className="up-tokens-row">
            <span className="up-tok"><span className="up-k">in</span>{fmtTokens(totalTokens.in)}</span>
            <span className="up-tok"><span className="up-k">out</span>{fmtTokens(totalTokens.out)}</span>
            {totalTokens.cacheR > 0 && <span className="up-tok"><span className="up-k">cache r</span>{fmtTokens(totalTokens.cacheR)}</span>}
            {totalTokens.cacheC > 0 && <span className="up-tok"><span className="up-k">cache c</span>{fmtTokens(totalTokens.cacheC)}</span>}
          </div>

          {modelRows.length > 0 && (
            <section className="up-section">
              <h3 className="up-section-title">By model</h3>
              <table className="up-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.map(m => (
                    <tr key={m.model}>
                      {/* `__unknown__` is the map's key for an agent that has
                          not reported a model yet, and it is not a word. The
                          row still belongs here — its tokens are in the strip
                          above — but under a name a person can read. */}
                      <td className="up-model-name" title={m.model === UNKNOWN_MODEL ? "no model reported yet" : m.model}>
                        {m.model === UNKNOWN_MODEL ? "unknown" : shortModel(m.model)}
                      </td>
                      <td className="up-num">{fmtTokens(m.inputTokens + m.outputTokens)}</td>
                      {m.priced
                        ? <td className="up-num up-cost-val">{fmtCost(m.cost.total)}</td>
                        : <td className="up-num up-unpriced">{UNPRICED_LABEL}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {sessionRows.length > 0 && (
            <section className="up-section">
              <h3 className="up-section-title">By session</h3>
              <div className="up-sessions">
                {sessionRows.map(s => (
                  <div className="up-session-row" key={s.sessionId}>
                    {/* Same dot and the same hidden word as the session list
                        (#373) — this row is a <div>, so its state is read as
                        part of the line rather than as a control's name, but it
                        was the same silence either way. Two defects here, not
                        one: the dot also matched no rule at all, because every
                        `.sl-dot` selector was scoped to `.session-list` and
                        this panel is that sidebar's sibling. It was drawn as a
                        zero-sized empty span, so this list reported the state
                        in no channel whatsoever. */}
                    <span className={`sl-dot state-${s.state}`} aria-hidden />
                    <span className="vis-hidden">{stateLabel(s.state)}</span>
                    <span className="up-session-label">{s.label}</span>
                    <span className="up-session-tokens">{fmtTokens(s.inputTokens + s.outputTokens)}</span>
                    {/* A mixed session keeps its figure and gains a title: the
                        dollars are real, they are just not all of them, and a
                        floor presented as a total is the one thing this panel
                        must not print without saying so. */}
                    {s.cost > 0
                      ? (
                        <span
                          className="up-session-cost"
                          title={s.unpricedTokens > 0
                            ? `${fmtTokens(s.unpricedTokens)} tokens in this session are on an unpriced model, so this is a floor`
                            : undefined}
                        >{fmtCost(s.cost)}{s.unpricedTokens > 0 ? "+" : ""}</span>
                      )
                      : <span className="up-session-cost up-unpriced">{UNPRICED_LABEL}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {hasUnpriced && (
            <div className="up-hint">
              “{UNPRICED_LABEL}” means this build holds no published rate for that model —
              those tokens are counted above and their dollars are not.
            </div>
          )}
        </>
      ) : (
        <div className="up-empty">No usage data yet.<br />Start a Claude Code or Codex session.</div>
      )}
    </aside>
  );
}
