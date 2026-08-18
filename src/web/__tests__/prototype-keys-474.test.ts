// #474 — the lookup tables that answered out of `Object.prototype`.
//
// Every table in the deck that turns a NAME into a bucket, an emoji, a label or
// a sentence was read with plain bracket access against an object literal, and
// an object literal inherits from `Object.prototype`. So a name that happens to
// spell one of its members — `toString`, `constructor`, `valueOf`,
// `hasOwnProperty`, `__proto__` — never reached the default, because the value
// it got back was a function (or, for `__proto__`, the prototype object), and
// neither `?? default` nor `if (TABLE[k])` can see past either one.
//
// The names are not ours to choose. A tool name is `tool_name` off a hook
// payload, written by whatever agent is running; a command is the first word of
// something that agent ran; a filename, an extension and an MCP server segment
// all come the same way; a ccusage agent id comes out of another program's JSON.
// The deck cannot decide that none of them will ever be spelled `constructor`.
//
// What it cost, for the two the issue named: `categoryFor`'s answer goes into
// `className={`tool-burst cat-${b.category}…`}`, so a stringified function turns
// one class token into several (its source contains spaces) and the bubble loses
// its `cat-*` accent entirely; the same value is what the filter chips test with
// `hiddenCategories.has(b.category)`, so that bubble could never be filtered.
// The emoji slot handed React a function where it expects a node.
//
// Two halves are asserted below, and the second is the one that would hurt if
// the fix had been made carelessly. That a poisoned name now falls through to
// the default — which is the change — and that EVERY name the tables already
// knew answers exactly what it answered before, swept row by row out of the
// tables themselves rather than spot-checked.
//
// Plain node, no DOM: the bubbles come from `collectBursts`, which is the pure
// function the canvas layer calls, and the rest are pure functions called
// directly. Nothing here renders. The tables that live inside `ToolBursts.tsx`
// as module-private literals are swept by reading the file, which is how
// export-surface-383.test.ts reaches TOOL_EMOJI too — no export exists here for
// a test's sake. Every path is built from `import.meta.url`, and no assertion
// depends on a line ending, so this reads the same on all three platforms.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentNodeData, ToolCall } from "../types";
import { collectBursts } from "../components/ToolBursts";
import { categoryFor, CODEX_TOOL_EMOJI, TOOL_CATEGORY, type ToolCategory } from "../tool-taxonomy";
import { agentLabel } from "../provider-copy";
import {
  CCUSAGE_REASONS, COMMAND_REASONS, REASONS,
  explainCcusageFailure, explainCommandFailure, explainFailure,
} from "../admin-failure";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TOOL_BURSTS = src("../components/ToolBursts.tsx");
const APP = src("../App.tsx");

/** The names an object literal answers without having a row for them. */
const PROTO_KEYS = [
  "toString", "constructor", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__proto__",
];

/** The subset that survives a `.toLowerCase()`, which is the only half that can
 *  reach the four tables keyed by a lower-cased name (filenames, extensions, MCP
 *  servers, ccusage ids). Derived rather than listed so it cannot drift from the
 *  list above. */
const LOWER_PROTO_KEYS = PROTO_KEYS.filter(k => k === k.toLowerCase());

/** …and the subset of THAT which can be an MCP server segment at all. `__` is
 *  the separator inside `mcp__<server>__<method>`, so a name containing it never
 *  arrives as a whole server segment — `mcp____proto____probe` parses as a
 *  server of `__proto____probe` and no method. */
const MCP_PROTO_KEYS = LOWER_PROTO_KEYS.filter(k => !k.includes("__"));

const NOW = 1_000_000;

/** The bubbles the canvas draws for one tool call — the real layout pass, the
 *  same entry point `<ToolBursts>` calls once per data change. */
