// #337: the deck installs the `Notification` hook, the events arrive, they are
// written to events.jsonl — and `case "Notification": { break; }` dropped every
// one of them. So the deck always knew which session was sitting blocked on a
// human, the one question five parallel agents make worth asking, and showed
// nothing.
//
// Two things are being pinned here. The first is that waiting rides ALONGSIDE
// `state` instead of becoming a fourth AgentState: a permission_prompt arrives
// mid-turn while the session is active, an idle_prompt arrives after Stop while
// it is done, and a union would have destroyed one of those two facts whichever
// way it was written.
//
// The second, and the one that decides whether the badge is worth having, is
// the clearing. A badge that outlives the block is worse than no badge — it
// teaches the user to distrust the only signal the deck exists to give — so
// every event that is evidence the session moved takes it away, and the events
// that are NOT evidence leave it standing. The trap on that side is the three
// *Observed events: the server starts a transcript scan for every hook payload
// carrying a transcript_path, the notification included, so a rule of "any
// event clears it" would have cleared the block a second or two after it was
// set and no badge would ever have survived long enough to be read.
//
// No DOM here — plain node, vitest — so this drives applyEvent directly and the
// three surfaces that read `waiting` are checked by eye.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-337";

/** The two payloads CC actually emits, verbatim from a real events.jsonl. */
const PERMISSION = { notification_type: "permission_prompt", message: "Claude needs your permission" };
const IDLE = { notification_type: "idle_prompt", message: "Claude is waiting for your input" };

let seq = 0;

function send(state: GraphState, payload: HookPayload, receivedAt?: number): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: receivedAt ?? 1_000 + seq,
    source: "hook",
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

/** A session mid-turn: started, prompted, one tool call in flight. */
function running(): GraphState {
  seq = 0;
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
  state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "run the tests" });
  return send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" });
}

const root = (state: GraphState) => state.agents.get(SESSION)!;

describe("a permission prompt on a session that is still running", () => {
  it("blocks it without claiming the turn ended", () => {
    const state = send(running(), { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).state).toBe("active");
    expect(root(state).waiting?.kind).toBe("permission");
  });

  it("keeps CC's own sentence, which is the only human wording we get", () => {
    // The payload has no tool_name, no tool_input and no tool_use_id: it says a
    // session is blocked, never on what. This sentence is the whole message.
    const state = send(running(), { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).waiting?.message).toBe("Claude needs your permission");
  });

  it("stamps `since` from the envelope, not from the clock", () => {
    // Wall-clock time here would make every replayed notification look like it
    // had just arrived, and a tab opened an hour into a block would read
    // "waiting 0s".
    const state = send(running(), { hook_event_name: "Notification", ...PERMISSION }, 9_000);
    expect(root(state).waiting?.since).toBe(9_000);
  });
});

describe("an idle prompt after the turn is over", () => {
  it("blocks it without un-finishing it", () => {
    let state = send(running(), { hook_event_name: "Stop" });
    state = send(state, { hook_event_name: "Notification", ...IDLE });
    expect(root(state).state).toBe("done");
    expect(root(state).endedAt).toBeGreaterThan(0);
    expect(root(state).waiting?.kind).toBe("idle");
  });
});

