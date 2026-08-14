// A finished sign-in leaves its "Account N added" card up, and the dialog stays
// mounted under it. The effect that told AccountsPanel to reload listed the
// panel's `onChanged` among its dependencies, and the panel mints that closure
// inline on every render — so the reload re-rendered the panel, the render
// handed down a new closure, the effect re-ran, and it reloaded again. One
// round trip per network turn until someone clicked Done, each turn enumerating
// the whole process table on the server (`ps -Ao args=`, or a PowerShell CIM
// query on Windows) behind /api/cswap-auto. These pin the rule that ends it:
// reaching "done" announces, being re-asked about "done" does not.
import { describe, it, expect } from "vitest";
import { createLoginAnnouncer } from "../login-announce";

/** Run the announcer the way the dialog's effect does, counting the reloads a
 *  given run of server states would ask AccountsPanel for. */
function reloads(states: (string | null | undefined)[]): number {
  const announcer = createLoginAnnouncer();
  let n = 0;
  for (const s of states) if (announcer.shouldAnnounce(s)) n++;
  return n;
}

describe("createLoginAnnouncer", () => {
  it("asks for a reload when the sign-in finishes", () => {
    const announcer = createLoginAnnouncer();
    expect(announcer.shouldAnnounce("done")).toBe(true);
  });

  it("does not ask again while the success card sits on the same finished sign-in", () => {
    // The bug, stated: the effect re-ran on every parent render and the old
    // rule — `state === "done"` — said yes to every one of them.
    const announcer = createLoginAnnouncer();
    expect(announcer.shouldAnnounce("done")).toBe(true);
    expect(announcer.shouldAnnounce("done")).toBe(false);
    expect(announcer.shouldAnnounce("done")).toBe(false);
  });

  it("costs one reload no matter how many renders the panel does behind the card", () => {
    expect(reloads(Array.from({ length: 500 }, () => "done"))).toBe(1);
  });

  it("stays silent through every step that leads up to the end", () => {
    const announcer = createLoginAnnouncer();
    expect(announcer.shouldAnnounce("awaiting_url")).toBe(false);
    expect(announcer.shouldAnnounce("awaiting_code")).toBe(false);
    expect(announcer.shouldAnnounce("registering")).toBe(false);
  });

  it("says nothing about a sign-in that ended without adding anything", () => {
    // Nothing reached the store, so there is no roster to re-read.
    expect(reloads(["failed", "failed"])).toBe(0);
    expect(reloads(["idle", "idle"])).toBe(0);
  });

  it("says nothing before a sign-in has been started", () => {
    // The dialog opens with no login at all, and the paste tab never gets one.
    expect(reloads([null, undefined, null])).toBe(0);
  });

  it("announces once per sign-in, so Try again still refreshes the roster", () => {
    // "Try again" clears the state and runs a second flow in the same dialog;
    // a latch that never re-armed would leave that account off the panel.
    expect(reloads(["awaiting_code", "done", "done", null, "awaiting_code", "done", "done"])).toBe(2);
  });

  it("counts one reload for one sign-in across a whole run of renders", () => {
    const states = [
      null, null,                                   // dialog open, nothing started
      "awaiting_url", "awaiting_url",
      "awaiting_code", "awaiting_code", "awaiting_code",
      "registering",
      ...Array.from({ length: 200 }, () => "done"), // the success card, re-rendering
    ];
    expect(reloads(states)).toBe(1);
  });

  it("keeps each dialog's latch to itself", () => {
    // One announcer per mounted dialog: opening a second one after the first
    // finished must not inherit a latch that is already spent.
    const first = createLoginAnnouncer();
    expect(first.shouldAnnounce("done")).toBe(true);
    expect(createLoginAnnouncer().shouldAnnounce("done")).toBe(true);
  });
});
