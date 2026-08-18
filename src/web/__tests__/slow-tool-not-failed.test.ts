// #436: any Claude tool call still running after ninety seconds was drawn as a
// FAILURE, and the cause the deck named for it was untrue.
//
// `sweepStaleTools` judged a call on its own age: `now - t.startedAt > 90_000`
// stamped `ok = false` and `errorPreview = "stale (no PostToolUse received)"`.
// Five surfaces read `ok` — the burst dot's colour, the tool row's status, the
// ToolModal's error styling, the detail panel's error count and the session
// summary's "Errors" stat — so the call went red on all of them and stayed red
// until its real PostToolUse arrived and resurrected it.
//
// ── what the real log says ──────────────────────────────────────────────────
//
// 1420 Claude calls with a matched PreToolUse -> PostToolUse pair, from this
// machine's events.jsonl (metadata only — event names, tool names, timestamps):
//
//   p50 438ms   p90 5.7s   p95 19.1s   p99 63.0s   max 776.2s
//   over 90s: 13 calls (0.92%) — 12 Bash, 1 AskUserQuestion
//   over 600s: 2 calls
//
// Every one of those 13 was healthy and returned normally; the worst was drawn
// red, and counted in the Errors stat, for 686.2s. Against them the sweep caught
// 3 calls that were genuinely orphaned. Four out of five of its verdicts were
// false, on a signal the user acts on — a red Bash is a build you go and kill.
//
// ── why it is not a bigger number ───────────────────────────────────────────
//
// Ninety seconds sat below Claude Code's own Bash timeout (120s default, 600s
// max), so the sweep fired inside the CLI's documented operating range. But 600s
// is no safer: two measured honest calls ran past it, because PreToolUse fires
// before the permission decision and a call parked on a human has no bound at
// all — the same shape as the Codex approval prompt #397 was about. No threshold
// on the call's own age can work, because "slow" and "lost" overlap on that axis.
//
// The rule is now the session's silence rather than the call's age, on the
// window `sweepStaleSessions` (#350) already defends as the point at which a
// session is presumed dead. A call settles only once the session it belongs to
// has stopped emitting entirely — which is the evidence the sweep was always
// really looking for, and the only evidence that separates the two cases.
//
// Note what that does NOT rest on. A foreground tool call is the whole of what
// its session is doing, so the session is silent for the duration of the call by
// construction: all 13 false positives ran on sessions whose longest silence
// inside the call window was the call itself. Reading `lastEventAt` against the
// OLD ninety-second window would have condemned all 13 exactly as `startedAt`
// did. The clock and the window had to change together, and the tests below pin
// both — the middle describe would pass on the pre-fix source if only the clock
// had moved.
//
// Which way this chooses to be wrong: a genuinely lost call now lingers as a
// spinner instead of settling at ninety seconds. It still settles — every one of
// the 3 real orphans measured here belonged to a session that did eventually
// fall silent — just later, and only once there is evidence for it. A spinner
// that outstays its welcome is a smaller lie than a failure that never happened.
//
// No DOM — plain node, vitest — so this drives the reducer directly and
// re-derives the two surfaces inline the way App.tsx computes them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyEvent,
  initialState,
  STALE_SESSION_MS,
  sweepStaleSessions,
  sweepStaleTools,
  type GraphState,
} from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-436";
const CWD = "/repo";
const SEC = 1_000;
const MIN = 60_000;
/** Where every scenario starts, so "T0 + 13 minutes" is a readable number. */
const T0 = 1_700_000_000_000;
/** The window the old sweep used, kept as a named number because half of these
 *  tests are about what must NOT happen when a call crosses it. */
const OLD_STALE_TOOL_MS = 90 * SEC;
/** The longest honest call in the measured log, to the millisecond. */
const LONGEST_HONEST_MS = 776_200;

let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: at,
    source: "hook",
    payload: { session_id: SESSION, cwd: CWD, ...payload },
  };
  return applyEvent(state, env);
}

/** A Claude session that has just started a `Bash` call at T0 and, like every
 *  session running a foreground command, says nothing at all while it runs. */
function running(tool = "Bash", provider: "claude" | "codex" = "claude"): GraphState {
  seq = 0;
  let state = send(initialState(), T0 - 10 * SEC, { hook_event_name: "SessionStart", provider });
  state = send(state, T0 - 5 * SEC, { hook_event_name: "UserPromptSubmit", prompt: "run the suite", provider });
  return send(state, T0, { hook_event_name: "PreToolUse", tool_name: tool, tool_use_id: "t1", provider });
}

