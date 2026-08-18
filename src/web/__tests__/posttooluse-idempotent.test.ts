// #444. `PostToolUse` is the only event in this reducer whose handler does
// arithmetic, and it was the only one of the four re-delivery-prone events with
// no guard against a second copy. `PreToolUse` refreshes a known id in place,
// `UserPromptSubmit` declines to re-append a prompt it already has, `pushActive`
// declines to re-push a key — and `PostToolUse` ran `addUsage(owner.usage, …)`,
// a `+=`, once per delivery. The tool list stayed right (one entry, one status);
// only the money moved.
//
// That re-delivery is not hypothetical. Replaying this machine's real
// events.jsonl + events.jsonl.1 (18,137 envelopes, a 22-hour window) finds 3,996
// PostToolUse deliveries covering 2,971 distinct tool_use_ids — 1,025 surplus
// copies, 25.7% of all deliveries, spread over 514 ids that arrived up to three
// times each, every copy carrying its own seq and 512 of the 514 spanning more
// than one server epoch, which is exactly the fan-out the file's comments
// describe. What that traffic did NOT contain is a single `tool_response` with a
// usage object in it, so the measured dollar drift on this corpus is $0.00: the
// arithmetic is live, the input to it happened not to arrive in this window.
// The re-stamping did land — `endedAt` moved by a median of 6ms and a maximum
// of 1,867ms per duplicated call, which is a call's drawn duration changing
// because of who delivered its outcome.
//
// The whole difficulty is telling a DUPLICATE from a LATE outcome. Both reach
// the handler with the call missing from `toolIndex` and `endedAt` already set,
// because the stale sweep (#436) settles a call and drops its index entry, and so
// does the first delivery of this event. The tests below pin that the two are
// separated by `outcomeApplied` — set only by an outcome event, never by the
// sweep — so a duplicate changes nothing and a late outcome still overturns the
// sweep's guess.
//
// No DOM — plain node, vitest — so this drives the reducer directly.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  MAX_TOOLS_PER_AGENT,
  pruneOldAgents,
  STALE_SESSION_MS,
  sweepStaleSessions,
  sweepStaleTools,
  type GraphState,
} from "../reducer";
import { costForUsage } from "../pricing";
import type { HookEnvelope, HookPayload } from "../types";

const SEC = 1_000;
const MIN = 60_000;
/** Where every scenario starts, so "T0 + 5 minutes" reads as a number. */
const T0 = 1_700_000_000_000;

let seq = 0;

/** Deliver one event. Every copy gets a FRESH seq on purpose: that is what the
 *  real duplicates look like, and it is why the seq/epoch guard at the top of
 *  `applyEvent` lets them through instead of collapsing them for free. */
function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: payload.provider === "codex" ? "codex" : "hook",
    payload,
  };
  return applyEvent(state, env);
}

function fresh(): GraphState {
  seq = 0;
  return initialState();
}

/** The `tool_response` of a finished subagent call — the one shape that carries
 *  usage back through a tool result, and therefore the only one whose duplicate
 *  costs money. */
function responseWithUsage() {
  return {
    content: "done",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  };
}

const MODEL = "claude-opus-4-1-20250805";

function root(state: GraphState, sessionId: string) {
  const a = state.agents.get(sessionId);
  if (!a) throw new Error(`no root for ${sessionId}`);
  return a;
}

/** A session that has made one subagent call and not yet heard back. */
function sessionMidCall(sessionId: string, at: number): GraphState {
  let state = fresh();
  state = send(state, at, {
    hook_event_name: "SessionStart", session_id: sessionId, cwd: "/repo", model: MODEL,
  });
  state = send(state, at + SEC, {
    hook_event_name: "PreToolUse", session_id: sessionId, model: MODEL,
    tool_name: "Task", tool_use_id: "tt", tool_input: { prompt: "go" },
  });
  return state;
}

