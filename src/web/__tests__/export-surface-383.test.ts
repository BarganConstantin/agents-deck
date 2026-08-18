// The deletions from #383, pinned so they do not come back.
//
// Every symbol below was exported with no reader outside its own module. That is
// not dead code — each one has an in-file caller and every one of them still
// runs — it is dead export SURFACE, and the cost is paid by the next person to
// read the module, who has to search the whole tree to find out that nobody is
// on the other end. The same goes for the eight TOOL_CATEGORY rows: a key whose
// value is the default answers exactly what no key answers.
//
// Two things are asserted for each, and both halves matter. That the symbol is
// no longer exported, which is the change. And that it still WORKS, which is the
// thing that would actually hurt if the change had been made carelessly —
// dropping an `export` keyword and dropping the declaration look identical in a
// diff read too quickly, and the second one silently removes a branch.
//
// Plain node throughout: the assertions are module namespaces, source text and
// pure functions, and nothing here renders.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { categoryFor, TOOL_CATEGORY } from "../tool-taxonomy";
import { canAskForApproval } from "../codex-approval";
import { billedInputTokens } from "../pricing";
import type { TokenUsage } from "../types";

const SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const WEB = fileURLToPath(new URL("../", import.meta.url));
const src = (root: string, file: string) => readFileSync(join(root, file), "utf8");

/** The module's live export names. */
async function exportsOf(spec: string): Promise<string[]> {
  return Object.keys(await import(/* @vite-ignore */ spec));
}

// ── the ten in-file-only exports ────────────────────────────────────────────

