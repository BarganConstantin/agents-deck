// Which binary every account operation is sent to, and when that answer is
// allowed to change.
//
// `cswapBin()` is called on roughly twenty paths across cswap-admin.mjs,
// cswap-auto.mjs and claude-accounts.mjs — every add, switch, move, import,
// export, remove and poll. Each call would otherwise cost a `cswap --version`
// child process, so the answer is memoized; and because it is memoized, there
// has to be a way to invalidate it after an install, which is `resetCswapBin`.
// That pair is the contract this file pins, and it is the reason #383 kept the
// export instead of removing it as unused surface: `ensureCswap` is the only
// caller and its return value says nothing about which binary the twenty
// operations after it will be driven with.
//
// It also corrects the reading #383 was filed with. The call site's comment said
// the reset cleared a stale "not on PATH" answer; it never did — the not-found
// answer is returned without being cached, and the tests below say so. What it
// clears is a POSITIVE resolution that an install has since made wrong.
//
// Nothing is spawned and nothing on disk is read: `run` and `existsSync` both
// answer from the test. Plain node, no DOM.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const world = vi.hoisted(() => ({
  /** Every `run(cmd, args)` the module made, in order. */
  probes: [] as string[],
  /** Which command names `--version` succeeds for. */
  working: new Set<string>(),
  /** Which paths existsSync says are there. */
  present: new Set<string>(),
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    world.probes.push(cmd);
    const ok = args[0] === "--version" && world.working.has(cmd);
    return { ok, code: ok ? 0 : 1, killed: false, stdout: ok ? "claude-swap 0.25.0" : "", stderr: "" };
  },
  runDetached: () => {},
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, existsSync: (p: string) => world.present.has(p) };
});

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/cswap-install.mjs") as {
  cswapBin: () => Promise<string>;
  resetCswapBin: () => void;
  cswapCandidates: (platform?: string, env?: Record<string, string>, home?: string) => string[];
};
const { cswapBin, resetCswapBin, cswapCandidates } = mod;

const prevOverride = process.env.AGENTS_DECK_CSWAP;
beforeEach(() => {
  world.probes.length = 0;
  world.working.clear();
  world.present.clear();
  delete process.env.AGENTS_DECK_CSWAP;
  resetCswapBin();
});
afterAll(() => {
  if (prevOverride === undefined) delete process.env.AGENTS_DECK_CSWAP;
  else process.env.AGENTS_DECK_CSWAP = prevOverride;
});

describe("cswapBin remembers the binary it found", () => {
  it("probes once and answers from memory after that", () => {
    // Twenty account operations must not become twenty child processes. The
    // probe carries an 8s timeout, so the difference is not theoretical.
    world.working.add("cswap");
    return cswapBin()
      .then(first => {
        expect(first).toBe("cswap");
        expect(world.probes).toEqual(["cswap"]);
        return cswapBin();
      })
      .then(second => {
        expect(second).toBe("cswap");
        expect(world.probes).toEqual(["cswap"]);
      });
  });

  it("holds on to that answer even once the machine has changed under it", async () => {
    // The reason an explicit reset has to exist at all: nothing re-checks on its
    // own, so a resolution made at boot is the one used for the life of the
    // process unless somebody invalidates it.
    world.working.add("cswap");
    expect(await cswapBin()).toBe("cswap");
    world.working.delete("cswap");
    expect(await cswapBin()).toBe("cswap");
    expect(world.probes).toEqual(["cswap"]);
  });

  it("falls through PATH to the places uv and pipx actually install it", async () => {
    // The bare name is tried first because PATH is the cheap answer; ~/.local/bin
    // is famously not on it, which is the whole reason the candidate list exists.
    const candidate = cswapCandidates()[0];
    world.present.add(candidate);
    world.working.add(candidate);
    expect(await cswapBin()).toBe(candidate);
    expect(world.probes[0]).toBe("cswap");
    expect(world.probes).toContain(candidate);
  });
});

describe("what resetCswapBin actually clears", () => {
  it("makes the next call probe again after a resolution has been cached", async () => {
    // The contract ensureCswap depends on: install, reset, and the operations
    // that follow are sent to whatever is on the machine NOW.
    world.working.add("cswap");
    expect(await cswapBin()).toBe("cswap");
    expect(world.probes).toEqual(["cswap"]);

    resetCswapBin();

    // The install moved it: the bare name no longer answers, a real path does.
    const installed = cswapCandidates()[0];
    world.working.delete("cswap");
    world.present.add(installed);
    world.working.add(installed);
    expect(await cswapBin()).toBe(installed);
  });

  it("has no negative answer to clear, because a failed lookup is never cached", async () => {
    // #383 recorded this as clearing a stale "not on PATH" answer. It does not:
    // `cswapBin` returns the bare name on failure WITHOUT writing it to the
    // memo, so the next call re-probes whether or not anything reset it. Both
    // halves are asserted, since the useful fact is that the retry happens and
    // the reset is not what causes it.
    expect(await cswapBin()).toBe("cswap");
    const afterFirst = world.probes.length;
    expect(afterFirst).toBeGreaterThan(0);

    expect(await cswapBin()).toBe("cswap");
    expect(world.probes.length, "a failed lookup re-probes with no reset at all")
      .toBe(afterFirst * 2);

    resetCswapBin();
    expect(await cswapBin()).toBe("cswap");
    expect(world.probes.length, "and the reset changes nothing on this path")
      .toBe(afterFirst * 3);
  });

  it("leaves an install that appears between two lookups reachable", async () => {
    // The sequence ensureCswap runs when nothing was installed: look (nothing),
    // install, reset, look again. It has to find the new copy, and it does so
    // here through the retry rather than through the reset — which is worth
    // pinning, because it is what makes the reset safe to call unconditionally.
    expect(await cswapBin()).toBe("cswap");
    const installed = cswapCandidates()[0];
    world.present.add(installed);
    world.working.add(installed);
    resetCswapBin();
    expect(await cswapBin()).toBe(installed);
  });
});

describe("AGENTS_DECK_CSWAP outranks all of it", () => {
  it("is answered without a probe and is never cached", async () => {
    // Somebody debugging a bad resolution needs a change to take effect on the
    // next call, not after a restart — so the override is read every time and
    // never reaches the memo.
    process.env.AGENTS_DECK_CSWAP = "/opt/custom/cswap";
    expect(await cswapBin()).toBe("/opt/custom/cswap");
    process.env.AGENTS_DECK_CSWAP = "/opt/other/cswap";
    expect(await cswapBin()).toBe("/opt/other/cswap");
    expect(world.probes, "the override must not spawn a probe").toEqual([]);

    // And dropping it does not leave one of its values behind in the memo.
    delete process.env.AGENTS_DECK_CSWAP;
    world.working.add("cswap");
    expect(await cswapBin()).toBe("cswap");
  });
});
