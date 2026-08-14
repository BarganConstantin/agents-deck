// Codex reports the session's real context window on `task_started`, and the
// server relays it as `model_context_window` on a ModelObserved payload —
// the only event that ever carries the field. The reducer used to stamp it
// far below, past ModelObserved's early return, so it never landed on an
// agent; and both consumers read the static pricing table regardless. The
// Codex CLI clamps gpt-5.6 to 258,400 while the table defaults to 1,050,000,
// so the dead path meant a session at 97% of its window rendered as 24%.
// These pin the wiring end to end: reducer stamps it, UI prefers it.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import { effectiveContextWindow, contextWindowForModel } from "../pricing";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-ctx-window";
const CODEX_REPORTED = 258_400;

let seq = 0;
function send(state: GraphState, payload: HookPayload): GraphState {
  seq += 1;
  const env: HookEnvelope = { seq, receivedAt: Date.now(), source: "hook", payload };
  return applyEvent(state, env);
}

function withRoot(): GraphState {
  return send(initialState(), {
    hook_event_name: "SessionStart",
    session_id: SESSION,
    provider: "codex",
    cwd: "/repo",
  });
}

describe("live model_context_window reaches the agent", () => {
  it("stamps the root from a ModelObserved payload", () => {
    const state = send(withRoot(), {
      hook_event_name: "ModelObserved",
      session_id: SESSION,
      model: "gpt-5.6",
      model_context_window: CODEX_REPORTED,
    });
    expect(state.agents.get(SESSION)?.contextWindow).toBe(CODEX_REPORTED);
    // The branch still does its original job.
    expect(state.agents.get(SESSION)?.model).toBe("gpt-5.6");
  });

  it("stamps the root from an ordinary tool event too", () => {
    const state = send(withRoot(), {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      provider: "codex",
      tool_name: "shell",
      tool_use_id: "call-1",
      model_context_window: CODEX_REPORTED,
    });
    expect(state.agents.get(SESSION)?.contextWindow).toBe(CODEX_REPORTED);
  });

  it("leaves the field unset when no event reports a window", () => {
    const state = send(withRoot(), {
      hook_event_name: "ModelObserved",
      session_id: SESSION,
      model: "gpt-5.6",
    });
    expect(state.agents.get(SESSION)?.contextWindow).toBeUndefined();
  });

  it("ignores a non-positive or non-numeric window", () => {
    let state = send(withRoot(), {
      hook_event_name: "ModelObserved",
      session_id: SESSION,
      model_context_window: 0,
    });
    state = send(state, {
      hook_event_name: "ModelObserved",
      session_id: SESSION,
      // A provider that reported the window as a string would be a lie the
      // donut must not believe — the fallback table is the safer answer.
      model_context_window: "258400" as unknown as number,
    });
    expect(state.agents.get(SESSION)?.contextWindow).toBeUndefined();
  });

  it("tracks the newest reported window", () => {
    let state = send(withRoot(), {
      hook_event_name: "ModelObserved",
      session_id: SESSION,
      model_context_window: 128_000,
    });
    state = send(state, {
      hook_event_name: "ModelObserved",
      session_id: SESSION,
      model_context_window: CODEX_REPORTED,
    });
    expect(state.agents.get(SESSION)?.contextWindow).toBe(CODEX_REPORTED);
  });
});

describe("effectiveContextWindow precedence", () => {
  it("prefers the live window over the static table", () => {
    expect(contextWindowForModel("gpt-5.6")).toBe(1_050_000);
    expect(effectiveContextWindow(CODEX_REPORTED, "gpt-5.6")).toBe(CODEX_REPORTED);
  });

  it("falls back to the table when nothing was reported", () => {
    expect(effectiveContextWindow(undefined, "gpt-5.6")).toBe(1_050_000);
    expect(effectiveContextWindow(0, "gpt-5.6")).toBe(1_050_000);
  });

  it("falls back for an unknown model with no live window", () => {
    expect(effectiveContextWindow(undefined, undefined))
      .toBe(contextWindowForModel(undefined));
  });
});
