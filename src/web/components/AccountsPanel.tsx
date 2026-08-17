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
import { commandOutput, explainCommandFailure, explainFailure } from "../admin-failure";
import { type SwapNote, manageAfterMove, slotChoices } from "../account-move";
import { aliasSave } from "../alias-save";
import { PRODUCT } from "../brand";
import {
  type Failure,
  RELOAD_UNREACHABLE,
  answered,
  explainReload,
  nextFailure,
} from "../accounts-reload";

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
// How long the "a second account moved too" line stands. Long enough to read a
// sentence the user did not ask for, short enough that a manage block left open
// does not keep reporting a move from ten minutes ago. Same shape as the
// panel's other transient states — `copied` at 1.8s, an armed remove at 4s.
const SWAP_NOTE_MS = 8_000;
// How long `save` stands as `saved`. The panel's other transient confirmations
// — `copied` on a share — use the same 1.8s, and the word is the whole signal.
const SAVED_MS = 1_800;
// Past this, a reload is called dead rather than slow. Both routes can spawn
// cswap, and the server kills those at 20 seconds, so anything shorter would
// abort answers that were still coming.
const RELOAD_TIMEOUT_MS = 30_000;
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
/**
 * claude-swap's failure codes, said in the product's voice.
 *
 * These come straight out of its store, and the panel used to print whatever it
 * found — which is how a user ended up looking at `invalid_grant` on their
 * ACTIVE account with nothing to do about it. Two of these are permanent and
 * only the user can clear them: the stored refresh token is dead, and every
 * poll will keep failing until someone signs in again. Those get `fixable`, and
 * the row grows a button.
 */
export function errorText(code: string): { text: string; hint: string; fixable: boolean } {
  switch (code) {
    case "invalid_grant":
    case "no_refresh_token":
      return {
        text: "login expired",
        hint: "claude-swap's stored login for this account was rejected and cannot be refreshed. "
            + "Signing in again replaces it — the account keeps its slot, its alias and its history.",
        fixable: true,
      };
    case "http-401":
      return { text: "re-login needed", hint: "Anthropic refused this account's token.", fixable: true };
    case "http-429":
      return { text: "rate limited", hint: "Anthropic is throttling requests for this account. It clears on its own.", fixable: false };
    case "transient":
      return { text: "temporary error", hint: "A network or server hiccup while reading usage. The next collection retries.", fixable: false };
    case "timeout":
      return { text: "timed out", hint: "Reading this account's usage took too long. The next collection retries.", fixable: false };
    case "network":
      return { text: "unreachable", hint: "Could not reach Anthropic to read this account's usage.", fixable: false };
    default:
      // Still shown, because a code we have not met is better than silence —
      // but labelled as one, so it does not read as a sentence.
      return { text: code, hint: `claude-swap reported "${code}" for this account.`, fixable: false };
  }
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

/**
 * Copy text, and say whether it worked.
 *
 * navigator.clipboard is undefined outside a secure context and can sit
 * unresolved while the browser decides on permission — which leaves a Copy
 * button silently dead. Race it, then fall back to the old selection trick.
 * Same shape as the version banner's copy, for the same reason.
 */
async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try {
    ok = await Promise.race([
      navigator.clipboard?.writeText(text).then(() => true) ?? Promise.resolve(false),
      new Promise<boolean>(r => window.setTimeout(() => r(false), 500)),
    ]);
  } catch { ok = false; }
  if (ok) return true;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand("copy");
    ta.remove();
  } catch { ok = false; }
  return ok;
}

/** How long a share stays importable, said as a countdown. `tone` drives the
 *  colour: a share is a live credential, so running out is worth noticing. */
export function shareExpiry(expiresAt: number, nowSec: number): { text: string; tone: "ok" | "soon" | "gone" } {
  const left = Math.round(expiresAt / 1000) - nowSec;
  if (left <= 0) return { text: "expired", tone: "gone" };
  if (left < 60) return { text: `expires in ${left}s`, tone: "soon" };
  return { text: `expires in ${Math.round(left / 60)}m`, tone: "ok" };
}

interface Props { onClose: () => void }

