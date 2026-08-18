// #443. `toolIndex` and `toolOwner` are keyed by tool_use_id and live for the
// whole board, not per agent. Four sites used to write or clear them —
// `PreToolUse` sets both, `PostToolUse` clears both when the call settles,
// `trimTools` clears both when a call falls out of the 200-per-agent window, and
// `sweepStaleTools` clears both when it settles a lost call — and every one of
// them reaches an entry only THROUGH the owning agent. So when `pruneOldAgents`
// or `pruneDoneSessions` deleted an agent that still had a call in flight, the
// entry it left behind was reachable by nothing at all: not `PostToolUse`, whose
// resurrection scan walks `state.agents`; not either sweep, which iterate the
// same map; not `trimTools`, which runs only from its own agent's `PreToolUse`;
// and not the collector, since the map held the last strong reference to a
// `ToolCall` that still carried its whole `tool_input`.
//
// The size of it, measured rather than assumed: replaying this machine's entire
// 21-hour events.jsonl with both pruners live evicted 16 agents and orphaned
// zero ids, because on Claude a session killed mid-call never reaches `done` in
// the first place — no `Stop` arrives — and `sweepStaleTools` releases its calls
// on the same tick and the same window that `sweepStaleSessions` uses to reap it
// (#436). What is left is the pair of cases below: Codex, where the sweep
// deliberately abstains (#397) so pruning is the only bound on an approval
// prompt nobody answered, and Claude where a `PostToolUse` went missing but the
// `Stop` that ends the agent still landed. This is a tidiness fix at the scale
// this machine runs at, and the tests are about the contract, not the bytes.
//
// The half worth guarding is the other direction. A tool id does not belong to
// one `ToolCall` forever: a re-delivered `PreToolUse` for an id that already
// settled finds nothing in `toolIndex`, and `resolveOwner` hands it to whoever
// the attribution stack names at that moment, which is a different agent once a
// subagent has started in between — so both maps end up pointing at a NEW call
// on a LIVE agent while the old object stays in the finished agent's list.
// Releasing by id alone would let pruning the finished one evict the live one,
// and the last block here pins that it does not.
//
// No DOM — plain node, vitest — so this drives the reducer directly.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  pruneDoneSessions,
  pruneOldAgents,
  STALE_SESSION_MS,
  sweepStaleSessions,
  sweepStaleTools,
  type GraphState,
} from "../reducer";
import type { HookEnvelope, HookPayload, ToolCall } from "../types";

const SEC = 1_000;
const MIN = 60_000;
/** Where every scenario starts, so "T0 + 5 minutes" reads as a number. */
const T0 = 1_700_000_000_000;

let seq = 0;

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

/** Ids the board can still reach: every call held by a surviving agent. An
 *  entry in either map that is not in here is an orphan by definition, since
 *  every reader and every deleter goes through the owning agent. */
function reachableIds(state: GraphState): Set<string> {
  const ids = new Set<string>();
  for (const a of state.agents.values()) for (const t of a.tools) ids.add(t.id);
  return ids;
}

function orphans(state: GraphState): { index: string[]; owner: string[] } {
  const reach = reachableIds(state);
  return {
    index: [...state.toolIndex.keys()].filter(id => !reach.has(id)),
    owner: [...state.toolOwner.keys()].filter(id => !reach.has(id)),
  };
}

function expectNoOrphans(state: GraphState): void {
  const o = orphans(state);
  expect(o.index).toEqual([]);
  expect(o.owner).toEqual([]);
}

/** A Codex session that made one call and was stopped before the call ever
 *  produced an output line — the abandoned approval prompt of #397, which the
 *  stale sweep is right to leave in flight and which pruning is therefore the
 *  only thing that bounds. */
function abandonedCodexSession(id: string, at: number): GraphState {
  let state = fresh();
  state = send(state, at, { hook_event_name: "SessionStart", session_id: id, cwd: "/repo", provider: "codex" });
  state = send(state, at + SEC, {
    hook_event_name: "PreToolUse", session_id: id, provider: "codex",
    tool_name: "Bash", tool_use_id: `${id}-call`,
    tool_input: { command: "rm -rf ./build" },
  });
  state = send(state, at + 2 * SEC, { hook_event_name: "Stop", session_id: id, provider: "codex" });
  return state;
}

