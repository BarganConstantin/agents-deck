import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { sessionHue } from "../reducer";
import { billedInputTokens, cacheWriteBreakdown, costForUsage, fmtCost, fmtCostRate, ratesForModel, UNPRICED_LABEL } from "../pricing";
import { codexApprovalTell } from "../codex-approval";
import { ContextDonut } from "./ContextModal";

/** Multi-line breakdown for the cost chip tooltip — shows the actual
 *  multiplication so the user can verify pricing is sane.
 *  e.g. "input  725 × $5/M     = $0.00"
 *
 *  Every row must multiply out to the figure printed beside it, and the rows
 *  must sum to the total: this tooltip exists only to be checked by hand, so a
 *  row whose operands don't produce its own result is worse than no row. */
export function costBreakdownTooltip(usage: TokenUsage, modelId: string | undefined): string {
  const rates = ratesForModel(modelId);
  // This branch was unreachable until #400: the only element carrying this
  // tooltip was gated on the same ratesForModel call that returns null here, so
  // the graceful answer existed and could never be read. It names the model now
  // because that is the one thing the reader needs in order to act on it — the
  // sentence is otherwise a claim about nothing, and the id is what goes in the
  // issue asking for the row.
  if (!rates) {
    return `model: ${modelId}\nno published rate in this build — the tokens are counted, the dollars are not`;
  }
  const fmtN = (n: number) => n.toLocaleString();
  const fmtR = (r: number) => `$${r}/MTok`;
  const c = costForUsage(usage, modelId);
  const cw = cacheWriteBreakdown(usage, rates);
  // Cache writes are billed per TTL — 2× input for a 1-hour entry, 1.25× for a
  // 5-minute one — so once a transcript reports both, one multiplication can't
  // reproduce the total the chip shows. Split the row rather than print a
  // product that doesn't check out.
  const cacheWriteRows = cw.tokens1h > 0
    ? [
        `cache w5m${fmtN(cw.tokens5m).padStart(14)}  × ${fmtR(rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd5m)}`,
        `cache w1h${fmtN(cw.tokens1h).padStart(14)}  × ${fmtR(rates.cacheWrite1h ?? rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd1h)}`,
      ]
    : [`cache w  ${fmtN(cw.tokens5m).padStart(14)}  × ${fmtR(rates.cacheWrite).padEnd(11)} = ${fmtCost(cw.usd5m)}`];
  // Codex reports a single `input_tokens` that already contains the cached
  // prefix, and only the remainder is billed at the input rate — so the raw
  // count printed here disagreed with its own dollar column by ~10x on a
  // multi-turn session. Print the tokens the rate is applied to, and relabel
  // the row when that differs from what the agent reported so the missing
  // tokens are visibly the ones on the cache-read line below.
  const inputTokens = billedInputTokens(usage, modelId);
  const inputLabel = inputTokens === usage.inputTokens ? "input" : "uncached";
  return [
    `model: ${modelId}`,
    `${inputLabel.padEnd(9)}${fmtN(inputTokens).padStart(14)}  × ${fmtR(rates.input).padEnd(11)} = ${fmtCost(c.input)}`,
    `output   ${fmtN(usage.outputTokens).padStart(14)}  × ${fmtR(rates.output).padEnd(11)} = ${fmtCost(c.output)}`,
    `cache r  ${fmtN(usage.cacheReadTokens).padStart(14)}  × ${fmtR(rates.cacheRead).padEnd(11)} = ${fmtCost(c.cacheRead)}`,
    ...cacheWriteRows,
    `─────────────────────────────────────────`,
    `total                                 = ${fmtCost(c.total)}`,
  ].join("\n");
}
import type { AgentNodeData, TokenUsage, ToolCall, WaitingBlock } from "../types";

