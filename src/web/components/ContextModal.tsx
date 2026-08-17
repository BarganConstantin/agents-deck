// Read-only modal showing the structural breakdown of a session's
// context window — message counts, tool calls, CLAUDE.md files in scope,
// and the token totals split by Anthropic billing bucket. This is an
// approximation: CC's real `/context` view isn't exposed via hooks, so
// counts come from a regex scan of the transcript JSONL on the server.
import React, { useRef } from "react";
import type { AgentNodeData } from "../types";
import { fmtCost, costForUsage, effectiveContextWindow } from "../pricing";
import { useModalDismiss } from "./use-modal-dismiss";

function fmtN(n: number): string { return n.toLocaleString(); }
function fmtKB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Widest path the row can print. `.ctx-md-path` is 12px monospace inside a
 *  560px modal, sharing the row with the size column, so ~60 columns is what
 *  fits before CSS starts clipping. */
const PATH_MAX_CHARS = 60;

/** Cuts the head off an over-long path and marks the cut with a leading
 *  ellipsis, so the tail survives — every file in this list is named CLAUDE.md,
 *  so the trailing directories are the only thing telling two rows apart. This
 *  used to be `direction: rtl` in styles.css, which got the left-side ellipsis
 *  by flipping the paragraph to RTL and, with it, moved the leading '/' of
 *  every POSIX path to the end of the line. Cutting at a separator keeps half a
 *  directory name off the screen; '\' counts as one because a Windows path
 *  reads C:\Users\… Exported for tests. */
export function truncatePathStart(path: string, max = PATH_MAX_CHARS): string {
  if (path.length <= max) return path;
  const tail = path.slice(path.length - (max - 1)); // one column pays for the ellipsis
  const sep = tail.search(/[/\\]/);
  return "…" + (sep === -1 ? tail : tail.slice(sep));
}

interface Props {
  agent: AgentNodeData;
  onClose: () => void;
}

export default function ContextModal({ agent, onClose }: Props) {
  // Opened from the .ctx-donut on a node header, which is where a keyboard
  // user has to end up again — this modal used to answer neither Escape nor
  // the question of where focus went when it closed.
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });

  const ctx = agent.context;
  const usage = agent.usage;
  const current = ctx?.currentContextTokens ?? 0;
  const window = effectiveContextWindow(agent.contextWindow, agent.model);
  const pct = Math.min(100, (current / window) * 100);
  const cost = costForUsage(usage, agent.model);
  const cumulative = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;

  return (
    <div className="ctx-modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="ctx-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Context breakdown">
        <header className="ctx-modal-head">
          <div>
            <div className="ctx-modal-title">Context · {agent.label}</div>
            <div className="ctx-modal-sub">approximation — CC's /context isn't hook-exposed</div>
          </div>
          <button type="button" ref={closeRef} className="ctx-modal-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </header>

        <section className="ctx-window-row">
          <div className="ctx-window-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className="ctx-window-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="ctx-window-meta">
            <span className="ctx-window-pct">{pct.toFixed(1)}%</span>
            <span>{fmtN(current)} / {fmtN(window)} tok (current turn)</span>
          </div>
        </section>

        <h3 className="ctx-section-title">Cumulative usage · whole session</h3>
        <div className="ctx-grid">
          <Row label="input tokens"        val={fmtN(usage.inputTokens)} />
          <Row label="output tokens"       val={fmtN(usage.outputTokens)} />
          <Row label="cache reads"         val={fmtN(usage.cacheReadTokens)} />
          <Row label="cache writes"        val={fmtN(usage.cacheCreateTokens)} />
          <Row label="cumulative total"    val={fmtN(cumulative)} />
          <Row label="estimated cost"      val={fmtCost(cost.total)} accent />
        </div>

        <h3 className="ctx-section-title">Transcript composition</h3>
        <div className="ctx-grid">
          <Row label="user messages"       val={fmtN(ctx?.msgsUser ?? 0)} />
          <Row label="assistant messages"  val={fmtN(ctx?.msgsAssistant ?? 0)} />
          <Row label="tool uses"           val={fmtN(ctx?.toolUses ?? 0)} />
          <Row label="tool results"        val={fmtN(ctx?.toolResults ?? 0)} />
          <Row label="system-reminders"    val={fmtN(ctx?.systemReminders ?? 0)} />
        </div>

        <h3 className="ctx-section-title">CLAUDE.md files in scope</h3>
        {(ctx?.claudeMdFiles?.length ?? 0) === 0 ? (
          <div className="ctx-empty">No CLAUDE.md files found on the path from cwd to ~/.claude.</div>
        ) : (
          <ul className="ctx-md-list">
            {ctx!.claudeMdFiles.map(f => (
              <li key={f.path}>
                <span className="ctx-md-path" title={f.path}>{truncatePathStart(f.path)}</span>
                <span className="ctx-md-size">{fmtKB(f.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({ label, val, accent }: { label: string; val: string; accent?: boolean }) {
  return (
    <div className={`ctx-row${accent ? " accent" : ""}`}>
      <span className="ctx-row-label">{label}</span>
      <span className="ctx-row-val">{val}</span>
    </div>
  );
}

/** Compact donut indicator — used on the root agent's node header. */
interface DonutProps {
  currentContextTokens: number;
  modelId?: string;
  /** Live window reported by the CLI, when the provider sends one. */
  contextWindow?: number;
  size?: number;
  onClick?: () => void;
  title?: string;
}
export function ContextDonut({ currentContextTokens, modelId, contextWindow, size = 26, onClick, title }: DonutProps) {
  const window = effectiveContextWindow(contextWindow, modelId);
  const pct = Math.min(1, currentContextTokens / window);
  const r = size / 2 - 3;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  // Color shifts from accent → warning as we close on the ceiling.
  const stroke = pct > 0.9 ? "var(--err)" : pct > 0.7 ? "var(--inflight)" : "var(--accent)";
  return (
    <button
      type="button"
      className="ctx-donut"
      onClick={onClick}
      title={title ?? `context: ${currentContextTokens.toLocaleString()} / ${window.toLocaleString()} (${(pct * 100).toFixed(1)}%)`}
      aria-label="Show context breakdown"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r} stroke="var(--line)" strokeWidth="2.5" fill="none" />
        <circle
          cx={c} cy={c} r={r}
          stroke={stroke} strokeWidth="2.5" fill="none"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 400ms ease" }}
        />
        <text x={c} y={c + 3} textAnchor="middle" fontSize="8" fill="var(--text)" fontWeight="600">
          {Math.round(pct * 100)}
        </text>
      </svg>
    </button>
  );
}