function bubbles(name: string, input?: unknown) {
  const tool: ToolCall = { id: "t1", name, inputPreview: "", input, startedAt: NOW - 100 };
  const agent: AgentNodeData = {
    id: "a1", sessionId: "s1", label: "a1", kind: "root", state: "active",
    startedAt: NOW - 1000, tools: [tool], prompts: [], toolCount: 1, childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  };
  const all = collectBursts(
    new Map([[agent.id, agent]]),
    new Set([agent.id]),
    new Map([[agent.id, { x: 0, y: 0 }]]),
    new Map(),
    new Map([[agent.id, { width: 260, height: 130 }]]),
    NOW,
  );
  return { primary: all.find(b => !b.isSub)!, sub: all.find(b => b.isSub) };
}

/** The rows of one `const NAME … = { … };` literal in ToolBursts.tsx, as
 *  [key, value] pairs. Whole-line comments go first, so a sentence in the prose
 *  above a row cannot be read as a row. Keys are matched in both spellings the
 *  file uses — bare and quoted — and several rows per line are matched, which is
 *  how COMMAND_EMOJI is written. */
function rowsOf(table: string): [string, string][] {
  const block = new RegExp(`const ${table}[^=]*= \\{([\\s\\S]*?)^\\};`, "m").exec(TOOL_BURSTS);
  if (!block) throw new Error(`${table} is no longer a literal in ToolBursts.tsx`);
  const body = block[1].split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  return [...body.matchAll(/(?:([A-Za-z_$][\w$]*)|"([^"]+)")\s*:\s*"([^"]*)"/g)]
    .map(m => [m[1] ?? m[2], m[3]] as [string, string]);
}

/** MCP_SERVERS holds an object per row rather than a string. */
function mcpServerRows(): [string, { emoji: string; name: string }][] {
  const block = /const MCP_SERVERS[^=]*= \{([\s\S]*?)^\};/m.exec(TOOL_BURSTS);
  if (!block) throw new Error("MCP_SERVERS is no longer a literal in ToolBursts.tsx");
  const body = block[1].split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  return [...body.matchAll(/(?:([A-Za-z_$][\w$]*)|"([^"]+)")\s*:\s*\{\s*emoji:\s*"([^"]+)",\s*name:\s*"([^"]+)"\s*\}/g)]
    .map(m => [m[1] ?? m[2], { emoji: m[3], name: m[4] }] as [string, { emoji: string; name: string }]);
}

// ── the fixtures really are poisonous ───────────────────────────────────────

describe("the names this is about", () => {
  it("are all answered by a bare object literal that has no row for them", () => {
    // If a future engine stopped inheriting one of these, the assertions below
    // would pass for the wrong reason and nobody would know.
    for (const key of PROTO_KEYS) {
      expect(({} as Record<string, unknown>)[key], key).toBeDefined();
    }
    expect(LOWER_PROTO_KEYS).toContain("constructor");
    expect(LOWER_PROTO_KEYS).toContain("__proto__");
  });
});

// ── the two the issue named ─────────────────────────────────────────────────

describe("categoryFor, on a tool name that spells an Object.prototype member", () => {
  for (const name of PROTO_KEYS) {
    it(`files ${name} under "other" like any other unknown tool`, () => {
      const cat = categoryFor(name);
      expect.soft(cat).toBe("other");
      // The class attribute: one token, no function source spilled into it.
      expect.soft(typeof cat).toBe("string");
      expect.soft(`tool-burst cat-${cat}`).toBe("tool-burst cat-other");
      expect.soft(String(cat)).not.toMatch(/\s/);
      // The filter chips: the bucket the canvas tinted it with is a bucket a
      // chip can actually hold, so hiding "other" hides this bubble too.
      const hidden = new Set<ToolCategory>(["other"]);
      expect.soft(hidden.has(cat)).toBe(true);
    });
  }
});

describe("the bubble the canvas draws for such a tool name", () => {
  for (const name of PROTO_KEYS) {
    it(`draws ${name} as the ✨ fallback under its own name`, () => {
      const { primary } = bubbles(name);
      // TOOL_EMOJI — a node React can render, not a function.
      expect.soft(primary.emoji).toBe("✨");
      expect.soft(typeof primary.emoji).toBe("string");
      // CODEX_PRIMARY_LABEL — the raw name, because no Codex tool is called this.
      expect.soft(primary.name).toBe(name);
      expect.soft(typeof primary.name).toBe("string");
      // TOOL_CATEGORY, through the burst the layer actually renders.
      expect.soft(primary.category).toBe("other");
    });
  }
});

// ── the same shape everywhere else it was written ───────────────────────────

describe("the sub-bubble tables, on the same names", () => {
  for (const name of PROTO_KEYS) {
    it(`gives a command called ${name} the generic gear`, () => {
      const { sub } = bubbles("Bash", { command: name });
      expect.soft(sub?.emoji).toBe("⚙️");
      expect.soft(sub?.name).toBe(name);
    });
  }

  for (const name of LOWER_PROTO_KEYS) {
    it(`gives a file called ${name} the generic page`, () => {
      // SPECIAL_FILES: the whole basename.
      expect.soft(bubbles("Read", { file_path: `/repo/${name}` }).sub?.emoji).toBe("📄");
      // EXT_EMOJI: the extension.
      expect.soft(bubbles("Read", { file_path: `/repo/notes.${name}` }).sub?.emoji).toBe("📄");
    });
  }

  for (const name of MCP_PROTO_KEYS) {
    it(`keeps an MCP server called ${name} unrecognised`, () => {
      const { primary, sub } = bubbles(`mcp__${name}__probe`);
      // MCP_SERVERS, on the primary: no branded identity, so the raw segment
      // stays and the hash tint is what tells this server from the next one.
      expect.soft(primary.emoji).toBe("🔌");
      expect.soft(primary.name).toBe(name);
      expect.soft(primary.mcpHue).toBeTypeOf("number");
      // …and on the sub-bubble's tooltip, which named `undefined` before.
      expect.soft(sub?.emoji).toBe("🔌");
      expect.soft(sub?.name).toBe("probe");
      expect.soft(sub?.inputPreview).toBe(`${name} · probe`);
    });
  }
});

describe("agentLabel, on a ccusage agent id of the same shape", () => {
  for (const name of LOWER_PROTO_KEYS) {
    it(`title-cases ${name} rather than printing a function`, () => {
      const label = agentLabel(name);
      expect.soft(typeof label).toBe("string");
      expect.soft(label).toBe(name[0].toUpperCase() + name.slice(1));
    });
  }
});

describe("the admin-failure maps, on a reason code of the same shape", () => {
  for (const reason of PROTO_KEYS) {
    it(`answers a reason of ${reason} with the code itself`, () => {
      // No sentence for it, so all three fall through to naming the code —
      // which is what they do for every reason a build has no wording for.
      expect.soft(explainFailure({ reason }, "fallback")).toBe(reason);
      expect.soft(explainCommandFailure({ reason }, "fallback")).toBe(reason);
      expect.soft(explainCcusageFailure({ reason }, "fallback")).toBe(reason);
    });
  }
});

describe("the version row's upgrade-block copy", () => {
  it("asks App.tsx's table whether it has a row rather than trusting `??`", () => {
    // App.tsx cannot be imported here — React, JSX, reactflow — so this half is
    // pinned by reading the file, the way codex-tool-taxonomy.test.ts pins the
    // detail strip's use of the shared bucket table.
    expect(APP).toMatch(/Object\.hasOwn\(UPGRADE_BLOCK_TEXT, version\.upgradeBlocked\)/);
    expect(APP).not.toMatch(/UPGRADE_BLOCK_TEXT\[[^\]]+\]\s*\?\?/);
  });
});

// ── and nothing a name already answered has moved ───────────────────────────

describe("every row the tables already had answers exactly what it answered", () => {
  it("TOOL_CATEGORY: categoryFor returns each row's own value", () => {
    const keys = Object.keys(TOOL_CATEGORY);
    expect(keys.length).toBeGreaterThan(25);
    for (const name of keys) {
      // For a name the table HAS, the old expression `TOOL_CATEGORY[name] ??
      // "other"` was exactly `TOOL_CATEGORY[name]` — so this is the before/after
      // comparison, row by row, for every row there is.
      expect(categoryFor(name), name).toBe(TOOL_CATEGORY[name]);
    }
  });

  it("TOOL_EMOJI: every tool in the literal still draws its own emoji", () => {
    const rows = rowsOf("TOOL_EMOJI");
    expect(rows.length).toBeGreaterThan(30);
    for (const [name, emoji] of rows) {
      expect(bubbles(name).primary.emoji, name).toBe(emoji);
    }
    // …and the Codex half that is spread into the same literal at runtime.
    for (const [name, emoji] of Object.entries(CODEX_TOOL_EMOJI)) {
      expect(bubbles(name).primary.emoji, name).toBe(emoji);
    }
  });

  it("COMMAND_EMOJI: every command in the literal still draws its own emoji", () => {
    const rows = rowsOf("COMMAND_EMOJI");
    expect(rows.length).toBeGreaterThan(80);
    for (const [cmd, emoji] of rows) {
      expect(bubbles("Bash", { command: cmd }).sub?.emoji, cmd).toBe(emoji);
    }
  });

  it("SPECIAL_FILES: every filename in the literal still draws its own emoji", () => {
    const rows = rowsOf("SPECIAL_FILES");
    expect(rows.length).toBeGreaterThan(15);
    for (const [file, emoji] of rows) {
      expect(bubbles("Read", { file_path: `/repo/${file}` }).sub?.emoji, file).toBe(emoji);
    }
  });

  it("EXT_EMOJI: every extension in the literal still draws its own emoji", () => {
    const rows = rowsOf("EXT_EMOJI");
    expect(rows.length).toBeGreaterThan(50);
    for (const [ext, emoji] of rows) {
      expect(bubbles("Read", { file_path: `/repo/notes.${ext}` }).sub?.emoji, ext).toBe(emoji);
    }
  });

  it("MCP_SERVERS: every server in the literal still draws its own identity", () => {
    const rows = mcpServerRows();
    expect(rows.length).toBeGreaterThan(25);
    for (const [server, known] of rows) {
      const { primary, sub } = bubbles(`mcp__${server}__probe`);
      expect(primary.emoji, server).toBe(known.emoji);
      expect(primary.name, server).toBe(known.name);
      expect(sub?.inputPreview, server).toBe(`${known.name} · probe`);
    }
  });

  it("the three admin-failure maps: every reason still gets its own sentence", () => {
    expect(Object.keys(REASONS).length).toBeGreaterThan(5);
    for (const [reason, sentence] of Object.entries(REASONS)) {
      expect(explainFailure({ reason }, "fallback"), reason).toBe(sentence);
    }
    expect(Object.keys(COMMAND_REASONS).length).toBeGreaterThan(3);
    for (const [reason, sentence] of Object.entries(COMMAND_REASONS)) {
      expect(explainCommandFailure({ reason }, "fallback"), reason).toBe(sentence);
    }
    expect(Object.keys(CCUSAGE_REASONS).length).toBeGreaterThan(3);
    for (const [reason, sentence] of Object.entries(CCUSAGE_REASONS)) {
      expect(explainCcusageFailure({ reason }, "fallback"), reason).toBe(sentence);
    }
  });

  it("agentLabel: every ccusage id it names still gets that name", () => {
    // The map is module-private; these are the ids it exists for, and the
    // title-cased fallback for one it has never heard of.
    expect(agentLabel("claude")).toBe("Claude Code");
    expect(agentLabel("codex")).toBe("Codex");
    expect(agentLabel("opencode")).toBe("OpenCode");
    expect(agentLabel("openclaw")).toBe("OpenClaw");
    expect(agentLabel("copilot")).toBe("GitHub Copilot");
    expect(agentLabel("pi")).toBe("pi-agent");
    expect(agentLabel("AMP")).toBe("Amp");
    expect(agentLabel("")).toBe("");
  });
});