function elapsed(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${String(rs).padStart(2, "0")}s`;
}

export default function AgentNode({ data, selected }: NodeProps<AgentNodeData & { now: number; onOpenContext?: (sessionId: string) => void }>) {
  const now = data.now ?? Date.now();
  const cls = [
    "agent-node",
    `state-${data.state}`,
    data.synthetic ? "synthetic" : "",
    selected ? "selected" : "",
  ].filter(Boolean).join(" ");

  const inflight = data.tools.filter(t => !t.endedAt).length;
  const hue = sessionHue(data.sessionId);
  const currentContextTokens = data.context?.currentContextTokens ?? 0;
  const hasContextSignal = data.kind === "root" && currentContextTokens > 0;

  return (
    // --accent itself is built in styles.css from this hue: the token that
    // reads well on a #14161b node is not the one that reads on a white one,
    // and .tokens-meta / .spawn-badge are text.
    <div className={cls} style={{ "--session-hue": hue } as React.CSSProperties}>
      <span className="accent-stripe" />
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />

      <div className="head">
        <div className="title">
          <StatePill state={data.state} />
          <span className="label" title={data.cwd}>{data.label}</span>
          {data.synthetic && <span className="synth-tag" title="No SessionStart captured — synthesised">?</span>}
        </div>
        <div className="head-right">
          {hasContextSignal && data.onOpenContext && (
            <ContextDonut
              currentContextTokens={currentContextTokens}
              modelId={data.model}
              contextWindow={data.contextWindow}
              onClick={() => data.onOpenContext!(data.sessionId)}
            />
          )}
          <div className="time" title={`Started ${new Date(data.startedAt).toLocaleTimeString()}`}>
            {elapsed(data.startedAt, data.endedAt, now)}
          </div>
        </div>
      </div>

      <div className="sub">
        {data.kind === "root" ? "session" : "subagent"}
        {data.childCount > 0 && (
          <span className="spawn-badge" title={`${data.childCount} subagents spawned`}>→ {data.childCount}</span>
        )}
        {data.cwdBasename && data.kind === "subagent" ? ` · ${data.cwdBasename}` : ""}
        {/* The chip README.md names as how the two CLIs are told apart, on the
            nodes that have no model to put in it (#404). `provider` has been
            carried on every node since Codex support landed and read by nothing
            in the UI, so a Claude and a Codex session in one repo were two cards
            separated by a session-id suffix and nothing else — and the model
            chip, the documented workaround, is absent on synthetic nodes, on
            subagents with no model event, and on every root before its first
            ModelObserved.

            Only "codex" falls back, deliberately. The reducer stamps "claude" as
            the DEFAULT for any event that names no provider — that is how events
            recorded before the field existed replay — so a "Claude Code" chip
            would print an assumption as an observation, on every model-less node
            of the commonest deck. A "codex" stamp is only ever set from a rollout
            this deck actually read. */}
        {data.model
          ? <span className="model-chip" title={data.model}>{shortModel(data.model)}</span>
          : data.provider === "codex"
            ? <span className="model-chip" title="OpenAI Codex — no model reported yet">Codex</span>
            : null}
      </div>

      {/* A row of its own rather than a chip in the title. The card is 260px
          wide and the header already spends it on the state pill, the workspace
          name and the elapsed clock; a fourth item there pushed the label to an
          ellipsis and still overflowed. A blocked session has earned a line. */}
      {data.waiting && <WaitingRow waiting={data.waiting} now={now} />}

      {/* The same slot, for the sessions that can never fill it (#398). A Codex
          session emits no notification and its rollout carries no approval
          record, so `data.waiting` is structurally always null here and this
          card, the sidebar, the topbar count, the tab title and the favicon are
          all silent whether or not the session is parked on a prompt.

          Rendering nothing let that silence read as "all clear", which is the
          one reading it cannot support. So the card says what it does not know,
          in the place the answer would have gone — the shape #416 gave a model
          with no published rate. It is deliberately NOT an inference that the
          session is blocked: codex-approval.ts holds why that inference is
          unsound and why nothing here reaches the alarm counters. It also stays
          quiet on the common case — a session at approval_policy "never" cannot
          be blocked at all — so it is rare enough to be worth reading. */}
      {(() => {
        const tell = codexApprovalTell(data);
        if (!tell) return null;
        return (
          <div className="approval-blind-row" title={tell.detail}>
            <span className="approval-blind-dot" aria-hidden />
            <span className="approval-blind-said">{tell.label}</span>
          </div>
        );
      })()}

      {data.tools.length > 0 && <ToolRateSpark tools={data.tools} now={now} />}

      <div className="meta">
        <span><b>{data.toolCount}</b> tools</span>
        {inflight > 0 && <span className="inflight-meta"><b>{inflight}</b> in-flight</span>}
        {(data.usage.inputTokens + data.usage.outputTokens) > 0 && (
          <span className="tokens-meta" title={`in:${data.usage.inputTokens}  out:${data.usage.outputTokens}  cache-r:${data.usage.cacheReadTokens}  cache-c:${data.usage.cacheCreateTokens}${(data.usage.reasoningOutputTokens ?? 0) > 0 ? `  reasoning:${data.usage.reasoningOutputTokens}` : ""}`}>
            <b>{fmtTok(data.usage.inputTokens + data.usage.outputTokens)}</b> tok
          </span>
        )}
        {data.model && (() => {
          // An unpriced model says so, in the slot the money would have used.
          // The gate here used to be `ratesForModel(data.model) &&`, which took
          // the whole element away the moment the lookup failed: a gpt-5.1-codex
          // card showed `412.3k tok` and then nothing, indistinguishable from a
          // session that had spent nothing, and the tooltip written for exactly
          // this case sat behind the failing call. The marker only appears once
          // there are tokens to price — a card with no usage yet has nothing to
          // be unpriced about, and would otherwise carry this the whole time it
          // was starting up.
          const rates = ratesForModel(data.model);
          if (!rates) {
            if ((data.usage.inputTokens + data.usage.outputTokens) <= 0) return null;
            return (
              <span className="cost-unpriced" title={costBreakdownTooltip(data.usage, data.model)}>
                {UNPRICED_LABEL}
              </span>
            );
          }
          const c = costForUsage(data.usage, data.model);
          if (c.total <= 0) return null;
          const elapsedSec = Math.max(0, ((data.endedAt ?? now) - data.startedAt) / 1000);
          const rate = data.state === "active" ? fmtCostRate(c.total, elapsedSec) : null;
          const tt = costBreakdownTooltip(data.usage, data.model) + (rate ? `\nburn: ${rate}` : "");
          return (
            <span className="cost-meta" title={tt}>
              <b>{fmtCost(c.total)}</b>
              {rate && <span className="cost-rate">{rate}</span>}
            </span>
          );
        })()}
      </div>

      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}

/** The one word this app uses for a session's state, wherever it says it.
 *
 *  It was inline in StatePill until #373, where the session list and the usage
 *  panel gained a spoken copy of the same fact — their dot carries the state
 *  and a dot cannot be read aloud. Two ternaries would have been two
 *  vocabularies waiting to disagree: a card that says `live` beside a row that
 *  says `running` is one state with two names, and a reader who uses both
 *  surfaces has to learn that they mean the same thing. Same argument, and the
 *  same shape, as waitingSentence below.
 *
 *  `err` rather than `failed` even in text nobody sees, for that reason exactly
 *  — it is the word on the card, so it is the word in the row. */
export function stateLabel(state: AgentNodeData["state"]): string {
  return state === "active" ? "live" : state === "done" ? "done" : "err";
}

function StatePill({ state }: { state: AgentNodeData["state"] }) {
  return <span className={`state-pill state-${state}`}>{stateLabel(state)}</span>;
}

/** What a blocked session says for itself, on the card, in the row and in the
 *  topbar's tooltip. CC's own sentence wherever there is one — the payload has
 *  no tool_name and no tool_input, so it is the entire truth we hold about the
 *  block, and paraphrasing it would only add a claim we cannot back. The
 *  fallback is what stops a re-wording upstream, or an older log line with no
 *  message at all, from rendering a coloured row that says nothing. One
 *  function so the three surfaces cannot drift apart, the way shortModel below
 *  is one for the same reason. */
export function waitingSentence(waiting: WaitingBlock): string {
  if (waiting.message) return waiting.message;
  return waiting.kind === "permission" ? "Needs your permission" : "Waiting for your input";
}

/** The visible label, which is CC's sentence for a permission block and a
 *  quieter one for an idle block.
 *
 *  "Claude is waiting for your input" is accurate and reads as an emergency,
 *  and it is the kind that fires most — three of every four blocks on this
 *  machine's log. What it actually describes is a turn that ended and has not
 *  been picked back up, sitting on a node that already reads `done` two columns
 *  away. So the visible half says whose move it is and the verbatim sentence
 *  stays in the tooltip, where it is still the only human wording the payload
 *  gives us and still exactly what CC said. A permission block is genuinely
 *  urgent and keeps its sentence untouched. */
export function waitingLabel(waiting: WaitingBlock): string {
  return waiting.kind === "permission" ? waitingSentence(waiting) : "Your turn";
}

/** The session is blocked on a human — and on which of the two chores that is.
 *  A dot alone would not carry it: a permission prompt is a decision a session
 *  cannot proceed without, an idle prompt is a finished turn waiting for your
 *  next instruction, and those are not the same errand. So the sentence carries
 *  it and the hue and the dot reinforce it — and only the permission variant
 *  pings: a stalled session is interrupt-driven and rare, which is the case a
 *  pulse is for, and a session that finished and is resting is neither. The
 *  ping is .ap-pulse, the emitter the accounts panel
 *  already uses, so the app keeps one idiom for "still asking" and one
 *  reduced-motion answer for it. */
function WaitingRow({ waiting, now }: { waiting: WaitingBlock; now: number }) {
  const permission = waiting.kind === "permission";
  const said = waitingSentence(waiting);
  return (
    <div
      className={permission ? "waiting-row permission" : "waiting-row idle"}
      title={`${said}\nBlocked for ${elapsed(waiting.since, undefined, now)} — the answer goes in the terminal, not here.`}
    >
      {permission
        ? <span className="ap-pulse" aria-hidden />
        : <span className="waiting-dot" aria-hidden />}
      <span className="waiting-said">{waitingLabel(waiting)}</span>
      <b>{elapsed(waiting.since, undefined, now)}</b>
    </div>
  );
}

function fmtTok(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Sparkline of tool starts per bucket over the last 60s. Most-recent
 *  bucket lives on the right and is highlighted while it's the active one. */
function ToolRateSpark({ tools, now }: { tools: ToolCall[]; now: number }) {
  const WINDOW_MS = 60_000;
  const BUCKETS = 24;
  const BUCKET_MS = WINDOW_MS / BUCKETS;
  const counts: number[] = new Array(BUCKETS).fill(0);
  let total = 0;
  for (const t of tools) {
    const age = now - t.startedAt;
    if (age < 0 || age >= WINDOW_MS) continue;
    const idx = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
    if (idx >= 0 && idx < BUCKETS) {
      counts[idx] += 1;
      total += 1;
    }
  }
  const max = Math.max(1, ...counts);
  const W = 132;
  const H = 14;
  const barW = W / BUCKETS;
  const peakRate = max / (BUCKET_MS / 1000);
  return (
    <div className="tool-spark-row" title={`${total} tool calls in last 60s · peak ${peakRate.toFixed(1)}/s`}>
      <svg className="tool-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {counts.map((c, i) => {
          const h = c === 0 ? 1.5 : Math.max(1.5, (c / max) * H);
          const isLatest = i === BUCKETS - 1 && c > 0;
          const isActive = c > 0;
          const cls = `tool-spark-bar${isActive ? " active" : ""}${isLatest ? " latest" : ""}`;
          return (
            <rect
              key={i}
              x={i * barW + 0.4}
              y={H - h}
              width={Math.max(0.5, barW - 1)}
              height={h}
              rx={0.8}
              className={cls}
            />
          );
        })}
      </svg>
      <span className="tool-spark-label">60s</span>
    </div>
  );
}

/** Render model ids into compact display labels:
 *    "claude-opus-4-7-20250101"            → "Opus 4.7"
 *    "claude-haiku-4-5"                    → "Haiku 4.5"
 *    "anthropic.claude-sonnet-4-5-…-v1:0"  → "Sonnet 4.5"
 *    "gpt-5.3-codex"                       → "GPT-5.3 Codex"
 *    "gpt-5"                               → "GPT-5"
 *    "o3-mini"                             → "o3-mini"
 *  Falls back to the raw id if the shape is unfamiliar so we never hide info.
 *
 *  Two things are dropped before matching, because an id carries them and a
 *  chip has no room for them: Bedrock's `anthropic.` namespace, and the release
 *  date Anthropic stamps on every Claude id. The date was being read as a third
 *  version component ever since this was written — "Opus 4.7.20250101", against
 *  the "Opus 4.7" promised right above — because eight digits satisfy the same
 *  `\d+` as the one or two a version number has. Length is what tells them
 *  apart. The usage-history modal used to carry a second labeller purely to
 *  strip both; one function now, so a family added here reaches every panel
 *  rather than four out of five. */
export function shortModel(id: string): string {
  const bare = id.replace(/^anthropic\./, "").replace(/[-_]\d{8}(?!\d)/, "");
  const claude = bare.match(/^claude[-_](opus|sonnet|haiku|fable|mythos)[-_](\d+(?:[-_.]\d+)*)/i);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    const version = claude[2].replace(/[-_]/g, ".");
    return `${family} ${version}`;
  }
  const gptCodex = bare.match(/^gpt[-_](\d+(?:[-_.]\d+)*)[-_]codex\b/i);
  if (gptCodex) return `GPT-${gptCodex[1].replace(/[-_]/g, ".")} Codex`;
  const gpt = bare.match(/^gpt[-_](\d+(?:[-_.]\d+)*)/i);
  if (gpt) return `GPT-${gpt[1].replace(/[-_]/g, ".")}`;
  return id;
}
