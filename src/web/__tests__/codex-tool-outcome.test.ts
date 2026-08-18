// #397: Codex tool outcomes were wrong in BOTH directions.
//
// Direction 1 — a failed Codex tool could never be red. The reducer derives the
// flag from the event NAME (`tc.ok = name === "PostToolUse"`) and the Codex
// mapper hardcoded that name for every output it saw, success or not. `ok` was
// structurally incapable of being false on the Codex path: a command that
// exited non-zero drew green, the detail panel's error count and the session
// summary's "Errors" stat were pinned at 0 for the life of a Codex session, and
// exported session JSON recorded `ok: true` for calls that had failed.
//
// Direction 2 — a call that was merely WAITING was reported as a failure that
// never happened. `sweepStaleTools` reads "no PostToolUse after 90s" as "the
// event was lost", which is true of Claude and false of Codex: Codex appends the
// call line to its rollout at request time, so a call parked on an approval
// prompt is already on the canvas with `endedAt == null`. Ninety seconds later
// the sweep stamped it `ok = false` with `errorPreview = "stale (no PostToolUse
// received)"` — a failure that had not happened, blamed on a mechanism that does
// not exist on this provider.
//
// ── what the rollouts actually say ─────────────────────────────────────────
//
// Every tool result in this machine's CODEX_HOME, 8 files, structural names and
// counts only. Codex prepends its own outcome line to the tool's output; that
// line, not any structured field, is where the verdict lives:
//
//   CLI      tool          first line of output part 0           count
//   0.144.5  exec          "Script completed"                       75
//   0.144.5  exec          "Script failed"                           2
//   0.144.5  apply_patch   "Exit code: 0"                            2
//   0.144.5  exec_command  (bare string, no outcome line at all)    30
//   0.144.5  run           (bare string, no outcome line at all)     2
//   0.147.0  exec          "Script completed"                        6
//
// Two things follow, and both are pinned below. The two CLI versions spell the
// outcome IDENTICALLY — 0.147 renamed the prompt event (#395) but left the exec
// wrapper alone — so one rule covers both with no version sniffing. And the
// outcome line is at part index 0 in 85 of the 85 results that have one, while
// the later parts are the command's own stdout: on this machine two results
// contain a line reading "Script error:" in part 1 under a wrapper that says
// "Script completed", so a rule that scanned every part would paint two
// successful calls red.
//
// The issue's own caveat — "all 8 rollout files contain only successful tool
// calls" — is wrong, and that matters: it was drawn from `patch_apply_end.
// success` (6/6 true), `CommandExecution.exit_code` (2/2 zero) and the call
// lines' `status` (85/85 "completed", including both failed calls, because that
// field is the MODEL's item status and not the execution's). Two exec calls did
// genuinely fail. The evidence was in the output text the issue had set aside.
//
// No DOM — plain node, vitest — so this drives the real mapper and the real
// reducer, with the object shapes copied from real rollout lines.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, STALE_SESSION_MS, sweepStaleTools, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
// @ts-expect-error — .mjs server module, no types
import { codexObjToPayload } from "../../server/index.mjs";

const SESSION = "01a00e99-37b3-7781-90d7-aa76a7fca6fa";
const CWD = "/repo";
const T0 = 1_700_000_000_000;
/** The cutoff App.tsx used to run the tool sweep with, kept here because these
 *  tests are about a provider the sweep never touches whatever the window is —
 *  #436 later moved the real call site onto STALE_SESSION_MS. */
const STALE_TOOL_MS = 90_000;

type Rollout = { type: string; payload: Record<string, unknown> };

// ── the real rollout shapes, keys verbatim from ~/.codex/sessions ────────────

/** The `exec` tool, on both CLI versions: a custom tool call whose result is an
 *  ARRAY of `{ type: "input_text", text }` parts. `status` is on the call line
 *  and is "completed" even when the script failed, which is why nothing here
 *  reads it. */
const execCall = (callId: string): Rollout => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name: "exec", input: '{"cmd":"npm test"}', call_id: callId, status: "completed" },
});

