// A Claude session gets a human-readable name on its card. Claude Code
// writes two whole-line records into the transcript that nothing here used to
// read:
//
//   {"type":"ai-title","aiTitle":"Inspect repository to understand current state",…}
//   {"type":"agent-name","agentName":"account-management-oauth-flow",…}
//
// Everything below was checked against the two largest transcripts on the
// machine this was built on — 46.4 MB / 12,845 lines and 19.6 MB — and the
// numbers quoted in the comments are measured, not estimated.
//
// The parser is text-in on purpose. `scanTranscript` hands it whatever bytes
// were appended since the last pass, so the unit under test is "a chunk of
// transcript" and a chunk is a string; that keeps every case here to a few
// lines instead of a 46 MB fixture.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { readSessionNaming } from "../../server/index.mjs";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const TITLE = (t: string, sid = "s1") =>
  JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: sid });
const NAME = (n: string, sid = "s1") =>
  JSON.stringify({ type: "agent-name", agentName: n, sessionId: sid });

describe("readSessionNaming", () => {
  it("reads both records out of a chunk", () => {
    const text = [
      TITLE("Inspect repository to understand current state"),
      NAME("account-management-oauth-flow"),
    ].join("\n");
    expect(readSessionNaming(text)).toEqual({
      aiTitle: "Inspect repository to understand current state",
      agentName: "account-management-oauth-flow",
    });
  });

  // Both records are re-emitted about once per turn rather than only when they
  // change — 685 ai-title entries carrying 2 distinct values in the 46.4 MB
  // transcript. Last one wins is the whole rule.
  it("takes the newest of a repeated record, not the first", () => {
    const text = [
      TITLE("Check GitHub for open issues"),
      NAME("first-name"),
      TITLE("Inspect repository to understand current state"),
      NAME("account-management-oauth-flow"),
    ].join("\n");
    expect(readSessionNaming(text)).toEqual({
      aiTitle: "Inspect repository to understand current state",
      agentName: "account-management-oauth-flow",
    });
  });

  // The degradation the whole feature turns on. A young session, or a stretch
  // of transcript that is all tool output, yields nulls — never a placeholder,
  // never a guess. The client leaves the row off rather than printing "unknown".
  it("answers null for a chunk carrying neither record", () => {
    const text = [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7" } }),
      JSON.stringify({ type: "user", message: { role: "user" } }),
    ].join("\n");
    expect(readSessionNaming(text)).toEqual({ aiTitle: null, agentName: null });
  });

  it("answers null for empty, whitespace and non-string input", () => {
    for (const bad of ["", "\n\n", null, undefined, 42, {}]) {
      expect(readSessionNaming(bad as unknown as string))
        .toEqual({ aiTitle: null, agentName: null });
    }
  });

  // A cursor read hands over whole lines, but a truncated one is cheap to
  // survive and expensive to get wrong: a half-written record must not be
  // guessed at from the fragment that did arrive.
  it("ignores a truncated record rather than half-parsing it", () => {
    const whole = NAME("account-management-oauth-flow");
    const text = [TITLE("A real title"), whole.slice(0, whole.length - 12)].join("\n");
    expect(readSessionNaming(text)).toEqual({ aiTitle: "A real title", agentName: null });
  });

  // The marker strings appear in ordinary prose too — this very file contains
  // both. Matching the substring is only the cheap gate; `type` decides.
  it("does not take a name from a line that merely mentions the marker", () => {
    const text = [
      JSON.stringify({ type: "user", message: { content: 'the "agent-name" record' } }),
      JSON.stringify({ type: "assistant", message: { content: 'an "ai-title" line' } }),
    ].join("\n");
    expect(readSessionNaming(text)).toEqual({ aiTitle: null, agentName: null });
  });

  it("skips a record whose value is empty or the wrong type", () => {
    const text = [
      JSON.stringify({ type: "agent-name", agentName: "", sessionId: "s1" }),
      JSON.stringify({ type: "ai-title", aiTitle: null, sessionId: "s1" }),
      JSON.stringify({ type: "ai-title", aiTitle: { a: 1 }, sessionId: "s1" }),
    ].join("\n");
    expect(readSessionNaming(text)).toEqual({ aiTitle: null, agentName: null });
  });

  // A Codex rollout carries neither record, which is the reason the card has to
  // degrade rather than render an empty slot.
  it("finds nothing in a Codex rollout line", () => {
    const text = JSON.stringify({
      timestamp: "2026-08-19T10:00:00Z",
      type: "turn_context",
      payload: { cwd: "/repo", approval_policy: "never", model: "gpt-5.3-codex" },
    });
    expect(readSessionNaming(text)).toEqual({ aiTitle: null, agentName: null });
  });
});

// ── The reducer half ─────────────────────────────────────────────────────────

const SESSION = "sess-name";
let seq = 0;
const envelope = (payload: HookPayload): HookEnvelope =>
  ({ seq: ++seq, receivedAt: Date.now(), source: "hook", payload });

