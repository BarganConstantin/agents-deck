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

  it("clears on SubagentStart — traffic on this session", () => {
    expect(root(afterOne({ hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" })).waiting)
      .toBeFalsy();
  });

  it("clears on SubagentStop — traffic on this session", () => {
    const started = (s: GraphState) =>
      send(s, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    expect(root(afterOne({ hook_event_name: "SubagentStop", agent_id: "sub-1" }, started)).waiting).toBeFalsy();
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