const root = (state: GraphState) => state.agents.get(SESSION)!;
const call = (state: GraphState) => root(state).tools.find(t => t.id === "t1")!;

/** The detail panel's error count, App.tsx:`agent.tools.filter(t => t.ok === false)`.
 *  Re-derived rather than imported because it is written inline in the component
 *  and there is no module to ask; the expression is copied verbatim so it moves
 *  when that one does. */
const errCount = (state: GraphState): number => root(state).tools.filter(t => t.ok === false).length;

/** The tool row's status, App.tsx's exact ternary. This is the surface the issue
 *  is about: "err" is the red one. */
const status = (state: GraphState): "inflight" | "err" | "done" => {
  const t = call(state);
  return t.endedAt == null ? "inflight" : t.ok === false ? "err" : "done";
};

// ── the bug: a slow call is not a failed call ───────────────────────────────

describe("a Claude tool call that is merely slow", () => {
  it("is still in-flight, not red, at the old ninety-second cutoff", () => {
    const state = running();
    expect(sweepStaleTools(state, T0 + OLD_STALE_TOOL_MS + 5 * SEC, STALE_SESSION_MS)).toBe(false);
    expect(status(state)).toBe("inflight");
    expect(call(state).ok).toBeUndefined();
    expect(call(state).errorPreview).toBeUndefined();
    expect(errCount(state)).toBe(0);
  });

  it("survives the longest call this machine has actually recorded", () => {
    // 776.2s of `Bash`. Under the old rule this was red — and counted as an
    // error — for 686.2s of its 776.2s, which is the headline number in #436.
    const state = running();
    for (let t = T0; t <= T0 + LONGEST_HONEST_MS; t += 15 * SEC) {
      // Swept on every step, the way the 250ms tick in App.tsx sweeps.
      expect(sweepStaleTools(state, t, STALE_SESSION_MS)).toBe(false);
    }
    expect(status(state)).toBe("inflight");
    expect(errCount(state)).toBe(0);
  });

  it("settles green with its real duration when it finally returns", () => {
    let state = running();
    sweepStaleTools(state, T0 + 5 * MIN, STALE_SESSION_MS);
    const late = T0 + 13 * MIN;
    state = send(state, late, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_response: "ok" });

    expect(status(state)).toBe("done");
    expect(call(state).ok).toBe(true);
    expect(call(state).endedAt).toBe(late);
    expect(errCount(state)).toBe(0);
  });

  it("leaves an AskUserQuestion parked on a human alone, like a Codex approval", () => {
    // The sharpest case, and the one #397 already recognised on the other
    // provider: the call is blocked on the user BY DESIGN, so its age carries no
    // information about its health whatsoever.
    const state = running("AskUserQuestion");
    expect(sweepStaleTools(state, T0 + 20 * MIN, STALE_SESSION_MS)).toBe(false);
    expect(status(state)).toBe("inflight");
    expect(errCount(state)).toBe(0);
  });
});

// ── the window and the clock had to move together ──────────────────────────

describe("a session whose subagents are still reporting", () => {
  it("keeps its old call in-flight far beyond the window", () => {
    // This is the half a bigger number could not buy: the session has been alive
    // and noisy for three hours, so the call is not evidence of anything being
    // lost however old it is. `sweepStaleSessions` reaches the same verdict from
    // the same field, which is the point of sharing it.
    let state = running();
    for (let t = T0; t <= T0 + 180 * MIN; t += 10 * MIN) {
      state = send(state, t + SEC, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `sub-${t}` });
      state = send(state, t + 2 * SEC, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `sub-${t}` });
      expect(sweepStaleTools(state, t + 3 * SEC, STALE_SESSION_MS)).toBe(false);
      expect(sweepStaleSessions(state, t + 3 * SEC, STALE_SESSION_MS)).toBe(false);
    }
    expect(status(state)).toBe("inflight");
    expect(errCount(state)).toBe(0);
  });

  it("would still have been condemned by the old window, on either clock", () => {
    // The measurement that rules out "just swap startedAt for lastEventAt". A
    // foreground call means a silent session, so at ninety seconds the two clocks
    // read the same and both are wrong. Stated as a fact about this fixture: the
    // session's newest event is the PreToolUse itself.
    const state = running();
    expect(root(state).lastEventAt).toBe(T0);
    expect(sweepStaleTools(state, T0 + OLD_STALE_TOOL_MS + SEC, OLD_STALE_TOOL_MS)).toBe(true);
    expect(status(state)).toBe("err");
  });
});