export default function AccountsPanel({ onClose }: Props) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [switching, setSwitching] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const timerRef = useRef<number | null>(null);
  // Which account's row is expanded into its edit controls. One at a time —
  // the panel is 288px wide and two open rows leave nothing to look at.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  // Which account's alias was just stored. `save` is never disabled by the
  // draft matching the alias any more — that was the block's resting state and
  // it rendered at 1.98:1 — so the button confirms instead of greying out.
  const [aliasSaved, setAliasSaved] = useState<number | null>(null);
  // Removal is irreversible, and there is no confirmation dialog anywhere in
  // this deck. The button becomes its own confirmation and gives up after a
  // few seconds, so a stray click can never be the second one.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [share, setShare] = useState<{ num: number; blob: string; expiresAt: number } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  // A move into an occupied slot relocates an account the user never picked.
  // Nothing else on screen says so — both accounts simply appear where they
  // were not — so the slot row says it, in the block that did it.
  const [swapNote, setSwapNote] = useState<SwapNote | null>(null);

  // A reload the user asked for, and the same one on a timer. Only the forced
  // half touches `reloading`: a poll blinking the ↻ every 15 seconds would read
  // as the panel doing something to itself.
  const load = useCallback(async (force = false) => {
    if (force) setReloading(true);
    // A deck that accepts the connection and then wedges never rejects these
    // fetches. Unbounded, the first load would sit on "Checking…" behind a ↻
    // disabled forever — the dead button this busy state exists to rule out,
    // made permanent.
    const ctl = new AbortController();
    const bell = window.setTimeout(() => ctl.abort(), RELOAD_TIMEOUT_MS);
    try {
      const [accts, autoRes] = await Promise.all([
        fetch(`/api/claude-accounts${force ? "?refresh=1" : ""}`, { signal: ctl.signal }),
        fetch("/api/cswap-auto", { signal: ctl.signal }),
      ]);
      if (accts.ok)    setData(await accts.json());
      if (autoRes.ok)  setAuto(await autoRes.json());
      const verdict = explainReload([await answered(accts), await answered(autoRes)]);
      setFailure(prev => nextFailure(prev, verdict));
    } catch {
      setFailure(prev => nextFailure(prev, RELOAD_UNREACHABLE));
    } finally {
      window.clearTimeout(bell);
      if (force) setReloading(false);
    }
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
      // This route's `detail` is cswap's stderr verbatim, not a sentence
      // anybody wrote — same as the switch below, and unlike the admin route.
      if (!out?.ok) setFailure({ text: explainCommandFailure(out, "command failed"), raw: commandOutput(out) });
      return out;
    } catch {
      setFailure({ text: "server unreachable" });
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
      // The admin route composes its `detail` with failureText(), so here the
      // server's own words are the message and explainFailure ranks them first.
      if (!out?.ok) setFailure({ text: explainFailure(out, "command failed") });
      return out;
    } catch {
      setFailure({ text: "server unreachable" });
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
      if (!body?.ok) setFailure({ text: explainCommandFailure(body, "the switch failed"), raw: commandOutput(body) });
      await load(true);
    } catch {
      setFailure({ text: "server unreachable" });
    } finally {
      setSwitching(null);
    }
  };

  /**
   * Store the alias in the field, and say so.
   *
   * Both endings are the same word. A draft that already matches the store is
   * not a failure and not a no-op the user should have to detect — it is an
   * alias that is saved — so it confirms without a round trip, and a draft that
   * differs confirms once the store has it. `saved` replaces the disabled state
   * the block used to open in.
   */
  const doAlias = async (num: number, stored: string | null) => {
    const { commit, alias } = aliasSave(aliasDraft, stored);
    if (commit) {
      const out = await admin({ action: "alias", account: num, alias }, `alias-${num}`);
      await load(true);
      if (!out?.ok) return;
      // The store now holds the trimmed value, so the field should too — or the
      // next comparison is against a draft the store never saw.
      setAliasDraft(alias);
    }
    setAliasSaved(num);
    window.setTimeout(() => setAliasSaved(n => (n === num ? null : n)), SAVED_MS);
  };

  /**
   * Send an account to another slot, then put the manage block back where its
   * account went.
   *
   * The reload alone is not enough: `cswap move` into an occupied slot is a
   * swap, so the slot numbers this block is keyed by change hands underneath
   * it. manageAfterMove decides what survives that; a refused move returns
   * null and nothing here is touched, leaving the block open and armed exactly
   * as the user left it with the failure box below to say why.
   */
  const doMove = async (from: number, to: number) => {
    const out = await admin({ action: "move", account: from, slot: to }, `move-${from}`);
    const next = manageAfterMove(
      { menuFor, confirmRemove, shareFor: share?.num ?? null, swapNote },
      from,
      out,
    );
    // The roster first, then the block, and never the other way round: the two
    // disagree about who holds a slot for exactly as long as one has moved on
    // and the other has not, and that disagreement IS the bug — the block
    // rendered over a row belonging to somebody else. Both updates land in the
    // same tick here, so no render is ever caught between them.
    await load(true);
    if (next) {
      setMenuFor(next.menuFor);
      setConfirmRemove(next.confirmRemove);
      if (next.shareFor == null) { setShare(null); setShareCopied(false); }
      setSwapNote(next.swapNote);
      const note = next.swapNote;
      if (note) window.setTimeout(() => setSwapNote(n => (n === note ? null : n)), SWAP_NOTE_MS);
    }
  };

  return (
    // Named for the topbar toggle's aria-controls — see UsagePanel.
    <div className="accounts-panel" id="accounts-panel" aria-label="Claude accounts">
      <div className="ap-header">
        <h3>Accounts</h3>
        <div className="ap-header-right">
          <button type="button" className="btn ap-add" onClick={() => setAddOpen(true)}
            title="Sign in to another Claude account, or paste one shared from another deck">+</button>
          <button type="button" className="btn ap-refresh" onClick={() => load(true)}
            disabled={reloading} aria-label="Reload accounts"
            title="Reload from claude-swap">{reloading ? "…" : "↻"}</button>
          <button type="button" className="btn icon-btn" onClick={onClose} aria-label="Close accounts panel" title="Close (A)">×</button>
        </div>
      </div>

      {/* Nothing has arrived yet. "Checking…" is only true while a request is
          still out: the panel's failure box lives inside the branch below,
          which needs a roster to render, so a first load that failed used to
          leave this word standing with nothing behind it. */}
      {data == null ? (
        failure ? (
          <div className="ap-empty" role="alert">
            <span title={failure.raw || undefined}>{failure.text}</span>
            <span className="ap-hint">
              No accounts have arrived, so there is nothing to show yet. The panel keeps
              trying every {POLL_MS / 1000} seconds.
            </span>
            <button type="button" className="ap-fix" disabled={reloading} onClick={() => load(true)}>
              {reloading ? "trying…" : "try again"}
            </button>
          </div>
        ) : (
          <div className="ap-empty">Checking…</div>
        )
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
                {/* aria-controls only while the block exists: an IDREF that
                    resolves to nothing is not a relationship, it is a dangling
                    pointer, and closed is exactly when there is nothing to
                    point at. */}
                <button type="button" className={`ap-more${menuFor === a.num ? " on" : ""}`}
                  aria-label={`Manage account ${a.num}`} aria-expanded={menuFor === a.num}
                  aria-controls={menuFor === a.num ? `ap-manage-${a.num}` : undefined}
                  title="Share, rename, move, remove"
                  onClick={() => {
                    setMenuFor(menuFor === a.num ? null : a.num);
                    setAliasDraft(a.alias ?? "");
                    setConfirmRemove(null);
                    setShare(null);
                    setShareCopied(false);
                    setSwapNote(null);
                    setAliasSaved(null);
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
                {a.error && (() => {
                  const e = errorText(a.error);
                  return (
                    <>
                      <span className="ap-err" title={e.hint}>{e.text}</span>
                      {/* A dead login is the one failure here that no amount of
                          waiting fixes, so the fix is one click away rather
                          than a paragraph away. */}
                      {e.fixable && (
                        <button type="button" className="ap-fix" onClick={() => setAddOpen(true)}
                          title="Open the sign-in dialog. Signing in as this account replaces its stored login in place.">
                          sign in again
                        </button>
                      )}
                    </>
                  );
                })()}
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
                /* A named group, so a screen reader that has just heard "Manage
                   account 2, expanded" is told what the three rows underneath
                   belong to instead of walking into unattributed form fields. */
                <div className="ap-manage" id={`ap-manage-${a.num}`}
                  role="group" aria-label={`Manage account ${a.num}`}>
                  <div className="ap-manage-name">
                    {/* A real <label> still, only no longer on screen. The word
                        `name` beside a field whose placeholder already reads
                        `e.g. work` was a 34px gutter spent restating the field,
                        and the same gutter on the two rows below pushed every
                        control into two thirds of a 259px column. Hidden rather
                        than dropped for an aria-label, because the association
                        is what a screen reader and voice control both use, and
                        2.5.3 has nothing to disagree with once no label shows. */}
                    <label className="vis-hidden" htmlFor={`ap-alias-${a.num}`}>Alias</label>
                    <input
                      id={`ap-alias-${a.num}`}
                      className="ap-manage-input"
                      type="text"
                      value={aliasDraft}
                      onChange={e => setAliasDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") doAlias(a.num, a.alias); }}
                      /* An example, not a narration of the empty state: "no
                         alias" reads as a field whose value is those two words. */
                      placeholder="e.g. work"
                      spellCheck={false}
                      /* The block is a form revealed by a button, and the field
                         at the top of it is where the keyboard should land —
                         otherwise reaching it means tabbing back through the
                         switch, the lanes and the freshness line. It mounts
                         only when the block opens, so this fires exactly then. */
                      autoFocus
                    />
                    <button type="button" className="ap-manage-btn" disabled={busy != null}
                      onClick={() => doAlias(a.num, a.alias)}
                      title="A short name to show instead of the email"
                    >{aliasSaved === a.num ? "saved" : "save"}</button>
                  </div>

                  {/* Three verbs on one line. They were three labelled rows —
                      `slot`, `share` and a `remove` under its own rule — each
                      one a control with a word introducing it and a sentence
                      explaining it. None of the three needed either once the
                      controls said what they do: the picker names the slot and
                      the consequence per option, and a button called `share` is
                      not clarified by being told it is the share row. */}
                  <div className="ap-manage-acts">
                    <label className="vis-hidden" htmlFor={`ap-slot-${a.num}`}>Slot</label>
                    <span className="ap-field">
                      <select
                        id={`ap-slot-${a.num}`}
                        value={String(a.num)}
                        disabled={busy != null}
                        onChange={e => doMove(a.num, Number(e.target.value))}
                      >
                        {/* `rotation order` named the number and never the
                            effect; `swaps if the slot is taken` named the effect
                            and left the reader to work out which slots those
                            were — all of them but the last. On the options, the
                            warning sits on the choice that carries it and the
                            one harmless move is visible as the exception. */}
                        {slotChoices((data.accounts ?? []).map(x => x.num), a.num)
                          .map(c => <option key={c.slot} value={c.slot}>{c.label}</option>)}
                      </select>
                    </span>
                    <button type="button" className="ap-manage-btn" disabled={busy != null}
                      title={`Copy this account to another ${PRODUCT}. The share carries a live login and expires in 10 minutes.`}
                      onClick={async () => {
                        setShareCopied(false);
                        const out = await admin({ action: "share", account: a.num }, `share-${a.num}`);
                        if (out?.ok) setShare({ num: a.num, blob: out.blob, expiresAt: out.expiresAt });
                      }}>share</button>
                    {/* Two clicks, and the second one expires. There is no
                        confirmation dialog anywhere in this deck and removing an
                        account cannot be undone, so it is pushed to the far edge
                        of the row: 47px of empty space, measured, against the
                        14px that separated it from `share` when it had a row of
                        its own. `confirm` rather than `confirm remove` because
                        the long form is 99px and would leave the row one pixel
                        of slack and no gap at all — see the pinned width in
                        styles.css, which is what stops the button moving out
                        from under the second click as it arms. */}
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
                    >{confirmRemove === a.num ? "confirm" : "remove"}</button>
                  </div>

                  {/* A move into an occupied slot relocates an account the user
                      never picked, and this is the only place that says so. It
                      is a row that exists for eight seconds and then does not,
                      which is why the block can be two rows at rest and still
                      report something that happens on one move in three. */}
                  {swapNote?.at === a.num && (() => {
                    const other = data.accounts?.find(x => x.num === swapNote.displaced);
                    const who = other?.alias ?? other?.email ?? "the account that was there";
                    return (
                      <span className="ap-manage-hint ap-manage-swap"
                        title={`Slot ${swapNote.at} was taken, so the two accounts traded places: `
                             + `${who} now holds slot ${swapNote.displaced}.`}>
                        swapped with slot {swapNote.displaced}
                      </span>
                    );
                  })()}

                  {share?.num === a.num && (() => {
                    const exp = shareExpiry(share.expiresAt, nowSec);
                    const dead = exp.tone === "gone";
                    return (
                      <div className={`ap-share${dead ? " expired" : ""}`}>
                        <code className="ap-share-blob">{share.blob}</code>
                        <div className="ap-share-foot">
                          {/* An expired blob is refused by the other deck, so
                              offering to copy it is offering a dead end. */}
                          <button type="button" className="ap-manage-btn" disabled={busy != null}
                            onClick={async () => {
                              if (dead) {
                                setShareCopied(false);
                                const out = await admin({ action: "share", account: a.num }, `share-${a.num}`);
                                if (out?.ok) setShare({ num: a.num, blob: out.blob, expiresAt: out.expiresAt });
                                return;
                              }
                              if (await copyText(share.blob)) {
                                setShareCopied(true);
                                window.setTimeout(() => setShareCopied(false), 1800);
                              }
                            }}>
                            {dead ? "make a new share" : shareCopied ? "copied" : "copy"}
                          </button>
                          <span className="ap-manage-hint">
                            carries a live login · <span className={`ap-share-expiry ${exp.tone}`}>{exp.text}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })()}

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
                    className={`ap-auto-state${auto.enabled ? " live" : ""}`}
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

          {/* Announced, because a switch that failed is the answer to a click
              that happened somewhere else in the panel, and dismissible,
              because nothing else here clears it: the next action does, and
              until then a stale refusal sits under a roster that has since
              moved on. */}
          {failure && (
            <div className="ap-failure" role="alert">
              <span className="ap-failure-text" title={failure.raw || undefined}>{failure.text}</span>
              <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
                aria-label="Dismiss this message" title="Dismiss">×</button>
            </div>
          )}

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
