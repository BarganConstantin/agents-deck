import React, { useEffect } from "react";
import type { ToolCall } from "../types";

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const status =
    tool.endedAt == null ? "inflight"
    : tool.ok === false  ? "err"
    :                       "done";

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <span className={`status-dot ${status}`} />
            <span className="modal-tool-name">{tool.name}</span>
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