describe("#443 — a pruned agent releases its tool ids", () => {
  it("pruneDoneSessions drops the in-flight ids of the session it evicts", () => {
    const state = abandonedCodexSession("sess-a", T0);
    expect(state.toolIndex.size).toBe(1);
    expect(state.toolOwner.size).toBe(1);

    // Five minutes on: past DONE_SESSION_GRACE_MS and nowhere near the 90-minute
    // window either sweep works on, so the pruner is the only thing acting.
    const at = T0 + 5 * MIN;
    expect(sweepStaleTools(state, at, STALE_SESSION_MS)).toBe(false);
    expect(pruneDoneSessions(state, at, 0, 2 * MIN)).toBe(true);

    expect(state.agents.size).toBe(0);
    expect(state.toolIndex.size).toBe(0);
    expect(state.toolOwner.size).toBe(0);
    expectNoOrphans(state);
  });

  it("pruneOldAgents drops the in-flight ids of the agent it evicts", () => {
    // The Claude shape of the same thing, and the reason this is not a
    // Codex-only bug: the subagent's `PostToolUse` never arrived — hook POSTs are
    // fire-and-forget and one sent while the server was restarting is gone — but
    // its `SubagentStop` did, so the node reaches `done` holding a live call
    // while its root carries on working.
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "sess-b", cwd: "/repo" });
    state = send(state, T0 + SEC, {
      hook_event_name: "SubagentStart", session_id: "sess-b",
      parent_tool_use_id: "k1", subagent_type: "worker",
    });
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-b", parent_tool_use_id: "k1",
      tool_name: "Read", tool_use_id: "lost-1", tool_input: { file_path: "/repo/src/index.ts" },
    });
    state = send(state, T0 + 3 * SEC, {
      hook_event_name: "SubagentStop", session_id: "sess-b", parent_tool_use_id: "k1",
    });
    // The root is still going, so `pruneDoneSessions` will not touch this tree
    // and `pruneOldAgents` is unambiguously the pruner under test.
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-b",
      tool_name: "Bash", tool_use_id: "root-1", tool_input: { command: "npm test" },
    });
    expect(state.agents.size).toBe(2);
    expect(state.toolIndex.size).toBe(2);

    const at = T0 + 5 * MIN;
    expect(pruneOldAgents(state, at, /*cap*/ 1, /*graceMs*/ 0)).toBe(true);

    expect([...state.agents.keys()]).toEqual(["sess-b"]);
    expect(state.toolIndex.has("lost-1")).toBe(false);
    expect(state.toolOwner.has("lost-1")).toBe(false);
    expectNoOrphans(state);
    // The surviving root keeps its own call in flight — the release is scoped to
    // the agent that left, not to the session it belonged to.
    expect(state.toolIndex.has("root-1")).toBe(true);
    expect(state.toolOwner.get("root-1")).toBe("sess-b");
  });

  it("keeps both maps bounded by the surviving agents across a day of sessions", () => {
    // The growth claim, run as a loop rather than argued: 40 abandoned Codex
    // sessions twenty minutes apart, pruned down to the six-session cap the deck
    // actually uses. What is left in the maps must be what the survivors hold.
    seq = 0;
    let state = initialState();
    let at = T0;
    for (let i = 0; i < 40; i++) {
      const id = `day-${i}`;
      state = send(state, at, { hook_event_name: "SessionStart", session_id: id, cwd: "/repo", provider: "codex" });
      state = send(state, at + SEC, {
        hook_event_name: "PreToolUse", session_id: id, provider: "codex",
        tool_name: "Bash", tool_use_id: `${id}-call`, tool_input: { command: "sleep 1" },
      });
      state = send(state, at + 2 * SEC, { hook_event_name: "Stop", session_id: id, provider: "codex" });
      at += 20 * MIN;
      // The tick App.tsx runs, in the order App.tsx runs it.
      sweepStaleTools(state, at, STALE_SESSION_MS);
      sweepStaleSessions(state, at, STALE_SESSION_MS);
      pruneOldAgents(state, at, 200, 5 * MIN);
      pruneDoneSessions(state, at, 6, 2 * MIN);
    }

    expect(state.agents.size).toBe(6);
    expectNoOrphans(state);
    // One in-flight call per surviving session, and nothing beyond them.
    expect(state.toolIndex.size).toBe(6);
    expect(state.toolOwner.size).toBe(6);
  });
});

