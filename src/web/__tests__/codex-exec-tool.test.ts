// #417: every Codex tool call drew as an anonymous grey ✨ with no command.
//
// Claude's `⚡ Bash → 🐙 git` and Codex's `✨ exec` were the same work on the
// same canvas. Two independent faults produced that, and neither one alone
// explains it — fixing either would still have left the bubble unreadable.
//
// FAULT 1, server. `codexObjToPayload`'s `custom_tool_call` branch hardcoded
// `tool_input: { patch: pl.input }`. It was written when `apply_patch` was the
// only thing that arrived in that container and it was right then; it is not
// the only thing now, and on 0.147 it is not even the common one. The client
// reads `cmd` / `command` / `script` for a command and `patch` for a file path,
// so a shell script filed under `patch` could produce neither.
//
// FAULT 2, client. The tool is called `exec` and six lookup tables had never
// heard the name — TOOL_CATEGORY, TOOL_EMOJI, CODEX_PRIMARY_LABEL, SHELL_TOOLS
// and CODEX_TOOLS in ToolBursts.tsx, plus DETAIL_TOOL_CAT in App.tsx. Every one
// of them listed `shell` / `exec_command` / `shell_command`, and the CLI now
// sends none of those as a call name.
//
// ── what the rollouts actually say ─────────────────────────────────────────
//
// Every tool call in this machine's CODEX_HOME, 8 rollout files, record kind
// and tool name only:
//
//   CLI      record             name           count   input shape
//   0.144.5  custom_tool_call   exec              77    JS program (string)
//   0.144.5  custom_tool_call   apply_patch        2    *** Begin Patch … doc
//   0.144.5  function_call      exec_command      30    JSON {cmd,workdir,…}
//   0.144.5  function_call      run                2    JSON {search_query,…}
//   0.147.0  custom_tool_call   exec               6    JS program (string)
//
// `exec` is 83 of the 117 calls, and the ONLY name 0.147 emits at all. Two
// things about it decide the whole fix. It arrives through `custom_tool_call`,
// which is why it was filed as a patch. And its input is not a command — it is
// a small JavaScript program that calls `tools.exec_command({ cmd })`: 83 of 83
// start with `const `, none parses as JSON, all are multi-line. That is why
// filing it under `command` instead would only have swapped one wrong picture
// for another, drawing `⚡ Shell → ⚙️ const` on every Codex call. Codex agrees
// it is a program — its result wrapper says "Script completed" (#397), not an
// exit code.
//
// No DOM — plain node, vitest — so this drives the real mapper, the real
// reducer and the real burst layout, with the object shapes copied from real
// rollout lines.
import { describe, it, expect } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { collectBursts, primaryBubbleWidth } from "../components/ToolBursts";
// @ts-expect-error — .mjs server module, no types
import { codexObjToPayload } from "../../server/index.mjs";

const SESSION = "01a00e99-37b3-7781-90d7-aa76a7fca6fa";
const CWD = "/repo";
const T0 = 1_700_000_000_000;
/** The fixed primary-bubble width estimate Claude's short labels were sized for. */
const ESTIMATED_BUBBLE_W = 96;

type Rollout = { type: string; payload: Record<string, unknown> };

// ── the real rollout shapes ─────────────────────────────────────────────────

/** A Codex `exec` call. The input is the script verbatim in its observed
 *  shape; only the command inside it is invented. 0.144 puts `text(r.output)`
 *  on its own line, 0.147 usually trails it on the first — both are here
 *  because the extraction must not care. */
const execCall = (callId: string, script: string): Rollout => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name: "exec", input: script, call_id: callId, status: "completed" },
});

/** 0.144.5's spelling: two lines, the four arguments in their observed order. */
const script144 = (cmd: string) =>
  `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:"/repo",yield_time_ms:250,max_output_tokens:8000});\ntext(r.output);`;

/** 0.147.0's spelling: the same call with the print trailing on one line. */
const script147 = (cmd: string) =>
  `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:"/repo",yield_time_ms:250,max_output_tokens:8000}); text(r.output);\n`;

