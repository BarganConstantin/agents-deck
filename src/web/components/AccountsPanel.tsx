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
import AddAccountDialog from "./AddAccountDialog";

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
  nextAt: number | null;     // unix ms — claude-swap's next planned read
  stale: boolean;
  error: string | null;
}

interface AccountsData {
  ok: boolean;
  accounts?: Account[];
  activeNum?: number | null;
  reason?: string;
  hint?: string;
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
 * " · next in 4m" — when claude-swap plans to read this account again.
 *
 * The age alone reads as neglect. The two together read as a cadence, which is
 * what it is: claude-swap sets the interval per account and every surface
 * inherits it, so a number that has not moved in ten minutes is on schedule
 * rather than stuck. Nothing is shown once the read is due, because at that
 * point the answer is "any moment now" and a countdown to zero that lingers is
 * worse than no countdown.
 */
function due(nextAt: number | null, nowSec: number): string {
  if (!nextAt) return "";
  const s = Math.floor(nextAt / 1000) - nowSec;
  if (s <= 0)  return " · due";
  if (s < 60)  return ` · next in ${s}s`;
  return ` · next in ${Math.round(s / 60)}m`;
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

/** Every slot an account could move to: the ones in use, plus the next free. */
function slotOptions(accounts: Account[]): number[] {
  const used = accounts.map(a => a.num);
  const max = used.length ? Math.max(...used) : 0;
  return [...new Set([...used, max + 1])].sort((a, b) => a - b);
}

/** How long a share stays importable, said as a countdown. */
function shareExpiry(expiresAt: number, nowSec: number): string {
  const left = Math.round(expiresAt / 1000) - nowSec;
  if (left <= 0) return "expired";
  if (left < 60) return `expires in ${left}s`;
  return `expires in ${Math.round(left / 60)}m`;
}

interface Props { onClose: () => void }

export default function AccountsPanel({ onClose }: Props) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const timerRef = useRef<number | null>(null);
  // Which account's row is expanded into its edit controls. One at a time —
  // the panel is 288px wide and two open rows leave nothing to look at.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  // Removal is irreversible, and there is no confirmation dialog anywhere in
  // this deck. The button becomes its own confirmation and gives up after a
  // few seconds, so a stray click can never be the second one.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [share, setShare] = useState<{ num: number; blob: string; expiresAt: number } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

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

  /** Every store-changing action is one POST to the same route. */
  const admin = useCallback(async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag);
    setFailure(null);
    try {
      const res = await fetch("/api/claude-accounts/admin", {
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

  // How close the active account is to tripping the rule. Both numbers are
  // already on screen — the binding lane is whichever is highest, same as the
  // one claude-swap measures against — so this costs nothing to show and
  // answers the question the threshold setting otherwise leaves hanging.
  const threshold = auto?.settings["autoswitch.threshold"]?.value ?? "90";
  const activeAcct = data?.accounts?.find(a => a.active);
  const activePct = activeAcct?.lanes.length
    ? Math.max(...activeAcct.lanes.map(l => l.pct))
    : null;
  const nearTrigger = activePct != null && activePct >= Number(threshold) - 15;

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
          <button type="button" className="btn ap-add" onClick={() => setAddOpen(true)}
            title="Sign in to another Claude account, or paste one shared from another deck">+</button>
          <button type="button" className="btn ap-refresh" onClick={() => load(true)} title="Reload from claude-swap">↻</button>
          <button type="button" className="btn icon-btn" onClick={onClose} aria-label="Close accounts panel" title="Close (A)">×</button>
        </div>
      </div>

      {data == null ? (
        <div className="ap-empty">Checking…</div>
      ) : !data.ok ? (
        <div className="ap-empty">
          {data.reason === "no_cswap" ? (
            <>
              <span>claude-swap isn't installed.</span>
              <span className="ap-hint">
                This panel reads the account store claude-swap keeps — without it there is
                nothing to show. It is a separate tool, published on PyPI, so it does not
                come with this package.
              </span>
              {data.hint && <code className="ap-cmd">{data.hint}</code>}
              <span className="ap-hint">Then add an account with the <strong>+</strong> button above.</span>
            </>
          ) : data.reason === "no_accounts" ? (
            <>
              <span>No accounts added yet.</span>
              <span className="ap-hint">
                claude-swap is installed but has nothing in its store. Use the <strong>+</strong> above
                to sign one in, or to paste one shared from another deck.
              </span>
            </>
          ) : (
            <>
              <span>Couldn't read the account store.</span>
              <span className="ap-hint">
                claude-swap is installed, but its store could not be read
                {data.reason ? ` (${data.reason})` : ""}.
              </span>
            </>
          )}
        </div>
      ) : (
        <>
          {data.accounts?.map(a => (
            <div key={a.num} className={`ap-account${a.active ? " active" : ""}${a.disabled ? " disabled" : ""}`}>
              <div className="ap-account-head">
                <span className="ap-num">{a.num}</span>
                {a.alias && <span className="ap-alias">{a.alias}</span>}
                <span className="ap-email" title={a.org ?? undefined}>{a.email}</span>
                <button type="button" className={`ap-more${menuFor === a.num ? " on" : ""}`}
                  aria-label={`Manage account ${a.num}`} aria-expanded={menuFor === a.num}
                  title="Share, rename, move, remove"
                  onClick={() => {
                    setMenuFor(menuFor === a.num ? null : a.num);
                    setAliasDraft(a.alias ?? "");
                    setConfirmRemove(null);
                    setShare(null);
                    setShareCopied(false);
                  }}>⋯</button>
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
                {/* A bare "9m ago" under a stack of percentages does not say
                    what happened 9 minutes ago — and the honest answer is not
                    "you looked", it is "claude-swap read this account". The
                    verb is the whole content of the line. */}
                {a.fetchedAt
                  ? <span
                      className={`ap-age${a.stale ? " ap-stale" : ""}`}
                      title={"When claude-swap last read this account's usage, and when it plans to read it again. "
                           + "It sets that interval itself — 3 minutes at the fastest, wider while an account is "
                           + "recovering from a rate limit — and every surface, including `cswap watch`, follows "
                           + "the same plan."}
                    >collected {ago(a.fetchedAt, nowSec)}{due(a.nextAt, nowSec)}</span>
                  : <span className="ap-age ap-stale" title="claude-swap has not read this account yet">never collected</span>}
              </div>

              {menuFor === a.num && (
                <div className="ap-manage">
                  <div className="ap-manage-row">
                    <span className="ap-manage-label">name</span>
                    <input
                      className="ap-manage-input"
                      type="text"
                      value={aliasDraft}
                      onChange={e => setAliasDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") admin({ action: "alias", account: a.num, alias: aliasDraft }, `alias-${a.num}`).then(() => load(true)); }}
                      placeholder="no alias"
                      spellCheck={false}
                      aria-label={`Alias for account ${a.num}`}
                    />
                    <button type="button" className="ap-manage-btn" disabled={busy != null || (aliasDraft.trim() === (a.alias ?? ""))}
                      onClick={() => admin({ action: "alias", account: a.num, alias: aliasDraft }, `alias-${a.num}`).then(() => load(true))}
                      title="A short name to show instead of the email">save</button>
                  </div>

                  <div className="ap-manage-row">
                    <span className="ap-manage-label">slot</span>
                    <span className="ap-field">
                      <select
                        aria-label={`Slot for account ${a.num}`}
                        value={String(a.num)}
                        disabled={busy != null}
                        onChange={e => admin({ action: "move", account: a.num, slot: Number(e.target.value) }, `move-${a.num}`).then(() => load(true))}
                      >
                        {slotOptions(data.accounts ?? []).map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </span>
                    <span className="ap-manage-hint">rotation order</span>
                  </div>

                  <div className="ap-manage-row">
                    <button type="button" className="ap-manage-btn" disabled={busy != null}
                      title="Copy this account to another agents-deck. The share carries a live login and expires in 10 minutes."
                      onClick={async () => {
                        setShareCopied(false);
                        const out = await admin({ action: "share", account: a.num }, `share-${a.num}`);
                        if (out?.ok) setShare({ num: a.num, blob: out.blob, expiresAt: out.expiresAt });
                      }}>share…</button>
                    {/* Two clicks, and the second one expires. There is no
                        confirmation dialog anywhere in this deck, and removing
                        an account cannot be undone. */}
                    <button
                      type="button"
                      className={`ap-manage-btn danger${confirmRemove === a.num ? " armed" : ""}`}
                      disabled={busy != null}
                      title={confirmRemove === a.num
                        ? "This deletes the stored credentials for this account"
                        : "Remove this account from claude-swap"}
                      onClick={() => {
                        if (confirmRemove !== a.num) {
                          setConfirmRemove(a.num);
                          window.setTimeout(() => setConfirmRemove(c => (c === a.num ? null : c)), 4000);
                          return;
                        }
                        setConfirmRemove(null);
                        admin({ action: "remove", account: a.num }, `rm-${a.num}`).then(() => { setMenuFor(null); load(true); });
                      }}
                    >{confirmRemove === a.num ? "confirm remove" : "remove"}</button>
                  </div>

                  {share?.num === a.num && (
                    <div className="ap-share">
                      <code className="ap-share-blob">{share.blob}</code>
                      <div className="ap-share-foot">
                        <button type="button" className="ap-manage-btn" onClick={async () => {
                          try { await navigator.clipboard.writeText(share.blob); setShareCopied(true); } catch { /* select it by hand */ }
                        }}>{shareCopied ? "copied" : "copy"}</button>
                        <span className="ap-manage-hint">
                          carries a live login · {shareExpiry(share.expiresAt, nowSec)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* ── auto-switch ── */}
          {auto?.ok && (
            <div className="ap-auto">
              {/* Title, live number, threshold and switch on one line. The
                  section is two facts and one control; stacked over three rows
                  it read like a form, and the row label ("switch when") only
                  restated the title. Left to right it now says what it is,
                  where you are, where it trips, and whether it is armed. */}
              <div className="ap-auto-head">
                <span className="ap-auto-title">Auto-switch</span>

                <span className="ap-auto-ctl">
                  {/* The live number belongs next to the threshold it is
                      racing: the setting means nothing without knowing where
                      you are. */}
                  {activePct != null && (
                    <span className={`ap-auto-now${nearTrigger ? " near" : ""}`}>{Math.round(activePct)}%</span>
                  )}
                  <span className="ap-field" title="Switch once the active account passes this much of its limit">
                    <select
                      aria-label="Switch threshold"
                      value={threshold}
                      disabled={busy != null}
                      onChange={e => post({ action: "setting", key: "autoswitch.threshold", value: e.target.value }, "threshold").then(() => load(true))}
                    >
                      {THRESHOLDS.map(t => <option key={t} value={t}>{t}%</option>)}
                    </select>
                  </span>

                  {/* Always a control, never a read-out. An earlier version
                      hid the toggle whenever a terminal loop was detected, on
                      the grounds that the deck's own loop would be redundant —
                      but a setting you cannot see is worse than a redundant
                      one, and the toggle still decides what happens the moment
                      that terminal loop stops. The terminal's state is shown
                      beside it instead of replacing it. */}
                  <button
                    type="button"
                    className={`ap-auto-state toggle${auto.enabled ? " live" : ""}`}
                    role="switch"
                    aria-checked={auto.enabled}
                    disabled={busy != null}
                    onClick={() => post({ action: "enable", enabled: !auto.enabled }, "enable").then(() => load(true))}
                    title={auto.enabled
                      ? "Stop switching accounts automatically"
                      : "Switch accounts automatically when the active one nears its limit"}
                  >
                    <i className={auto.enabled ? "ap-pulse" : "ap-dot"} aria-hidden />
                    {auto.enabled ? "on" : "off"}
                  </button>
                </span>
              </div>

              {/* Which engine is actually switching right now. Two would not
                  corrupt anything — claude-swap serializes under its state
                  lock — but they double the tick rate against a request budget
                  that is already the scarce resource, so the deck stands down
                  while the terminal loop runs and says so. */}
              {auto.external && (
                <p className="ap-auto-note">
                  <i className="ap-pulse" aria-hidden /> A <code>cswap auto</code> loop in your terminal is
                  doing the switching. The deck stands down while it runs
                  {auto.enabled ? " — this toggle takes over when you stop it." : "."}
                </p>
              )}

              {/* The one thing worth saying after the settings: that the loop
                  is alive. Only shown once a tick has actually happened —
                  before that there is nothing to report and an empty rule
                  under the settings reads like something failed to load. */}
              {auto.lastTick && (
                <div className="ap-auto-foot">
                  <span className="ap-auto-result">checked {ago(auto.lastTick.at, nowSec)}</span>
                </div>
              )}
            </div>
          )}

          {failure && <div className="ap-failure">{failure}</div>}

          <p className="ap-footnote" title="Anthropic's usage endpoint allows roughly 28–30 requests per hour per account, shared by every tool on this machine — polling it from here would rate-limit your account. So the deck never fetches: it asks claude-swap to collect while this panel is open, at most once every three minutes, and claude-swap decides whether that touches the network at all.">
            Collected by claude-swap while this panel is open.
          </p>
        </>
      )}

      {addOpen && (
        <AddAccountDialog
          onClose={() => setAddOpen(false)}
          onChanged={() => load(true)}
        />
      )}
    </div>
  );
}
