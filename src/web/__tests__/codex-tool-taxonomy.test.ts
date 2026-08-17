// #417, the half that is about the next rename rather than this one.
//
// When Codex renamed its shell tool to `exec`, SIX lookup tables missed it at
// once — TOOL_CATEGORY, TOOL_EMOJI, CODEX_PRIMARY_LABEL, SHELL_TOOLS and
// CODEX_TOOLS in ToolBursts.tsx, plus DETAIL_TOOL_CAT in App.tsx, whose comment
// claimed the duplication was "small enough that a shared module isn't worth
// it". Six of six missed, which is what a set of parallel tables does: adding a
// name costs six edits and misses at least one, and the miss is silent because
// every table has a plausible default — "other", the ✨ fallback, the raw name,
// no sub-bubble. The result is indistinguishable from the deck being broken.
//
// So the Codex half of all six now derives from ONE spec table, and these pin
// that it really does: for every Codex tool name the deck knows, the bubble the
// canvas draws must match the spec in every field, and the bucket the detail
// panel counts it under must be the same bucket the canvas tints it with. A
// name added to the spec is a name all six know, or these fail.
//
// No DOM — plain node, vitest. App.tsx cannot be imported here (React, JSX,
// reactflow), so its half is pinned two ways: behaviourally through the shared
// function it now calls, and structurally by reading the file to prove it calls
// it rather than keeping a seventh copy of the table.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { collectBursts, primaryBubbleWidth } from "../components/ToolBursts";
import {
  categoryFor,
  codexScriptCommand,
  CODEX_SHELL_TOOLS,
  CODEX_TOOL_EMOJI,
  CODEX_TOOL_LABEL,
  CODEX_TOOL_NAMES,
  CODEX_TOOL_SPECS,
} from "../tool-taxonomy";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSION = "codex-session";
const CWD = "/repo";
const T0 = 1_700_000_000_000;
/** The fixed primary-bubble width estimate Claude's short labels were sized for. */
const ESTIMATED_BUBBLE_W = 96;

/** A plausible tool_input per Codex tool, in the shape the server now sends —
 *  `exec` gets its script, `apply_patch` its patch document, the rest the JSON
 *  arguments their function_call container carries. */
const INPUT_FOR: Record<string, unknown> = {
  exec: { script: 'const r = await tools.exec_command({cmd:"git status",workdir:"/repo"}); text(r.output);' },
  shell: { command: ["bash", "-c", "git status"] },
  exec_command: { cmd: "git status", workdir: "/repo" },
  shell_command: { command: "git status" },
  write_stdin: { cmd: "y" },
  wait: { cmd: "sleep 1" },
  apply_patch: { patch: "*** Begin Patch\n*** Update File: src/web/App.tsx\n*** End Patch\n" },
  update_plan: { plan: [] },
  run: { search_query: [{ q: "anything" }] },
};

let seq = 0;

function push(state: GraphState, payload: HookPayload): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: T0, source: "codex", payload };
  return applyEvent(state, env);
}

/** The bubbles the canvas draws for one tool call, through the real reducer and
 *  the real layout pass. */
function bubblesFor(toolName: string, input: unknown) {
  seq = 0;
  let state = push(initialState(), { session_id: SESSION, cwd: CWD, provider: "codex", hook_event_name: "SessionStart" });
  state = push(state, {
    session_id: SESSION, cwd: CWD, provider: "codex", hook_event_name: "PreToolUse",
    tool_name: toolName, tool_use_id: "call_1", tool_input: input as HookPayload["tool_input"],
  });
  const agents = state.agents;
  const positions = new Map([...agents.keys()].map(id => [id, { x: 0, y: 0 }]));
  const measured = new Map([...agents.keys()].map(id => [id, { width: 260, height: 130 }]));
  const all = collectBursts(agents, new Set(agents.keys()), positions, new Map(), measured, T0 + 1_000);
  return { primary: all.find(b => !b.isSub), sub: all.find(b => b.isSub) };
}

// ── the invariant that would have caught this bug ───────────────────────────

describe("every Codex tool the deck knows, drawn from the one spec table", () => {
  for (const [name, spec] of Object.entries(CODEX_TOOL_SPECS)) {
    it(`draws ${name} as ${spec.emoji} ${spec.label} in the ${spec.category} bucket`, () => {
      const { primary, sub } = bubblesFor(name, INPUT_FOR[name]);
      // TOOL_EMOJI, CODEX_PRIMARY_LABEL and TOOL_CATEGORY, all three at once.
      expect(primary).toMatchObject({ emoji: spec.emoji, name: spec.label, category: spec.category, toolName: name });
      // Not the fallbacks that made the bug invisible.
      expect(primary!.emoji).not.toBe("✨");
      expect(primary!.category).not.toBe("other");
      if (spec.label !== name) expect(primary!.name).not.toBe(name);
      // SHELL_TOOLS: a tool that carries a command shows the command.
      if (spec.shell) expect(sub, `${name} should chain a sub-bubble`).toBeTruthy();
      // DETAIL_TOOL_CAT: the detail strip and the canvas count it the same way.
      expect(categoryFor(name)).toBe(primary!.category);
      // CODEX_TOOLS: the width estimate scales for it, so a long label cannot
      // bury the chained sub-bubble inside the primary (#84).
      expect(primaryBubbleWidth(name, "a-very-long-label")).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    });
  }

  it("keeps both CLI versions' names, because both versions are in use", () => {
    // 0.147 emits `exec` and nothing else; 0.144 emits `exec`, `exec_command`,
    // `apply_patch` and `run`. A rollout written by either is read by whichever
    // deck the user is running, so dropping a name re-creates this bug pointing
    // the other way.
    for (const name of ["exec", "exec_command", "apply_patch", "run"]) {
      expect(CODEX_TOOL_NAMES.has(name), `${name} should be known`).toBe(true);
      expect(categoryFor(name)).not.toBe("other");
      expect(CODEX_TOOL_EMOJI[name]).toBeTruthy();
      expect(CODEX_TOOL_LABEL[name]).toBeTruthy();
    }
    expect(CODEX_SHELL_TOOLS.has("exec")).toBe(true);
    // apply_patch edits files; its sub-bubble is the file path, not a command.
    expect(CODEX_SHELL_TOOLS.has("apply_patch")).toBe(false);
  });

  it("leaves Claude's tools and MCP calls exactly where they were", () => {
    expect(categoryFor("Bash")).toBe("shell");
    expect(categoryFor("Read")).toBe("file");
    expect(categoryFor("Agent")).toBe("agent");
    expect(categoryFor("ExitPlanMode")).toBe("plan");
    expect(categoryFor("ScheduleWakeup")).toBe("other");
    expect(categoryFor("mcp__github__create_pr")).toBe("mcp");
    // An MCP method that happens to share a Codex tool's name is still MCP.
    expect(categoryFor("mcp__sandbox__exec")).toBe("mcp");
    // A name nobody knows still falls back rather than throwing.
    expect(categoryFor("frobnicate")).toBe("other");
  });
});