const SCRIPT_BY_VERSION = { "0.144": script144, "0.147": script147 } as const;
const VERSIONS = ["0.144", "0.147"] as const;

/** A patch document, as `apply_patch` carries it (2/2 observed on 0.144.5). */
const PATCH_DOC = "*** Begin Patch\n*** Update File: src/web/App.tsx\n@@\n-before\n+after\n*** End Patch\n";
const patchCall = (callId: string): Rollout => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name: "apply_patch", input: PATCH_DOC, call_id: callId, status: "completed" },
});

// ── driving the real mapper, reducer and layout ─────────────────────────────

let seq = 0;

function map(obj: Rollout): HookPayload | null {
  return codexObjToPayload(obj, SESSION, CWD) as HookPayload | null;
}

function push(state: GraphState, at: number, payload: HookPayload): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: at, source: payload.provider === "codex" ? "codex" : "hook", payload };
  return applyEvent(state, env);
}

function feed(state: GraphState, at: number, obj: Rollout): GraphState {
  const payload = map(obj);
  if (!payload) return state;
  return push(state, at, payload);
}

/** A live Codex session with its root on the board, the way the watcher opens
 *  one: the lazy SessionStart, then the rollout's own lines. */
function session(): GraphState {
  seq = 0;
  return push(initialState(), T0, { session_id: SESSION, cwd: CWD, provider: "codex", hook_event_name: "SessionStart" });
}

/** The bubbles the canvas would draw for this state — the real layout pass,
 *  over a canvas holding exactly the sessions in it. */
function bursts(state: GraphState) {
  const agents = state.agents;
  const positions = new Map([...agents.keys()].map((id, i) => [id, { x: 0, y: i * 400 }]));
  const measured = new Map([...agents.keys()].map(id => [id, { width: 260, height: 130 }]));
  return collectBursts(agents, new Set(agents.keys()), positions, new Map(), measured, T0 + 1_000);
}

/** The primary bubble and its chained sub-bubble for a given tool call. */
function bubblesFor(state: GraphState, callId: string) {
  const all = bursts(state).filter(b => b.toolId === callId);
  return { primary: all.find(b => !b.isSub), sub: all.find(b => b.isSub) };
}

/** One Codex tool call, mapped and reduced onto a fresh session. */
function canvasWith(call: Rollout): GraphState {
  return feed(session(), T0, call);
}

// ── fault 1: the key the input is filed under ───────────────────────────────

describe("the key codexObjToPayload files a custom_tool_call's input under", () => {
  for (const version of VERSIONS) {
    it(`files an exec script under "script", not "patch" (Codex ${version})`, () => {
      const script = SCRIPT_BY_VERSION[version]("git status --short");
      const payload = map(execCall("call_1", script)) as any;
      expect(payload).toMatchObject({
        hook_event_name: "PreToolUse", tool_name: "exec", tool_use_id: "call_1", provider: "codex",
      });
      expect(payload.tool_input).toEqual({ script });
      // The whole of fault 1 in one line: 83 shell scripts stored as patches.
      expect(payload.tool_input).not.toHaveProperty("patch");
    });
  }

  it("still files an apply_patch document under \"patch\"", () => {
    // Not merely unchanged — load-bearing. The client's extractFilePath() reads
    // `input.patch` to find the `*** Update File:` header, so renaming this key
    // would trade one broken sub-bubble for another.
    const payload = map(patchCall("call_p")) as any;
    expect(payload.tool_name).toBe("apply_patch");
    expect(payload.tool_input).toEqual({ patch: PATCH_DOC });
  });

  it("files a name it has never heard under a neutral key rather than guessing", () => {
    // The lesson of this bug, encoded: a confident wrong key is worse than an
    // honest unknown one. `patch` was a confident wrong key for 83 calls.
    const unknown: Rollout = {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "frobnicate", input: "whatever this is", call_id: "call_u" },
    };
    const payload = map(unknown) as any;
    expect(payload.tool_name).toBe("frobnicate");
    expect(payload.tool_input).toEqual({ input: "whatever this is" });
    expect(payload.tool_input).not.toHaveProperty("patch");
    expect(payload.tool_input).not.toHaveProperty("command");
  });

  it("leaves function_call inputs exactly as they arrive", () => {
    // 0.144's `exec_command` comes through the other container with real JSON
    // arguments, and that branch was never wrong. Parsed, not re-keyed.
    const fn: Rollout = {
      type: "response_item",
      payload: {
        type: "function_call", name: "exec_command", call_id: "call_f",
        arguments: '{"cmd":"ls","workdir":"/repo","yield_time_ms":250,"max_output_tokens":8000}',
      },
    };
    const payload = map(fn) as any;
    expect(payload.tool_name).toBe("exec_command");
    expect(payload.tool_input).toEqual({ cmd: "ls", workdir: "/repo", yield_time_ms: 250, max_output_tokens: 8000 });
  });
});

