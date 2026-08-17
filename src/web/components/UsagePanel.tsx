// UsagePanel — floating panel showing aggregated token usage and cost
// across all sessions, by model and by session. Toggled via $ button
// in the topbar or the U keyboard shortcut.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { costForUsage, fmtCost, fmtCostRate, type CostBreakdown } from "../pricing";
import { PRODUCT } from "../brand";
import type { GraphState } from "../reducer";
import type { AgentState } from "../types";
import { fmtTokens } from "../token-format";
import { shortModel } from "./AgentNode";

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
}

interface SessionRow {
  sessionId: string;
  label: string;
  state: AgentState;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

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
    <div className="cost-bar" aria-label="Cost breakdown">
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

function useQuota() {
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
    fetch_(true); // force on mount — avoids stale ok:false cache from prior run
    timerRef.current = window.setInterval(() => fetch_(false), QUOTA_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, []);

  const refresh = () => fetch_(true);
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

function useCodexQuota() {
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
    fetch_(true); // force on mount — get fresh data immediately
    timerRef.current = window.setInterval(() => fetch_(false), CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, []);

  const refresh = () => fetch_(true);
  return { data, loading, refresh };
}

function useCodexUsage() {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async () => {
    try {
      const res = await fetch("/api/codex-usage");
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
  };

  useEffect(() => {
    fetch_();
    timerRef.current = window.setInterval(fetch_, CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, []);

  return { data };
}

interface Props {
  state: GraphState;
  now: number;
  onClose: () => void;
}

export default function UsagePanel({ state, now, onClose }: Props) {
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useQuota();
  const { data: codexQuota, loading: codexLoading, refresh: refreshCodex } = useCodexQuota();
  const { data: codexUsage } = useCodexUsage();

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
      const key = a.model ?? "__unknown__";
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

    const byModel = Array.from(modelMap.values()).sort((a, b) => b.cost.total - a.cost.total);

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
    for (const a of state.agents.values()) {
      if (a.kind !== "root") continue;
      let cost = costForUsage(a.usage, a.model).total;
      let inT = a.usage.inputTokens, outT = a.usage.outputTokens;
      for (const sub of state.agents.values()) {
        if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
        cost += costForUsage(sub.usage, sub.model).total;
        inT  += sub.usage.inputTokens;
        outT += sub.usage.outputTokens;
      }
      roots.push({
        sessionId: a.sessionId,
        label: a.label || a.cwdBasename || "session",
        state: a.state,
        cost,
        inputTokens: inT,
        outputTokens: outT,
      });
    }
    return roots.sort((a, b) => b.cost - a.cost).slice(0, 12);
  }, [state, state.lastSeq]);

  const hasCost = totalCost.total > 0;
  const totalTokenSum = totalTokens.in + totalTokens.out;

  const anyLoading = quotaLoading || codexLoading;
  // Per section, not per panel. The two quotas come from different places and
  // now age at very different rates — Codex is fetched here, Claude is usually
  // read from claude-swap's last collection, which can be half an hour old.
  // One combined "just now" in the header took the fresher of the two and
  // stamped it on both.
  const claudeAge = ageLabel(quota?.fetchedAt, nowSec);
  const codexAge  = ageLabel(codexQuota?.fetchedAt, nowSec);

  const refreshAll = () => { refreshQuota(); refreshCodex(); };

  return (
    // The id is the target of the topbar toggle's aria-controls. It is spelled
    // the same as the class on purpose: one name for the region, so the button
    // that opens it cannot point somewhere else after a rename.
    <div className="usage-panel" id="usage-panel" aria-label="Usage">
      <div className="up-header">
        <h3>Usage</h3>
        {burnRate && <span className="up-rate">{burnRate}</span>}
        <div className="up-header-right">
          <button
            type="button"
            className="btn up-refresh-btn"
            onClick={refreshAll}
            disabled={anyLoading}
            title="Refresh Claude + Codex quota"
          >{anyLoading ? "…" : "↻"}</button>
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
      <section className="up-section up-quota-section">
        <h4 className="up-section-title">
          Claude quota
          {/* Where the numbers came from, on hover. Anthropic's usage endpoint
              allows ~28-30 calls an hour per account, shared by every tool on
              the machine, so when claude-swap is already collecting them the
              deck reads its store instead of spending a second call — which is
              why this age is minutes rather than seconds. */}
          {claudeAge && !quotaLoading && (
            <span className="up-section-age" title={quotaSourceHint(quota?.source)}>{claudeAge}</span>
          )}
        </h4>
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

      {/* ── Codex quota ── */}
      <section className="up-section up-quota-section">
        <h4 className="up-section-title">
          Codex quota
          {codexQuota?.ok && codexQuota.planLabel && (
            <span className="up-plan-badge">{codexQuota.planLabel}</span>
          )}
          {codexAge && !codexLoading && (
            <span className="up-section-age" title="Fetched from the Codex usage endpoint">{codexAge}</span>
          )}
        </h4>
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

            {/* token-count from local files + credits */}
            {codexUsage?.ok && codexUsage.window7d && codexUsage.window7d.sessionCount > 0 && (
              <div className="up-quota-sub">
                {fmtTokens(codexUsage.window7d.totalTokens)} tokens · {codexUsage.window7d.sessionCount} session
                {codexUsage.window7d.sessionCount !== 1 ? "s" : ""} (7d)
              </div>
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
      </section>

      {/* ── Cost + tokens ── */}
      {hasCost ? (
        <>
          <div className="up-total">
            <span className="up-total-value">{fmtCost(totalCost.total)}</span>
            <span className="up-total-label">total spend</span>
          </div>
          <CostBar cost={totalCost} />

          {totalTokenSum > 0 && (
            <div className="up-tokens-row">
              <span className="up-tok"><span className="up-k">in</span>{fmtTokens(totalTokens.in)}</span>
              <span className="up-tok"><span className="up-k">out</span>{fmtTokens(totalTokens.out)}</span>
              {totalTokens.cacheR > 0 && <span className="up-tok"><span className="up-k">cache r</span>{fmtTokens(totalTokens.cacheR)}</span>}
              {totalTokens.cacheC > 0 && <span className="up-tok"><span className="up-k">cache c</span>{fmtTokens(totalTokens.cacheC)}</span>}
            </div>
          )}

          {byModel.filter(m => m.cost.total > 0).length > 0 && (
            <section className="up-section">
              <h4 className="up-section-title">By model</h4>
              <table className="up-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.filter(m => m.cost.total > 0).map(m => (
                    <tr key={m.model}>
                      <td className="up-model-name" title={m.model}>{shortModel(m.model)}</td>
                      <td className="up-num">{fmtTokens(m.inputTokens + m.outputTokens)}</td>
                      <td className="up-num up-cost-val">{fmtCost(m.cost.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {bySessions.filter(s => s.cost > 0).length > 0 && (
            <section className="up-section">
              <h4 className="up-section-title">By session</h4>
              <div className="up-sessions">
                {bySessions.filter(s => s.cost > 0).map(s => (
                  <div className="up-session-row" key={s.sessionId}>
                    <span className={`sl-dot state-${s.state}`} aria-hidden />
                    <span className="up-session-label">{s.label}</span>
                    <span className="up-session-tokens">{fmtTokens(s.inputTokens + s.outputTokens)}</span>
                    <span className="up-session-cost">{fmtCost(s.cost)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : totalTokenSum > 0 ? (
        <>
          <div className="up-tokens-row">
            <span className="up-tok"><span className="up-k">in</span>{fmtTokens(totalTokens.in)}</span>
            <span className="up-tok"><span className="up-k">out</span>{fmtTokens(totalTokens.out)}</span>
          </div>
          <div className="up-hint">Cost appears once a known model is detected.</div>
        </>
      ) : (
        <div className="up-empty">No usage data yet.<br />Start a Claude Code or Codex session.</div>
      )}
    </div>
  );
}