describe("#443 — the late PostToolUse still lands", () => {
  it("settles a surviving agent's call after another session was pruned", () => {
    // The pruner walks the tool list of the agents it deletes and no others, so
    // an unrelated live call must come through untouched and settle the ordinary
    // way — through `toolIndex`, not through the resurrection scan.
    let state = abandonedCodexSession("sess-gone", T0);
    state = send(state, T0 + 3 * SEC, { hook_event_name: "SessionStart", session_id: "sess-live", cwd: "/repo" });
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-live",
      tool_name: "Bash", tool_use_id: "live-1", tool_input: { command: "npm run build" },
    });

    const at = T0 + 5 * MIN;
    expect(pruneDoneSessions(state, at, 0, 2 * MIN)).toBe(true);
    expect(state.agents.has("sess-gone")).toBe(false);
    expect(state.toolIndex.has("live-1")).toBe(true);
    expect(state.toolOwner.get("live-1")).toBe("sess-live");

    state = send(state, at + SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-live",
      tool_use_id: "live-1", tool_response: { stdout: "built" },
    });

    const call = state.agents.get("sess-live")!.tools.find(t => t.id === "live-1")!;
    expect(call.ok).toBe(true);
    expect(call.endedAt).toBe(at + SEC);
    expect(call.response).toEqual({ stdout: "built" });
    // Settled the normal way, so the id is out of both maps for the usual reason.
    expectNoOrphans(state);
    expect(state.toolIndex.has("live-1")).toBe(false);
  });

  it("still resurrects a swept call on an agent that survived the prune", () => {
    // #436's recovery path, run with a prune in the middle of it: the sweep
    // settles a lost call and drops it from `toolIndex`, the call stays in its
    // agent's list, and a `PostToolUse` that turns up afterwards is found by the
    // scan over `state.agents` and clears the sweep's verdict. Pruning some other
    // session must not be able to interfere with any of that.
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "sess-slow", cwd: "/repo" });
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-slow",
      tool_name: "Bash", tool_use_id: "slow-1", tool_input: { command: "make" },
    });
    state = send(state, T0 + 2 * SEC, { hook_event_name: "SessionStart", session_id: "sess-other", cwd: "/repo" });
    state = send(state, T0 + 3 * SEC, { hook_event_name: "Stop", session_id: "sess-other" });

    // Past the window: the slow session has been silent throughout, so the sweep
    // settles its call — and the other session is prunable at the same tick.
    const at = T0 + 2 * STALE_SESSION_MS;
    expect(sweepStaleTools(state, at, STALE_SESSION_MS)).toBe(true);
    expect(pruneDoneSessions(state, at, 0, 2 * MIN)).toBe(true);

    const swept = state.agents.get("sess-slow")!.tools.find(t => t.id === "slow-1")!;
    expect(swept.ok).toBe(false);
    expect(swept.errorPreview).toBe("session ended before this call returned");
    expect(state.toolIndex.has("slow-1")).toBe(false);
    expectNoOrphans(state);

    // It was working the whole time.
    state = send(state, at + SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-slow",
      tool_use_id: "slow-1", tool_response: { stdout: "ok" },
    });
    expect(swept.ok).toBe(true);
    expect(swept.errorPreview).toBeUndefined();
    expect(swept.endedAt).toBe(at + SEC);
  });

  it("is a no-op for an agent the pruner already removed", () => {
    const state = abandonedCodexSession("sess-c", T0);
    const at = T0 + 5 * MIN;
    pruneDoneSessions(state, at, 0, 2 * MIN);
    expect(state.agents.size).toBe(0);

    // The call is off the board — nothing draws it, nothing can reach it — so
    // the event that would have settled it settles nothing.
    const after = send(state, at + SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-c", provider: "codex",
      tool_use_id: "sess-c-call", tool_response: { stdout: "late" },
    });
    // Any event for a session with no node re-materialises a bare root, which is
    // `resolveOwner`'s documented fallback and not something this issue changes.
    // What matters is that the root comes back EMPTY: the pruned call is not
    // resurrected onto it, and neither map gains an entry.
    const root = after.agents.get("sess-c")!;
    expect(root.tools).toEqual([]);
    expect(after.toolIndex.size).toBe(0);
    expect(after.toolOwner.size).toBe(0);
  });
});

