// #398: a blocked Codex session is invisible on every alarm surface.
//
// The observation is true and this file does not fix it, because it cannot be
// fixed. `root.waiting` has exactly one writer — the reducer's `Notification`
// case — and the Codex path emits no `Notification`, because it is not a hook
// stream at all: it is a reconstruction from the rollout JSONL Codex appends
// under $CODEX_HOME/sessions, and that file carries no approval record.
//
// Sampled every rollout under this machine's CODEX_HOME (structural names and
// keys only, never content): 8 files, ~1,100 records, 20 distinct type names,
// and nothing approval-shaped among them. That absence has a SHAPE, which is
// what makes it evidence rather than a small sample: Codex's persist filter
// keeps outcomes and drops requests, uniformly.
//
//     event_msg/patch_apply_end       6      event_msg/patch_apply_begin     0
//     event_msg/web_search_end        2      event_msg/web_search_begin      0
//     event_msg/item_completed       30      event_msg/item_started          0
//     event_msg/task_complete        57      (no turn_started of any kind)
//
// Every persisted half is the END half, and an approval REQUEST is the other
// half. The CLI binary does carry `exec_approval_request` among its event names,
// so the signal exists in the process and simply never reaches the file;
// `state_5.sqlite`'s `threads` table (37 columns) has `approval_mode` and
// `sandbox_policy` but no status column, so the blocked state is in memory and
// nowhere else on disk.
//
// So the deck cannot know. What it CAN know, and threw away, is
// `turn_context.approval_policy` — the one recorded fact that says whether a
// session is even capable of stopping to ask. The mapper read `model` off that
// record and dropped everything else. 57 of the 58 turn_contexts here are
// "never", where Codex denies an escalation instead of prompting and no block is
// possible at all; 1 is "on-request", where one is.
//
// This file pins both halves: the fact is now carried end to end, and it is
// deliberately NOT turned into an alarm. The last describe is the important one
// — a Codex session with an outstanding tool call under a policy that can ask
// must still count zero blocked, must leave the tab strip untouched, and must
// not disturb a Claude session blocked beside it.
//
// No DOM — plain node, vitest — so this drives the real translation function,
// the real reducer and the same ambient-counts predicates the app renders from.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { blockedSessions, isAlarming, runningSessionCount } from "../ambient-counts";
import { ambientSignal } from "../ambient";
import { canAskForApproval, codexApprovalTell } from "../codex-approval";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
// @ts-expect-error — .mjs server module, no types
import { codexObjToPayload } from "../../server/index.mjs";

const SESSION = "019ff475-79c7-7783-97e6-414efa702b67";
const CLAUDE_SESSION = "c0ffee00-0000-4000-8000-000000000001";
const CWD = "/repo";
const T0 = 1_700_000_000_000;

/** One rollout line, as Codex appends it. */
type Rollout = { type: string; payload: Record<string, unknown> };

// ── the real rollout shapes, keys verbatim from ~/.codex/sessions ────────────
//
// `turn_context` is the record this whole file is about. Every key below is one
// this machine's rollouts actually carry; the two that matter are `model`, which
// the mapper already read, and `approval_policy`, which it discarded.
const turnContext = (approvalPolicy: string | null): Rollout => ({
  type: "turn_context",
  payload: {
    turn_id: "turn-1",
    cwd: CWD,
    current_date: "2026-08-17",
    timezone: "Europe/Chisinau",
    ...(approvalPolicy === null ? {} : { approval_policy: approvalPolicy }),
    approvals_reviewer: "user",
    sandbox_policy: { type: "workspace-write", network_access: false },
    model: "gpt-5-codex",
    effort: "medium",
  },
});

const taskStarted: Rollout = {
  type: "event_msg",
  payload: { type: "task_started", turn_id: "turn-1", started_at: 0, model_context_window: 258_400 },
};

const userMessage = (text: string): Rollout => ({
  type: "event_msg",
  payload: { type: "user_message", message: text, images: null },
});

