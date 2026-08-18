// #462: one label over two models a 150x price apart.
//
// `shortModel` matched `gpt-<version>` and returned before it looked at what
// followed, so `gpt-5.4-nano` ($0.20/$1.25 per Mtok) and `gpt-5.4-pro`
// ($30/$180) both printed "GPT-5.4". Nothing was mis-billed — pricing.ts holds
// an ordered row per variant and every one of them is right — which is what made
// it worse than a label bug: the usage-history modal could put two rows a 150x
// price apart under one word, and a reader comparing them could only conclude
// the deck was wrong about the money.
//
// THE SCOPE IS NOT THE PAIR THE ISSUE NAMES. Sweeping every model id the deck
// can plausibly see — every one pricing.ts prices, every one
// CODEX_CONTEXT_DEFAULTS sizes, and every one this machine's own
// ~/.claude/agent-dag/events.jsonl and ~/.codex/sessions rollouts carry — found
// ELEVEN labels standing for more than one id. Eight of them were the defect;
// three are one model spelled several ways and are meant to collapse. The
// widest spread was in a family the issue never mentions: "GPT-5" covered
// `gpt-5-pro` at $15/$120 and `gpt-5-nano` at $0.05/$0.40, a 300x step under a
// single word. Both halves — the eight that had to split and the three that
// must not — are pinned below, because the corpus is the actual scope and the
// next family added to pricing.ts should be swept against it rather than
// eyeballed.
//
// Bare node, no DOM. `shortModel` is a pure string function, so it is called
// directly; the search consequence is driven through `matchesQuery` in
// search-match.ts rather than re-derived here, and the money consequence
// through `ratesForModel` in pricing.ts, so what is pinned is the behaviour of
// the modules that actually consume the label.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { shortModel } from "../model-label";
import { matchesQuery } from "../search-match";
import { ratesForModel } from "../pricing";
import type { AgentNodeData } from "../types";

const web = fileURLToPath(new URL("..", import.meta.url));

/** Fixed clock. Sonnet 5's published rate changes on 2026-08-31, and a rate
 *  that moves under the suite would make a comparison between two ids depend on
 *  the day it ran. */
const NOW = Date.UTC(2026, 7, 18);

const T0 = 1_700_000_000_000;

/** A card on the canvas carrying one model, which is all a model query reaches. */
function agent(id: string, model: string): AgentNodeData {
  return {
    id,
    sessionId: id,
    label: "deck",
    kind: "root",
    state: "active",
    startedAt: T0,
    tools: [],
    prompts: [],
    toolCount: 0,
    childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
    model,
  };
}

// ── the corpus ──────────────────────────────────────────────────────────────
// Every model id the deck can plausibly draw a label for. Three sources, all
// enumerated rather than sampled:
//
//   · pricing.ts — one id per RATES row, plus the aliases each row's comment
//     names (`gpt-5.6` is documented as an alias for `-sol`; the 5.1 row covers
//     `-codex`, `-codex-max` and `-chat-latest`).
//   · pricing.ts CODEX_CONTEXT_DEFAULTS — `gpt-5.3-codex-spark` is sized there
//     and priced by the `-codex` row, so it exists and pricing.ts never spells
//     it out on its own.
//   · this machine's logs — the ids actually observed in
//     ~/.claude/agent-dag/events.jsonl (claude-opus-5, claude-opus-4-8,
//     claude-opus-5[1m], gpt-5.6-luna) and in ~/.codex/sessions rollouts
//     (gpt-5.6-luna, gpt-5.6-sol). Names only; no transcript content is read.
//
// Plus the three spellings that are not new models but new ways of writing one:
// the Bedrock `anthropic.` namespace, the 8-digit release date, and the `_`
// separator every regex in pricing.ts accepts alongside `-`.
const CORPUS: string[] = [
  // Claude, one per RATES row
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-4",
  "claude-opus-4-1",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "claude-haiku-3-5",
  // Claude, the same models spelled the other ways an id arrives in
  "claude-opus-5[1m]",
  "claude-opus-4-7-20250101",
  "claude-sonnet-4-5-20250929",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  // OpenAI / Codex, one per RATES row plus the aliases those rows name
  "gpt-5.6-cyber",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.6",
  "gpt-5.5-pro",
  "gpt-5.5",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2-pro",
  "gpt-5.2",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-chat-latest",
  "gpt-5.1",
  "gpt-5-pro",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-codex",
  "gpt-5",
  "codex-mini-latest",
  "o1-pro",
  "o1",
  "o3-mini",
  "o3-pro",
  "o4-mini",
  "o3",
  // The underscore spellings every `[-_]` in pricing.ts exists to accept
  "gpt_5_4_nano",
  "gpt_5_1_codex",
];