describe("#444 — a second copy of one outcome is not a second outcome", () => {
  it("leaves usage, cost, counts and timing exactly where the first copy left them", () => {
    let state = sessionMidCall("sess-a", T0);
    const post: HookPayload = {
      hook_event_name: "PostToolUse", session_id: "sess-a", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(),
    };

    state = send(state, T0 + 2 * SEC, post);
    const after1 = { ...root(state, "sess-a").usage };
    const cost1 = costForUsage(after1, MODEL, T0).total;
    expect(after1.inputTokens).toBe(100);
    expect(cost1).toBeGreaterThan(0);
    expect(root(state, "sess-a").toolCount).toBe(1);
    expect(root(state, "sess-a").tools[0].endedAt).toBe(T0 + 2 * SEC);

    // Two more copies, each stamped by the deck that received it — milliseconds
    // apart, which is what the real fan-out looks like.
    state = send(state, T0 + 2 * SEC + 6, post);
    state = send(state, T0 + 2 * SEC + 55, post);

    const after3 = root(state, "sess-a").usage;
    expect(after3).toEqual(after1);
    expect(costForUsage(after3, MODEL, T0).total).toBe(cost1);
    expect(root(state, "sess-a").toolCount).toBe(1);
    expect(root(state, "sess-a").tools).toHaveLength(1);
    // The first copy's arrival is when the call ended. A later copy saying so
    // again does not make the call have run 55ms longer.
    expect(root(state, "sess-a").tools[0].endedAt).toBe(T0 + 2 * SEC);
    expect(root(state, "sess-a").tools[0].ok).toBe(true);
  });

  it("still adds a genuinely different call's usage", () => {
    let state = sessionMidCall("sess-b", T0);
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-b", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(),
    });
    state = send(state, T0 + 3 * SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-b", model: MODEL,
      tool_name: "Task", tool_use_id: "tt-2", tool_input: { prompt: "again" },
    });
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-b", model: MODEL,
      tool_name: "Task", tool_use_id: "tt-2", tool_response: responseWithUsage(),
    });

    // Idempotency is per call, not per payload shape: two real calls that each
    // returned the same numbers really did spend twice.
    expect(root(state, "sess-b").usage.inputTokens).toBe(200);
    expect(root(state, "sess-b").toolCount).toBe(2);
  });

  it("does not let a duplicate success overwrite the failure that landed first", () => {
    let state = sessionMidCall("sess-c", T0);
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PostToolUseFailure", session_id: "sess-c", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: "Error: exit 1",
    });
    state = send(state, T0 + 2 * SEC + 9, {
      hook_event_name: "PostToolUse", session_id: "sess-c", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(),
    });

    const call = root(state, "sess-c").tools[0];
    expect(call.ok).toBe(false);
    expect(call.errorPreview).toContain("exit 1");
    // And the copy that was refused did not pay either.
    expect(root(state, "sess-c").usage.inputTokens).toBe(0);
  });

  it("still tells the session it is alive, because that is not part of the outcome", () => {
    // #350's `lastEventAt` stamp and un-reap sit ABOVE the switch on purpose: a
    // duplicate is still a message from a process that is running, so refusing
    // its arithmetic must not refuse its proof of life.
    let state = sessionMidCall("sess-d", T0);
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-d", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(),
    });
    const reapAt = T0 + 2 * SEC + STALE_SESSION_MS + MIN;
    expect(sweepStaleSessions(state, reapAt, STALE_SESSION_MS)).toBe(true);
    expect(root(state, "sess-d").reaped).toBe(true);

    state = send(state, reapAt + SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-d", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(),
    });
    expect(root(state, "sess-d").reaped).toBe(false);
    expect(root(state, "sess-d").state).toBe("active");
    expect(root(state, "sess-d").lastEventAt).toBe(reapAt + SEC);
    // Alive, and still not billed twice.
    expect(root(state, "sess-d").usage.inputTokens).toBe(100);
  });
});

