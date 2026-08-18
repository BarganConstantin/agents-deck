// #431. The usage-history modal's subtitle read "via ccusage · local Claude /
// Codex logs" and the chart under it showed one merged number, so the panel
// named two CLIs and then refused to tell them apart. "How much of this is
// Codex?" had no answer anywhere on it — the model legend shows per-model cost,
// which is the closest thing, and it is exactly where eyeballing breaks down: it
// is long, it changes week to week, and adding it up means already knowing which
// model ids belong to which CLI.
//
// ccusage has computed that split all along. `daily --by-agent --json` adds one
// `agents` array per day, and the deck never sent the flag.
//
// What is pinned here, in the order the answer travels:
//
//   1. the argv — the flag is on the vector, with and without `--until`;
//   2. the fallback — an older ccusage that rejects it costs the split and not
//      the history, and the reader is shown no error;
//   3. what is remembered about that, which is narrower than what is retried;
//   4. the parse — a real `--by-agent` payload, measured from ccusage 20.0.20
//      on a machine running both CLIs, reaching the browser intact and rolling
//      up to figures that sum to the day totals already on screen;
//   5. the one-CLI and no-CLI machines, which must see the panel they see today.
//
// TEST ENVIRONMENT. Plain Node, no jsdom, so nothing here renders React — which
// is why the arithmetic and the copy live in usage-agents.ts and
// provider-copy.ts rather than in the modal. HOME, PATH and AGENTS_DECK_CCUSAGE
// are redirected before ccusage.mjs is imported, the way the six sibling ccusage
// files do it: this file's subject is which ccusage the deck runs and with what,
// so it must not find the developer's own managed install or a global copy on
// their PATH, on any platform.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSUMED, readProviders } from "../providers";
import { agentLabel, usageSubtitle } from "../provider-copy";
import { agentColor, agentTotals, dayAgentSummary, sharePct } from "../usage-agents";

// ── the payload, as ccusage 20.0.20 actually produces it ────────────────────
//
// Trimmed from a real `daily --json --since … --by-agent` run: two days from a
// machine that runs Claude Code constantly and Codex rarely, which is the shape
// the issue reports and the one the UI is hardest on — the smaller CLI's segment
// is a fraction of a pixel wide.
//
// Three properties of this fixture are the measurement, not decoration:
//   · `agent: "all"` stays on the day itself, so the merged view the deck has
//     always drawn survives the flag;
//   · `metadata.agents` is present with AND without the flag, which is why the
//     day-detail header could list names and no money before this;
//   · each day's `totalCost` is exactly the sum of its agents' — 578.6711595999998
//     + 0.0010828799999999998 — so the split cannot disagree with the total
//     printed beside it.
const CLAUDE_ONLY_DAY = {
  period: "2026-08-11",
  agent: "all",
  totalCost: 142.71654,
  totalTokens: 180_000_000,
  inputTokens: 12_000,
  outputTokens: 600_000,
  cacheCreationTokens: 3_000_000,
  cacheReadTokens: 176_388_000,
  modelsUsed: ["claude-opus-5"],
  modelBreakdowns: [{ modelName: "claude-opus-5", cost: 142.71654, inputTokens: 12_000, outputTokens: 600_000, cacheCreationTokens: 3_000_000, cacheReadTokens: 176_388_000 }],
  metadata: { agents: ["claude"] },
  agents: [
    { agent: "claude", totalCost: 142.71654, totalTokens: 180_000_000, inputTokens: 12_000, outputTokens: 600_000, cacheCreationTokens: 3_000_000, cacheReadTokens: 176_388_000, modelsUsed: ["claude-opus-5"], modelBreakdowns: [] },
  ],
};
const BOTH_DAY = {
  period: "2026-08-12",
  agent: "all",
  totalCost: 578.6722424799998,
  totalTokens: 700_000_000,
  inputTokens: 20_000,
  outputTokens: 900_000,
  cacheCreationTokens: 9_000_000,
  cacheReadTokens: 690_080_000,
  modelsUsed: ["claude-sonnet-5", "claude-opus-5", "gpt-5.6-luna"],
  modelBreakdowns: [
    { modelName: "claude-opus-5", cost: 400.0, inputTokens: 10_000, outputTokens: 500_000, cacheCreationTokens: 5_000_000, cacheReadTokens: 400_000_000 },
    { modelName: "claude-sonnet-5", cost: 178.6711595999998, inputTokens: 9_000, outputTokens: 399_000, cacheCreationTokens: 4_000_000, cacheReadTokens: 290_079_000 },
    { modelName: "gpt-5.6-luna", cost: 0.0010828799999999998, inputTokens: 1_000, outputTokens: 1_000, cacheCreationTokens: 0, cacheReadTokens: 1_000 },
  ],
  metadata: { agents: ["claude", "codex"] },
  agents: [
    { agent: "claude", totalCost: 578.6711595999998, totalTokens: 699_998_000, inputTokens: 19_000, outputTokens: 899_000, cacheCreationTokens: 9_000_000, cacheReadTokens: 690_079_000, modelsUsed: ["claude-sonnet-5", "claude-opus-5"], modelBreakdowns: [] },
    { agent: "codex", totalCost: 0.0010828799999999998, totalTokens: 2_000, inputTokens: 1_000, outputTokens: 1_000, cacheCreationTokens: 0, cacheReadTokens: 1_000, modelsUsed: ["gpt-5.6-luna"], modelBreakdowns: [] },
  ],
};
/** What the flag produces. */
const BY_AGENT_JSON = JSON.stringify({
  daily: [CLAUDE_ONLY_DAY, BOTH_DAY],
  totals: { totalCost: 721.3887824799998, totalTokens: 880_000_000, inputTokens: 32_000, outputTokens: 1_500_000, cacheCreationTokens: 12_000_000, cacheReadTokens: 866_468_000 },
});
/** What a ccusage too old for the flag produces: the identical days with the
 *  `agents` array taken off, which is the only difference the two runs had. */