// ── fault 2: what the canvas draws ──────────────────────────────────────────

describe("the bubble a Codex exec call draws", () => {
  for (const version of VERSIONS) {
    it(`reads "⚡ Shell → 🐙 git", the way Claude's Bash does (Codex ${version})`, () => {
      const state = canvasWith(execCall("call_1", SCRIPT_BY_VERSION[version]("git status --short")));
      const { primary, sub } = bubblesFor(state, "call_1");

      // Before the fix: emoji "✨", name "exec", category "other", no sub at all.
      expect(primary).toMatchObject({ emoji: "⚡", name: "Shell", category: "shell", toolName: "exec" });
      expect(sub).toMatchObject({ emoji: "🐙", name: "git", category: "shell", isSub: true });
      // The sub-bubble's tooltip is what actually ran, not the program around it.
      expect(sub!.inputPreview).toBe("git status --short");
    });

    it(`shows the command and not the word "const" (Codex ${version})`, () => {
      // The trap in the obvious fix. `{ command: <the whole script> }` makes
      // parseShellCommand take the program's first token, so every Codex call
      // in the session draws the same sub-bubble: ⚙️ const.
      const { sub } = bubblesFor(canvasWith(execCall("c", SCRIPT_BY_VERSION[version]("npm test"))), "c");
      expect(sub!.name).toBe("npm");
      expect(sub!.name).not.toBe("const");
    });
  }

  it("keeps the raw tool name on the bubble for the tooltip to show", () => {
    // The clean label is display-only; nothing about what Codex called it is
    // hidden, which is the property that makes relabelling safe at all.
    const { primary } = bubblesFor(canvasWith(execCall("c", script147("ls"))), "c");
    expect(primary!.toolName).toBe("exec");
  });

  it("hands the extracted command to the same parser Claude's goes through", () => {
    // The extraction stops at "the command"; everything after it — unwrapping
    // `bash -c`, stripping a leading path — is parseShellCommand's existing
    // work, and the command has to reach it in a state it can still do that in.
    const { sub } = bubblesFor(canvasWith(execCall("c", script147('bash -c "git log --oneline -3"'))), "c");
    expect(sub!.name).toBe("git");
  });

  it("keeps a multi-line command in one piece", () => {
    // Ten real calls on this machine pass a whole awk program as the command,
    // newlines and all. It arrives as a JavaScript string literal with those
    // newlines escaped, so the extraction has to cross them rather than stop at
    // the first one.
    const script = 'const r = await tools.exec_command({cmd:"awk \'\\nfunction f(x) { return x }\\n\' file.txt",workdir:"/repo"}); text(r.output);';
    const { sub } = bubblesFor(canvasWith(execCall("c", script)), "c");
    expect(sub!.name).toBe("awk");
    expect(sub!.inputPreview).toContain("\n");
  });

  it("survives the quotes a real command needs, rather than showing them", () => {
    // The command reaches the deck as a JavaScript string literal, so a command
    // containing quotes arrives escaped. Undoing that is what keeps the tooltip
    // readable instead of showing the model's quoting.
    const script = 'const r = await tools.exec_command({cmd:"grep -rn \\"needle\\" src",workdir:"/repo"}); text(r.output);';
    const { sub } = bubblesFor(canvasWith(execCall("c", script)), "c");
    expect(sub!.name).toBe("grep");
    expect(sub!.inputPreview).toBe('grep -rn "needle" src');
  });

  it("names the API the script called when the script runs no shell command", () => {
    // 0.147 routes the web tool through the same script: `tools.web__run`.
    // There is no command to show, so the bubble shows what it did instead of
    // stopping at a bare "Shell" — a captured tool should never be unreadable.
    const script = 'const r = await tools.web__run({search_query:[{q:"vitest plain node"}],response_length:"short"}); text(r)';
    const { primary, sub } = bubblesFor(canvasWith(execCall("c", script)), "c");
    expect(primary).toMatchObject({ emoji: "⚡", name: "Shell" });
    expect(sub).toMatchObject({ name: "web__run", isSub: true });
  });

  it("prefers the command over the patch when a script does both", () => {
    // Three real scripts generate a diff and pipe it into tools.apply_patch.
    // The command is the first thing the script did and the thing worth naming.
    const script = 'const gen = await tools.exec_command({cmd:"git diff",workdir:"/repo"});\nconst applied = await tools.apply_patch(gen.output);';
    const { sub } = bubblesFor(canvasWith(execCall("c", script)), "c");
    expect(sub!.name).toBe("git");
  });

  it("scales the primary width so a long command's bubble clears it", () => {
    // #84's overlap, which every Codex tool name is exposed to. "Shell" is
    // short enough to stay on the fixed estimate; the point is that `exec` is
    // now inside the set that scales at all.
    expect(primaryBubbleWidth("exec", "Shell")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("exec", "a-very-long-label")).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("Bash", "a-very-long-label")).toBe(ESTIMATED_BUBBLE_W);
  });
});