// ── the case the sweep exists for still works ──────────────────────────────

describe("a session that genuinely died mid-call", () => {
  const dead = () => running();
  const reap = (state: GraphState) => sweepStaleTools(state, T0 + STALE_SESSION_MS + SEC, STALE_SESSION_MS);

  it("settles the abandoned call as failed once the session is silent", () => {
    const state = dead();
    expect(reap(state)).toBe(true);
    expect(status(state)).toBe("err");
    expect(call(state).ok).toBe(false);
  });

  it("stamps it at the last moment there was evidence, not at an invented offset", () => {
    // The old sweep wrote `startedAt + maxMs`, a duration it made up. The session
    // and its call now agree about when the terminal died, because both read the
    // same last event.
    const state = dead();
    reap(state);
    sweepStaleSessions(state, T0 + STALE_SESSION_MS + SEC, STALE_SESSION_MS);
    expect(call(state).endedAt).toBe(T0);
    expect(root(state).endedAt).toBe(T0);
    expect(root(state).reaped).toBe(true);
  });

  it("names what was observed instead of an internal mechanism", () => {
    const state = dead();
    reap(state);
    expect(call(state).errorPreview).toBe("session ended before this call returned");
  });

  it("drops the call from the live index and stops reporting it as changed", () => {
    const state = dead();
    reap(state);
    expect(state.toolIndex.has("t1")).toBe(false);
    expect(state.toolOwner.has("t1")).toBe(false);
    // Idempotent: a settled call is not swept a second time on the next tick, so
    // the 250ms interval does not re-render forever.
    expect(reap(state)).toBe(false);
  });

  it("is put back, un-lied, if the session turns out to have been alive", () => {
    // The sweep is still a guess, so the un-guess has to keep working: a late
    // PostToolUse finds the call by scanning its owner and clears the marker,
    // exactly as a late event un-reaps the root above it.
    let state = dead();
    reap(state);
    // The tick runs both sweeps, so the root is reaped alongside its call and
    // both have to come back together.
    sweepStaleSessions(state, T0 + STALE_SESSION_MS + SEC, STALE_SESSION_MS);
    expect(status(state)).toBe("err");
    expect(root(state).reaped).toBe(true);

    const late = T0 + STALE_SESSION_MS + 5 * MIN;
    state = send(state, late, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_response: "ok" });

    expect(status(state)).toBe("done");
    expect(call(state).ok).toBe(true);
    expect(call(state).endedAt).toBe(late);
    expect(call(state).errorPreview).toBeUndefined();
    expect(errCount(state)).toBe(0);
    expect(root(state).reaped).toBe(false);
  });
});

// ── the window the app actually ships ──────────────────────────────────────

describe("the cutoff App.tsx drives the sweep with", () => {
  const app = () => readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("is the session-silence window and not a shorter one of its own", () => {
    // Everything above takes the window as an argument, so it can only ever say
    // "given the shipped cutoff, …". The cutoff itself lives at the call site,
    // and a reducer test that drives the function directly would never notice it
    // being wrong — which is exactly how a ninety-second constant sat under a
    // ninety-minute rule. #350 pins its own call site the same way, and for the
    // same reason.
    expect(app()).toMatch(/sweepStaleTools\(stateRef\.current, t, STALE_SESSION_MS\)/);
  });

  it("no longer keeps a separate ninety-second tool constant", () => {
    // Two windows for one question is what the bug was. There is one now, and it
    // is the one with the reasoning written under it.
    expect(app()).not.toMatch(/STALE_TOOL_MS/);
  });
});

// ── #397 is untouched ──────────────────────────────────────────────────────

describe("the Codex exemption from #397", () => {
  it("still skips a Codex call even on a session that has gone silent for hours", () => {
    // #436 narrowed WHEN Claude calls are swept; it must not have widened the
    // sweep onto the provider that opted out of it entirely. Codex writes its
    // call line at request time, so a call with no output line has not finished
    // — there is nothing here to settle at any window.
    const state = running("exec", "codex");
    expect(root(state).provider).toBe("codex");
    expect(sweepStaleTools(state, T0 + 3 * 60 * MIN, STALE_SESSION_MS)).toBe(false);
    expect(call(state).ok).toBeUndefined();
    expect(call(state).endedAt).toBeUndefined();
    expect(call(state).errorPreview).toBeUndefined();
    expect(errCount(state)).toBe(0);
  });
});
