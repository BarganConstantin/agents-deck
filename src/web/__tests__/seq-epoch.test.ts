// The reducer drops any envelope whose seq it has already seen. That guard
// assumed the server's seq counter only ever grows, and it does not: every
// boot re-derives it by replaying events.jsonl, so after a 50MB rotation or a
// POST /api/clear the fresh counter starts far below the seq an already-open
// tab holds. The tab keeps its GraphState across EventSource reconnects, so
// the guard used to swallow every live event from the restarted server and
// freeze the canvas — live indicator green, nothing moving — until the counter
// organically climbed past the stale value. Envelopes now carry a per-boot
// `epoch`; a new one rebases the guard.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-epoch";

function envelope(seq: number, epoch: string | undefined, payload: HookPayload): HookEnvelope {
  const env: HookEnvelope = { seq, receivedAt: Date.now(), source: "hook", payload };
  if (epoch !== undefined) env.epoch = epoch;
  return env;
}

function toolUse(tool: string): HookPayload {
  return { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: tool };
}

describe("seq guard across a server restart", () => {
  it("keeps applying events when the new server restarts seq numbering", () => {
    let state = applyEvent(initialState(), envelope(1500, "boot-a", toolUse("Read")));
    expect(state.lastSeq).toBe(1500);

    // Log rotated (or was cleared), server restarted: numbering starts over.
    state = applyEvent(state, envelope(3, "boot-b", toolUse("Grep")));

    expect(state.totalEvents).toBe(2);
    expect(state.lastSeq).toBe(3);
    expect(state.seqEpoch).toBe("boot-b");
    expect(state.agents.get(SESSION)?.tools.map(t => t.name)).toEqual(["Read", "Grep"]);
  });

  it("still ignores duplicates once the new epoch is established", () => {
    let state = applyEvent(initialState(), envelope(1500, "boot-a", toolUse("Read")));
    state = applyEvent(state, envelope(3, "boot-b", toolUse("Grep")));
    state = applyEvent(state, envelope(3, "boot-b", toolUse("Grep")));
    state = applyEvent(state, envelope(2, "boot-b", toolUse("Bash")));

    expect(state.totalEvents).toBe(2);
    expect(state.agents.get(SESSION)?.tools.map(t => t.name)).toEqual(["Read", "Grep"]);
  });

  it("carries the epoch across a __clear so the next live event is not dropped", () => {
    let state = applyEvent(initialState(), envelope(1500, "boot-a", toolUse("Read")));
    state = applyEvent(state, envelope(1501, "boot-a", { hook_event_name: "__clear" }));
    expect(state.agents.size).toBe(0);
    expect(state.seqEpoch).toBe("boot-a");

    state = applyEvent(state, envelope(1502, "boot-a", toolUse("Grep")));
    expect(state.agents.get(SESSION)?.tools.map(t => t.name)).toEqual(["Grep"]);

    // A restart after the clear truncated the log rebases the counter again.
    state = applyEvent(state, envelope(1, "boot-c", toolUse("Bash")));
    expect(state.agents.get(SESSION)?.tools.map(t => t.name)).toEqual(["Grep", "Bash"]);
  });

  it("keeps the plain monotonic guard for servers that stamp no epoch", () => {
    let state = applyEvent(initialState(), envelope(10, undefined, toolUse("Read")));
    state = applyEvent(state, envelope(4, undefined, toolUse("Grep")));

    expect(state.totalEvents).toBe(1);
    expect(state.lastSeq).toBe(10);
    expect(state.seqEpoch).toBeNull();
  });
});
