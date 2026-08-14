// The prompt in front of the deck's one irreversible action. Clear does not
// tidy a view: it empties the server's ring buffer and truncates events.jsonl,
// the log a restarted deck replays to rebuild everything on the canvas. The
// wording says so, because "Clear canvas" reads like something a refresh
// would undo and nothing here does.
//
// Escape and a backdrop click cancel, the same way ToolModal, AddAccountDialog
// and UsageHistoryModal do. Cancel takes focus on mount so a stray Enter or
// Space — and the "c" that opened this, since ownsKeystroke() leaves the keys
// of a focused button alone — lands on the harmless answer.
import React, { useEffect, useRef } from "react";

interface Props {
  /** Agents on the canvas right now: the visible half of what goes away. */
  agentCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ClearConfirm({ agentCount, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const removes = agentCount === 0
    ? "This deletes the server's event log"
    : `This removes ${agentCount === 1 ? "the one agent" : `all ${agentCount} agents`} on the canvas and deletes the server's event log`;

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal clear-confirm"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-confirm-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span className="status-dot err" aria-hidden />
            <span id="clear-confirm-title" className="modal-tool-name">Clear the deck?</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn icon-btn" onClick={onCancel} aria-label="Cancel (Esc)" title="Cancel (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          <p className="modal-note">
            {removes} — the file a restarted deck replays to rebuild what you see. Layout,
            pins and selection go with it. This cannot be undone.
          </p>
          <div className="cc-actions">
            <button type="button" ref={cancelRef} className="btn" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn danger" onClick={onConfirm}>Clear everything</button>
          </div>
        </section>
      </div>
    </div>
  );
}
