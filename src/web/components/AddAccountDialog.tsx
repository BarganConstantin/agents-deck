// Adding an account without a terminal.
//
// Two ways in, because they are genuinely different journeys. Signing in is a
// conversation with Anthropic — a link, then a code that comes back through the
// browser. Pasting a shared account is a one-shot transfer from another deck.
//
// The sign-in half has a shape worth stating: `claude auth login` prints a URL
// and then BLOCKS on stdin waiting for the code, so a process stays alive on
// the server between the two steps here. That is why this is a dialog with
// state rather than a single form — and why closing it has to cancel, not just
// disappear.
//
// And nothing starts until asked. This used to launch the sign-in the moment
// the dialog opened, which threw a browser tab at anyone who came here to paste
// a share — an irreversible side effect as the greeting. Opening a dialog is
// not consent to open a browser.
import React, { useCallback, useEffect, useRef, useState } from "react";
import Confetti from "./Confetti";
import { isLoginOver, loginEndNotice, shouldPollLogin, type LoginServerState } from "../login-flow";
import { createLoginAnnouncer } from "../login-announce";
import { explainFailure } from "../admin-failure";
import { useModalDismiss } from "./use-modal-dismiss";

/** Server-side login progress, polled while the dialog is open. */
type LoginState = {
  state: LoginServerState;
  url: string | null;
  error: string | null;
  account: { num: string | null; email: string; added: boolean } | null;
  expiresAt: number | null;
};

type Props = {
  onClose: () => void;
  /** Reload the roster — a new account only appears once the panel re-reads. */
  onChanged: () => void;
};

const POLL_MS = 1500;

