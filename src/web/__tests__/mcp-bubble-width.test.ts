// The MCP primary bubble is labelled with the server segment, and an
// unrecognised server keeps its raw name — often a long uuid. While the width
// estimate was pinned at 96px for every non-Codex tool, the chained method
// sub-bubble was placed inside the primary and the two drew on top of each
// other. These assert the estimate now tracks the label for MCP calls, and
// that short/known labels still land on the original fixed estimate.
import { describe, it, expect } from "vitest";
import { primaryBubbleWidth } from "../components/ToolBursts";

/** Same constants the layout uses: the fixed floor and the sub-bubble gap. */
const ESTIMATED_BUBBLE_W = 96;
const SUB_GAP = 28;

/** Where the method sub-bubble starts, relative to the primary's left edge. */
const subOffset = (tool: string, label: string) =>
  primaryBubbleWidth(tool, label) + SUB_GAP;

describe("primaryBubbleWidth", () => {
  it("widens for a long unknown MCP server so the method bubble clears it", () => {
    const w = primaryBubbleWidth("mcp__supabase-local__query", "supabase-local");
    expect(w).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    // 34px of emoji + padding, then ~7.5px per character.
    expect(w).toBeCloseTo(34 + "supabase-local".length * 7.5);
  });

  it("keeps a uuid-named MCP server's sub-bubble outside the primary", () => {
    const uuid = "3f2a9c1e-7b45-4d8a-9f10-c6e5b2d84a37";
    expect(subOffset(`mcp__${uuid}__list_tables`, uuid))
      .toBeGreaterThan(primaryBubbleWidth(`mcp__${uuid}__list_tables`, uuid));
    // The old fixed estimate buried the method bubble deep inside the primary.
    expect(subOffset(`mcp__${uuid}__list_tables`, uuid))
      .toBeGreaterThan(ESTIMATED_BUBBLE_W + SUB_GAP);
  });

  it("leaves known MCP servers on the fixed estimate — their names are short", () => {
    expect(primaryBubbleWidth("mcp__github__create_pr", "GitHub")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("mcp__linear__list_issues", "Linear")).toBe(ESTIMATED_BUBBLE_W);
  });

  it("still scales Codex tools and leaves Claude tools untouched", () => {
    expect(primaryBubbleWidth("exec_command", "Shell")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("shell_command", "a-very-long-label")).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("Bash", "Bash")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("NotebookEdit", "NotebookEdit")).toBe(ESTIMATED_BUBBLE_W);
  });
});
