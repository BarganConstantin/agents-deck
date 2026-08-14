// The server caches `sessionId -> { rootModel, subsSig }` and stamps the
// model onto outgoing hook payloads so the client can attribute a model to
// an agent the moment the event lands. It used to assign the whole cache
// entry to `payload.model`, but the reducer only reads a *string* `model`,
// so the synchronous enrichment did nothing — and the object rode along on
// every broadcast and every line appended to events.jsonl. These pin the
// rule: stamp the root model id, or stamp nothing.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no types
import { cachedModelId } from "../../server/index.mjs";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-model";

function envelope(payload: HookPayload): HookEnvelope {
  return { seq: 1, receivedAt: Date.now(), source: "hook", payload };
}

describe("cachedModelId", () => {
  it("unwraps the cache entry to the root model id", () => {
    expect(cachedModelId({ rootModel: "claude-opus-4-7", subsSig: "{}" }))
      .toBe("claude-opus-4-7");
  });

  it("stamps nothing when only subagent models resolved", () => {
    expect(cachedModelId({ rootModel: null, subsSig: '{"a":"claude-haiku-4-5"}' }))
      .toBeNull();
  });

  it("stamps nothing for an unseen session", () => {
    expect(cachedModelId(undefined)).toBeNull();
    expect(cachedModelId(null)).toBeNull();
  });
});

describe("model stamped on a hook payload", () => {
  it("reaches the agent through the reducer", () => {
    const cached = { rootModel: "claude-opus-4-7", subsSig: "{}" };
    const state = applyEvent(initialState(), envelope({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Read",
      model: cachedModelId(cached),
    }));
    expect(state.agents.get(SESSION)?.model).toBe("claude-opus-4-7");
  });

  it("would not reach the agent as the raw cache object", () => {
    const state = applyEvent(initialState(), envelope({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Read",
      model: { rootModel: "claude-opus-4-7", subsSig: "{}" },
    }));
    expect(state.agents.get(SESSION)?.model).toBeFalsy();
  });
});