async function admin(body: Record<string, unknown>) {
  const res = await fetch("/api/claude-accounts/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

/** The check mark, drawn rather than shown. 340ms, ease-out, once. */
const SuccessMark = React.forwardRef<SVGSVGElement>((_props, ref) => {
  return (
    <svg className="aa-mark" viewBox="0 0 44 44" aria-hidden ref={ref}>
      <circle className="aa-mark-ring" cx="22" cy="22" r="20" />
      <path className="aa-mark-tick" d="M13.5 22.5 L19.5 28.5 L31 17" />
    </svg>
  );
});
SuccessMark.displayName = "SuccessMark";

export default function AddAccountDialog({ onClose, onChanged }: Props) {
  const [tab, setTab] = useState<"login" | "paste">("login");
  const [login, setLogin] = useState<LoginState | null>(null);
  const [code, setCode] = useState("");
  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ added: boolean; num: string | null; email: string | null } | null>(null);
  const startedRef = useRef(false);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const blobRef = useRef<HTMLInputElement | null>(null);
  // The burst needs a point on screen to come from, and the mark is it.
  const markRef = useRef<SVGSVGElement | null>(null);

  const close = useCallback(() => {
    // A live `claude auth login` on the server outlives this component, and an
    // abandoned one holds the next attempt hostage for five minutes. Cancelling
    // also puts the previous account back if the sign-in already completed.
    if (startedRef.current) admin({ action: "login-cancel" }).catch(() => {});
    onClose();
  }, [onClose]);

  // `close`, not `onClose`: Escape has to cancel the sign-in running on the
  // server, exactly as the × does. The dialog picks its own first field per
  // tab, so no focusRef here.
  useModalDismiss(close);

  // Started by the button, never by arriving. `claude auth login` opens a
  // browser tab as its first act, and a dialog that does that before being
  // asked is a dialog nobody trusts to open again.
  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    startedRef.current = true;
    const out = await admin({ action: "login" }).catch(() => null);
    setBusy(false);
    if (!out?.ok) { setError(explainFailure(out, "could not start the sign-in")); return; }
    setLogin(out as LoginState);
  }, []);

  // Poll only while something is actually moving on the server — see
  // login-flow.ts for why "idle" ends the loop rather than continuing it.
  useEffect(() => {
    if (!shouldPollLogin(login?.state)) return;
    const iv = window.setInterval(async () => {
      try {
        const res = await fetch("/api/claude-accounts/login");
        if (res.ok) setLogin(await res.json());
      } catch { /* the next tick tries again */ }
    }, POLL_MS);
    return () => window.clearInterval(iv);
  }, [login]);

  // Both of these are read by the effect below and neither may appear in its
  // dependency list: AccountsPanel hands this dialog a new `onChanged` on every
  // render, so depending on it made the roster reload a function of rendering
  // rather than of the sign-in, and the success card kept the dialog mounted
  // long enough for that to become a permanent request loop — see
  // login-announce.ts for what each turn of it cost.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const announcerRef = useRef(createLoginAnnouncer());

  useEffect(() => {
    if (login?.state === "awaiting_code") codeRef.current?.focus();
    if (announcerRef.current.shouldAnnounce(login?.state)) onChangedRef.current();
  }, [login?.state]);

  // The share tab's field is the only thing on it; focusing it saves a click
  // and makes ⌘V the obvious next move.
  useEffect(() => { if (tab === "paste") blobRef.current?.focus(); }, [tab]);

  const submitCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    const out = await admin({ action: "login-code", code }).catch(() => null);
    setBusy(false);
    if (!out?.ok) {
      setError(explainFailure(out, "the code was not accepted"));
      // A rejected code does not end the sign-in — the CLI is still asking, so
      // the field stays open with the bad value selected for retyping.
      if (out?.state) setLogin(out as LoginState);
      codeRef.current?.select();
      return;
    }
    setCode("");
    setLogin(out as LoginState);
  }, [code, login]);

  const submitBlob = useCallback(async () => {
    setBusy(true);
    setError(null);
    const out = await admin({ action: "import", blob }).catch(() => null);
    setBusy(false);
    if (!out?.ok) { setError(explainFailure(out, "the import failed")); return; }
    setBlob("");
    setImported({ added: out.added === true, num: out.num ?? null, email: out.email ?? null });
    onChanged();
  }, [blob, onChanged]);

  const done = login?.state === "done" ? login.account : null;
  // A sign-in that is over without having succeeded: the server's own "failed",
  // or the "idle" it reports once it no longer holds the flow at all. Both end
  // the same way — no spinner, no poll, and a sentence that says which of the
  // two happened.
  const ended = isLoginOver(login?.state) || Boolean(error && startedRef.current && !busy);
  const notice = loginEndNotice({ state: login?.state, serverError: login?.error, localError: error });

  return (
    <div className="modal-backdrop" onClick={close} role="presentation">
      <div className="modal aa-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add a Claude account">
        <header className="modal-head">
          <div className="modal-title">
            <span className="aa-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "login"}
                className={`aa-tab${tab === "login" ? " on" : ""}`} onClick={() => setTab("login")}>Sign in</button>
              <button type="button" role="tab" aria-selected={tab === "paste"}
                className={`aa-tab${tab === "paste" ? " on" : ""}`} onClick={() => setTab("paste")}>Paste a share</button>
            </span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn icon-btn" onClick={close} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body aa-body">
          {tab === "login" ? (
            done ? (
              <div className="aa-done">
                <SuccessMark ref={markRef} />
                <Confetti anchor={markRef} />
                <h4>{done.added ? `Account ${done.num} added` : "Credentials refreshed"}</h4>
                <p className="aa-note">
                  <strong>{done.email}</strong>
                  {done.added
                    ? " is in the rotation. The account you were using is still active."
                    : " was already managed, so its stored credentials were replaced."}
                </p>
                <button type="button" className="btn primary" onClick={onClose}>Done</button>
              </div>
            ) : login?.state === "awaiting_code" || login?.state === "registering" ? (
              <>
                <div className="aa-step">
                  <h4>1 · Approve in the browser</h4>
                  <p className="aa-note">A tab should have opened. If not, use this link:</p>
                  <a className="aa-link" href={login.url ?? "#"} target="_blank" rel="noreferrer noopener">{login.url}</a>
                </div>
                <div className="aa-step">
                  <h4>2 · Paste the code it gives you</h4>
                  <div className="aa-field">
                    <input
                      ref={codeRef}
                      type="text"
                      value={code}
                      onChange={e => setCode(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && code.trim() && !busy) submitCode(); }}
                      placeholder="paste the code here"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Sign-in code"
                      disabled={login.state === "registering"}
                    />
                    <button type="button" className="btn primary" disabled={busy || !code.trim() || login.state === "registering"}
                      onClick={submitCode}>
                      {login.state === "registering" ? "registering…" : "Continue"}
                    </button>
                  </div>
                  {/* A rejected code leaves the flow in awaiting_code — which is
                      right, the CLI is still asking — but that branch is above
                      the failure branch, so without this the message had
                      nowhere to render and the user retyped blind. */}
                  {(error || login.error) && <p className="aa-err">{error ?? login.error}</p>}
                  <p className="aa-note">
                    The code goes straight to the claude CLI on this machine. It is never stored or sent anywhere else.
                  </p>
                </div>
              </>
            ) : ended ? (
              <div className="aa-step">
                <h4>{notice.title}</h4>
                <p className="aa-err">{notice.message}</p>
                <button type="button" className="btn" onClick={() => { startedRef.current = false; setLogin(null); setError(null); start(); }}>
                  Try again
                </button>
              </div>
            ) : busy || startedRef.current ? (
              <div className="aa-step"><p className="aa-note">Asking the claude CLI for a sign-in link…</p></div>
            ) : (
              // The primer. Says what the button will do before it does it —
              // this one opens a browser tab, which is not something to spring
              // on someone who wanted the other tab.
              <div className="aa-step aa-primer">
                <h4>Sign in to Anthropic</h4>
                <p className="aa-note">
                  Opens a browser tab where you approve the sign-in, then asks for the code it shows you.
                  claude-swap records the account when it completes, and the account you are using now stays active.
                </p>
                <div className="aa-actions">
                  <button type="button" className="btn primary" onClick={start} disabled={busy}>
                    Open the sign-in page
                  </button>
                </div>
              </div>
            )
          ) : imported ? (
            <div className="aa-done">
              <SuccessMark ref={markRef} />
              {/* Only when something actually arrived: celebrating a no-op is
                  how a celebration stops meaning anything. */}
              {imported.added && <Confetti anchor={markRef} />}
              <h4>{imported.added ? `Account ${imported.num} imported` : "Already here"}</h4>
              <p className="aa-note">
                {imported.added ? (
                  <>
                    {imported.email ? <strong>{imported.email}</strong> : "That account"} is in the rotation now.
                    Nothing changed on the deck you copied it from.
                  </>
                ) : (
                  "This deck already holds that account, so nothing changed."
                )}
              </p>
              <div className="aa-actions">
                <button type="button" className="btn primary" onClick={onClose}>Done</button>
                <button type="button" className="btn" onClick={() => setImported(null)}>Import another</button>
              </div>
            </div>
          ) : (
            <div className="aa-step">
              <h4>Paste an account shared from another deck</h4>
              <div className="aa-field">
                <input
                  ref={blobRef}
                  type="text"
                  value={blob}
                  onChange={e => setBlob(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && blob.trim() && !busy) submitBlob(); }}
                  placeholder="ccdeck1:…"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Shared account"
                />
                <button type="button" className="btn primary" disabled={busy || !blob.trim()} onClick={submitBlob}>
                  {busy ? "importing…" : "Import"}
                </button>
              </div>
              {error && <p className="aa-err">{error}</p>}
              <p className="aa-note">
                Use <strong>share</strong> on an account in the other deck. A share carries a live login and expires ten minutes after it is made.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