/** The call line, which Codex appends at REQUEST time — before the tool has run
 *  and therefore before any approval prompt is answered. That is exactly why a
 *  pending call cannot distinguish "blocked" from "busy": it is written in both
 *  cases, at the same moment, and the output line is what differs. */
const functionCall = (callId: string): Rollout => ({
  type: "response_item",
  payload: { type: "function_call", id: "fc_1", name: "shell", arguments: '{"command":["ls"]}', call_id: callId },
});

const taskComplete: Rollout = {
  type: "event_msg",
  payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done", duration_ms: 900 },
};

// ── driving the two real functions ──────────────────────────────────────────

let seq = 0;

/** Translate a rollout line the way the watcher does, then feed whatever comes
 *  out to the reducer. Returns the payload so one step can assert both the
 *  mapping and the state it produced. */
function feed(state: GraphState, at: number, obj: Rollout): { state: GraphState; payload: HookPayload | null } {
  const payload = codexObjToPayload(obj, SESSION, CWD) as HookPayload | null;
  if (!payload) return { state, payload: null };
  seq++;
  const env: HookEnvelope = { seq, receivedAt: at, source: "codex", payload };
  return { state: applyEvent(state, env), payload };
}

/** Feed a payload the deck did not get from the Codex mapper — a real Claude
 *  hook event, or a hand-built one. */
function push(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  return applyEvent(state, { seq, receivedAt: at, source: "test", payload });
}

/**
 * A live Codex session with its root on the board, the way the watcher opens
 * one, with the module-level policy cache reset first.
 *
 * The reset is not tidiness. `codexObjToPayload` keeps its per-session state in
 * a module map that outlives any one test, so a policy left behind by an earlier
 * test would be spread onto this one's payloads and every assertion below would
 * be reading the previous test's setup. A `turn_context` carrying no
 * `approval_policy` is the clearing write — which is itself the behaviour the
 * second test in this file pins, so the reset and the contract are the same
 * line of code rather than a back door around it.
 */
function codexSession(): GraphState {
  seq = 1;
  codexObjToPayload(turnContext(null), SESSION, CWD);
  return applyEvent(initialState(), {
    seq,
    receivedAt: T0,
    source: "codex",
    payload: { session_id: SESSION, cwd: CWD, provider: "codex", hook_event_name: "SessionStart" },
  });
}

const root = (state: GraphState, id = SESSION) => state.agents.get(id)!;

describe("turn_context.approval_policy survives the mapper", () => {
  it("rides on the payloads that follow it, the way `model` already does", () => {
    let s = codexSession();
    // The record itself still maps to nothing — it is a snapshot, not an event —
    // which is the behaviour that made the field so easy to lose in the first
    // place.
    const ctx = feed(s, T0 + 1_000, turnContext("on-request"));
    expect(ctx.payload).toBeNull();

    const after = feed(ctx.state, T0 + 2_000, userMessage("hello"));
    expect(after.payload).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      provider: "codex",
      approval_policy: "on-request",
    });
  });

  it("still tracks the model off the same record", () => {
    const s = codexSession();
    const after = feed(feed(s, T0 + 1_000, turnContext("never")).state, T0 + 2_000, userMessage("hi"));
    expect(after.payload).toMatchObject({ model: "gpt-5-codex", approval_policy: "never" });
  });

  it("lets a later turn_context supersede an earlier one", () => {
    let s = codexSession();
    s = feed(s, T0 + 1_000, turnContext("on-request")).state;
    s = feed(s, T0 + 2_000, userMessage("one")).state;
    // The user toggled the policy between turns, which Codex records by writing
    // a fresh turn_context. The newest one wins; nothing here is cumulative.
    s = feed(s, T0 + 3_000, turnContext("never")).state;
    const after = feed(s, T0 + 4_000, userMessage("two"));
    expect(after.payload).toMatchObject({ approval_policy: "never" });
  });

  it("clears the answer when a turn_context arrives without the field", () => {
    let s = codexSession();
    s = feed(s, T0 + 1_000, turnContext("on-request")).state;
    // A future Codex that renames or drops the key must not leave the session
    // pinned to whatever it last said — a stale policy is worse than none,
    // because the surface built on it would be confidently wrong.
    s = feed(s, T0 + 2_000, turnContext(null)).state;
    const after = feed(s, T0 + 3_000, userMessage("still here"));
    expect(after.payload?.approval_policy).toBeUndefined();
  });
});