describe("#444 — a LATE outcome is not a duplicate and still lands", () => {
  it("overturns the stale sweep's verdict and pays exactly once", () => {
    // #436: the sweep settles a call only once its whole session has been silent
    // for the window, and the verdict is a guess. A late outcome is evidence, and
    // evidence beats a guess — which is the case an `endedAt != null` guard would
    // have silently deleted, since the sweep writes `endedAt` too.
    let state = sessionMidCall("sess-e", T0);
    const sweptAt = T0 + SEC + STALE_SESSION_MS + MIN;
    expect(sweepStaleTools(state, sweptAt, STALE_SESSION_MS)).toBe(true);

    const call = root(state, "sess-e").tools[0];
    expect(call.ok).toBe(false);
    expect(call.errorPreview).toBe("session ended before this call returned");
    expect(call.endedAt).toBe(T0 + SEC);
    expect(state.toolIndex.has("tt")).toBe(false);
    expect(root(state, "sess-e").usage.inputTokens).toBe(0);

    const lateAt = sweptAt + 5 * MIN;
    state = send(state, lateAt, {
      hook_event_name: "PostToolUse", session_id: "sess-e", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(),
    });

    expect(call.ok).toBe(true);
    expect(call.errorPreview).toBeUndefined();
    expect(call.endedAt).toBe(lateAt);
    expect(root(state, "sess-e").usage.inputTokens).toBe(100);

    // …and the copies of that late outcome are duplicates like any other.
    state = send(state, lateAt + 12, {
      hook_event_name: "PostToolUse", session_id: "sess-e", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(),
    });
    expect(root(state, "sess-e").usage.inputTokens).toBe(100);
    expect(call.endedAt).toBe(lateAt);
  });
});