describe("#443 — releasing is scoped to the ids the departing agent still owns", () => {
  /** A session where one tool_use_id has been recorded twice: once on the root,
   *  which settled it, and once again on a subagent that started afterwards.
   *
   *  That is a re-delivery, which this reducer is explicitly built to survive —
   *  several decks appending to one events.jsonl, a hook retry, a replay of a log
   *  region already streamed live. The second copy finds nothing in `toolIndex`
   *  (the first copy's `PostToolUse` cleared it) and nothing in the subagent's own
   *  list, so it is recorded as a new call and both maps are re-pointed at it,
   *  while the root keeps the settled original under the same id. */
  function reRegistered(): GraphState {
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "sess-d", cwd: "/repo" });
    // Named a subagent that has not announced itself yet, so `resolveOwner` falls
    // through to the root while `explicitSubagentId` still records the name.
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-d", parent_tool_use_id: "k9",
      tool_name: "Grep", tool_use_id: "dup-1", tool_input: { pattern: "first" },
    });
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-d", parent_tool_use_id: "k9",
      tool_use_id: "dup-1", tool_response: { matches: 0 },
    });
    state = send(state, T0 + 3 * SEC, {
      hook_event_name: "SubagentStart", session_id: "sess-d",
      parent_tool_use_id: "k9", subagent_type: "worker",
    });
    // The re-delivery. The subagent exists now, so this copy lands on it.
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-d", parent_tool_use_id: "k9",
      tool_name: "Grep", tool_use_id: "dup-1", tool_input: { pattern: "first" },
    });
    // The root's turn ends; the subagent is still running.
    state = send(state, T0 + 5 * SEC, { hook_event_name: "Stop", session_id: "sess-d" });
    return state;
  }

  const SUB = "sess-d::k9";

  it("sets the scenario up the way the reducer actually resolves it", () => {
    const state = reRegistered();
    const root = state.agents.get("sess-d")!;
    const sub = state.agents.get(SUB)!;
    // One id, two ToolCall objects, on two different agents.
    expect(root.tools.map(t => t.id)).toEqual(["dup-1"]);
    expect(sub.tools.map(t => t.id)).toEqual(["dup-1"]);
    expect(root.tools[0]).not.toBe(sub.tools[0]);
    expect(root.tools[0].endedAt).toBe(T0 + 2 * SEC);
    expect(sub.tools[0].endedAt).toBeUndefined();
    // Both maps point at the live one.
    expect(state.toolIndex.get("dup-1")).toBe(sub.tools[0]);
    expect(state.toolOwner.get("dup-1")).toBe(SUB);
  });

  it("leaves the live subagent's entry alone when the root is pruned", () => {
    const state = reRegistered();
    const sub = state.agents.get(SUB)!;
    const live: ToolCall = sub.tools[0];

    const at = T0 + 5 * MIN;
    expect(pruneOldAgents(state, at, /*cap*/ 1, /*graceMs*/ 0)).toBe(true);
    expect(state.agents.has("sess-d")).toBe(false);
    expect(state.agents.has(SUB)).toBe(true);

    // Releasing by id alone would have taken this with the root, because the
    // root's own list still held a settled `dup-1`.
    expect(state.toolIndex.get("dup-1")).toBe(live);
    expect(state.toolOwner.get("dup-1")).toBe(SUB);
    expectNoOrphans(state);
  });

  it("keeps the permission prompt attributable to the subagent still working", () => {
    // The observable cost of getting the line above wrong. `blockedSubagentId`
    // walks `toolIndex` for exactly the calls that have not settled, and reads
    // the newest one to decide which subagent a prompt is about (#361). Evicting
    // a live entry there does not just lose a map key — it loses the attribution,
    // and with it the rule that lets that subagent's own traffic clear the block.
    const state = reRegistered();
    const at = T0 + 5 * MIN;
    pruneOldAgents(state, at, /*cap*/ 1, /*graceMs*/ 0);

    const after = send(state, at + SEC, {
      hook_event_name: "Notification", session_id: "sess-d",
      notification_type: "permission_prompt", message: "Grep wants to run",
    });
    const waiting = after.agents.get("sess-d")!.waiting!;
    expect(waiting.kind).toBe("permission");
    expect(waiting.subagentId).toBe(SUB);
  });
});

