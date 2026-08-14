// One model id, two labels, one screen. `shortModel` in AgentNode.tsx renders
// the model chips, the session rows and the usage table; the usage-history
// modal had a same-named private copy that only stripped prefixes, so
// `claude-sonnet-4-5-20250929` read as "Sonnet 4.5" in the usage panel and
// "sonnet-4-5" in the modal beside it (#251). Nothing was computed from either
// string, which is why it survived — but a family added to the shared helper
// reached four panels and never the fifth.
//
// The private copy knew two things the shared one did not: ccusage reports
// Bedrock ids with an `anthropic.` namespace on the front, and every Claude id
// ends in a release date. The shared helper read that date as a third version
// component — "Opus 4.7.20250101", where its own doc comment had promised
// "Opus 4.7" since the day it was written — so deleting the copy without
// folding both in would have been a downgrade, not a simplification. Both are
// pinned below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shortModel } from "../components/AgentNode";

const modal = readFileSync(
  fileURLToPath(new URL("../components/UsageHistoryModal.tsx", import.meta.url)),
  "utf8",
);

describe("the shared model label", () => {
  it("reads a dated Claude id as family and version, without the date", () => {
    expect(shortModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(shortModel("claude-opus-4-7-20250101")).toBe("Opus 4.7");
  });

  it("keeps a version that is not a date", () => {
    expect(shortModel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(shortModel("claude-opus-4")).toBe("Opus 4");
  });

  it("reads a Bedrock id as the same label as the plain one", () => {
    expect(shortModel("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(shortModel("anthropic.claude-haiku-4-5")).toBe("Haiku 4.5");
  });

  it("still names Codex models apart from the plain GPT ones", () => {
    expect(shortModel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(shortModel("gpt-5")).toBe("GPT-5");
  });

  it("hands back an id it does not recognise untouched", () => {
    expect(shortModel("o3-mini")).toBe("o3-mini");
  });
});

describe("the usage-history modal", () => {
  it("takes its labels from the shared helper", () => {
    expect(modal).toMatch(/import \{ shortModel \} from "\.\/AgentNode";/);
  });

  it("declares no second labeller of its own", () => {
    expect(modal).not.toMatch(/function shortModel\b/);
  });
});
