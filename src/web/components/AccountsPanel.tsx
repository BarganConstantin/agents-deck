// AccountsPanel — every managed Claude account, its usage, and one click to
// switch between them. Toggled via the topbar button or the A shortcut.
//
// The data comes from claude-swap's local store, which the server reads rather
// than fetching: Anthropic's usage endpoint has a per-account request budget
// shared across every tool on the machine, so a dashboard that polled it
// directly would rate-limit the user's actual account. That has a visible
// consequence here — numbers can be minutes old, and saying so is part of the
// display rather than a caveat to hide.
import React, { useCallback, useEffect, useRef, useState } from "react";

interface Lane {
  id: string;
  label: string;
  pct: number;
  resetAt: number | null;   // unix seconds
}

interface Account {
  num: number;
  email: string | null;
  alias: string | null;
  org: string | null;
  active: boolean;
  disabled: boolean;
  lanes: Lane[];
  headroom: number | null;
  fetchedAt: number | null;  // unix ms
  stale: boolean;
  error: string | null;
}

interface AccountsData {
  ok: boolean;
  accounts?: Account[];
  activeNum?: number | null;
  reason?: string;
  fetchedAt?: number;
}

interface AutoTick {
  at: number;
  event: string;
  reason?: string | null;
  detail?: string | null;
  to?: number | null;
}

interface AutoStatus {
  ok: boolean;
  enabled: boolean;
  external: boolean;          // the user runs their own `cswap auto` loop
  lastTick: AutoTick | null;
  settings: Record<string, { value: string | null; isDefault: boolean }>;
}

interface PreviewResult {
  ok: boolean;
  event?: string;
  reason?: string | null;
  detail?: string | null;
  threshold?: number | null;
  headroom?: Record<string, number> | null;
  reasonText?: string;
}

const POLL_MS = 15_000;
const THRESHOLDS = [70, 80, 85, 90, 95];