// ── the six tables have exactly one source now ──────────────────────────────

describe("where the six tables get their Codex names from", () => {
  const toolBursts = readFileSync(join(web, "components", "ToolBursts.tsx"), "utf8");
  const app = readFileSync(join(web, "App.tsx"), "utf8");

  it("has App.tsx reading the shared bucket table instead of its own copy", () => {
    // The seventh copy is the one that would restart the drift, and it is the
    // one a future edit is most likely to re-introduce, because App.tsx is
    // where the filter chips and the activity strip live.
    expect(app).toMatch(/import \{ categoryFor[^}]*\} from "\.\/tool-taxonomy"/);
    expect(app).not.toMatch(/const DETAIL_TOOL_CAT/);
  });

  it("has ToolBursts.tsx deriving its five tables rather than listing them", () => {
    // Each of the five is spread or aliased from the shared spec; none of them
    // spells a Codex tool name itself any more.
    expect(toolBursts).toMatch(/from "\.\.\/tool-taxonomy"/);
    expect(toolBursts).not.toMatch(/const TOOL_CATEGORY/);
    expect(toolBursts).toMatch(/\.\.\.CODEX_TOOL_EMOJI/);
    expect(toolBursts).toMatch(/\.\.\.CODEX_SHELL_TOOLS/);
    expect(toolBursts).toMatch(/CODEX_PRIMARY_LABEL: Record<string, string> = CODEX_TOOL_LABEL/);
    expect(toolBursts).toMatch(/CODEX_TOOLS = CODEX_TOOL_NAMES/);
  });
});

// ── the script the `exec` tool actually runs ────────────────────────────────

describe("codexScriptCommand", () => {
  it("pulls the command out of the script both CLI versions write", () => {
    // 0.144 puts the print on its own line, 0.147 usually trails it. 78 of the
    // 83 real scripts on this machine yield their command to this.
    expect(codexScriptCommand('const r = await tools.exec_command({cmd:"git status",workdir:"/repo",yield_time_ms:250,max_output_tokens:8000});\ntext(r.output);'))
      .toBe("git status");
    expect(codexScriptCommand('const r = await tools.exec_command({cmd:"npm test",workdir:"/repo"}); text(r.output);\n'))
      .toBe("npm test");
  });

  it("names the API call when the script runs no command at all", () => {
    // The remaining five: four `web__run` searches and one script that only
    // applies a patch. Naming what it called beats drawing nothing.
    expect(codexScriptCommand('const r = await tools.web__run({search_query:[{q:"x"}],response_length:"short"}); text(r)'))
      .toBe("web__run");
    expect(codexScriptCommand('const patch = "*** Begin Patch";\ntext(await tools.apply_patch(patch));'))
      .toBe("apply_patch");
  });

  it("undoes the JavaScript quoting the command arrived wrapped in", () => {
    expect(codexScriptCommand('const r = await tools.exec_command({cmd:"grep -rn \\"needle\\" src"});'))
      .toBe('grep -rn "needle" src');
    expect(codexScriptCommand("const r = await tools.exec_command({cmd:'echo hi'});")).toBe("echo hi");
    expect(codexScriptCommand("const r = await tools.exec_command({cmd:`echo hi`});")).toBe("echo hi");
  });

  it("does not reach into a nested object for a key that is not this call's", () => {
    // `cmd` is read out of the argument literal itself, never from something
    // nested inside it — a bound the `[^{}]` scan enforces rather than hopes for.
    expect(codexScriptCommand('const r = await tools.exec_command({env:{cmd:"not-the-command"},workdir:"/repo"});'))
      .toBe("exec_command");
  });

  it("stays silent on text that is not a Codex script", () => {
    // It runs on every tool_input carrying a `script` key, PowerShell's
    // included, so anything that merely mentions `tools.` must not be mistaken
    // for a Codex program.
    expect(codexScriptCommand("npm run build; Write-Host $tools.Count")).toBeNull();
    expect(codexScriptCommand("git status")).toBeNull();
    expect(codexScriptCommand("")).toBeNull();
  });
});
