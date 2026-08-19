// Read-only modal showing the breakdown of a session's context window — message
// counts, tool calls, the memory files in scope, and the token totals split by
// billing bucket.
//
// HOW MUCH OF IT IS KNOWN DEPENDS ON THE PROVIDER, and every section below says
// which it is rather than rendering the same layout over two different degrees
// of certainty. For Claude Code this is an approximation: the real `/context`
// view is not exposed to a hook, so the counts come from a regex scan of the
// transcript JSONL on the server. For Codex the occupancy and the window are the
// CLI's own numbers, stated on every `token_count` record and exact — while the
// composition counts are not available at all, because there is no transcript to
// scan and the rollout watcher skips a session's history when it attaches. That
// section says so instead of printing five zeroes (#399).
import React, { useRef } from "react";
import type { AgentNodeData, Provider } from "../types";
import { fmtCost, costForUsage, effectiveContextWindow } from "../pricing";
import { useModalDismiss } from "./use-modal-dismiss";

/** Every line in this modal whose truth depends on which CLI the session is.
 *
 *  One function rather than four inline ternaries, and exported, because the
 *  suite runs in bare node with no DOM and cannot render the component to read
 *  its copy — the same reason codex-approval.ts holds a rule rather than a
 *  fragment. `compositionCounted: false` is the load-bearing field: it is the
 *  admission that replaces five numbers, and a test that could only check the
 *  strings would not notice the grid coming back. */
export interface ContextCopy {
  /** Under the title. What kind of number the percentage above is. */
  subtitle: string;
  /** Parenthetical on the token count: which moment it describes. */
  windowScope: string;
  /** Whether the five transcript-composition counts mean anything here. */
  compositionCounted: boolean;
  /** Shown instead of those counts when they do not. */
  compositionUncounted: string;
  /** Heading of the memory-file section, naming the file this CLI reads. */
  memoryHeading: string;
  /** Shown when that scan found nothing, naming where it looked. */
  memoryEmpty: string;
}

export function contextCopy(provider: Provider | undefined): ContextCopy {
  // Anything that is not explicitly Codex is treated as Claude, which is the
  // same default `provider` itself carries: events persisted before multi-
  // provider support have no provider field and are Claude sessions.
  if (provider === "codex") {
    return {
      // The Codex admission is the better news of the two and must not be
      // spelled as the Claude one. Codex states its occupancy and its window
      // itself, on every token_count record, so nothing here is reconstructed —
      // but both figures describe the CLI's most recent request rather than
      // this instant, and that is the only caveat they carry.
      subtitle: "reported by the Codex CLI — as of its most recent request",
      windowScope: "last request",
      compositionCounted: false,
      compositionUncounted:
        "Not counted for Codex — the deck reconstructs the session from its rollout file "
        + "and skips whatever was written before it attached, so a message and tool-call "
        + "breakdown here would be short by an unknown amount. The window figure above is "
        + "the CLI's own and is unaffected.",
      memoryHeading: "AGENTS.md files in scope",
      memoryEmpty: "No AGENTS.md files found on the path from cwd to the filesystem root, or in $CODEX_HOME.",
    };
  }
  return {
    subtitle: "approximation — CC's /context isn't hook-exposed",
    windowScope: "current turn",
    compositionCounted: true,
    compositionUncounted: "",
    memoryHeading: "CLAUDE.md files in scope",
    memoryEmpty: "No CLAUDE.md files found on the path from cwd to ~/.claude.",
  };
}

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
 *  ellipsis, so the tail survives — every file in this list has the same name
 *  (CLAUDE.md for a Claude session, AGENTS.md for a Codex one), so the trailing
 *  directories are the only thing telling two rows apart. This
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
  // Which CLI's memory file, and which of this panel's sections are answerable
  // at all. The two ecosystems fill this modal from different sources and one of
  // them cannot fill a whole section, so every line below that names a file, a
  // directory or a provider reads it from here rather than asserting Claude's
  // answer at a Codex session (#399).
  const copy = contextCopy(agent.provider);

  return (
    <div className="ctx-modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="ctx-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Context breakdown">
        <header className="ctx-modal-head">
          <div>
            <div className="ctx-modal-title">Context · {agent.label}</div>
            <div className="ctx-modal-sub">{copy.subtitle}</div>
          </div>
          <button type="button" ref={closeRef} className="glyph-btn ctx-modal-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </header>

        <section className="ctx-window-row">
          <div className="ctx-window-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className="ctx-window-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="ctx-window-meta">
            <span className="ctx-window-pct">{pct.toFixed(1)}%</span>
            <span>{fmtN(current)} / {fmtN(window)} tok ({copy.windowScope})</span>
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
        {/* Five counts, or the reason there are none. On Claude they come from a
            regex scan of a transcript the server has read from byte zero. Codex
            has no transcript to scan — the deck reconstructs the session by
            tailing the rollout JSONL, and at startup it deliberately skips
            whatever was already in the file, so a count kept from the moment the
            deck attached would be short by however much of the session happened
            first and would carry no sign of it.

            Printing five zeroes there was the option this rejected. The card
            beside this modal already shows a real tool count, so zeroes would
            not even read as "nothing happened" — they would read as a broken
            panel, and the one thing a context breakdown cannot afford is being
            confidently wrong about what is in the window. This is the shape #398
            gave a Codex session's approval state and #416 gave an unpriced
            model: say what cannot be known, in the slot the answer would have
            occupied. */}
        {copy.compositionCounted ? (
          <div className="ctx-grid">
            <Row label="user messages"       val={fmtN(ctx?.msgsUser ?? 0)} />
            <Row label="assistant messages"  val={fmtN(ctx?.msgsAssistant ?? 0)} />
            <Row label="tool uses"           val={fmtN(ctx?.toolUses ?? 0)} />
            <Row label="tool results"        val={fmtN(ctx?.toolResults ?? 0)} />
            <Row label="system-reminders"    val={fmtN(ctx?.systemReminders ?? 0)} />
          </div>
        ) : (
          <div className="ctx-empty">{copy.compositionUncounted}</div>
        )}

        <h3 className="ctx-section-title">{copy.memoryHeading}</h3>
        {(ctx?.memoryFiles?.length ?? 0) === 0 ? (
          <div className="ctx-empty">{copy.memoryEmpty}</div>
        ) : (
          <ul className="ctx-md-list">
            {ctx!.memoryFiles.map(f => (
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
          // Named here, valued in styles.css. The literal `stroke-dasharray
          // 400ms ease` this used to hold was an inline style, which outranks
          // every selector, so no `prefers-reduced-motion` rule could reach it
          // (#357) and the arc swept around the circle on every turn however
          // the reader had set their OS. `--ctx-arc-transition` becomes `none`
          // under that preference, and the arc simply is its new length.
          style={{ transition: "var(--ctx-arc-transition)" }}
        />
        <text x={c} y={c + 3} textAnchor="middle" fontSize="8" fill="var(--text)" fontWeight="600">
          {Math.round(pct * 100)}
        </text>
      </svg>
    </button>
  );
}