describe("the clear matrix — one case each", () => {
  /** Block the session, then deliver `next` and report what is left. */
  function afterOne(next: HookPayload, setup: (s: GraphState) => GraphState = s => s) {
    let state = setup(running());
    state = send(state, { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).waiting, "the block has to exist before it can be cleared").toBeTruthy();
    return send(state, next);
  }

  it("clears on UserPromptSubmit — the human answered", () => {
    expect(root(afterOne({ hook_event_name: "UserPromptSubmit", prompt: "yes" })).waiting).toBeFalsy();
  });

  it("clears on PreToolUse — the session moved again", () => {
    expect(root(afterOne({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2" })).waiting)
      .toBeFalsy();
  });

  it("clears on PostToolUse — the permission was granted and the call resolved", () => {
    expect(root(afterOne({ hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok" })).waiting)
      .toBeFalsy();
  });

  it("clears on PostToolUseFailure — a call that resolved badly still resolved", () => {
    expect(root(afterOne({ hook_event_name: "PostToolUseFailure", tool_use_id: "t1", tool_response: "boom" })).waiting)
      .toBeFalsy();
  });

  it("does NOT clear on SubagentStart — a Task starting is not the human answering", () => {
    // #361. This used to clear, on the rule that any session traffic is the
    // session moving again. A subagent starting is the session moving and the
    // human still being asked, which are not the same fact — and the block here
    // belongs to the root, whose own Task call is the newest thing in flight.
    expect(root(afterOne({ hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" })).waiting?.kind)
      .toBe("permission");
  });

  it("does NOT clear on SubagentStop raised under someone else's block", () => {
    const started = (s: GraphState) =>
      send(s, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    expect(root(afterOne({ hook_event_name: "SubagentStop", agent_id: "sub-1" }, started)).waiting?.kind)
      .toBe("permission");
  });

  it("clears on Stop — the turn is over, and the idle prompt ~60s later sets it again", () => {
    let state = afterOne({ hook_event_name: "Stop" });
    expect(root(state).waiting).toBeFalsy();
    state = send(state, { hook_event_name: "Notification", ...IDLE });
    expect(root(state).waiting?.kind).toBe("idle");
  });

  it("clears on SessionEnd", () => {
    expect(root(afterOne({ hook_event_name: "SessionEnd" })).waiting).toBeFalsy();
  });

  it("clears on SessionStart — a resumed session starts unblocked", () => {
    expect(root(afterOne({ hook_event_name: "SessionStart", cwd: "/repo" })).waiting).toBeFalsy();
  });

  it("does NOT clear on the server's own transcript scans", () => {
    // The trap. maybeResolveModel / maybeResolveUsage / maybeResolveContext run
    // for every hook payload carrying a transcript_path — the Notification
    // included — and push their synthetic events back through this same
    // reducer moments later. Counted as session traffic they would erase the
    // block roughly one SSE tick after it appeared.
    for (const observed of [
      { hook_event_name: "ModelObserved", model: "claude-opus-5" },
      { hook_event_name: "UsageObserved", usage: { input_tokens: 10, output_tokens: 2 } },
      { hook_event_name: "ContextObserved", context: { msgsUser: 1, currentContextTokens: 500 } },
    ]) {
      expect(root(afterOne(observed)).waiting?.kind, observed.hook_event_name).toBe("permission");
    }
  });

  it("leaves other sessions' blocks alone", () => {
    let state = send(running(), { hook_event_name: "Notification", ...PERMISSION });
    seq++;
    state = applyEvent(state, {
      seq,
      receivedAt: 5_000,
      source: "hook",
      payload: { session_id: "other-session", hook_event_name: "UserPromptSubmit", prompt: "hi" },
    });
    expect(root(state).waiting?.kind).toBe("permission");
  });
});

// #361: the clear matrix above only ever sent ROOT-level payloads, and the one
// shape it never sent is the one that breaks the feature. A subagent's tool call
// carries the root's session_id — on a real log 79% of PreToolUse and PostToolUse
// events are subagent-attributed — so "any event that is not a keeper clears the
// block" meant the alarm was wiped milliseconds after it was raised in every
// session running a Task, while the human was still looking at the prompt. And
// nothing puts it back: the notification is not re-sent, and since #348 the
// idle_prompt that follows a minute later is deliberately not an alarm.
describe("a session with subagents, which is nearly every session", () => {
  /** The root is blocked while a Task works underneath it. The root's own Bash
   *  (t1, from `running()`) is the newest call in flight when the prompt lands,
   *  so the block is the root's. */
  function blockedWithSubagentWorking(): GraphState {
    let state = send(running(), { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).waiting?.kind, "the block has to exist before it can be cleared").toBe("permission");
    return state;
  }

  it("keeps the block when a subagent fires a tool call — the reported bug", () => {
    const state = send(blockedWithSubagentWorking(), {
      hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t9", agent_id: "sub-1",
    });
    expect(root(state).waiting?.kind).toBe("permission");
  });

  it("keeps it through everything a busy subagent emits", () => {
    // The whole vocabulary a Task produces under the root's session id. Sent as
    // one run because that is how they arrive: three parallel subagents each
    // doing this is a dozen events a second, any one of which used to be enough.
    let state = blockedWithSubagentWorking();
    for (const p of [
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t9", agent_id: "sub-1" },
      { hook_event_name: "PostToolUse", tool_use_id: "t9", tool_response: "ok", agent_id: "sub-1" },
      { hook_event_name: "PostToolUseFailure", tool_use_id: "t9", tool_response: "boom", agent_id: "sub-1" },
      { hook_event_name: "SubagentStop", agent_id: "sub-1" },
      { hook_event_name: "SubagentStart", agent_id: "sub-2", agent_type: "explorer" },
    ]) {
      state = send(state, p);
      expect(root(state).waiting?.kind, p.hook_event_name).toBe("permission");
    }
  });

  it("keeps it for the older `parent_tool_use_id` spelling too", () => {
    // `explicitSubagentKey` reads either field. Real CC payloads in the log all
    // use agent_id, but the reducer has always accepted both and the clear rule
    // must not be the one place that treats a subagent as the root.
    const state = send(blockedWithSubagentWorking(), {
      hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok", parent_tool_use_id: "sub-1",
    });
    expect(root(state).waiting?.kind).toBe("permission");
  });

  it("still clears on every root-level event, with a Task running the whole time", () => {
    // The inverse, and the half that must not regress: a live subagent puts a key
    // on the attribution stack, so resolveOwner hands these events to sub-1 — but
    // the clear rule reads the payload, not the owner, and none of these payloads
    // names a subagent. Counted on a real log, none of them ever does: 45/45
    // UserPromptSubmit, 39/39 Stop, 6/6 SessionStart, 3/3 SessionEnd and every
    // root-attributed tool event carried neither agent_id nor parent_tool_use_id.
    for (const next of [
      { hook_event_name: "UserPromptSubmit", prompt: "yes" },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t2" },
      { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok" },
      { hook_event_name: "PostToolUseFailure", tool_use_id: "t1", tool_response: "boom" },
      { hook_event_name: "Stop" },
      { hook_event_name: "SessionEnd" },
      { hook_event_name: "SessionStart", cwd: "/repo" },
    ]) {
      expect(root(send(blockedWithSubagentWorking(), next)).waiting, next.hook_event_name).toBeFalsy();
    }
  });

  it("leaves an idle block on the old rule — a working subagent is proof it is not idle", () => {
    // The two kinds are different claims. "Waiting for your input" says nothing
    // is happening, and a subagent's tool call falsifies that directly; it says
    // nothing about whether the human answered a prompt, which is the permission
    // block's whole content. An idle block is not an alarm post-#348 — it sorts
    // the sidebar and prints "waiting 3m" — and printing that over a session
    // whose subagents are visibly working is the lie worth avoiding here.
    let state = send(running(), { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "Notification", ...IDLE });
    expect(root(state).waiting?.kind).toBe("idle");
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t9", agent_id: "sub-1" });
    expect(root(state).waiting).toBeFalsy();
  });
});

// The hole #361's own one-line fix leaves: if only root-level traffic clears the
// block, then a prompt a SUBAGENT raised has nothing to clear it. The human
// answers, the subagent's PostToolUse is the very next thing that arrives, and
// it carries an agent_id — so the alarm would stand until the Task finished and
// the root's own PostToolUse for it landed. Measured on a real log that is a
// median of 103 seconds and a tail of eleven minutes of a lit favicon, tab title
// and topbar chip on a session nobody is being asked anything about, with the
// 90-minute #350 sweep as the only other backstop.
describe("a prompt the subagent raised, and who is allowed to answer it", () => {
  /** sub-1 hits a permission prompt: its PreToolUse fires (CC runs that hook
   *  before it asks), so its call is the newest in flight when the notification
   *  lands and the block is attributed to it. sub-2 is a sibling, working. */
  function subagentAsked(): GraphState {
    let state = send(running(), { hook_event_name: "SubagentStart", agent_id: "sub-2", agent_type: "explorer" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t8", agent_id: "sub-2" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t9", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).waiting?.subagentId).toBe(`${SESSION}::sub-1`);
    return state;
  }

  it("clears when that subagent's blocked call settles — the human approved", () => {
    const state = send(subagentAsked(), {
      hook_event_name: "PostToolUse", tool_use_id: "t9", tool_response: "ok", agent_id: "sub-1",
    });
    expect(root(state).waiting).toBeFalsy();
  });

  it("clears on anything else that subagent does — the human may have denied it", () => {
    // A denial produces no PostToolUse for the call that was refused; what comes
    // back is the subagent carrying on with the feedback, or giving up. Any event
    // it emits is the same evidence: it is running again, so it is not blocked.
    for (const next of [
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t10", agent_id: "sub-1" },
      { hook_event_name: "PostToolUseFailure", tool_use_id: "t9", tool_response: "denied", agent_id: "sub-1" },
      { hook_event_name: "SubagentStop", agent_id: "sub-1" },
    ]) {
      expect(root(send(subagentAsked(), next)).waiting, next.hook_event_name).toBeFalsy();
    }
  });

  it("is not cleared by the sibling Task that was never asked anything", () => {
    // The bug, in the shape it takes once the block is attributed: sub-2 is
    // running flat out beside sub-1 and none of it is an answer.
    let state = subagentAsked();
    for (const p of [
      { hook_event_name: "PostToolUse", tool_use_id: "t8", tool_response: "ok", agent_id: "sub-2" },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t11", agent_id: "sub-2" },
      { hook_event_name: "SubagentStop", agent_id: "sub-2" },
    ]) {
      state = send(state, p);
      expect(root(state).waiting?.kind, p.hook_event_name).toBe("permission");
    }
  });

  it("still clears on root-level traffic, whichever subagent it was attributed to", () => {
    expect(root(send(subagentAsked(), { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok" })).waiting)
      .toBeFalsy();
    expect(root(send(subagentAsked(), { hook_event_name: "Stop" })).waiting).toBeFalsy();
  });

  it("attributes to nobody when the root is the one asking, so no subagent can clear it", () => {
    // The root's own PreToolUse is the newest call in flight, so the block is the
    // root's — and then sub-1 finishing its own work says nothing about it.
    //
    // t7 is also the case that decides where the attribution is read from: it
    // carries no agent_id, and with sub-1 on the active stack resolveOwner draws
    // it UNDER sub-1. Read off the owning node, this block would belong to sub-1
    // and sub-1's next event would clear a prompt the root is still sitting on —
    // #361 again, in the one shape the one-line fix does not cover.
    let state = send(running(), { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "t8", agent_id: "sub-1" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t7" });
    state = send(state, { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).waiting?.subagentId).toBeUndefined();
    state = send(state, { hook_event_name: "PostToolUse", tool_use_id: "t8", tool_response: "ok", agent_id: "sub-1" });
    expect(root(state).waiting?.kind).toBe("permission");
    state = send(state, { hook_event_name: "PostToolUse", tool_use_id: "t7", tool_response: "ok" });
    expect(root(state).waiting).toBeFalsy();
  });

  it("keeps the first copy's attribution when the notification is re-delivered", () => {
    // Every deck sharing events.jsonl posts its own copy, and each tab replays
    // the whole log on open. A later copy sees a session that has moved on — the
    // blocked call may have settled by then, leaving nothing in flight to read —
    // so re-deriving per copy would let a re-delivery widen or narrow what is
    // allowed to clear the block.
    let state = subagentAsked();
    state = send(state, { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).waiting?.subagentId).toBe(`${SESSION}::sub-1`);
  });

  it("survives the whole log being replayed into a fresh tab", () => {
    // Order-independence is this reducer's contract, and a tab that opens
    // mid-block must land on the block. The state a tab rebuilds and the state a
    // tab already had are the same state, or the badge flickers on refresh.
    seq = 0;
    let state = initialState();
    for (const payload of [
      { hook_event_name: "SessionStart", cwd: "/repo" },
      { hook_event_name: "UserPromptSubmit", prompt: "run the tests" },
      { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "t1" },
      { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t9", agent_id: "sub-1" },
      { hook_event_name: "Notification", ...PERMISSION },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t10", agent_id: "sub-1" },
    ] as HookPayload[]) state = send(state, payload);
    expect(root(state).waiting).toBeFalsy();
  });
});

describe("only the root carries it", () => {
  it("puts the badge on the session, not on whichever subagent happens to be live", () => {
    // Notification has no parent_tool_use_id and no agent_id, so resolveOwner
    // would attribute it to the top of the active-subagent stack — the wrong
    // node, and one the block does not belong to in the first place.
    let state = send(running(), { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, { hook_event_name: "Notification", ...PERMISSION });
    expect(root(state).waiting?.kind).toBe("permission");
    expect(state.agents.get(`${SESSION}::sub-1`)!.waiting).toBeFalsy();
  });
});

describe("a kind we have never seen", () => {
  it("sets nothing at all rather than a badge with no wording behind it", () => {
    const state = send(running(), { hook_event_name: "Notification", notification_type: "carrier_pigeon", message: "?" });
    expect(root(state).waiting).toBeFalsy();
  });
});

describe("duplicate deliveries of one notification", () => {
  it("yields one block whose `since` is the first delivery's receivedAt", () => {
    // Three decks share one events.jsonl and each persists the event itself, so
    // the log holds the same notification three times under three seq values.
    // Re-stamping would restart the "waiting 4m" readout every time a copy
    // landed, which is the whole reason the number is worth printing.
    let state = running();
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, 20_000);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, 20_004);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, 20_009);
    expect(root(state).waiting).toEqual({
      kind: "permission",
      message: "Claude needs your permission",
      since: 20_000,
    });
  });

  it("settles on the same `since` whichever order the copies arrive in", () => {
    // Order-independence is this reducer's stated contract, and the fan-out has
    // no ordering guarantee between decks — so the earliest stamp wins rather
    // than the earliest arrival.
    let state = running();
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, 20_009);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, 20_000);
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, 20_004);
    expect(root(state).waiting?.since).toBe(20_000);
  });

  it("re-stamps when the block genuinely changed, since it is a different chore", () => {
    let state = running();
    state = send(state, { hook_event_name: "Notification", ...PERMISSION }, 20_000);
    state = send(state, { hook_event_name: "Notification", ...IDLE }, 30_000);
    expect(root(state).waiting).toEqual({
      kind: "idle",
      message: "Claude is waiting for your input",
      since: 30_000,
    });
  });
});

describe("replay — every tab reads the whole log back on open", () => {
  /** The log, applied from scratch the way a freshly-opened tab applies it. */
  function replay(log: HookPayload[]): GraphState {
    seq = 0;
    let state = initialState();
    for (const payload of log) state = send(state, payload);
    return state;
  }

  const OPENING: HookPayload[] = [
    { hook_event_name: "SessionStart", cwd: "/repo" },
    { hook_event_name: "UserPromptSubmit", prompt: "run the tests" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
  ];

  it("ends blocked when the log ends on a block", () => {
    const state = replay([
      ...OPENING,
      { hook_event_name: "Notification", ...PERMISSION },
      { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok" },
      { hook_event_name: "Notification", ...PERMISSION },
    ]);
    expect(root(state).waiting?.kind).toBe("permission");
  });

  it("ends clear when the log ends on the answer", () => {
    const state = replay([
      ...OPENING,
      { hook_event_name: "Notification", ...PERMISSION },
      { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok" },
    ]);
    expect(root(state).waiting).toBeFalsy();
  });

  it("agrees with the live tab that watched the same events arrive", () => {
    // The state a tab rebuilds from the log and the state a tab already had are
    // the same state, or the badge flickers on every refresh.
    const log: HookPayload[] = [
      ...OPENING,
      { hook_event_name: "Notification", ...PERMISSION },
      { hook_event_name: "UserPromptSubmit", prompt: "yes" },
      { hook_event_name: "Stop" },
      { hook_event_name: "Notification", ...IDLE },
    ];
    let live = running();
    for (const payload of log.slice(OPENING.length)) live = send(live, payload);
    expect(root(replay(log)).waiting).toEqual(root(live).waiting);
    expect(root(replay(log)).waiting?.kind).toBe("idle");
  });
});

describe("Codex", () => {
  it("never gets a waiting value, because it never emits a notification", () => {
    // Codex is reconstructed from rollout files and has no Notification of any
    // kind. Null here is the absence of a signal, not a claim that the session
    // is unblocked — which is why the UI must not render "not waiting" as a
    // positive statement about a Codex session.
    seq = 0;
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo", provider: "codex" });
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "hi", provider: "codex" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "shell", tool_use_id: "c1", provider: "codex" });
    state = send(state, { hook_event_name: "ModelObserved", model: "gpt-5.3-codex", provider: "codex" });
    state = send(state, { hook_event_name: "Stop", provider: "codex" });
    expect(root(state).provider).toBe("codex");
    expect(root(state).waiting).toBeFalsy();
  });
});
