// What a tool IS — its bucket, its emoji, the label the deck writes on the
// bubble — answered once, for both the canvas and the detail panel.
//
// WHY THIS MODULE EXISTS (#417). The deck used to answer that question in six
// separate literals: TOOL_CATEGORY, TOOL_EMOJI, SHELL_TOOLS, CODEX_TOOLS and
// CODEX_PRIMARY_LABEL in ToolBursts.tsx, plus DETAIL_TOOL_CAT in App.tsx, whose
// own comment said the duplication was "kept in sync manually — small enough
// that a shared module isn't worth it". Then Codex started routing its shell
// work through a tool called `exec`, and all six missed it at once: the bubble
// drew as a grey ✨ with the raw name and no sub-bubble, the detail strip
// counted it under "other", and the category chips filed it away from the
// other shell calls. Six edits to fix one rename is six chances to miss one,
// which is precisely what happened, so the Codex half of every table is now
// DERIVED from the single spec table below and a rename costs exactly one line.
//
// The Claude half deliberately stays where it is. Claude's tool names have not
// moved in the life of this project and each table covers a different slice of
// them; hoisting them too would be churn without a bug behind it. What is
// shared here is the part that has actually drifted.

/** The bucket a tool's bubble is tinted by, and the one the detail-panel
 *  activity strip and the canvas filter chips count under. Declared here
 *  because App.tsx and ToolBursts.tsx used to declare the same eight-member
 *  union separately — as `DetailCategory` and `ToolCategory` — and a union
 *  that exists twice is a union that can disagree with itself. */
export type ToolCategory = "file" | "shell" | "web" | "agent" | "task" | "plan" | "mcp" | "other";

/** Everything the deck knows about one Codex tool name. */
export interface CodexToolSpec {
  /** Bubble tint, activity-strip bucket, filter chip. */
  category: ToolCategory;
  /** Primary-bubble emoji. */
  emoji: string;
  /** Clean, Claude-style label. Codex exposes raw internal names ("exec",
   *  "exec_command", "apply_patch"); the raw name still goes into the tooltip,
   *  so nothing is hidden by showing a readable one on the bubble. */
  label: string;
  /** Does this tool's input carry a command worth chaining a sub-bubble off?
   *  Only shell-family tools do — the file-family `apply_patch` gets its
   *  sub-bubble from the file path in its patch header instead. */
  shell?: true;
}

/**
 * Every Codex tool name the deck recognises, and what it is.
 *
 * WHAT THE ROLLOUTS ACTUALLY CONTAIN. Names and counts from every rollout in
 * this machine's CODEX_HOME (8 files, two CLI versions), record kind and tool
 * name only:
 *
 *   CLI      record             name           count
 *   0.144.5  custom_tool_call   exec              77
 *   0.144.5  custom_tool_call   apply_patch        2
 *   0.144.5  function_call      exec_command      30
 *   0.144.5  function_call      run                2
 *   0.147.0  custom_tool_call   exec               6
 *
 * `exec` is 83 of the 117 tool calls on this machine and is the ONLY tool name
 * 0.147 emits at all — every other name below is either 0.144-era or a shape
 * the deck has carried since before the rename. They are all kept: the two
 * versions coexist on real machines, a rollout written by one is read by the
 * other's deck, and dropping a name only re-creates this bug pointing the other
 * way.
 *
 * `shell`, `shell_command` and `write_stdin` are not observed here at all; they
 * predate this table and are left in place because an entry for a tool that
 * never arrives costs nothing, while a missing one costs a grey ✨.
 */