// file, symbol, and a fragment proving the declaration survived the un-export.
const UNEXPORTED: [dir: string, file: string, symbol: string, declaration: RegExp][] = [
  [SERVER, "npx.mjs",         "PREFETCH_TIMEOUT_MS",     /^const PREFETCH_TIMEOUT_MS = /m],
  [SERVER, "self-update.mjs", "isGitCheckout",           /^function isGitCheckout\(pkgRoot\) \{/m],
  [SERVER, "claude-dir.mjs",  "claudeCliOnDisk",         /^function claudeCliOnDisk\(\{/m],
  [SERVER, "installer.mjs",   "CLAUDE_EVENTS",           /^const CLAUDE_EVENTS = \[/m],
  [WEB,    "codex-approval.ts", "ASKING_APPROVAL_POLICIES", /^const ASKING_APPROVAL_POLICIES: /m],
  [WEB,    "pricing.ts",      "isCodexModel",            /^function isCodexModel\(/m],
  [WEB,    "tool-taxonomy.ts", "CODEX_TOOL_CATEGORY",    /^const CODEX_TOOL_CATEGORY: /m],
];

describe("the symbols #383 took off their modules' public surface", () => {
  for (const [dir, file, symbol, declaration] of UNEXPORTED) {
    it(`${file} no longer exports ${symbol}, and still declares it`, async () => {
      const text = src(dir, file);
      // The declaration is intact — this is an un-export, not a deletion.
      expect(text, `${symbol} declaration is gone from ${file}`).toMatch(declaration);
      // And no export statement anywhere in the file names it, in either form:
      // the inline keyword or a name in an `export { … }` list.
      expect(text, `${file} re-exports ${symbol} inline`)
        .not.toMatch(new RegExp(`^export (?:const|let|var|function|async function|class) ${symbol}\\b`, "m"));
      for (const list of text.matchAll(/^export \{([^}]*)\}/gm)) {
        expect(list[1].split(",").map(s => s.trim()), `${file} re-exports ${symbol} in a list`)
          .not.toContain(symbol);
      }
      // The live namespace agrees, which is the assertion the two above exist to
      // explain when it fails.
      expect(await exportsOf(join(dir, file))).not.toContain(symbol);
    });
  }
});

describe("everything those symbols decide still gets decided", () => {
  it("still tells a git checkout to pull instead of installing over it", async () => {
    // isGitCheckout, reached the way the deck reaches it. This repo is a
    // checkout, so its own root is the fixture.
    const { upgradeCommand } = await import("../../server/self-update.mjs") as {
      upgradeCommand: (root: string) => string;
    };
    expect(upgradeCommand(fileURLToPath(new URL("../../../", import.meta.url))))
      .toBe("git pull && npm run build");
  });

  it("still finds Claude Code by its binary alone", async () => {
    // claudeCliOnDisk, reached through hasClaudeInstalled with the whole machine
    // injected — no config dir, so the binary walk is the only thing that can
    // answer yes.
    const { hasClaudeInstalled } = await import("../../server/claude-dir.mjs") as {
      hasClaudeInstalled: (o: Record<string, unknown>) => boolean;
    };
    const onPath = hasClaudeInstalled({
      platform: "linux", env: { PATH: "/usr/local/bin" }, home: "/home/x",
      configDir: "/home/x/.claude", exists: (p: string) => p === "/usr/local/bin/claude",
    });
    expect(onPath).toBe(true);
    expect(hasClaudeInstalled({
      platform: "linux", env: { PATH: "/usr/local/bin" }, home: "/home/x",
      configDir: "/home/x/.claude", exists: () => false,
    })).toBe(false);
  });

  it("still splits the asking approval policies from the one that cannot ask", () => {
    // ASKING_APPROVAL_POLICIES, through the only function that reads it. The
    // three-way answer is the point: true, false and "not known" are different.
    expect(canAskForApproval("on-request")).toBe(true);
    expect(canAskForApproval("on-failure")).toBe(true);
    expect(canAskForApproval("untrusted")).toBe(true);
    expect(canAskForApproval("never")).toBe(false);
    expect(canAskForApproval("something-new")).toBeNull();
  });

  it("still bills a Codex session's cached input differently from a Claude one", () => {
    // isCodexModel, through billedInputTokens. Codex reports cache reads inside
    // its input count and bills them separately; Claude does not.
    const usage: TokenUsage = {
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000, cacheCreateTokens: 0,
    };
    expect(billedInputTokens(usage, "gpt-5.6")).toBe(100_000);
    expect(billedInputTokens(usage, "claude-opus-5")).toBe(1_000_000);
  });

  it("still merges every Codex tool name into the one bucket table", () => {
    // CODEX_TOOL_CATEGORY, through the table it is spread into. If the spread
    // were lost, every Codex call would fall to "other" — the exact bug #417
    // was filed for.
    expect(categoryFor("exec")).toBe("shell");
    expect(categoryFor("apply_patch")).toBe("file");
    expect(categoryFor("update_plan")).toBe("task");
    expect(categoryFor("run")).toBe("web");
  });

  it("still registers every hook event with Claude Code", () => {
    // CLAUDE_EVENTS, which has no live reader outside its own file at all. The
    // list is the deck's entire input: an event missing here is a deck that
    // never hears about that half of a session.
    const installer = src(SERVER, "installer.mjs");
    const block = /const CLAUDE_EVENTS = \[([\s\S]*?)\];/.exec(installer);
    expect(block, "CLAUDE_EVENTS is no longer a list").toBeTruthy();
    const events = [...block![1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect(events).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
      "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop",
      "SessionEnd", "Notification",
    ]);
    // And the list is still what the claude provider installs, rather than a
    // constant left behind beside a literal that has drifted away from it.
    expect(installer).toMatch(/events:\s*CLAUDE_EVENTS/);
  });
});

// ── the eight no-op category rows ───────────────────────────────────────────

const NO_OP_ROWS = [
  "ScheduleWakeup", "CronCreate", "CronList", "CronDelete",
  "Monitor", "PushNotification", "RemoteTrigger", "ToolSearch",
];

describe("the TOOL_CATEGORY rows that mapped a name to the default", () => {
  it("answers exactly what it answered before, from the fallback instead", () => {
    // The whole justification for removing them, stated as an assertion:
    // `categoryFor` is `TOOL_CATEGORY[name] ?? "other"`, so a row saying "other"
    // and no row at all are the same answer. Nothing in the deck asks whether a
    // name is PRESENT in the table, which is what would have made them differ.
    for (const name of NO_OP_ROWS) expect(categoryFor(name), name).toBe("other");
  });

  it("has stopped spelling them out in the table", () => {
    for (const name of NO_OP_ROWS) {
      expect(Object.keys(TOOL_CATEGORY), name).not.toContain(name);
      expect(TOOL_CATEGORY[name], name).toBeUndefined();
    }
  });

  it("has not lost the names, which still carry their own emoji", () => {
    // The counter-argument the rows were kept for was that they documented a
    // schedule family somebody meant to give its own bucket. That record is in
    // TOOL_EMOJI, where the names have real values rather than the default, so
    // removing the category rows loses nothing a reader was relying on.
    const toolBursts = src(WEB, "components/ToolBursts.tsx");
    const block = /const TOOL_EMOJI[^=]*= \{([\s\S]*?)^\};/m.exec(toolBursts);
    expect(block, "TOOL_EMOJI is no longer a literal").toBeTruthy();
    for (const name of NO_OP_ROWS) {
      expect(block![1], `${name} lost its emoji too`).toMatch(new RegExp(`\\b${name}:\\s*"`));
    }
  });

  it("leaves the rows that are not the default exactly where they were", () => {
    // The reason this was a surgical removal and not a purge: the other rows in
    // the same literal are the whole bucket system.
    expect(categoryFor("Read")).toBe("file");
    expect(categoryFor("Bash")).toBe("shell");
    expect(categoryFor("WebSearch")).toBe("web");
    expect(categoryFor("Task")).toBe("agent");
    expect(categoryFor("TodoWrite")).toBe("task");
    expect(categoryFor("ExitPlanMode")).toBe("plan");
    expect(categoryFor("mcp__github__create_pr")).toBe("mcp");
    expect(categoryFor("frobnicate")).toBe("other");
  });
});

// ── what #383 deliberately did NOT remove ───────────────────────────────────

describe("the identity map App.tsx keeps on purpose", () => {
  it("still maps every category to a label of its own", () => {
    // DETAIL_CAT_LABEL is `{ file: "file", shell: "shell", … }` today, so every
    // lookup through it answers its own key and it looks exactly like the eight
    // rows above. It is not the same thing: those rows fed a lookup with a
    // fallback that already gave the right answer, and this is the only place a
    // chip's visible TEXT is decided. The day one of them wants to read "MCP
    // servers" rather than "mcp", this is where that is written — deleting it
    // would mean inlining `{c}` at three call sites and putting it back. #383
    // flagged it and explicitly did not recommend removing it; this pins that
    // decision so the next sweep does not have to make it again.
    const app = src(WEB, "App.tsx");
    const block = /const DETAIL_CAT_LABEL[^=]*= \{([\s\S]*?)\};/.exec(app);
    expect(block, "DETAIL_CAT_LABEL is gone — see the comment above").toBeTruthy();
    const keys = [...block![1].matchAll(/(\w+):/g)].map(m => m[1]);
    // The same eight members the emoji table has, since they index the same union.
    expect(keys.sort()).toEqual(
      ["agent", "file", "mcp", "other", "plan", "shell", "task", "web"],
    );
  });

  it("says why at the declaration, not only here", () => {
    // The decision above was pinned in this file and nowhere else, so a reader
    // of App.tsx still met eight rows that spell their own keys with nothing
    // saying they are deliberate — and #383 was raised a second time on exactly
    // that. The rationale lives at the site now; this keeps it there. Matched on
    // the issue number and the shape (a block comment ending immediately above
    // the declaration) rather than on any sentence, so the prose stays free to
    // be rewritten.
    const app = src(WEB, "App.tsx");
    const at = app.indexOf("const DETAIL_CAT_LABEL");
    expect(at, "DETAIL_CAT_LABEL is gone — see the test above").toBeGreaterThan(-1);
    // \s covers the \r of a CRLF checkout.
    const preceding = app.slice(0, at);
    expect(preceding, "no block comment sits on DETAIL_CAT_LABEL").toMatch(/\*\/\s*$/);
    const comment = /\/\*(?:(?!\*\/)[\s\S])*\*\/\s*$/.exec(preceding)![0];
    expect(comment).toContain("#383");
  });
});