/** Label → the ids that print it, for the ids that share one. */
function collisions(ids: string[]): Array<[string, string[]]> {
  const byLabel = new Map<string, string[]>();
  for (const id of ids) {
    const label = shortModel(id);
    const seen = byLabel.get(label);
    if (seen) seen.push(id);
    else byLabel.set(label, [id]);
  }
  return [...byLabel]
    .filter(([, group]) => group.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));
}

// The eight labels that stood for more than one MODEL before this fix, with
// every id each one swallowed. Written out in full rather than derived, so the
// table is readable as the bug report it is.
const WAS_COLLAPSED: Array<[string, string[]]> = [
  ["GPT-5",            ["gpt-5-pro", "gpt-5-mini", "gpt-5-nano", "gpt-5"]],
  ["GPT-5.1",          ["gpt-5.1-chat-latest", "gpt-5.1"]],
  ["GPT-5.1 Codex",    ["gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt_5_1_codex"]],
  ["GPT-5.2",          ["gpt-5.2-pro", "gpt-5.2"]],
  ["GPT-5.3 Codex",    ["gpt-5.3-codex-spark", "gpt-5.3-codex"]],
  ["GPT-5.4",          ["gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4", "gpt_5_4_nano"]],
  ["GPT-5.5",          ["gpt-5.5-pro", "gpt-5.5"]],
  ["GPT-5.6",          ["gpt-5.6-cyber", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6"]],
];

/** The same model, however its id is punctuated. pricing.ts accepts `-` and `_`
 *  interchangeably in every pattern it has, so `gpt_5_4_nano` and
 *  `gpt-5.4-nano` are two spellings of one thing and are meant to land on one
 *  label — which makes them the wrong unit to count when asking how many models
 *  a label stands for. */
function oneModel(id: string): string {
  return id.replace(/_/g, "-").replace(/(\d)-(\d)/g, "$1.$2");
}

describe("the collision table the fix was scoped to", () => {
  it("leaves only the groups that are one model spelled several ways", () => {
    // Everything still sharing a label after the fix, in full. Every one of the
    // five is deliberate and none of them can disagree about money: a separator
    // pricing.ts already treats as equivalent, a release date, a Bedrock
    // namespace and CC's `[1m]` context banner are notations on one model, not
    // two models.
    expect(collisions(CORPUS)).toEqual([
      ["GPT-5.1 Codex", ["gpt-5.1-codex", "gpt_5_1_codex"]],
      ["GPT-5.4 Nano", ["gpt-5.4-nano", "gpt_5_4_nano"]],
      ["Opus 4.7", ["claude-opus-4-7", "claude-opus-4-7-20250101"]],
      ["Opus 5", ["claude-opus-5", "claude-opus-5[1m]"]],
      ["Sonnet 4.5", ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "anthropic.claude-sonnet-4-5-20250929-v1:0"]],
    ]);
  });

  it("gives every id in each of the eight collapsed GPT groups a label of its own", () => {
    for (const [wasLabel, ids] of WAS_COLLAPSED) {
      const labels = ids.map(shortModel);
      expect(new Set(labels).size, `${wasLabel} → ${labels.join(" | ")}`)
        .toBe(new Set(ids.map(oneModel)).size);
    }
  });

  it("no label anywhere in the corpus stands for two different published rates", () => {
    // The invariant the money surfaces need. UsagePanel's by-model table is
    // keyed by the raw id and prices each row from it, so two rows CAN legally
    // differ in cost — what they must never do is carry the same name while
    // they do it.
    const signature = (id: string) => JSON.stringify(ratesForModel(id, NOW));
    for (const [label, ids] of collisions(CORPUS)) {
      // An id pricing.ts holds no row for reads `not priced`, which is itself a
      // distinguishing thing to print, and the Bedrock namespace is unpriced
      // for reasons that have nothing to do with labels. Compare the ids that
      // do carry a rate.
      const rates = ids.map(signature).filter(s => s !== "null");
      expect(new Set(rates).size, `${label} ← ${ids.join(", ")}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("the pairs the issue is about", () => {
  it("tells gpt-5.4-nano and gpt-5.4-pro apart, at last", () => {
    expect(shortModel("gpt-5.4-nano")).toBe("GPT-5.4 Nano");
    expect(shortModel("gpt-5.4-pro")).toBe("GPT-5.4 Pro");
    expect(shortModel("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
  });

  it("names every gpt-5.6 variant, the family with five of them", () => {
    expect(shortModel("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(shortModel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(shortModel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(shortModel("gpt-5.6-cyber")).toBe("GPT-5.6 Cyber");
  });

  it("names the groups the issue did not find, including the widest one", () => {
    // "GPT-5" was the worst of the eleven and is absent from the issue: a 300x
    // step between the two ids below, printed as one word.
    expect(shortModel("gpt-5-pro")).toBe("GPT-5 Pro");
    expect(shortModel("gpt-5-nano")).toBe("GPT-5 Nano");
    expect(ratesForModel("gpt-5-pro", NOW)!.input).toBe(15);
    expect(ratesForModel("gpt-5-nano", NOW)!.input).toBe(0.05);
    // And the three the issue's own price table skips over.
    expect(shortModel("gpt-5.2-pro")).toBe("GPT-5.2 Pro");
    expect(shortModel("gpt-5.1-codex-mini")).toBe("GPT-5.1 Codex Mini");
    expect(shortModel("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark");
  });

  it("keeps a codex-tuned model apart from a plain one without a special case", () => {
    // The `-codex` branch that used to sit above the general one was the thing
    // stopping `-codex-max` and `-codex-mini` being told apart. One rule now
    // renders every qualifier, and Codex falls out of it unchanged.
    expect(shortModel("gpt-5.1-codex")).toBe("GPT-5.1 Codex");
    expect(shortModel("gpt-5.1-codex-max")).toBe("GPT-5.1 Codex Max");
    expect(shortModel("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(shortModel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  });

  it("does not let a bare id grow a suffix it never had", () => {
    // The issue's own verification line, and the half a looser pattern gets
    // wrong: a model with no variant must read exactly as it always did.
    expect(shortModel("gpt-5.6")).toBe("GPT-5.6");
    expect(shortModel("gpt-5.5")).toBe("GPT-5.5");
    expect(shortModel("gpt-5.4")).toBe("GPT-5.4");
    expect(shortModel("gpt-5")).toBe("GPT-5");
  });

  it("reads the underscore spelling of a variant the same as the hyphen one", () => {
    // `[-_]` appears in every pattern in pricing.ts because both spellings
    // reach the deck; a label that handled one and not the other would put the
    // same model on two rows.
    expect(shortModel("gpt_5_4_nano")).toBe("GPT-5.4 Nano");
    expect(shortModel("gpt_5_1_codex")).toBe("GPT-5.1 Codex");
  });

  it("leaves every Claude label exactly as it was", () => {
    expect(shortModel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(shortModel("claude-sonnet-5")).toBe("Sonnet 5");
    expect(shortModel("claude-opus-4-7-20250101")).toBe("Opus 4.7");
    expect(shortModel("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(shortModel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(shortModel("claude-fable-5")).toBe("Fable 5");
  });

  it("still hands back an id whose shape it does not recognise", () => {
    // The docstring's promise, and the reason the GPT branch is anchored: a
    // version digit with a letter fused to it is not a version plus a
    // qualifier, and "GPT-4 O" would be an invention rather than an
    // abbreviation.
    expect(shortModel("o3-mini")).toBe("o3-mini");
    expect(shortModel("o4-mini")).toBe("o4-mini");
    expect(shortModel("codex-mini-latest")).toBe("codex-mini-latest");
    expect(shortModel("gpt-4o")).toBe("gpt-4o");
    expect(shortModel("gpt-4o-mini")).toBe("gpt-4o-mini");
  });
});

describe("the label still fits where it is drawn", () => {
  it("never returns a string longer than the id it was given", () => {
    // The structural bound. `gpt-` becomes `GPT-`, every `-` or `_` becomes one
    // space or one dot, and `anthropic.` and the release date are removed — so
    // no branch can lengthen an id, and the raw id was already a legal return
    // value from this function. Whatever a surface could draw before, it can
    // draw now.
    for (const id of CORPUS) {
      expect(shortModel(id).length, id).toBeLessThanOrEqual(id.length);
    }
  });

  it("stays inside the 19 characters the narrowest surface was measured for", () => {
    // The measured bound, and where it comes from. The tightest of the four
    // surfaces printing this label is the usage-history day breakdown:
    // `.uh-model-row` gives the name a hard 130px column, an 8px dot and a 5px
    // gap leave 117px, and 19 mixed-case characters at 11px in the UI sans
    // stack measure about 105px. The node chip has more room — `.agent-node` is
    // max-width 260px, 230px of it content, "session" spends 46px of that at
    // 11px in the mono stack, and a 19-character chip at 10px with 0.02em
    // tracking plus 22px of chrome is 140px in the 184px left. A twentieth
    // character breaks neither; the number is written down so the next
    // qualifier is measured rather than guessed.
    const longest = CORPUS.map(shortModel).sort((a, b) => b.length - a.length);
    expect(longest[0].length).toBeLessThanOrEqual(19);
    expect(longest.filter(l => l.length === 19).sort()).toEqual([
      "GPT-5.1 Chat Latest",
      "GPT-5.3 Codex Spark",
    ]);
  });
});

describe("what the search does with the label now", () => {
  it("finds each model by the words its own chip prints, and only that model", () => {
    // The #418 consequence, which is the half that makes this more than a label
    // bug: search indexes the raw id AND this label, so while two models shared
    // a label there was no string a user could read off a card that would
    // select one of them — typing "GPT-5.4" returned four models, and the four
    // cards it returned all said "GPT-5.4".
    //
    // The check is on the MOST SPECIFIC labels in each family, the ones no other
    // label in the group extends. A bare "GPT-5.6" is a prefix of every variant
    // beside it and matching all five is the honest answer to a query that
    // genuinely is less specific; before this fix every label in a group was
    // most specific and every one of them selected the whole group.
    for (const [, ids] of WAS_COLLAPSED) {
      const cards = ids.map((id, i) => agent(`s${i}`, id));
      for (const id of ids) {
        const label = shortModel(id);
        const extended = ids.some(other => {
          const l = shortModel(other);
          return l.length > label.length && l.startsWith(label);
        });
        if (extended) continue;
        const hits = cards.filter(c => matchesQuery(c, label)).map(c => c.model!);
        expect(hits, label).toContain(id);
        expect(new Set(hits.map(oneModel)).size, `${label} → ${hits.join(" | ")}`).toBe(1);
      }
    }
  });

  it("still finds each model by the raw id someone pasted from a config file", () => {
    const nano = agent("n", "gpt-5.4-nano");
    const pro = agent("p", "gpt-5.4-pro");
    expect(matchesQuery(nano, "gpt-5.4-nano")).toBe(true);
    expect(matchesQuery(pro, "gpt-5.4-nano")).toBe(false);
    expect(matchesQuery(pro, "gpt-5.4-pro")).toBe(true);
    // And the family query keeps finding the whole family, by id and by label.
    expect(matchesQuery(nano, "gpt-5.4")).toBe(true);
    expect(matchesQuery(pro, "GPT-5.4")).toBe(true);
  });

  it("finds a Codex variant by its qualifier alone, which is what a user types", () => {
    expect(matchesQuery(agent("a", "gpt-5.6-luna"), "luna")).toBe(true);
    expect(matchesQuery(agent("b", "gpt-5.6-terra"), "luna")).toBe(false);
    expect(matchesQuery(agent("c", "gpt-5.1-codex-max"), "codex max")).toBe(true);
  });
});

describe("what the money surfaces do with the label now", () => {
  it("agrees with the rate the row is priced at, for the pair the issue opens with", () => {
    // pricing.ts was never wrong; it holds an ordered row per variant and the
    // by-model table keys on the raw id. What changed is that the name beside
    // the figure now identifies which of the two rows is which.
    expect(shortModel("gpt-5.4-nano")).toBe("GPT-5.4 Nano");
    expect(ratesForModel("gpt-5.4-nano", NOW)).toMatchObject({ input: 0.2, output: 1.25 });
    expect(shortModel("gpt-5.4-pro")).toBe("GPT-5.4 Pro");
    expect(ratesForModel("gpt-5.4-pro", NOW)).toMatchObject({ input: 30, output: 180 });
  });

  it("names a model it cannot price without implying a rate for it", () => {
    // #400's `not priced` and this label answer two different questions, and
    // the label must not start answering the pricing one. A gpt-5.7 nobody has
    // published rates for gets a full, honest name and still no dollars.
    expect(shortModel("gpt-5.7-quartz")).toBe("GPT-5.7 Quartz");
    expect(ratesForModel("gpt-5.7-quartz", NOW)).toBeNull();
  });

  it("keeps every priced id in the corpus priced, since the label is display only", () => {
    // A guard against the label change reaching pricing by accident: the ids
    // pricing.ts has rows for still resolve, variant by variant.
    for (const id of CORPUS) {
      if (id.startsWith("anthropic.")) continue;  // unpriced for its namespace, not its label
      expect(ratesForModel(id, NOW), id).not.toBeNull();
    }
  });
});

describe("one labeller, in one place", () => {
  it("is declared in model-label.ts and nowhere else under src/web", () => {
    // The failure #251 fixed and this file inherits: a second private copy that
    // strips a prefix the shared one does not, so one id reads two ways on one
    // screen. The helper moved out of AgentNode.tsx in this fix, and the check
    // that matters is not where it lives but that it lives in exactly one file.
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "__tests__" ? [] : files(path);
        return /\.tsx?$/.test(path) ? [path] : [];
      });
    const declaring = files(web).filter(p => /function shortModel\b/.test(readFileSync(p, "utf8")));
    expect(declaring.map(p => p.slice(web.length))).toEqual(["model-label.ts"]);
  });
});
