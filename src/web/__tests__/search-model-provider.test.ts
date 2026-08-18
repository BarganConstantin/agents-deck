// #418: the deck refuses to find a string it drew on the card itself.
//
// A node reads `GPT-5.3 Codex`, the user types `codex`, and the canvas answers
// "No agents match “codex”". The matcher walked six fields — label, cwd, cwd
// basename, session id, first prompt, tool names — and neither the model nor the
// provider was among them, so the filter a mixed-CLI canvas most obviously wants
// was the one it could not express.
//
// Two things the issue got wrong, both pinned below.
//
//   * "the two things the node card shows as a chip" — the card shows ONE chip.
//     `AgentNode.tsx` renders `shortModel(data.model)` and nothing anywhere
//     renders `provider`; codex-approval.ts:59 already says so ("`provider` is
//     stamped on the node and rendered nowhere"). That is why the two fields get
//     two different rules rather than the two identical lines the issue proposed.
//
//   * "Worth matching the displayed model label too" is not a nicety, it is the
//     load-bearing half for Claude. The id is `claude-opus-4-7-20250101` and the
//     chip says `Opus 4.7`; the space and the dot exist ONLY in the label, so a
//     user typing the four characters they can see would still have found
//     nothing under the issue's own patch. The first describe proves the two
//     strings do not contain each other before asserting either match, so the
//     reason both are indexed survives in the suite rather than in a commit
//     message.
//
// The provider rule is a prefix, and that is the one place this diverges from
// how every other field behaves. `provider` holds two values across the entire
// board, so a substring match on it does not narrow anything — `ex`, `de`, `od`
// and eight single letters would each select every agent of one provider, on a
// set of cards showing no such text anywhere. Prefix keeps every spelling anyone
// types, because incremental typing is a prefix.
//
// Bare node, no DOM: the rule lives in search-match.ts precisely so it can be
// driven directly here, the way ambient-counts.ts and codex-approval.ts are. The
// last describe reads App.tsx as text only to prove the component calls THIS
// function and no longer carries a private copy of it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { matchesQuery, SEARCH_PLACEHOLDER } from "../search-match";
import { shortModel } from "../model-label";
import { applyEvent, initialState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload, Provider, ToolCall } from "../types";

const web = fileURLToPath(new URL("..", import.meta.url));

/** Comments in this codebase quote the code they explain — the header of
 *  search-match.ts names `toLocaleLowerCase` in order to say it is banned. A
 *  source assertion that reads them is asserting about prose, so strip them and
 *  read only what runs. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const appSrc = code(readFileSync(join(web, "App.tsx"), "utf8"));
const matchSrc = code(readFileSync(join(web, "search-match.ts"), "utf8"));

const T0 = 1_700_000_000_000;

function tool(name: string): ToolCall {
  return { id: `t-${name}`, name, inputPreview: "", startedAt: T0 };
}

/** A card on the canvas. Only the fields a query can reach are worth setting. */
function agent(over: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    id: "s1",
    sessionId: "s1",
    label: "deck",
    kind: "root",
    state: "active",
    startedAt: T0,
    tools: [],
    prompts: [],
    toolCount: 0,
    childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    ...over,
  };
}

function envelope(payload: HookPayload): HookEnvelope {
  return { seq: 1, receivedAt: T0, source: "hook", payload };
}