export const CODEX_TOOL_SPECS: Record<string, CodexToolSpec> = {
  // The 0.147-era script tool, and the whole reason this module exists. It is
  // filed as shell rather than as its own bucket because that is what it does:
  // the script it runs is a wrapper around `tools.exec_command({ cmd })`, and a
  // user scanning the canvas for "where did it run something" wants it in the
  // same amber as Claude's Bash. See codexScriptCommand() below for how the
  // command inside the script reaches the sub-bubble.
  exec: { category: "shell", emoji: "⚡", label: "Shell", shell: true },
  // The 0.144-era shell tools. `exec_command` did not disappear in 0.147 — it
  // moved INSIDE the exec script, where it is spelled `tools.exec_command`.
  shell: { category: "shell", emoji: "⚡", label: "Shell", shell: true },
  exec_command: { category: "shell", emoji: "⚡", label: "Shell", shell: true },
  shell_command: { category: "shell", emoji: "⚡", label: "Shell", shell: true },
  write_stdin: { category: "shell", emoji: "💻", label: "stdin", shell: true },
  wait: { category: "shell", emoji: "⏳", label: "wait", shell: true },
  // Codex's file-edit tool. Its sub-bubble comes from the `*** Update File:`
  // header inside the patch, so it is NOT marked `shell` — see skinForFileCall.
  apply_patch: { category: "file", emoji: "🩹", label: "Edit" },
  // Codex's planning tool — the same bucket as TodoWrite/TaskCreate.
  update_plan: { category: "task", emoji: "📋", label: "Plan" },
  // Codex's web tool, which arrives under the unhelpfully generic name `run`.
  // Two independent pieces of evidence say it is the web tool and not a shell:
  // the only arguments observed on it are `search_query` and `response_length`,
  // and the very same call inside a 0.147 exec script is spelled
  // `tools.web__run`. Claude has no built-in named `run` and MCP tools are all
  // `mcp__…`, so claiming the bare name here cannot shadow anything.
  run: { category: "web", emoji: "🌐", label: "Web" },
};

/** Codex tool name → category, for merging into the one category table. */
export const CODEX_TOOL_CATEGORY: Record<string, ToolCategory> =
  Object.fromEntries(Object.entries(CODEX_TOOL_SPECS).map(([name, s]) => [name, s.category]));

/** Codex tool name → primary-bubble emoji. */
export const CODEX_TOOL_EMOJI: Record<string, string> =
  Object.fromEntries(Object.entries(CODEX_TOOL_SPECS).map(([name, s]) => [name, s.emoji]));

/** Codex tool name → the clean label drawn in place of the raw internal name. */
export const CODEX_TOOL_LABEL: Record<string, string> =
  Object.fromEntries(Object.entries(CODEX_TOOL_SPECS).map(([name, s]) => [name, s.label]));

/** Every Codex tool name, whatever its family. Used for the primary-bubble
 *  width estimate, which has to scale for these because Codex labels can run
 *  longer than the fixed estimate Claude's short names were sized for (#84). */
export const CODEX_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(CODEX_TOOL_SPECS));

/** The Codex tools whose input carries a command, i.e. the ones that earn a
 *  chained sub-bubble showing what actually ran. */
export const CODEX_SHELL_TOOLS: ReadonlySet<string> =
  new Set(Object.entries(CODEX_TOOL_SPECS).filter(([, s]) => s.shell).map(([name]) => name));

/**
 * Every tool the deck can name, Claude's and Codex's, in one table.
 *
 * This is the merge of what used to be `TOOL_CATEGORY` (ToolBursts.tsx) and
 * `DETAIL_TOOL_CAT` (App.tsx). The two were meant to be identical and were
 * within a hair of it — DETAIL_TOOL_CAT was a strict subset, missing only the
 * eight names TOOL_CATEGORY mapped to "other", which is the default anyway — so
 * merging them changes no answer for any tool either of them knew. It removes
 * the only way they could ever disagree again.
 */