/** An `exec` result. `head` is Codex's own outcome line; `tail` is the command's
 *  stdout, which lands in the later parts. */
const execOutput = (callId: string, head: string, tail = "…output…"): Rollout => ({
  type: "response_item",
  payload: {
    type: "custom_tool_call_output",
    call_id: callId,
    output: [
      { type: "input_text", text: `${head}\nWall time 0.2 seconds\nOutput:\n${tail}` },
      { type: "input_text", text: tail },
    ],
  },
});

/** `apply_patch` reports itself with an exit code rather than a word, and its
 *  result has a single part. */
const patchOutput = (callId: string, code: number): Rollout => ({
  type: "response_item",
  payload: {
    type: "custom_tool_call_output",
    call_id: callId,
    output: [{ type: "input_text", text: `Exit code: ${code}\nWall time: 0 seconds\n…` }],
  },
});

/** The 0.144-only `exec_command` / `run` tools: a plain function call whose
 *  result is a bare string carrying no outcome line whatsoever (32/32). */
const fnCall = (callId: string): Rollout => ({
  type: "response_item",
  payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: callId },
});
const fnOutput = (callId: string, text: string): Rollout => ({
  type: "response_item",
  payload: { type: "function_call_output", call_id: callId, output: text },
});

// The #395 turn-lifecycle lines, re-declared here rather than imported: this
// file must be able to prove on its own that the tool fix left the turn fix
// standing, and a test that imports another test's fixtures pins nothing.
const taskStarted: Rollout = { type: "event_msg", payload: { type: "task_started", turn_id: "t1", model_context_window: 258_400 } };
const taskComplete: Rollout = { type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 9_600 } };
/** Codex ≤ 0.144 writes the prompt as its own event… */
const userMessage = (text: string): Rollout => ({ type: "event_msg", payload: { type: "user_message", message: text, kind: "plain" } });
/** …and ≥ 0.147 writes the same submission as a completed UserMessage item. */
const userItem = (text: string): Rollout => ({
  type: "event_msg",
  payload: { type: "item_completed", thread_id: SESSION, turn_id: "t1", item: { type: "UserMessage", id: "i0", content: [{ type: "text", text }] } },
});

// ── driving the two real functions ──────────────────────────────────────────

let seq = 0;

function map(obj: Rollout): HookPayload | null {
  return codexObjToPayload(obj, SESSION, CWD) as HookPayload | null;
}

/** Translate a rollout line the way the watcher does, then feed whatever comes
 *  out to the reducer. */
function feed(state: GraphState, at: number, obj: Rollout): GraphState {
  const payload = map(obj);
  if (!payload) return state;
  return push(state, at, payload);
}

function push(state: GraphState, at: number, payload: HookPayload): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: at, source: payload.provider === "codex" ? "codex" : "hook", payload };
  return applyEvent(state, env);
}

/** A live Codex session with its root on the board, the way the watcher opens
 *  one: the lazy SessionStart, then the rollout's own lines. */
function session(): GraphState {
  seq = 0;
  return push(initialState(), T0, { session_id: SESSION, cwd: CWD, provider: "codex", hook_event_name: "SessionStart" });
}

const root = (state: GraphState) => state.agents.get(SESSION)!;
const toolOf = (state: GraphState, callId: string) => root(state).tools.find(t => t.id === callId)!;

/** The five surfaces that render an outcome all ask exactly this question
 *  (`ToolBursts.tsx`, `App.tsx` twice, `ToolModal.tsx`, `SessionSummary.tsx`),
 *  so counting it here is counting what the user sees. */
const errCount = (state: GraphState) => root(state).tools.filter(t => t.ok === false).length;

/** One call, start to finish, on a fresh session. */
function callAndAnswer(call: Rollout, output: Rollout): GraphState {
  let state = feed(session(), T0, call);
  state = feed(state, T0 + 200, output);
  return state;
}

// ── direction 1: a real failure draws failed ────────────────────────────────

