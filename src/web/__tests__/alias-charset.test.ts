// `setAlias` was the one admin argument with no charset rule.
//
// Everything else the accounts panel sends to cswap is an integer bounded to
// 1..999. The alias got `.trim()` and nothing more, so quotes, `%`, `&` and
// interior newlines all survived into `run(cswapBin(), ["alias", n, clean])`.
//
// On POSIX that is harmless — `run` spawns the vector untouched and nothing
// parses it. On Windows cswap is a `.cmd` shim, so the vector goes through
// `cmd.exe /d /s /c` (see viaCmd), and quote-doubling covers every metacharacter
// EXCEPT one: cmd.exe expands `%VAR%` inside quotes and a command line has no
// escape for it. So `%USERPROFILE%` stored the user's home path in the alias,
// and an unbalanced quote plus an `&` could end the quoted region early. The
// unbounded length was the other half — an alias is a short name shown instead
// of an email.
//
// The rule is the one cswap-auto.mjs already applies to its model list. These
// pin it, pin that a rejected alias never reaches a subprocess at all, and pin
// the ordinary names that must keep working.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Same recorder as cswap-export-secret-leak.test.ts: `run` is replaced, the rest
// of exec.mjs stays real. What matters here is whether it is called.
const { nextRun, calls } = vi.hoisted(() => ({
  nextRun: { value: null as unknown },
  calls: [] as { cmd: string; args: string[] }[],
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return Promise.resolve(nextRun.value);
    },
  };
});

const prevBin = process.env.AGENTS_DECK_CSWAP;
process.env.AGENTS_DECK_CSWAP = "cswap-under-test";
afterAll(() => {
  if (prevBin === undefined) delete process.env.AGENTS_DECK_CSWAP;
  else process.env.AGENTS_DECK_CSWAP = prevBin;
});

// @ts-expect-error — plain JS module, no types
const { setAlias } = await import("../../server/cswap-admin.mjs");

const OK_RUN = { ok: true, code: 0, killed: false, timedOut: false, stdout: "ok", stderr: "" };

beforeEach(() => { calls.length = 0; nextRun.value = OK_RUN; });

describe("setAlias", () => {
  it("refuses a value that would be read by cmd.exe rather than stored", async () => {
    const hostile = [
      "%USERNAME%",                 // expands inside quotes; no escape exists
      "%USERPROFILE%\nfoo",         // …and an interior newline `.trim()` never saw
      'work" & calc.exe & "',       // an unbalanced quote plus a command separator
      "a\nb",
      "a\rb",
      "back`tick`",
      "$(id)",
      "semi;colon",
      "pipe|it",
      "x".repeat(65),               // the unbounded-length half
    ];
    for (const alias of hostile) {
      expect(await setAlias(1, alias), alias).toEqual({ ok: false, reason: "bad_value" });
    }
    // And none of them reached a subprocess: the refusal is before the spawn,
    // not a matter of how the spawn quotes.
    expect(calls).toHaveLength(0);
  });

  it("keeps the names people actually use", async () => {
    for (const alias of ["work", "day job", "acme_corp", "acme-corp", "v2.prod", "Ana 42"]) {
      expect(await setAlias(1, alias), alias).toEqual({ ok: true, output: "ok" });
    }
    expect(calls.map(c => c.args[2])).toEqual(["work", "day job", "acme_corp", "acme-corp", "v2.prod", "Ana 42"]);
    expect(calls.every(c => c.cmd === "cswap-under-test" && c.args[0] === "alias")).toBe(true);
  });

  it("still clears an alias, which is an empty value rather than a bad one", async () => {
    expect(await setAlias(3, "")).toEqual({ ok: true, output: "ok" });
    expect(await setAlias(3, "   ")).toEqual({ ok: true, output: "ok" });
    expect(await setAlias(3, null)).toEqual({ ok: true, output: "ok" });
    expect(calls.every(c => c.args[2] === "--unset")).toBe(true);
  });

  it("trims before it judges, so a padded ordinary name is not refused", async () => {
    expect(await setAlias(1, "  work  ")).toEqual({ ok: true, output: "ok" });
    expect(calls[0].args[2]).toBe("work");
  });

  it("checks the account number first, as every other admin call does", async () => {
    expect(await setAlias(0, "work")).toEqual({ ok: false, reason: "bad_account" });
    expect(await setAlias(1000, "work")).toEqual({ ok: false, reason: "bad_account" });
    expect(calls).toHaveLength(0);
  });
});