describe("#443 — the neighbouring rules are untouched", () => {
  it("#397: the Codex skip still leaves an unanswered call in flight", () => {
    // The sweep must keep its hands off Codex however long the session has been
    // quiet — a missing output line there means the call has not finished, not
    // that the result was lost. Pruning is what bounds it, and only pruning.
    const state = abandonedCodexSession("sess-e", T0);
    const at = T0 + 2 * STALE_SESSION_MS;
    expect(sweepStaleTools(state, at, STALE_SESSION_MS)).toBe(false);

    const call = state.agents.get("sess-e")!.tools[0];
    expect(call.endedAt).toBeUndefined();
    expect(call.ok).toBeUndefined();
    expect(state.toolIndex.has("sess-e-call")).toBe(true);
  });

  it("#436: the sweep still measures the session's silence, not the call's age", () => {
    // A call far older than the window on a session that is still talking must
    // stay in flight, and stay in `toolIndex` — the pruners take nothing from a
    // live agent.
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "sess-f", cwd: "/repo" });
    state = send(state, T0 + SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-f",
      tool_name: "Bash", tool_use_id: "long-1", tool_input: { command: "make -j8" },
    });
    // Two hours in, the session says something else — a subagent reporting, the
    // user typing. The call itself is older than the window; the session is not.
    const heard = T0 + 2 * STALE_SESSION_MS;
    state = send(state, heard, { hook_event_name: "UserPromptSubmit", session_id: "sess-f", prompt: "still there?" });

    const at = heard + SEC;
    expect(sweepStaleTools(state, at, STALE_SESSION_MS)).toBe(false);
    pruneOldAgents(state, at, 200, 5 * MIN);
    pruneDoneSessions(state, at, 6, 2 * MIN);

    const call = state.agents.get("sess-f")!.tools.find(t => t.id === "long-1")!;
    expect(call.endedAt).toBeUndefined();
    expect(state.toolIndex.has("long-1")).toBe(true);
    expect(state.toolOwner.get("long-1")).toBe("sess-f");
  });

  it("#442: a reaped session still loses its attribution stack, and now its ids", () => {
    let state = fresh();
    state = send(state, T0, { hook_event_name: "SessionStart", session_id: "sess-g", cwd: "/repo" });
    state = send(state, T0 + SEC, {
      hook_event_name: "SubagentStart", session_id: "sess-g",
      parent_tool_use_id: "kz", subagent_type: "worker",
    });
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-g", parent_tool_use_id: "kz",
      tool_name: "Bash", tool_use_id: "reap-1", tool_input: { command: "pytest" },
    });
    expect(state.activeSubagentStack.get("sess-g")).toEqual(["kz"]);

    // Nothing more is ever heard: the terminal was killed. The tick runs in
    // App.tsx's order — tools, then sessions, then the two pruners.
    const at = T0 + 2 * STALE_SESSION_MS;
    expect(sweepStaleTools(state, at, STALE_SESSION_MS)).toBe(true);
    expect(sweepStaleSessions(state, at, STALE_SESSION_MS)).toBe(true);
    expect(state.activeSubagentStack.get("sess-g")).toBeUndefined();
    // The sweep settled the call itself, so both maps are already clear here —
    // this is the path #443 does NOT change, and the reason the real log showed
    // no orphans at all.
    expect(state.toolIndex.size).toBe(0);
    expect(state.toolOwner.size).toBe(0);

    expect(pruneDoneSessions(state, at + SEC, 0, 0)).toBe(true);
    expect(state.agents.size).toBe(0);
    expect(state.activeSubagentStack.get("sess-g")).toBeUndefined();
    expectNoOrphans(state);
  });
});