const PLAIN_JSON = JSON.stringify({
  daily: [CLAUDE_ONLY_DAY, BOTH_DAY].map(({ agents, ...day }) => day),
  totals: JSON.parse(BY_AGENT_JSON).totals,
});

/** Exactly what a ccusage that has never heard of the flag says, measured:
 *  exit 2, an EMPTY stdout, and the complaint on stderr naming the option. */
const UNKNOWN_FLAG = { stderr: "Unknown option '--by-agent'\nRun 'ccusage --help' for usage.", code: 2 };

// ── the server half, with every spawn faked ─────────────────────────────────

const { calls, runPlan, fakeChild } = vi.hoisted(() => {
  type Sub = (v?: unknown) => void;
  type Reply = { stdout?: string; stderr?: string; code: number };
  return {
    calls: [] as { file: string; args: string[] }[],
    runPlan: [] as Reply[],
    fakeChild: (reply: Reply) => {
      const out: Sub[] = [], err: Sub[] = [], self: Record<string, Sub[]> = {};
      setTimeout(() => {
        if (reply.stdout) out.forEach(cb => cb(reply.stdout));
        if (reply.stderr) err.forEach(cb => cb(reply.stderr));
        self.close?.forEach(cb => cb(reply.code));
      }, 0);
      return {
        pid: 4242,
        stdout: { on: (_ev: string, cb: Sub) => { out.push(cb); } },
        stderr: { on: (_ev: string, cb: Sub) => { err.push(cb); } },
        on: (ev: string, cb: Sub) => { (self[ev] ||= []).push(cb); },
        kill: () => {},
        unref: () => {},
      };
    },
  };
});

