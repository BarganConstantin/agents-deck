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
import React, { useCallback, useEffect, useRef, useState } from "react";

/** Server-side login progress, polled while the dialog is open. */
type LoginState = {
  state: "idle" | "awaiting_url" | "awaiting_code" | "registering" | "done" | "failed";
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

// Said in the product's voice. Each is a decision the server made on purpose,
// so each gets a sentence rather than a code.
const REASONS: Record<string, string> = {
  already_running: "a sign-in is already in progress",
  no_url: "the claude CLI did not offer a sign-in link — is it installed?",
  not_waiting: "that sign-in is no longer waiting for a code",
  not_prompted: "the CLI has not asked for a code yet",
  code_rejected: "that code was not accepted — copy it again from the browser",
  no_verdict: "the claude CLI has not answered — try the code again",
  empty_code: "paste the code from the browser first",
  login_failed: "the code was not accepted",
  no_identity: "signed in, but the CLI still reports nobody logged in",
  add_failed: "signed in, but claude-swap could not record the account",
  not_a_share: "that does not look like a shared account — it should start with ccdeck1:",
  corrupt: "that share is incomplete — copy the whole thing",
  wrong_version: "that share was made by a newer agents-deck",
  expired: "that share has expired — make a new one",
  import_failed: "claude-swap refused the import",
};

// `error` is what the route sends when the server threw: without it, a crash in
// the handler reaches the user as the generic fallback — indistinguishable from
// a refusal, and that is how a broken import spent a release looking like a
// rejected one.
const say = (out: { reason?: string; detail?: string; error?: string } | null, fallback: string) =>
  out?.detail || (out?.reason ? REASONS[out.reason] ?? out.reason : null) || out?.error || fallback;

export default function AddAccountDialog({ onClose, onChanged }: Props) {
  const [tab, setTab] = useState<"login" | "paste">("login");
  const [login, setLogin] = useState<LoginState | null>(null);
  const [code, setCode] = useState("");
  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ added: boolean; num: string | null } | null>(null);
  const startedRef = useRef(false);
  const codeRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    // A live `claude auth login` on the server outlives this component, and an
    // abandoned one holds the next attempt hostage for five minutes. Cancelling
    // also puts the previous account back if the sign-in already completed.
    if (startedRef.current) admin({ action: "login-cancel" }).catch(() => {});
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Start the sign-in as soon as that tab is chosen: the URL is the first thing
  // the user needs, and asking them to press "begin" first buys nothing.
  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    startedRef.current = true;
    const out = await admin({ action: "login" }).catch(() => null);
    setBusy(false);
    if (!out?.ok) { setError(say(out, "could not start the sign-in")); return; }
    setLogin(out as LoginState);
  }, []);

  useEffect(() => {
    if (tab !== "login" || startedRef.current) return;
    start();
  }, [tab, start]);

  // Poll only while something is actually moving on the server.
  useEffect(() => {
    if (!login || login.state === "done" || login.state === "failed") return;
    const iv = window.setInterval(async () => {
      try {
        const res = await fetch("/api/claude-accounts/login");
        if (res.ok) setLogin(await res.json());
      } catch { /* the next tick tries again */ }
    }, POLL_MS);
    return () => window.clearInterval(iv);
  }, [login]);

  useEffect(() => {
    if (login?.state === "awaiting_code") codeRef.current?.focus();
    if (login?.state === "done") onChanged();
  }, [login?.state, onChanged]);

  const submitCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    const out = await admin({ action: "login-code", code }).catch(() => null);
    setBusy(false);
    if (!out?.ok) {
      setError(say(out, "the code was not accepted"));
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
    if (!out?.ok) { setError(say(out, "the import failed")); return; }
    setBlob("");
    setImported({ added: out.added === true, num: out.num ?? null });
    onChanged();
  }, [blob, onChanged]);

  const done = login?.state === "done" ? login.account : null;

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
              <div className="aa-step">
                <h4>{done.added ? `Added account ${done.num}` : "Credentials refreshed"}</h4>
                <p className="aa-note">
                  {done.email}
                  {done.added
                    ? " is now in the rotation. The account you were using is still active."
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
            ) : login?.state === "failed" || error ? (
              <div className="aa-step">
                <h4>Sign-in failed</h4>
                <p className="aa-err">{error ?? login?.error}</p>
                <button type="button" className="btn" onClick={() => { startedRef.current = false; setLogin(null); setError(null); start(); }}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="aa-step"><p className="aa-note">Asking the claude CLI for a sign-in link…</p></div>
            )
          ) : (
            <div className="aa-step">
              <h4>Paste an account shared from another deck</h4>
              <div className="aa-field">
                <input
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
              {imported && (
                <p className="aa-note">
                  {imported.added
                    ? `Added account ${imported.num}.`
                    : "That account was already here, so nothing changed."}
                </p>
              )}
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
