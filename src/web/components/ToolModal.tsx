import React from "react";
import type { ToolCall } from "../types";
import { useModalDismiss } from "./use-modal-dismiss";

function safeJson(v: unknown): string {
  if (v == null) return "(none)";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function dur(t: ToolCall): string {
  if (t.endedAt == null) return "in-flight…";
  const ms = t.endedAt - t.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export default function ToolModal({
  tool,
  onClose,
}: {
  tool: ToolCall;
  onClose: () => void;
}) {
  // No focusRef: the × is the first control in the dialog, so the hook's own
  // default — the first tabbable — already lands there. What this modal was
  // missing is the ref below, without which there is no boundary to hold Tab
  // inside and the claim on the surface tag is a claim about nothing.
  const dialogRef = useModalDismiss(onClose);

  const status =
    tool.endedAt == null ? "inflight"
    : tool.ok === false  ? "err"
    :                       "done";

  return (
    // The scrim is the dismiss gesture, not the dialog: with role="dialog" on
    // it, a screen reader drew the boundary around the click-to-close backdrop
    // and announced an unnamed "dialog", because neither element carried a
    // name. The name is the tool, which is the only thing that tells one of
    // these apart from the next.
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="tool-modal-title">
        <header className="modal-head">
          <div className="modal-title">
            {/* Decoration, and marked as such (#373). This dot keeps its hue
                and gains no mark, because unlike the row in the tool list this
                dialog already carries all three states in words: the duration
                reads `in-flight…` while a call is open, the Response section is
                tagged `error` when it failed, and done is the one that is
                neither. The dot reinforces that; it is not the only channel. */}
            <span className={`status-dot ${status}`} aria-hidden />
            <span id="tool-modal-title" className="modal-tool-name">{tool.name}</span>
            <span className="modal-tool-id" title={tool.id}>{tool.id.slice(0, 12)}…</span>
          </div>
          <div className="modal-actions">
            <span className="modal-dur">{dur(tool)}</span>
            <button className="btn icon-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          {tool.trimmed && (
            <div className="modal-section">
              <p className="modal-note">
                Full payloads for this call were released to keep memory bounded — only
                the previews below are still held.
              </p>
            </div>
          )}
          <div className="modal-section">
            <h4>Input</h4>
            <pre>{safeJson(tool.input ?? tool.inputPreview)}</pre>
          </div>
          <div className="modal-section">
            <h4>Response {status === "err" && <span className="err-tag">error</span>}</h4>
            <pre>{tool.endedAt == null ? "(waiting…)" : safeJson(tool.response ?? tool.errorPreview)}</pre>
          </div>
        </section>
      </div>
    </div>
  );
}