describe("the outcome codexObjToPayload reads out of a tool result", () => {
  // The heart of the fix: the SAME two spellings on both CLI versions, so this
  // needs no version sniffing and cannot rot when only one version is upgraded.
  for (const version of ["0.144", "0.147"] as const) {
    it(`maps "Script completed" to PostToolUse (Codex ${version})`, () => {
      expect(map(execOutput("call_1", "Script completed")))
        .toMatchObject({ hook_event_name: "PostToolUse", tool_use_id: "call_1", provider: "codex" });
    });

    it(`maps "Script failed" to PostToolUseFailure (Codex ${version})`, () => {
      // Before the fix this was "PostToolUse" and the reducer had no way at all
      // to reach ok === false on a Codex session.
      expect(map(execOutput("call_1", "Script failed")))
        .toMatchObject({ hook_event_name: "PostToolUseFailure", tool_use_id: "call_1", provider: "codex" });
    });
  }

  it("reads apply_patch's exit code, where zero alone is a success", () => {
    expect(map(patchOutput("call_p", 0))).toMatchObject({ hook_event_name: "PostToolUse" });
    expect(map(patchOutput("call_p", 1))).toMatchObject({ hook_event_name: "PostToolUseFailure" });
    expect(map(patchOutput("call_p", 128))).toMatchObject({ hook_event_name: "PostToolUseFailure" });
  });

  it("reads only the first part, so the command's own stdout cannot fake a failure", () => {
    // Two real results on this machine carry a line reading "Script error:" in
    // part 1 — a script printing its own diagnostics — under a wrapper that
    // says the script completed. Scanning every part would draw them red.
    const noisy = execOutput("call_n", "Script completed", "Script error: something the script printed\nScript failed");
    expect(map(noisy)).toMatchObject({ hook_event_name: "PostToolUse" });
  });

  it("treats an unrecognised result as a success rather than inventing a failure", () => {
    // Every `function_call_output` observed (32/32) is a bare string with no
    // outcome line, so those calls have an unknown outcome. Unknown keeps the
    // behaviour this path has always had: a missed failure draws as it always
    // did, while a false failure would put a red dot and an "Errors" count on a
    // session that did nothing wrong.
    expect(map(fnOutput("call_f", "Chunk ID: 12ab34\n…"))).toMatchObject({ hook_event_name: "PostToolUse" });
    expect(map(fnOutput("call_f", ""))).toMatchObject({ hook_event_name: "PostToolUse" });
    expect(map({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c", output: [] } }))
      .toMatchObject({ hook_event_name: "PostToolUse" });
  });

  it("sees the outcome line on Windows, where the wrapper ends its lines with CRLF", () => {
    const crlf: Rollout = {
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_w", output: [{ type: "input_text", text: "Script failed\r\nWall time 0.2 seconds\r\n" }] },
    };
    expect(map(crlf)).toMatchObject({ hook_event_name: "PostToolUseFailure" });
  });

  it("still carries the response through, so the modal has something to show", () => {
    expect(map(execOutput("call_1", "Script failed"))).toHaveProperty("tool_response");
  });
});

describe("what the deck draws for a Codex call that really failed", () => {
  for (const version of ["0.144", "0.147"] as const) {
    it(`draws it failed, with an error preview and an error count (Codex ${version})`, () => {
      const state = callAndAnswer(execCall("call_1"), execOutput("call_1", "Script failed"));
      const t = toolOf(state, "call_1");
      expect(t.endedAt).toBe(T0 + 200);
      expect(t.ok).toBe(false);
      expect(t.errorPreview).toBeTruthy();
      // The "Errors" stat that used to be pinned at 0 for the life of a session.
      expect(errCount(state)).toBe(1);
    });
  }

  it("still draws a successful call as a success", () => {
    const state = callAndAnswer(execCall("call_1"), execOutput("call_1", "Script completed"));
    const t = toolOf(state, "call_1");
    expect(t.ok).toBe(true);
    expect(t.errorPreview).toBeUndefined();
    expect(errCount(state)).toBe(0);
  });

  it("counts one error among several calls, not all of them and not none", () => {
    let state = session();
    for (const [id, head] of [["c1", "Script completed"], ["c2", "Script failed"], ["c3", "Script completed"]] as const) {
      state = feed(state, T0, execCall(id));
      state = feed(state, T0 + 100, execOutput(id, head));
    }
    expect(errCount(state)).toBe(1);
    expect(root(state).tools.map(t => t.ok)).toEqual([true, false, true]);
  });
});

// ── direction 2: a blocked call is not a failed call ────────────────────────

describe("a Codex call parked on an approval prompt", () => {
  /** The call is on the canvas and unanswered — Codex writes the call line at
   *  request time, so this is exactly the state a pending approval leaves. */
  const pending = () => feed(session(), T0, execCall("call_1"));

  it("is not stamped failed when the ninety seconds run out", () => {
    const state = pending();
    expect(sweepStaleTools(state, T0 + STALE_TOOL_MS + 5_000, STALE_TOOL_MS)).toBe(false);

    const t = toolOf(state, "call_1");
    expect(t.ok).toBeUndefined();
    expect(t.errorPreview).toBeUndefined();
    // In-flight is the one description of it that is true.
    expect(t.endedAt).toBeUndefined();
    expect(errCount(state)).toBe(0);
  });

  it("does not claim a PostToolUse was lost, on a provider that has none", () => {
    const state = pending();
    sweepStaleTools(state, T0 + 10 * 60_000, STALE_TOOL_MS);
    expect(toolOf(state, "call_1").errorPreview).toBeUndefined();
  });

  it("is still waiting an hour later, rather than having quietly failed", () => {
    const state = pending();
    sweepStaleTools(state, T0 + 60 * 60_000, STALE_TOOL_MS);
    expect(toolOf(state, "call_1").ok).toBeUndefined();
    expect(errCount(state)).toBe(0);
  });

  it("settles with its real outcome when the human finally approves it", () => {
    // Five minutes on an approval prompt is ordinary. The sweep having left the
    // call alone, the output line settles it through the live index exactly as
    // if it had come back instantly.
    let state = pending();
    sweepStaleTools(state, T0 + 2 * 60_000, STALE_TOOL_MS);
    const late = T0 + 5 * 60_000;
    state = feed(state, late, execOutput("call_1", "Script failed"));

    const t = toolOf(state, "call_1");
    expect(t.endedAt).toBe(late);
    expect(t.ok).toBe(false);
    expect(errCount(state)).toBe(1);
  });

  it("settles green when the approved command then succeeds", () => {
    let state = pending();
    sweepStaleTools(state, T0 + 2 * 60_000, STALE_TOOL_MS);
    state = feed(state, T0 + 5 * 60_000, execOutput("call_1", "Script completed"));
    expect(toolOf(state, "call_1").ok).toBe(true);
    expect(errCount(state)).toBe(0);
  });
});

describe("the same sweep on a Claude session", () => {
  // The exemption is per provider and must not have become an exemption for
  // everybody: on Claude, a session that has gone silent really did take its
  // in-flight call down with it, and that call still has to settle.
  //
  // #436 changed WHEN, not whether. The sweep used to fire on the call's own age
  // after ninety seconds, which on Claude caught every honest slow `Bash` as
  // well; it now fires on the session's silence over STALE_SESSION_MS, the same
  // window sweepStaleSessions reaps the session on. So this session — one that
  // emits nothing after the call starts — still ends up failed, an hour and a
  // half later instead of a minute and a half.
  const claudeSession = "claude-session-1";
  const claudeRoot = (s: GraphState) => s.agents.get(claudeSession)!;

  function claudePending(): GraphState {
    seq = 0;
    let state = push(initialState(), T0, { session_id: claudeSession, cwd: CWD, hook_event_name: "SessionStart" });
    state = push(state, T0, { session_id: claudeSession, cwd: CWD, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1" });
    return state;
  }

  it("still stamps an unanswered Claude tool failed once its session is silent", () => {
    const state = claudePending();
    expect(claudeRoot(state).provider).toBe("claude");
    expect(sweepStaleTools(state, T0 + STALE_SESSION_MS + 5_000, STALE_SESSION_MS)).toBe(true);

    const t = claudeRoot(state).tools.find(x => x.id === "tu_1")!;
    expect(t.ok).toBe(false);
    // The last moment there was evidence the call was running, which on this
    // session is the PreToolUse itself.
    expect(t.endedAt).toBe(T0);
    expect(t.errorPreview).toBe("session ended before this call returned");
  });

  it("leaves the same call alone at ninety seconds, when it is merely slow", () => {
    // The #436 regression guard on this provider, stated against the same
    // fixture the sweep does still eventually settle.
    const state = claudePending();
    expect(sweepStaleTools(state, T0 + STALE_TOOL_MS + 5_000, STALE_SESSION_MS)).toBe(false);
    const t = claudeRoot(state).tools.find(x => x.id === "tu_1")!;
    expect(t.ok).toBeUndefined();
    expect(t.endedAt).toBeUndefined();
  });

  it("leaves a Claude failure reaching the deck as PostToolUseFailure untouched", () => {
    // The Claude hook path emits the failure name itself; #397 changed nothing
    // there and the reducer's handling of it is shared.
    let state = claudePending();
    state = push(state, T0 + 500, {
      session_id: claudeSession, cwd: CWD, hook_event_name: "PostToolUseFailure",
      tool_use_id: "tu_1", tool_response: "boom",
    });
    const t = claudeRoot(state).tools.find(x => x.id === "tu_1")!;
    expect(t.ok).toBe(false);
    expect(t.errorPreview).toBe("boom");
  });
});

// ── #395 must still hold ────────────────────────────────────────────────────

describe("the turn lifecycle #395 built, with tool outcomes now on top of it", () => {
  for (const [version, prompt] of [["0.144", userMessage("ship it")], ["0.147", userItem("ship it")]] as const) {
    it(`still settles the root on task_complete, and counts the failed call (Codex ${version})`, () => {
      let state = session();
      state = feed(state, T0, taskStarted);
      state = feed(state, T0 + 1_000, prompt);
      expect(root(state).state).toBe("active");
      expect(root(state).prompts.map(p => p.text)).toEqual(["ship it"]);

      state = feed(state, T0 + 2_000, execCall("call_1"));
      state = feed(state, T0 + 3_000, execOutput("call_1", "Script failed"));
      state = feed(state, T0 + 4_000, taskComplete);

      // #395's ending: settled at the moment it finished, not a reaper's guess.
      expect(root(state).state).toBe("done");
      expect(root(state).endedAt).toBe(T0 + 4_000);
      expect(root(state).reaped).toBeFalsy();
      // …and #397's verdict survives the turn ending on top of it.
      expect(errCount(state)).toBe(1);
    });
  }

  it("leaves the item_completed types #395 mapped exactly where they were", () => {
    // The prompt item still maps to a prompt, and CommandExecution still maps to
    // nothing. #397 settled the tool outcome from the tool RESULT the mapper
    // already holds, so it never needed to reach for this item — which is just
    // as well, since `item.id` is an `exec-<uuid>` that matches no `call_id`
    // (0 of 2 observed) and a PostToolUse with no `tool_use_id` settles nothing.
    expect(map(userItem("hi"))).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(map({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-1", exit_code: 1, status: "completed" } },
    })).toBeNull();
  });

  it("leaves patch_apply_end unmapped, so no call is ever settled twice", () => {
    // It carries `success` and a joinable `call_id`, but it is 0.144-only here
    // (6 events, 0 on 0.147) and it lands BETWEEN the call and its output. Were
    // it mapped too, the output line would arrive afterwards and overwrite the
    // verdict it had just written.
    expect(map({
      type: "event_msg",
      payload: { type: "patch_apply_end", call_id: "call_1", success: false, status: "failed", stdout: "", stderr: "no" },
    })).toBeNull();
  });
});