describe("the two strings a model is", () => {
  it("does not contain the label inside the id, which is why one match is not enough", () => {
    // The premise of indexing both. If either string contained the other, the
    // second lookup would be dead code and someone would rightly delete it.
    const id = "claude-opus-4-7-20250101";
    expect(shortModel(id)).toBe("Opus 4.7");
    expect(id.toLowerCase().includes("opus 4.7")).toBe(false);
    expect(shortModel(id).toLowerCase().includes("claude")).toBe(false);
  });

  it("finds a Claude session by the family in its id", () => {
    const a = agent({ model: "claude-opus-4-7-20250101" });
    expect(matchesQuery(a, "opus")).toBe(true);
    expect(matchesQuery(a, "sonnet")).toBe(false);
  });

  it("finds it by what the chip literally prints, spaces and dots included", () => {
    expect(matchesQuery(agent({ model: "claude-opus-4-7-20250101" }), "Opus 4.7")).toBe(true);
    expect(matchesQuery(agent({ model: "claude-sonnet-4-5-20250929" }), "sonnet 4.5")).toBe(true);
    expect(matchesQuery(agent({ model: "gpt-5.3-codex" }), "GPT-5.3 Codex")).toBe(true);
  });

  it("still finds it by an id pasted out of a config file", () => {
    const a = agent({ model: "claude-sonnet-4-5-20250929" });
    expect(matchesQuery(a, "claude-sonnet-4-5-20250929")).toBe(true);
    expect(matchesQuery(a, "20250929")).toBe(true);
  });

  it("finds a Bedrock id by the family the chip shows, not the namespace it hides", () => {
    const a = agent({ model: "anthropic.claude-haiku-4-5" });
    expect(shortModel("anthropic.claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(matchesQuery(a, "haiku 4.5")).toBe(true);
    expect(matchesQuery(a, "anthropic")).toBe(true);
  });

  it("finds a GPT by family and by version", () => {
    const a = agent({ model: "gpt-5.3-codex", provider: "codex" });
    expect(matchesQuery(a, "gpt")).toBe(true);
    expect(matchesQuery(a, "gpt-5.3")).toBe(true);
    expect(matchesQuery(a, "5.3")).toBe(true);
  });

  it("does not answer a model query, or throw, before a model has been observed", () => {
    // A synthetic node, or a session whose first model-bearing event has not
    // landed. The canvas re-runs this per card per keystroke; an exception here
    // is a blank board.
    const a = agent({ synthetic: true });
    expect(() => matchesQuery(a, "opus")).not.toThrow();
    expect(matchesQuery(a, "opus")).toBe(false);
    expect(matchesQuery(a, "gpt-5.3")).toBe(false);
  });

  it("leaves an unrecognised id searchable as itself", () => {
    // shortModel hands back the id untouched when no family matches, so the
    // second lookup is a no-op rather than a hole.
    const a = agent({ model: "o3-mini" });
    expect(shortModel("o3-mini")).toBe("o3-mini");
    expect(matchesQuery(a, "o3")).toBe(true);
  });
});

describe("filtering the canvas down to one CLI", () => {
  it("finds the Codex sessions by name — the query the issue opens with", () => {
    const codex = agent({ id: "c", sessionId: "c", provider: "codex", model: "gpt-5.3-codex" });
    const claude = agent({ id: "a", sessionId: "a", provider: "claude", model: "claude-opus-4-7-20250101" });
    expect(matchesQuery(codex, "codex")).toBe(true);
    expect(matchesQuery(claude, "codex")).toBe(false);
  });

  it("finds the Claude sessions by name", () => {
    const codex = agent({ id: "c", sessionId: "c", provider: "codex", model: "gpt-5.3-codex" });
    const claude = agent({ id: "a", sessionId: "a", provider: "claude", model: "claude-opus-4-7-20250101" });
    expect(matchesQuery(claude, "claude")).toBe(true);
    expect(matchesQuery(codex, "claude")).toBe(false);
  });

  it("finds a Codex session whose model does not say Codex anywhere", () => {
    // The case only the provider field can answer: `gpt-5` renders as `GPT-5`,
    // so neither the id nor the chip carries the word the user typed. Matching
    // the chip text alone would have left this session out of "show me the
    // Codex ones", which is the entire request.
    const a = agent({ provider: "codex", model: "gpt-5" });
    expect(shortModel("gpt-5")).toBe("GPT-5");
    expect(matchesQuery(a, "codex")).toBe(true);
  });

  it("finds a Codex session that has not reported a model at all", () => {
    expect(matchesQuery(agent({ provider: "codex" }), "codex")).toBe(true);
  });

  it("matches every prefix of the name, because that is what typing one is", () => {
    const a = agent({ label: "x", sessionId: "x", provider: "codex" });
    for (const typed of ["c", "co", "cod", "code", "codex"]) {
      expect(matchesQuery(a, typed)).toBe(true);
    }
  });

  it("stops at a prefix, so an interior fragment is not a whole-board selector", () => {
    // The reason this field is not a substring match. `provider` has two values
    // on the entire canvas, so `ex` under substring rules would return every
    // Codex session — a set of cards with no `ex` printed anywhere on them,
    // since nothing renders the provider.
    const a = agent({ label: "x", sessionId: "x", cwd: "/x", cwdBasename: "x", provider: "codex" });
    for (const typed of ["ex", "de", "od", "dex", "laude"]) {
      expect(matchesQuery(a, typed)).toBe(false);
    }
    expect(matchesQuery(a, "codexx")).toBe(false);
  });

  it("keeps the single letter honest — `c` does not distinguish the two", () => {
    expect(matchesQuery(agent({ label: "x", sessionId: "x", provider: "codex" }), "c")).toBe(true);
    expect(matchesQuery(agent({ label: "x", sessionId: "x", provider: "claude" }), "c")).toBe(true);
  });

  it("reads the same field the reducer writes", () => {
    // End to end rather than by hand: the matcher is worth nothing if it reads a
    // field the event pipeline never fills.
    const state = applyEvent(initialState(), envelope({
      hook_event_name: "PreToolUse",
      session_id: "sess-codex",
      cwd: "/repo",
      tool_name: "shell",
      provider: "codex" as Provider,
      model: "gpt-5.3-codex",
    }));
    const a = state.agents.get("sess-codex")!;
    expect(a.provider).toBe("codex");
    expect(matchesQuery(a, "codex")).toBe(true);
    expect(matchesQuery(a, "gpt-5.3 codex")).toBe(true);
    expect(matchesQuery(a, "claude")).toBe(false);
  });

  it("finds a legacy Claude session the reducer defaulted, not one it was told about", () => {
    // Events written before multi-provider support carry no `provider`; the
    // reducer stamps "claude". A query for `claude` has to reach those too.
    const state = applyEvent(initialState(), envelope({
      hook_event_name: "PreToolUse",
      session_id: "sess-old",
      cwd: "/repo",
      tool_name: "Read",
    }));
    expect(matchesQuery(state.agents.get("sess-old")!, "claude")).toBe(true);
  });
});

describe("case, and whose locale decides it", () => {
  it("folds the query however the user typed it", () => {
    const a = agent({ provider: "codex", model: "gpt-5.3-codex" });
    expect(matchesQuery(a, "CODEX")).toBe(true);
    expect(matchesQuery(a, "CoDeX")).toBe(true);
    expect(matchesQuery(agent({ model: "claude-opus-4-7-20250101" }), "OPUS 4.7")).toBe(true);
  });

  it("folds locale-independently, so the same deck answers the same in Istanbul", () => {
    // `toLowerCase` is the Unicode default case conversion and ignores the host
    // locale; `toLocaleLowerCase` folds `I` to dotless `ı` under tr-TR and az,
    // which would make `api` stop finding `~/Projects/API` on one machine and
    // not another. The values here are ASCII identifiers minted by the two CLIs,
    // never text in the user's language, so there is no locale in which the
    // locale-sensitive fold is the more correct one. Asserted against the source
    // because a test process cannot change the ICU default locale.
    expect(matchSrc).not.toMatch(/toLocaleLowerCase/);
    expect(matchSrc).toMatch(/toLowerCase\(\)/);
    expect(matchesQuery(agent({ cwd: "/Users/x/Projects/API" }), "api")).toBe(true);
  });
});

describe("what the search already found, and still must", () => {
  it("keeps everything when nothing is typed", () => {
    expect(matchesQuery(agent(), "")).toBe(true);
    expect(matchesQuery(agent({ provider: "codex", model: "gpt-5.3-codex" }), "")).toBe(true);
  });

  it("matches the label, the cwd, its basename, the session id and the first prompt", () => {
    const a = agent({
      id: "9f2c-aaaa",
      sessionId: "9f2c-aaaa",
      label: "agents-deck",
      cwd: "/Users/x/Desktop/agents-deck",
      cwdBasename: "agents-deck",
      firstPrompt: "fix the search box",
    });
    expect(matchesQuery(a, "agents-deck")).toBe(true);
    expect(matchesQuery(a, "desktop")).toBe(true);
    expect(matchesQuery(a, "9f2c")).toBe(true);
    expect(matchesQuery(a, "search box")).toBe(true);
    expect(matchesQuery(a, "nothing here")).toBe(false);
  });

  it("matches a tool name", () => {
    const a = agent({ tools: [tool("WebFetch"), tool("Bash")] });
    expect(matchesQuery(a, "webfetch")).toBe(true);
    expect(matchesQuery(a, "bash")).toBe(true);
    expect(matchesQuery(a, "grep")).toBe(false);
  });
});

describe("the field's promise about itself", () => {
  it("names the model, which is what #418 says it was understating", () => {
    expect(SEARCH_PLACEHOLDER).toMatch(/model/);
  });

  it("is the string the input actually shows", () => {
    expect(appSrc).toMatch(/placeholder=\{SEARCH_PLACEHOLDER\}/);
    expect(appSrc).not.toMatch(/placeholder="Search agents, cwd, tools…"/);
  });
});

describe("the component runs this rule and no other", () => {
  it("imports the shared matcher rather than declaring one", () => {
    expect(appSrc).toMatch(/import \{ matchesQuery, SEARCH_PLACEHOLDER \} from "\.\/search-match";/);
    expect(appSrc).not.toMatch(/function matchesQuery\b/);
  });

  it("uses it on both surfaces that filter — the canvas and the dim set", () => {
    expect(appSrc.match(/matchesQuery\(a, query\)/g)?.length).toBe(2);
  });

  it("borrows the chip's own labeller instead of abbreviating a second time", () => {
    // The note this file left behind — "if #374 ever extracts `shortModel` into
    // its own module, this import should follow it" — was taken up by #462,
    // which had to edit the helper and moved it to ./model-label on the way. A
    // pure matcher no longer pulls React, reactflow and ContextModal in behind
    // one string function. What is being asserted is unchanged: the matcher
    // borrows the chip's labeller and does not abbreviate a second time.
    expect(matchSrc).toMatch(/import \{ shortModel \} from "\.\/model-label";/);
    expect(matchSrc).not.toMatch(/function shortModel\b/);
  });
});