describe("the reducer puts it on the session root", () => {
  it("stamps approvalPolicy from a payload that carries it", () => {
    let s = codexSession();
    s = feed(s, T0 + 1_000, turnContext("on-request")).state;
    s = feed(s, T0 + 2_000, userMessage("go")).state;
    expect(root(s).approvalPolicy).toBe("on-request");
  });

  it("keeps a stamped policy when later payloads carry none", () => {
    let s = codexSession();
    s = feed(s, T0 + 1_000, turnContext("on-request")).state;
    s = feed(s, T0 + 2_000, userMessage("go")).state;
    // Absence on one payload means "not carried", never "withdrawn" — a real
    // change of policy arrives as a new turn_context, which is the write that
    // supersedes.
    s = push(s, T0 + 3_000, { session_id: SESSION, cwd: CWD, provider: "codex", hook_event_name: "Stop" });
    expect(root(s).approvalPolicy).toBe("on-request");
  });

  it("leaves a Claude root without one", () => {
    let s = push(initialState(), T0, { session_id: CLAUDE_SESSION, cwd: CWD, hook_event_name: "SessionStart" });
    s = push(s, T0 + 1_000, { session_id: CLAUDE_SESSION, cwd: CWD, hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(root(s, CLAUDE_SESSION).approvalPolicy).toBeUndefined();
    expect(root(s, CLAUDE_SESSION).provider).toBe("claude");
  });
});

describe("which policies can stop and ask", () => {
  it("says yes for the three that prompt", () => {
    expect(canAskForApproval("on-request")).toBe(true);
    expect(canAskForApproval("on-failure")).toBe(true);
    expect(canAskForApproval("untrusted")).toBe(true);
  });

  it("says no for never, the policy that denies instead of prompting", () => {
    expect(canAskForApproval("never")).toBe(false);
  });

  it("says `unknown` rather than guessing for a value it has not seen", () => {
    // A name this build does not recognise is a Codex that changed under us.
    // Sorting it into either group would be an assertion nothing has earned, so
    // it stays a third answer all the way to the surface.
    expect(canAskForApproval("ask-politely")).toBeNull();
    expect(canAskForApproval(undefined)).toBeNull();
    expect(canAskForApproval("")).toBeNull();
  });
});

describe("what the card says instead of guessing", () => {
  /** A Codex root as the reducer builds one, with the policy already stamped. */
  function codexRoot(over: Partial<AgentNodeData> = {}): AgentNodeData {
    let s = codexSession();
    s = feed(s, T0 + 1_000, turnContext("on-request")).state;
    s = feed(s, T0 + 2_000, userMessage("go")).state;
    return { ...root(s), ...over };
  }

  it("speaks up on a live Codex session that can be asked", () => {
    const tell = codexApprovalTell(codexRoot())!;
    expect(tell).not.toBeNull();
    // A statement about the DECK, not about the session. "This session is
    // waiting for you" would be a claim the deck cannot back and would be false
    // most of the times it appeared.
    expect(tell.label).toBe("approvals not visible");
    expect(tell.detail).toContain("on-request");
    expect(tell.detail).toContain("terminal");
  });

  it("stays quiet at approval_policy never, which cannot block at all", () => {
    let s = codexSession();
    s = feed(s, T0 + 1_000, turnContext("never")).state;
    s = feed(s, T0 + 2_000, userMessage("go")).state;
    expect(root(s).approvalPolicy).toBe("never");
    expect(codexApprovalTell(root(s))).toBeNull();
  });

  it("speaks up when the policy has not been read yet", () => {
    // Suppressing the caveat on the sessions the deck understands LEAST is the
    // wrong way round; asserting "never" for them would be worse.
    const tell = codexApprovalTell(codexRoot({ approvalPolicy: undefined }));
    expect(tell).not.toBeNull();
    expect(tell!.detail).toContain("not been read");
  });

  it("stays quiet on a Claude session", () => {
    expect(codexApprovalTell(codexRoot({ provider: "claude" }))).toBeNull();
  });

  it("stays quiet on a subagent and on a settled session", () => {
    expect(codexApprovalTell(codexRoot({ kind: "subagent" }))).toBeNull();
    // A session that has finished cannot be sitting on a prompt, and a permanent
    // caveat on every finished card is exactly the noise #348 removed.
    expect(codexApprovalTell(codexRoot({ state: "done" }))).toBeNull();
  });

  it("yields to a real waiting block if one ever arrives", () => {
    const blocked = codexRoot({ waiting: { kind: "permission", message: "Approve?", since: T0 } });
    expect(codexApprovalTell(blocked)).toBeNull();
  });
});

describe("the refusal: nothing here reaches an alarm surface", () => {
  /**
   * The exact board #398 describes: one Codex session, live, at a policy that
   * CAN ask, with a tool call outstanding and no result line — which is what a
   * session parked on an approval prompt looks like on disk, and equally what a
   * long-running command looks like. #397 stopped erasing that call into a
   * fabricated failure, so the evidence is still here; it is simply not enough
   * to tell the two apart, and this describe is what stops a later change from
   * pretending otherwise.
   */
  function blockedLookingCodexBoard(): GraphState {
    let s = codexSession();
    s = feed(s, T0 + 1_000, turnContext("on-request")).state;
    s = feed(s, T0 + 2_000, taskStarted).state;
    s = feed(s, T0 + 3_000, userMessage("run the build")).state;
    s = feed(s, T0 + 4_000, functionCall("call_1")).state;
    return s;
  }

  it("leaves the call in flight and the session live", () => {
    const s = blockedLookingCodexBoard();
    const r = root(s);
    expect(r.state).toBe("active");
    expect(r.approvalPolicy).toBe("on-request");
    expect(r.tools.some(t => t.endedAt == null)).toBe(true);
  });

  it("counts zero blocked sessions", () => {
    const s = blockedLookingCodexBoard();
    expect(root(s).waiting ?? null).toBeNull();
    expect(isAlarming(root(s).waiting)).toBe(false);
    expect(blockedSessions(s.agents.values())).toEqual([]);
  });

  it("leaves the tab title and the favicon exactly as they were", () => {
    const s = blockedLookingCodexBoard();
    const signal = ambientSignal({
      waiting: blockedSessions(s.agents.values()).length,
      running: runningSessionCount(s.agents.values()),
    });
    // Not "waiting". The amber mark and the parenthesised count are the deck's
    // rarest, loudest surfaces, and spending them on a guess is what would make
    // them worthless for the Claude sessions where the signal is real.
    expect(signal.icon).toBe("running");
    expect(signal.title).not.toMatch(/^\(/);
  });

  it("still lets a Claude permission prompt through, unchanged, on the same board", () => {
    let s = blockedLookingCodexBoard();
    s = push(s, T0 + 5_000, { session_id: CLAUDE_SESSION, cwd: CWD, hook_event_name: "SessionStart" });
    s = push(s, T0 + 6_000, {
      session_id: CLAUDE_SESSION,
      cwd: CWD,
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    });

    const blocked = blockedSessions(s.agents.values());
    expect(blocked.map(b => b.id)).toEqual([CLAUDE_SESSION]);
    const signal = ambientSignal({ waiting: blocked.length, running: runningSessionCount(s.agents.values()) });
    expect(signal.icon).toBe("waiting");
    expect(signal.title.startsWith("(1) ")).toBe(true);
  });
});