describe("#444 — replaying a whole log twice gives the state replaying it once gives", () => {
  /** A log with every shape that has ever had to be made idempotent in this
   *  file: a prompt, a root call that settles, a subagent that starts, works and
   *  stops, a call that carries usage, and a call left in flight. */
  const LOG: Array<{ at: number; p: HookPayload }> = [
    { at: T0, p: { hook_event_name: "SessionStart", session_id: "s", cwd: "/repo", model: MODEL } },
    { at: T0 + SEC, p: { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "ship it", model: MODEL } },
    { at: T0 + 2 * SEC, p: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "ls" }, model: MODEL } },
    { at: T0 + 3 * SEC, p: { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "b1", tool_response: "a\nb", model: MODEL } },
    { at: T0 + 4 * SEC, p: { hook_event_name: "SubagentStart", session_id: "s", agent_id: "k1", agent_type: "general-purpose", model: MODEL } },
    { at: T0 + 5 * SEC, p: { hook_event_name: "PreToolUse", session_id: "s", agent_id: "k1", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: "/x" }, model: MODEL } },
    { at: T0 + 6 * SEC, p: { hook_event_name: "PostToolUse", session_id: "s", agent_id: "k1", tool_name: "Read", tool_use_id: "r1", tool_response: "text", model: MODEL } },
    { at: T0 + 7 * SEC, p: { hook_event_name: "SubagentStop", session_id: "s", agent_id: "k1", model: MODEL } },
    { at: T0 + 8 * SEC, p: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Task", tool_use_id: "tt", tool_input: { prompt: "go" }, model: MODEL } },
    { at: T0 + 9 * SEC, p: { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Task", tool_use_id: "tt", tool_response: responseWithUsage(), model: MODEL } },
    { at: T0 + 10 * SEC, p: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "b2", tool_input: { command: "sleep 600" }, model: MODEL } },
  ];

  /** Everything the cards, the panels and the bills are computed from. Deliberately
   *  not `state` itself: `totalEvents` counts DELIVERIES, which is what it is for,
   *  and `lastSeq` moves with the stream. */
  function billable(state: GraphState) {
    return [...state.agents.values()]
      .map(a => ({
        id: a.id,
        toolCount: a.toolCount,
        childCount: a.childCount,
        prompts: a.prompts.length,
        usage: a.usage,
        cost: costForUsage(a.usage, MODEL, T0).total,
        tools: a.tools.map(t => ({ id: t.id, ok: t.ok, endedAt: t.endedAt, errorPreview: t.errorPreview })),
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
  }

  function replay(times: number): GraphState {
    let state = fresh();
    for (let i = 0; i < times; i++) for (const e of LOG) state = send(state, e.at, e.p);
    return state;
  }

  it("is byte-identical in everything the UI bills or counts", () => {
    const once = replay(1);
    const twice = replay(2);
    expect(billable(twice)).toEqual(billable(once));
    // The in-flight call is still in flight and still owned, in both.
    expect(twice.toolIndex.has("b2")).toBe(true);
    expect(twice.toolOwner.get("b2")).toBe("s");
    expect([...twice.toolIndex.keys()].sort()).toEqual([...once.toolIndex.keys()].sort());
    expect([...twice.toolOwner.keys()].sort()).toEqual([...once.toolOwner.keys()].sort());
  });

  it("bills the one usage-carrying call once no matter how many times the log is read", () => {
    expect(root(replay(1), "s").usage.inputTokens).toBe(100);
    expect(root(replay(3), "s").usage.inputTokens).toBe(100);
  });
});

describe("#444 — trimTools releases an id only where the maps still name that call", () => {
  /** The collision #443 found and left open here: one `tool_use_id`, two
   *  `ToolCall` objects. The first settles, a re-delivered `PreToolUse` arrives
   *  while a subagent is live, `findTool` misses on both the index (the settle
   *  cleared it) and the subagent's own list, and a second call is pushed there
   *  with both maps re-pointed at it. */
  function twoCallsOneId(): GraphState {
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "s", cwd: "/repo", model: MODEL });
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash",
      tool_use_id: "dup-1", tool_input: { command: "ls" }, model: MODEL,
    });
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash",
      tool_use_id: "dup-1", tool_response: "ok", model: MODEL,
    });
    state = send(state, T0 + 3 * SEC, {
      hook_event_name: "SubagentStart", session_id: "s", agent_id: "k9",
      agent_type: "general-purpose", model: MODEL,
    });
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash",
      tool_use_id: "dup-1", tool_input: { command: "ls" }, model: MODEL,
    });
    return state;
  }

  it("keeps the live copy when the old one falls out of the root's window", () => {
    const state = twoCallsOneId();
    const live = state.toolIndex.get("dup-1");
    expect(live).toBeDefined();
    expect(state.toolOwner.get("dup-1")).toBe("s::k9");
    expect(root(state, "s").tools[0]).not.toBe(live);

    // Push the root's own history past the window so its stale copy of `dup-1`
    // is evicted. Nothing about that eviction is a statement about the live call
    // on the subagent, which is 200 calls away and still running. The subagent's
    // Stop is what hands the root its own traffic back — until it lands,
    // `resolveOwner` attributes every unattributed call to the live subagent.
    let s = send(state, T0 + 5 * SEC, {
      hook_event_name: "SubagentStop", session_id: "s", agent_id: "k9", model: MODEL,
    });
    for (let i = 0; i < MAX_TOOLS_PER_AGENT + 5; i++) {
      s = send(s, T0 + 10 * SEC + i, {
        hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash",
        tool_use_id: `filler-${i}`, tool_input: { command: "true" }, model: MODEL,
      });
    }
    expect(root(s, "s").tools.some(t => t.id === "dup-1")).toBe(false);

    // Deleting by id alone took the live entry with the evicted one, which left a
    // running call that its own PostToolUse could reach only by the resurrection
    // scan and that the stale sweep could never settle at all.
    expect(s.toolIndex.get("dup-1")).toBe(live);
    expect(s.toolOwner.get("dup-1")).toBe("s::k9");

    // And it still settles the ordinary way, through the index.
    s = send(s, T0 + 20 * MIN, {
      hook_event_name: "PostToolUse", session_id: "s", agent_id: "k9",
      tool_name: "Bash", tool_use_id: "dup-1", tool_response: "done", model: MODEL,
    });
    expect(live!.ok).toBe(true);
    expect(live!.endedAt).toBe(T0 + 20 * MIN);
    expect(s.toolIndex.has("dup-1")).toBe(false);
    expect(s.toolOwner.has("dup-1")).toBe(false);
  });

  it("still releases the ids of the calls it really is evicting", () => {
    // The guard must not turn the eviction into a leak: an in-flight call that
    // falls out of the window is unreachable afterwards and its map entries have
    // to go, which is what this loop was written for in the first place.
    let s = fresh();
    s = send(s, T0, { hook_event_name: "SessionStart", session_id: "s2", cwd: "/repo", model: MODEL });
    for (let i = 0; i < MAX_TOOLS_PER_AGENT + 5; i++) {
      s = send(s, T0 + SEC + i, {
        hook_event_name: "PreToolUse", session_id: "s2", tool_name: "Bash",
        tool_use_id: `c-${i}`, tool_input: { command: "true" }, model: MODEL,
      });
    }
    const reachable = new Set(root(s, "s2").tools.map(t => t.id));
    expect(reachable.size).toBe(MAX_TOOLS_PER_AGENT);
    expect([...s.toolIndex.keys()].filter(id => !reachable.has(id))).toEqual([]);
    expect([...s.toolOwner.keys()].filter(id => !reachable.has(id))).toEqual([]);
  });
});