/** "3h 43m" / "6d 21h" — recomputed client-side so it never shows a stale countdown. */
function countdown(resetAtSec: number, nowSec: number): string | null {
  const diff = resetAtSec - nowSec;
  if (diff <= 0) return null;
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ago(ms: number, nowSec: number): string {
  const s = nowSec - Math.floor(ms / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * What a dry run concluded, in one phrase. claude-swap's own reason codes are
 * internal names — "below-threshold", "no-qualifying-candidate" — and its
 * `detail` is bare arithmetic like "17% < 90%", true but not an answer.
 */
function previewText(p: PreviewResult): string {
  if (p.event === "switch") return `would switch — ${p.detail ?? "another account"}`;
  const why: Record<string, string> = {
    "below-threshold":        "under threshold",
    "no-qualifying-candidate": "no better account",
    "all-exhausted":          "every account spent",
    "cooldown":               "cooling down",
    "external-engine":        "handled elsewhere",
  };
  const label = why[p.reason ?? ""] ?? p.reason ?? "nothing to do";
  return p.detail ? `stays put · ${label}, ${p.detail}` : `stays put · ${label}`;
}

/** Plain-language version of claude-swap's error codes. */
function errorText(code: string): string {
  if (code === "http-429") return "rate limited";
  if (code === "http-401") return "re-login needed";
  if (code === "timeout")  return "timed out";
  if (code === "network")  return "unreachable";
  return code;
}

function LaneBar({ lane, nowSec }: { lane: Lane; nowSec: number }) {
  const capped = Math.min(100, Math.max(0, lane.pct));
  const color  = capped >= 90 ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  const reset  = lane.resetAt ? countdown(lane.resetAt, nowSec) : null;
  return (
    <div className="ap-lane">
      <span className="ap-lane-label">{lane.label}</span>
      <div className="ap-lane-track">
        <div className="ap-lane-fill" style={{ width: `${capped === 0 ? 1.5 : capped}%`, background: color, opacity: capped === 0 ? 0.4 : 1 }} />
      </div>
      <span className="ap-lane-pct" style={{ color }}>{capped}%</span>
      <span className="ap-lane-reset">{reset ? `resets ${reset}` : ""}</span>
    </div>
  );
}

interface Props { onClose: () => void }

export default function AccountsPanel({ onClose }: Props) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      const [accts, autoRes] = await Promise.all([
        fetch(`/api/claude-accounts${force ? "?refresh=1" : ""}`),
        fetch("/api/cswap-auto"),
      ]);
      if (accts.ok)    setData(await accts.json());
      if (autoRes.ok)  setAuto(await autoRes.json());
    } catch { /* server unreachable */ }
  }, []);

  /** Every auto-switch control is one POST; they all reload afterwards. */
  const post = useCallback(async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag);
    setFailure(null);
    try {
      const res = await fetch("/api/cswap-auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      if (!out?.ok) setFailure(out?.detail || out?.reason || "command failed");
      return out;
    } catch {
      setFailure("server unreachable");
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    load(true);
    timerRef.current = window.setInterval(() => load(false), POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [load]);

  // Countdowns tick independently of the fetch so they stay honest between polls.
  useEffect(() => {
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const doSwitch = async (num: number) => {
    setSwitching(num);
    setFailure(null);
    try {
      const res = await fetch("/api/claude-accounts/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: num }),
      });
      const body = await res.json().catch(() => null);
      if (!body?.ok) setFailure(body?.output || body?.reason || "switch failed");
      await load(true);
    } catch {
      setFailure("server unreachable");
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="accounts-panel" aria-label="Claude accounts">
      <div className="ap-header">
        <h3>Accounts</h3>
        <div className="ap-header-right">
          <button type="button" className="btn ap-refresh" onClick={() => load(true)} title="Reload from claude-swap">↻</button>
          <button type="button" className="btn icon-btn" onClick={onClose} aria-label="Close accounts panel" title="Close (A)">×</button>
        </div>
      </div>

      {data == null ? (
        <div className="ap-empty">Checking…</div>
      ) : !data.ok ? (
        <div className="ap-empty">
          <span>No accounts found.</span>
          <span className="ap-hint">
            {data.reason === "no_store"
              ? "This panel reads claude-swap's store. Install it with uv tool install claude-swap, then run cswap add."
              : "claude-swap's store could not be read."}
          </span>
        </div>
      ) : (
        <>
          {data.accounts?.map(a => (
            <div key={a.num} className={`ap-account${a.active ? " active" : ""}${a.disabled ? " disabled" : ""}`}>
              <div className="ap-account-head">
                <span className="ap-num">{a.num}</span>
                {a.alias && <span className="ap-alias">{a.alias}</span>}
                <span className="ap-email" title={a.org ?? undefined}>{a.email}</span>
                {a.active
                  ? <span className="ap-badge-active">● active</span>
                  : (
                    <button
                      type="button"
                      className="btn ap-switch"
                      disabled={switching != null || a.disabled}
                      onClick={() => doSwitch(a.num)}
                      title={a.disabled ? "Held out of rotation" : `Switch to ${a.alias ?? a.email}`}
                    >{switching === a.num ? "…" : "switch"}</button>
                  )}
              </div>

              {a.lanes.length > 0
                ? a.lanes.map(l => <LaneBar key={l.id} lane={l} nowSec={nowSec} />)
                : <div className="ap-hint">No usage recorded yet.</div>}

              {/* Freshness is load-bearing here, not a footnote: an account
                  that has been rate-limited for hours still shows its last
                  good numbers, and switching to it on that basis would be a
                  decision made on old information. */}
              <div className="ap-meta">
                {a.error && <span className="ap-err">{errorText(a.error)}</span>}
                {a.fetchedAt
                  ? <span className={a.stale ? "ap-stale" : undefined}>{ago(a.fetchedAt, nowSec)}</span>
                  : <span className="ap-stale">never fetched</span>}
                {/* Holding an account out of rotation only matters when
                    something is rotating, so the control appears with it. */}
                {(auto?.enabled || auto?.external) && !a.active && (
                  <button
                    type="button"
                    className="ap-rotate"
                    disabled={busy != null}
                    onClick={() => post({ action: "account", account: a.num, enabled: a.disabled }, `rot-${a.num}`).then(() => load(true))}
                    title={a.disabled
                      ? "Return this account to auto-rotation"
                      : "Hold this account out of auto-rotation"}
                  >{a.disabled ? "held out" : "in rotation"}</button>
                )}
              </div>
            </div>
          ))}

          {/* ── auto-switch ── */}
          {auto?.ok && (
            <div className="ap-auto">
              <div className="ap-auto-head">
                <span className="ap-auto-title">Auto-switch</span>
                {auto.external ? (
                  // Two engines would not corrupt anything, but they would
                  // double the tick rate against the request budget and leave
                  // no single place explaining why an account moved.
                  <span className="ap-auto-state external" title="A cswap auto loop is already running in your terminal — the deck stays out of its way">
                    <i className="ap-dot" aria-hidden /> external
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`ap-auto-state toggle${auto.enabled ? " on" : ""}`}
                    role="switch"
                    aria-checked={auto.enabled}
                    disabled={busy != null}
                    onClick={() => post({ action: "enable", enabled: !auto.enabled }, "enable").then(() => load(true))}
                    title={auto.enabled
                      ? "Stop switching accounts automatically"
                      : "Switch accounts automatically when the active one nears its limit"}
                  >
                    <i className="ap-dot" aria-hidden /> {auto.enabled ? "on" : "off"}
                  </button>
                )}
              </div>

              {/* Written as a sentence rather than a settings grid: the rule is
                  short enough to state, and two labelled dropdowns with no
                  sentence around them never said what they applied to. */}
              <p className="ap-auto-rule">
                Switch at{" "}
                <span className="ap-field">
                  <select
                    aria-label="Switch threshold"
                    value={auto.settings["autoswitch.threshold"]?.value ?? "90"}
                    disabled={busy != null}
                    onChange={e => post({ action: "setting", key: "autoswitch.threshold", value: e.target.value }, "threshold").then(() => load(true))}
                  >
                    {THRESHOLDS.map(t => <option key={t} value={t}>{t}%</option>)}
                  </select>
                </span>{" "}
                to the account with{" "}
                <span className="ap-field">
                  <select
                    aria-label="Target account strategy"
                    value={auto.settings["autoswitch.strategy"]?.value ?? "best"}
                    disabled={busy != null}
                    onChange={e => post({ action: "setting", key: "autoswitch.strategy", value: e.target.value }, "strategy").then(() => load(true))}
                  >
                    {/* claude-swap's own names for these are "best" and
                        "consume-first", which say nothing on their own. */}
                    <option value="best">the most quota left</option>
                    <option value="consume-first">the soonest reset</option>
                  </select>
                </span>.
              </p>

              <div className="ap-auto-foot">
                <button
                  type="button"
                  className="ap-auto-dry"
                  disabled={busy != null}
                  onClick={async () => setPreview(await post({ action: "preview" }, "preview"))}
                  title="Evaluate a switch without performing one"
                >{busy === "preview" ? "checking…" : "dry run"}</button>

                {preview?.ok ? (
                  <span className={`ap-auto-result${preview.event === "switch" ? " would" : ""}`}>
                    {previewText(preview)}
                  </span>
                ) : auto.lastTick ? (
                  <span className="ap-auto-result">
                    checked {ago(auto.lastTick.at, nowSec)}
                  </span>
                ) : null}
              </div>
            </div>
          )}

          {failure && <div className="ap-failure">{failure}</div>}

          <p className="ap-footnote" title="Anthropic's usage endpoint allows roughly 28–30 requests per hour per account, shared by every tool on this machine. Polling it from here would rate-limit your account, so the deck reads what claude-swap already collected.">
            Read from claude-swap, not polled.
          </p>
        </>
      )}
    </div>
  );
}