export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  Read: "file", Write: "file", Edit: "file", MultiEdit: "file",
  Glob: "file", Grep: "file", LS: "file", NotebookEdit: "file",
  Bash: "shell", PowerShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  TodoWrite: "task", TaskCreate: "task", TaskUpdate: "task",
  TaskList: "task", TaskGet: "task", TaskOutput: "task", TaskStop: "task",
  EnterPlanMode: "plan", ExitPlanMode: "plan", AskUserQuestion: "plan",
  Skill: "plan", Workflow: "plan",
  ScheduleWakeup: "other", CronCreate: "other", CronList: "other",
  CronDelete: "other", Monitor: "other", PushNotification: "other",
  RemoteTrigger: "other", ToolSearch: "other",
  // …and every Codex name, from the one spec table above.
  ...CODEX_TOOL_CATEGORY,
};

/** The bucket a tool belongs to. Every MCP call is its own family regardless of
 *  what the server named the method. */
export function categoryFor(name: string): ToolCategory {
  if (name.startsWith("mcp__")) return "mcp";
  return TOOL_CATEGORY[name] ?? "other";
}

/**
 * The command a Codex `exec` script actually runs, dug out of the script.
 *
 * WHY THIS IS NEEDED AT ALL. `exec` is not a shell tool that takes a command
 * string; it is a SCRIPT tool, and its input is a small JavaScript program that
 * calls into a `tools.*` API. Every one of the 83 `exec` inputs on this machine
 * is such a program — 83/83 start with `const `, none parses as JSON, all are
 * multi-line, and the median is three lines. Codex's own result wrapper agrees:
 * it prefixes the output with "Script completed" / "Script failed" (#397), not
 * with an exit code.
 *
 * So the obvious fix — hand the whole input to commandStringOf as a command —
 * is wrong in a way that looks right until you see it: parseShellCommand would
 * take the first token of the program and the deck would draw `⚡ Shell → ⚙️
 * const` on every single Codex call. The real command is one level in, as the
 * `cmd` argument of `tools.exec_command({ cmd: "…" })`, which is how 79 of the
 * 84 `tools.*` calls observed are spelled.
 *
 * WHAT THE FALLBACK IS FOR. The other five calls are `tools.apply_patch(…)` and
 * `tools.web__run({ search_query })` — scripts that run no shell command at
 * all. Rather than draw nothing for those, the API method's own name is
 * returned, so the bubble reads `⚡ Shell → ⚙️ web__run` instead of stopping at
 * `⚡ Shell`. A tool the deck cannot fully read should still say what it did.
 *
 * The scan is bounded to the object literal that opens the call — `[^{}]` can
 * cross neither into a nested object nor out of this one — so a `cmd` key
 * belonging to some other call later in the script cannot be mistaken for this
 * one's. Returns null when the input is not a Codex script at all, which is the
 * signal to fall back to the ordinary command-string lookup.
 *
 * Both patterns require the CALL parenthesis rather than settling for the bare
 * `tools.` prefix, and that is not decoration. This runs on any tool_input
 * carrying a `script` key, which includes PowerShell's, and a PowerShell script
 * that so much as mentions `$tools.Count` would otherwise be reported as having
 * run a command named "Count".
 */
const EXEC_SCRIPT_CMD = /\btools\.exec_command\s*\(\s*\{[^{}]*?\bcmd\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const EXEC_SCRIPT_CALL = /\btools\.([A-Za-z_$][\w$]*)\s*\(/;

export function codexScriptCommand(script: string): string | null {
  if (typeof script !== "string" || !script) return null;
  const cmd = EXEC_SCRIPT_CMD.exec(script);
  if (cmd) {
    const unescaped = unescapeJsString(cmd[2]);
    if (unescaped.trim()) return unescaped;
  }
  const call = EXEC_SCRIPT_CALL.exec(script);
  return call ? call[1] : null;
}

/** Undo the JavaScript string escapes the script author had to write, so the
 *  tooltip shows the command as it ran rather than as it was quoted. Only the
 *  escapes that actually appear in shell commands are handled; anything else is
 *  left as written, since a wrong guess here would corrupt the very text this
 *  exists to make readable. */
function unescapeJsString(s: string): string {
  return s.replace(/\\(["'`\\nrt])/g, (_, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c);
}