/** A state holding one root agent for SESSION. */
function rooted() {
  return applyEvent(initialState(), envelope({
    hook_event_name: "SessionStart", session_id: SESSION, cwd: "/repo/vcrm-core",
  }));
}

describe("SessionNamed", () => {
  it("stamps the name and the title on the session root", () => {
    const s = applyEvent(rooted(), envelope({
      hook_event_name: "SessionNamed",
      session_id: SESSION,
      sessionName: "account-management-oauth-flow",
      sessionTitle: "Inspect repository to understand current state",
    }));
    const root = s.agents.get(SESSION)!;
    expect(root.sessionName).toBe("account-management-oauth-flow");
    expect(root.sessionTitle).toBe("Inspect repository to understand current state");
  });

  // The label is the workspace basename and the id is the address; neither is
  // the name's to take. A name that rewrites itself cannot become the thing the
  // user navigates by.
  it("leaves the label and the session id alone", () => {
    const s = applyEvent(rooted(), envelope({
      hook_event_name: "SessionNamed", session_id: SESSION, sessionName: "some-new-name",
    }));
    const root = s.agents.get(SESSION)!;
    expect(root.label).toBe("vcrm-core");
    expect(root.sessionId).toBe(SESSION);
    expect(root.id).toBe(SESSION);
  });

  // CC overwrites aiTitle with the slug once a session has a name: 353 of the
  // 685 title records in the 46.4 MB transcript are byte-identical to its
  // agentName. Keeping both would print the card back to the user as its own
  // tooltip, which reads as a bug rather than as information.
  it("drops a title that only repeats the name", () => {
    const s = applyEvent(rooted(), envelope({
      hook_event_name: "SessionNamed",
      session_id: SESSION,
      sessionName: "account-management-oauth-flow",
      sessionTitle: "account-management-oauth-flow",
    }));
    const root = s.agents.get(SESSION)!;
    expect(root.sessionName).toBe("account-management-oauth-flow");
    expect(root.sessionTitle).toBeUndefined();
  });

  it("drops a repeat that differs only by case or padding", () => {
    const s = applyEvent(rooted(), envelope({
      hook_event_name: "SessionNamed",
      session_id: SESSION,
      sessionName: "Account-Management",
      sessionTitle: "  account-management  ",
    }));
    expect(s.agents.get(SESSION)!.sessionTitle).toBeUndefined();
  });

  // Additive, exactly like ContextObserved: two records feed this and the scan
  // reports whichever it has. A pass carrying only the title must not wipe a
  // name the card is already showing.
  it("keeps a name that a later title-only pass says nothing about", () => {
    let s = applyEvent(rooted(), envelope({
      hook_event_name: "SessionNamed", session_id: SESSION, sessionName: "keep-me",
    }));
    s = applyEvent(s, envelope({
      hook_event_name: "SessionNamed", session_id: SESSION, sessionTitle: "A later sentence",
      sessionName: null,
    }));
    const root = s.agents.get(SESSION)!;
    expect(root.sessionName).toBe("keep-me");
    expect(root.sessionTitle).toBe("A later sentence");
  });

  it("takes a rename, since the newest record is the current one", () => {
    let s = applyEvent(rooted(), envelope({
      hook_event_name: "SessionNamed", session_id: SESSION, sessionName: "old-name",
    }));
    s = applyEvent(s, envelope({
      hook_event_name: "SessionNamed", session_id: SESSION, sessionName: "new-name",
    }));
    expect(s.agents.get(SESSION)!.sessionName).toBe("new-name");
  });

  // A Codex session never produces the event at all, so its root keeps both
  // fields undefined and AgentNode renders neither the row nor a placeholder.
  it("leaves a session that was never named with no name at all", () => {
    const root = rooted().agents.get(SESSION)!;
    expect(root.sessionName).toBeUndefined();
    expect(root.sessionTitle).toBeUndefined();
  });

  it("ignores a name for a session it does not know", () => {
    const s = applyEvent(rooted(), envelope({
      hook_event_name: "SessionNamed", session_id: "who-is-this", sessionName: "ghost",
    }));
    expect(s.agents.get("who-is-this")).toBeUndefined();
    expect(s.agents.get(SESSION)!.sessionName).toBeUndefined();
  });

  // The event comes off the transcript cursor, not off session traffic. The
  // three *Observed scans are already in WAITING_KEEPERS for this reason: a
  // session parked on a permission prompt is exactly when the deck has the
  // quiet to notice its name, and clearing the badge there would drop the alarm
  // a second or two after it was raised.
  it("does not clear a waiting block, being a scan and not session movement", () => {
    let s = applyEvent(rooted(), envelope({
      hook_event_name: "Notification", session_id: SESSION,
      notification_type: "permission_prompt", message: "Claude needs your permission",
    }));
    expect(s.agents.get(SESSION)!.waiting).toBeTruthy();
    s = applyEvent(s, envelope({
      hook_event_name: "SessionNamed", session_id: SESSION, sessionName: "named-while-blocked",
    }));
    const root = s.agents.get(SESSION)!;
    expect(root.waiting).toBeTruthy();
    expect(root.sessionName).toBe("named-while-blocked");
  });
});