describe("#444 — the neighbouring rules are untouched", () => {
  it("#436 — a call is still judged by its session's silence, not its own age", () => {
    let state = sessionMidCall("sess-f", T0);
    // The session keeps talking well past the window; the call is old, the
    // session is not, so nothing is swept.
    state = send(state, T0 + STALE_SESSION_MS + MIN, {
      hook_event_name: "UserPromptSubmit", session_id: "sess-f", prompt: "still here", model: MODEL,
    });
    expect(sweepStaleTools(state, T0 + STALE_SESSION_MS + 2 * MIN, STALE_SESSION_MS)).toBe(false);
    const call = root(state, "sess-f").tools[0];
    expect(call.endedAt).toBeUndefined();
    expect(state.toolIndex.has("tt")).toBe(true);
  });

  it("#397 — a Codex call waiting on a human is still never swept", () => {
    let state = fresh();
    state = send(state, T0, {
      hook_event_name: "SessionStart", session_id: "cx", cwd: "/repo", provider: "codex",
    });
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", session_id: "cx", provider: "codex",
      tool_name: "Bash", tool_use_id: "cx-1", tool_input: { command: "rm -rf ./build" },
    });
    expect(sweepStaleTools(state, T0 + 2 * STALE_SESSION_MS, STALE_SESSION_MS)).toBe(false);
    const call = state.agents.get("cx")!.tools[0];
    expect(call.endedAt).toBeUndefined();
    expect(call.ok).toBeUndefined();
    expect(state.toolIndex.has("cx-1")).toBe(true);
  });

  it("#443 — a pruned agent still releases only the ids the maps name it for", () => {
    const state = (() => {
      let s = fresh();
      s = send(s, T0, { hook_event_name: "SessionStart", session_id: "s3", cwd: "/repo", model: MODEL });
      s = send(s, T0 + SEC, {
        hook_event_name: "PreToolUse", session_id: "s3", tool_name: "Bash",
        tool_use_id: "root-1", tool_input: { command: "ls" }, model: MODEL,
      });
      s = send(s, T0 + 2 * SEC, {
        hook_event_name: "SubagentStart", session_id: "s3", agent_id: "k1",
        agent_type: "general-purpose", model: MODEL,
      });
      s = send(s, T0 + 3 * SEC, {
        hook_event_name: "PreToolUse", session_id: "s3", agent_id: "k1", tool_name: "Read",
        tool_use_id: "lost-1", tool_input: { file_path: "/x" }, model: MODEL,
      });
      s = send(s, T0 + 4 * SEC, { hook_event_name: "SubagentStop", session_id: "s3", agent_id: "k1", model: MODEL });
      return s;
    })();

    expect(pruneOldAgents(state, T0 + 5 * SEC, 1, 0)).toBe(true);
    // The subagent went and took its own in-flight id with it; the root survived
    // and kept both of its entries.
    expect(state.toolIndex.has("lost-1")).toBe(false);
    expect(state.toolOwner.has("lost-1")).toBe(false);
    expect(state.toolIndex.has("root-1")).toBe(true);
    expect(state.toolOwner.get("root-1")).toBe("s3");
  });
});
