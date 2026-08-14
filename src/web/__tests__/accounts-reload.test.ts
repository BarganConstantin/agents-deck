// The accounts panel's ↻ reloaded behind a poker face: no busy state, no
// completion signal, an empty catch and two `if (res.ok)` guards that dropped a
// refusal without a trace. A reload that failed looked exactly like one that
// came back with the same numbers, and the first load failing left "Checking…"
// on screen with no branch behind it — the panel's failure box renders inside
// the branch that needs a roster, so with no roster there was nowhere for the
// message to go.
//
// The rules for what a finished reload leaves on screen are pinned here, and
// the wiring that reaches them is read out of the component the way
// modal-dialog-role.test.ts reads its markup: the suite has no DOM, so the
// shape is what can be checked, and the shape is what the bug was.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RELOAD_UNREACHABLE,
  answered,
  explainReload,
  nextFailure,
} from "../accounts-reload";
import { COMMAND_REASONS } from "../admin-failure";

const ok = { ok: true, status: 200, body: null };

describe("what a finished reload says", () => {
  it("says nothing at all when both halves answered", () => {
    expect(explainReload([ok, ok])).toBeNull();
  });

  it("names the status when the refusal carried no words, which is all a 500 is", () => {
    // The handler threw; index.mjs answers { error: "internal error" } and the
    // panel has nothing to go on but the number.
    expect(explainReload([ok, { ok: false, status: 500, body: null }]))
      .toEqual({ text: "the deck server answered 500", reload: true });
  });

  it("speaks for the roster first, since the auto-switch strip is a footer on it", () => {
    const verdict = explainReload([
      { ok: false, status: 500, body: null },
      { ok: false, status: 503, body: null },
    ]);
    expect(verdict?.text).toBe("the deck server answered 500");
  });

  it("says a reason in the product's voice and keeps the tool's own words for the title", () => {
    const verdict = explainReload([
      { ok: false, status: 500, body: { reason: "no_cswap", detail: "Traceback (most recent call last):" } },
      ok,
    ]);
    expect(verdict?.text).toBe(COMMAND_REASONS.no_cswap);
    expect(verdict?.raw).toBe("Traceback (most recent call last):");
  });

  it("carries no title when the refusal printed nothing, so hovering promises nothing", () => {
    expect(explainReload([{ ok: false, status: 500, body: { reason: "timeout" } }, ok]))
      .toEqual({ text: COMMAND_REASONS.timeout, reload: true });
  });

  it("marks every message of its own as one a later reload may withdraw", () => {
    expect(explainReload([{ ok: false, status: 500, body: null }, ok])?.reload).toBe(true);
    expect(RELOAD_UNREACHABLE.reload).toBe(true);
  });
});

describe("reading a response the panel already took the data out of", () => {
  it("never touches a 200's body, which can only be read once", async () => {
    let reads = 0;
    const res = { ok: true, status: 200, json: async () => { reads++; return {}; } };
    expect(await answered(res)).toEqual({ ok: true, status: 200, body: null });
    expect(reads).toBe(0);
  });

  it("reads a refusal's body, since that is where the reason would be", async () => {
    const res = { ok: false, status: 500, json: async () => ({ reason: "no_cswap" }) };
    expect(await answered(res)).toEqual({ ok: false, status: 500, body: { reason: "no_cswap" } });
  });

  it("survives a refusal that is not JSON at all, such as a proxy's HTML", async () => {
    const res = { ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    expect(await answered(res)).toEqual({ ok: false, status: 502, body: null });
  });
});

describe("which message is left on screen", () => {
  const refused = { text: "claude-swap refused the switch", raw: "cswap: exit 1" };
  const unreachable = RELOAD_UNREACHABLE;

  it("withdraws its own message as soon as a reload lands", () => {
    expect(nextFailure(unreachable, null)).toBeNull();
  });

  it("leaves a refused switch alone, because the reload after one is not about it", () => {
    // doSwitch sets the message and then reloads; clearing on success would
    // delete the answer to the click that caused it.
    expect(nextFailure(refused, null)).toBe(refused);
  });

  it("hands back the same object while a poll keeps failing the same way", () => {
    // The box is role="alert". A fresh identity every 15 seconds re-announces
    // one sentence four times a minute.
    const again = { text: unreachable.text, reload: true } as const;
    expect(nextFailure(unreachable, again)).toBe(unreachable);
  });

  it("swaps the message when the reload starts failing a different way", () => {
    const server = { text: "the deck server answered 500", reload: true } as const;
    expect(nextFailure(unreachable, server)).toBe(server);
  });

  it("lets a failing reload take over from a refusal, since an unreachable deck outranks it", () => {
    expect(nextFailure(refused, unreachable)).toBe(unreachable);
  });
});

const web = fileURLToPath(new URL("..", import.meta.url));
const panel = readFileSync(`${web}components/AccountsPanel.tsx`, "utf8");

describe("the panel's reload path", () => {
  it("ends in a message or a clean slate whichever way the request went", () => {
    // One setFailure for the answered case, one for the thrown one. The empty
    // catch that swallowed everything is what this file exists for.
    expect(panel).toContain("setFailure(prev => nextFailure(prev, verdict));");
    expect(panel).toContain("setFailure(prev => nextFailure(prev, RELOAD_UNREACHABLE));");
    expect(panel).not.toMatch(/catch\s*\{\s*\/\*[^*]*\*\/\s*\}/);
  });

  it("bounds a reload that never answers, so nothing can wait on it forever", () => {
    expect(panel).toContain("const ctl = new AbortController();");
    expect(panel).toContain("window.setTimeout(() => ctl.abort(), RELOAD_TIMEOUT_MS)");
    expect(panel.match(/signal: ctl\.signal/g)).toHaveLength(2);
    expect(panel).toContain("window.clearTimeout(bell);");
  });

  it("waits longer than the server's own ceiling, so slow is never called dead", () => {
    // Both routes can spawn cswap, and exec.mjs kills a child at its default
    // timeout — a client bound under that would abort answers still coming.
    const exec = readFileSync(`${web}../server/exec.mjs`, "utf8");
    const serverMs = Number(/export function run\([\s\S]*?timeout = ([\d_]+)/.exec(exec)![1].replace(/_/g, ""));
    const clientMs = Number(/RELOAD_TIMEOUT_MS = ([\d_]+)/.exec(panel)![1].replace(/_/g, ""));
    expect(serverMs).toBeGreaterThan(0);
    expect(clientMs).toBeGreaterThanOrEqual(serverMs);
  });

  it("disables the ↻ and says so while a reload the user asked for is in flight", () => {
    expect(panel).toMatch(/className="btn ap-refresh"[\s\S]{0,200}disabled=\{reloading\}/);
    expect(panel).toContain('{reloading ? "…" : "↻"}');
    // Only the forced half: a poll blinking the button every 15 seconds would
    // read as the panel doing something to itself.
    expect(panel).toContain("if (force) setReloading(true);");
    expect(panel).toContain("if (force) setReloading(false);");
  });

  it("gives the empty state something to say and a way out of it", () => {
    expect(panel).toMatch(/data == null \? \(\s*failure \?/);
    expect(panel).toMatch(/<div className="ap-empty" role="alert">/);
    expect(panel).toMatch(/className="ap-fix" disabled=\{reloading\} onClick=\{\(\) => load\(true\)\}/);
  });
});