describe("the tools around exec, which must not have moved", () => {
  it("still draws apply_patch as an Edit on the file it touched", () => {
    const { primary, sub } = bubblesFor(canvasWith(patchCall("call_p")), "call_p");
    expect(primary).toMatchObject({ emoji: "🩹", name: "Edit", category: "file" });
    // The file path still comes out of the `*** Update File:` header.
    expect(sub).toMatchObject({ name: "App.tsx", category: "file", isSub: true });
  });

  it("still draws 0.144's exec_command function call as a Shell call", () => {
    const fn: Rollout = {
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call_f", arguments: '{"cmd":"cargo build","workdir":"/repo"}' },
    };
    const { primary, sub } = bubblesFor(canvasWith(fn), "call_f");
    expect(primary).toMatchObject({ emoji: "⚡", name: "Shell", category: "shell" });
    expect(sub).toMatchObject({ emoji: "🦀", name: "cargo" });
  });

  it("leaves a Claude Bash call untouched in colour, emoji, label and sub-bubble", () => {
    seq = 0;
    let state = push(initialState(), T0, { session_id: "claude-1", cwd: CWD, hook_event_name: "SessionStart" });
    state = push(state, T0 + 10, {
      session_id: "claude-1", cwd: CWD, hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_use_id: "tu_1", tool_input: { command: "git status --short", description: "status" },
    });
    const { primary, sub } = bubblesFor(state, "tu_1");
    expect(primary).toMatchObject({ emoji: "⚡", name: "Bash", category: "shell" });
    expect(sub).toMatchObject({ emoji: "🐙", name: "git", category: "shell" });
    expect(sub!.inputPreview).toBe("git status --short");
  });

  it("leaves a PowerShell script's own `script` key reading as a command", () => {
    // The script extraction runs on any input carrying a `script` key, and
    // PowerShell's is one. It must only fire on an actual Codex tools program —
    // a PowerShell script that merely mentions `$tools.Count` is not one.
    seq = 0;
    let state = push(initialState(), T0, { session_id: "claude-2", cwd: CWD, hook_event_name: "SessionStart" });
    state = push(state, T0 + 10, {
      session_id: "claude-2", cwd: CWD, hook_event_name: "PreToolUse",
      tool_name: "PowerShell", tool_use_id: "tu_ps",
      tool_input: { script: "npm run build; Write-Host $tools.Count" },
    });
    expect(bubblesFor(state, "tu_ps").sub).toMatchObject({ name: "npm" });
  });
});