vi.mock("node:child_process", () => ({
  // The default reply is the flagged payload, because the flagged run is what
  // this deck now sends: a test that wants the older CLI's answer says so.
  spawn: (file: string, args: string[] = []) => {
    calls.push({ file, args });
    return fakeChild((runPlan.shift() ?? { stdout: BY_AGENT_JSON, code: 0 }) as never);
  },
  spawnSync: () => ({ status: 1, stdout: "", stderr: "test: no npm here" }),
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// ccusage.mjs resolves ~/.agents-deck/ccusage out of os.homedir() at import
// time — $HOME on POSIX, %USERPROFILE% on Windows — so both are pointed into a
// temp directory BEFORE the module loads. PATH goes with them: #433 taught the
// deck to run a ccusage the user put on PATH, so a developer with
// `npm i -g ccusage` would otherwise have this file resolve THEIR copy and pass
// or fail on a fact about their machine. AGENTS_DECK_CCUSAGE and
// AGENTS_DECK_NO_INSTALL are cleared for the same reason.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-by-agent-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PATH: process.env.PATH,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  AGENTS_DECK_CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.PATH = join(FAKE_HOME, "nothing-here");
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_CCUSAGE;

/**
 * A ccusage.mjs with no memory of any earlier test.
 *
 * The module deliberately remembers, for the life of the process, that a
 * particular ccusage refused `--by-agent` — one process per fetch instead of two
 * is the whole point of it. That makes it exactly the wrong thing to share
 * between tests: the first case below that plays an old CLI would silently turn
 * every later expectation into one about a deck that had already given up
 * asking, and the file would then pass or fail on its own declaration order.
 * Re-importing per test gives each one its own module state, and clears the
 * two-minute response cache with it.
 *
 * The child_process mock is hoisted and survives resetModules, so `calls` and
 * `runPlan` keep pointing at the same arrays throughout.
 */
async function freshCcusage() {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  const mod = await import("../../server/ccusage.mjs");
  return mod.fetchCcusageDaily as (o: Record<string, unknown>) => Promise<Record<string, never>>;
}
let fetchCcusageDaily: Awaited<ReturnType<typeof freshCcusage>>;

const CCUSAGE_DIR = join(FAKE_HOME, ".agents-deck", "ccusage");
const PKG_DIR = join(CCUSAGE_DIR, "node_modules", "ccusage");
if (!PKG_DIR.startsWith(FAKE_HOME)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${FAKE_HOME}`);
const ENTRY = join(PKG_DIR, "src", "cli.js");

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

/** The deck's own managed install, in the state resolveEntry accepts. The
 *  marker is dated now so the once-a-day `npm view` cannot land a spawn in the
 *  middle of a plan. */
function managedInstall() {
  mkdirSync(join(PKG_DIR, "src"), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "20.0.20", bin: "./src/cli.js" }));
  writeFileSync(ENTRY, "");
  writeFileSync(join(CCUSAGE_DIR, ".last-update-check"), String(Date.now()));
}

beforeEach(async () => {
  calls.length = 0;
  runPlan.length = 0;
  managedInstall();
  fetchCcusageDaily = await freshCcusage();
});

/** Run `work` with console.error captured — the module's only way out to the
 *  terminal, and a failing run writes there. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await work();
  } finally {
    spy.mockRestore();
  }
}

/** The arguments of one run, without the entry-point path in front of them.
 *  `node <entry> daily …` is what the managed install is launched as. */
const ranWith = (i: number) => calls[i].args.slice(1);

describe("the argument list the deck sends ccusage", () => {
  it("asks for the split, on the end of the vector it always sent", async () => {
    // The whole of the issue's first half. `daily --json --since …` was the
    // entire argument list, and `--by-agent` is documented one line above the
    // `--since` example in the installed copy's own README.
    await fetchCcusageDaily({ since: "20260801" });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(process.execPath);
    expect(ranWith(0)).toEqual(["daily", "--json", "--since", "20260801", "--by-agent"]);
  });

  it("still sends --until, and sends it with the flag rather than instead of it", async () => {
    // Verified against the real CLI over a bounded range: the two options
    // compose, and the days come back with their `agents` arrays intact.
    await fetchCcusageDaily({ since: "20260810", until: "20260812" });

    expect(ranWith(0)).toEqual(["daily", "--json", "--since", "20260810", "--until", "20260812", "--by-agent"]);
  });

  it("sends it as one argument, never as text a shell would re-read", async () => {
    // #362 removed `shell: true` from this module and #456 routed every Windows
    // shim through cmd.exe with each argument quoted. A flag appended as a
    // string concatenation would have walked both of those back on the one
    // vector that also carries a user-supplied `--since`.
    await fetchCcusageDaily({ since: "20260802" });

    for (const arg of calls[0].args) expect(arg).not.toMatch(/\s/);
    expect(calls[0].args.filter(a => a === "--by-agent")).toHaveLength(1);
  });
});

describe("what comes back", () => {
  it("carries each day's agents through to the browser untouched", async () => {
    // The server reshapes nothing: `--by-agent` is purely additive, so the days
    // it hands over are the days it always handed over plus one array.
    const res = await fetchCcusageDaily({ since: "20260803" });

    expect(res.ok).toBe(true);
    expect(res.days).toHaveLength(2);
    expect(res.days[1].agents.map((a: { agent: string }) => a.agent)).toEqual(["claude", "codex"]);
    // And every key the modal read before the flag is still there and unchanged.
    expect(res.days[1].totalCost).toBe(BOTH_DAY.totalCost);
    expect(res.days[1].modelBreakdowns).toHaveLength(3);
    expect(res.days[1].metadata.agents).toEqual(["claude", "codex"]);
    expect(res.totals.totalCost).toBeCloseTo(721.3887824799998, 10);
  });

  it("adds up to the total the panel already prints, exactly", async () => {
    // The issue's first verification bullet. The split is drawn directly under
    // the range total it decomposes, so a sum that drifts from it would be
    // visible on screen as two numbers disagreeing about the same money.
    const res = await fetchCcusageDaily({ since: "20260804" });

    const rangeTotal = res.days.reduce((n: number, d: { totalCost: number }) => n + d.totalCost, 0);
    const byAgent = agentTotals(res.days).reduce((n, a) => n + a.cost, 0);
    expect(byAgent).toBe(rangeTotal);

    for (const day of res.days) {
      expect(day.agents.reduce((n: number, a: { totalCost: number }) => n + a.totalCost, 0)).toBe(day.totalCost);
    }
  });

  it("rolls the days up per CLI, dearest first", async () => {
    const res = await fetchCcusageDaily({ since: "20260805" });

    expect(agentTotals(res.days)).toEqual([
      { id: "claude", cost: 142.71654 + 578.6711595999998, tokens: 180_000_000 + 699_998_000 },
      { id: "codex", cost: 0.0010828799999999998, tokens: 2_000 },
    ]);
  });
});

describe("an older ccusage, which does not know the flag", () => {
  it("costs the split and not the history", async () => {
    // The one hazard the issue names, and the whole point of the retry: the
    // panel must still draw. Measured failure shape — exit 2, empty stdout,
    // "Unknown option" on stderr — so it can never be confused with a
    // successful run that happened to have no data.
    runPlan.push(UNKNOWN_FLAG, { stdout: PLAIN_JSON, code: 0 });

    const res = await quietly(() => fetchCcusageDaily({ since: "20260806" }));

    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.days).toHaveLength(2);
    // Two runs, the second one flagless — and it is the SAME vector otherwise,
    // so nothing else was given up to get the answer.
    expect(calls).toHaveLength(2);
    expect(ranWith(0)).toEqual(["daily", "--json", "--since", "20260806", "--by-agent"]);
    expect(ranWith(1)).toEqual(["daily", "--json", "--since", "20260806"]);
  });

  it("leaves the reader with no split rather than an empty one", async () => {
    // What the modal then has to work with. No `agents` anywhere means no
    // roll-up, which is the same answer a one-CLI machine gives — and the modal
    // draws the strip only for two or more, so both render today's panel.
    runPlan.push(UNKNOWN_FLAG, { stdout: PLAIN_JSON, code: 0 });

    const res = await quietly(() => fetchCcusageDaily({ since: "20260807" }));

    expect(res.days.every((d: { agents?: unknown }) => d.agents === undefined)).toBe(true);
    expect(agentTotals(res.days)).toEqual([]);
  });

  it("does not retry a failure that happened before ccusage ran", async () => {
    // A second process is a second wait, so the retry is for the CLI's own
    // refusals. AGENTS_DECK_NO_INSTALL with nothing installed is refused by the
    // deck itself, and retrying it would spawn nothing and say the same thing
    // twice.
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });
    process.env.AGENTS_DECK_NO_INSTALL = "1";
    try {
      const res = await quietly(() => fetchCcusageDaily({ since: "20260808" }));
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("no_install");
      expect(calls).toEqual([]);
    } finally {
      delete process.env.AGENTS_DECK_NO_INSTALL;
    }
  });

  it("reports the flagless run's failure when both of them fail", async () => {
    // Both attempts died, so the honest account of this machine is the one
    // without the deck's flag on it: blaming `--by-agent` for a failure it has
    // just been shown to make no difference to would send the reader after the
    // wrong thing.
    runPlan.push(UNKNOWN_FLAG, { stderr: "ccusage exited 3", code: 3 });

    const res = await quietly(() => fetchCcusageDaily({ since: "20260809" }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("run_failed");
    expect(res.error).toContain("ccusage exited 3");
    expect(res.error).not.toContain("by-agent");
  });
});

describe("who spent it, once the split is in hand", () => {
  it("tells a CLI that spent a little from one that spent nothing", () => {
    // The measured case from the issue: $662.05 against $0.01. The Codex
    // segment of the bar is a fraction of a pixel, so the percentage beside it
    // is the only thing that can answer the question the panel exists for — and
    // "0.0%" would answer it wrongly.
    expect(sharePct(0.01, 662.06)).toBe("<0.1%");
    expect(sharePct(0, 662.06)).toBe("0%");
    expect(sharePct(662.05, 662.06)).toBe("100.0%");
    expect(sharePct(1, 4)).toBe("25.0%");
    // A range that cost nothing has no shares in it rather than a division by
    // zero, and a range with no data at all is the same answer.
    expect(sharePct(1, 0)).toBe("0%");
    expect(sharePct(0, 0)).toBe("0%");
  });

  it("gives the two CLIs this deck watches colours that are not each other's", () => {
    expect(agentColor("claude")).not.toBe(agentColor("codex"));
    // Case is ccusage's to choose, not a second agent.
    expect(agentColor("Claude")).toBe(agentColor("claude"));
    // Everything unrecognised shares one colour, which is why the key prints
    // the name and the figure beside it rather than relying on the swatch.
    expect(agentColor("opencode")).toBe(agentColor("amp"));
  });

  it("names a CLI the way the product does, and title-cases the ones it cannot know", () => {
    expect(agentLabel("claude")).toBe("Claude Code");
    expect(agentLabel("codex")).toBe("Codex");
    expect(agentLabel("opencode")).toBe("OpenCode");
    // ccusage reads sixteen sources and grows; an id this build has never heard
    // of reads as a product name rather than as a raw token.
    expect(agentLabel("droid")).toBe("Droid");
    expect(agentLabel("")).toBe("");
  });

  it("ignores days with no agents rather than inventing an unnamed one", () => {
    // Otherwise a range half-answered by an old ccusage would put a figure on
    // screen that no CLI is responsible for.
    expect(agentTotals([{}, { agents: [] }])).toEqual([]);
    expect(agentTotals([{ agents: [{ agent: "codex", totalCost: 2, totalTokens: 9 }] }, {}]))
      .toEqual([{ id: "codex", cost: 2, tokens: 9 }]);
  });

  it("orders ties by id so nothing swaps places between renders", () => {
    const rows = agentTotals([{ agents: [
      { agent: "codex", totalCost: 0, totalTokens: 0 },
      { agent: "amp", totalCost: 0, totalTokens: 0 },
    ] }]);
    expect(rows.map(r => r.id)).toEqual(["amp", "codex"]);
  });
});

describe("the one selected day", () => {
  it("prices the CLIs it ran, which is what its header could not say before", () => {
    // The same merge one level down: `metadata.agents` gave the detail panel
    // "claude · codex" and no money, on the one surface whose whole job is
    // breaking a single day apart.
    // fmtCost's own rounding, not this function's: three figures above $100 and
    // "<1¢" below half a cent, which is the shape every other money on this
    // panel is printed in. It is the reason the percentage in the range strip
    // is worth its pixels — "$579 · <1¢" tells a reader which CLI is which but
    // not by how far.
    expect(dayAgentSummary(BOTH_DAY.agents)).toBe("Claude Code $579 · Codex <1¢");
  });

  it("says nothing at all for a day with one CLI in it", () => {
    // Its total is already printed two inches to the left; repeating it beside
    // a name would be new chrome on a machine with nothing to split.
    expect(dayAgentSummary(CLAUDE_ONLY_DAY.agents)).toBe(null);
    expect(dayAgentSummary(undefined)).toBe(null);
    expect(dayAgentSummary([])).toBe(null);
  });
});

describe("the subtitle that started this", () => {
  it("names what the run actually read, not a list written into the source", () => {
    // "via ccusage · local Claude / Codex logs" was a constant. It was wrong
    // twice: it merged the two CLIs it named, and it denied the fourteen others
    // ccusage reads.
    expect(usageSubtitle(ASSUMED, ["claude", "codex"]))
      .toBe("via ccusage · local Claude Code and Codex logs");
    expect(usageSubtitle(ASSUMED, ["claude"])).toBe("via ccusage · local Claude Code logs");
    expect(usageSubtitle(ASSUMED, ["claude", "codex", "opencode"]))
      .toBe("via ccusage · local Claude Code, Codex and OpenCode logs");
  });

  it("falls back to what this deck watches while there is nothing to measure", () => {
    // The first render, a run still going, a run that failed, an empty range,
    // and a ccusage too old to report the split — five states with no data, and
    // #402 put the answer for all of them in /api/health.
    const claudeOnly = readProviders({ providers: { claude: true, codex: false } });
    const codexOnly = readProviders({ providers: { claude: false, codex: true } });
    const neither = readProviders({ providers: { claude: false, codex: false } });

    expect(usageSubtitle(claudeOnly)).toBe("via ccusage · local Claude Code logs");
    expect(usageSubtitle(codexOnly)).toBe("via ccusage · local Codex logs");
    expect(usageSubtitle(ASSUMED)).toBe("via ccusage · local Claude Code and Codex logs");
    // `--no-claude --no-codex` is a legal pair of flags, and naming a CLI there
    // would be a claim about a panel that can only ever be empty.
    expect(usageSubtitle(neither)).toBe("via ccusage · local agent logs");
  });

  it("lets the data overrule the deck's own flags, because ccusage does", () => {
    // A deck started with --no-codex still gets Codex spend out of ccusage,
    // which reads the logs on the machine rather than this deck's arguments. A
    // subtitle that denied a CLI whose money is on screen would be the original
    // defect pointing the other way.
    const claudeOnly = readProviders({ providers: { claude: true, codex: false } });
    expect(usageSubtitle(claudeOnly, ["claude", "codex"]))
      .toBe("via ccusage · local Claude Code and Codex logs");
  });
});

// The only two cases that let the module's memory survive a whole test rather
// than one fetch — see freshCcusage for why every other case gets a module with
// no memory at all.
describe("what the deck remembers about a ccusage that refused the flag", () => {
  it("keeps asking after a failure that was never about the flag", async () => {
    // The retry is broad and the memory is narrow, because the two mistakes
    // cost different things: retrying needlessly costs one process on a machine
    // that is already failing, and remembering wrongly costs the split until the
    // deck is restarted. This failure names no flag, so nothing is concluded.
    runPlan.push({ stderr: "ccusage: EACCES /home/v/.claude", code: 1 }, { stdout: PLAIN_JSON, code: 0 });
    await quietly(() => fetchCcusageDaily({ since: "20260811" }));

    runPlan.push({ stdout: BY_AGENT_JSON, code: 0 });
    await fetchCcusageDaily({ since: "20260812" });

    expect(ranWith(2)).toContain("--by-agent");
  });

  it("stops asking once the CLI has named the flag as its objection", async () => {
    // Every parser quotes the option back — "Unknown option '--by-agent'",
    // "unrecognized option --by-agent", "Unknown argument: by-agent" — so the
    // flag's own name is the token they agree on, and no version table is
    // needed. After that, one process per fetch instead of two.
    runPlan.push(UNKNOWN_FLAG, { stdout: PLAIN_JSON, code: 0 });
    await quietly(() => fetchCcusageDaily({ since: "20260813" }));
    expect(calls).toHaveLength(2);

    calls.length = 0;
    await fetchCcusageDaily({ since: "20260814" });

    expect(calls).toHaveLength(1);
    expect(ranWith(0)).toEqual(["daily", "--json", "--since", "20260814"]);
  });
});
