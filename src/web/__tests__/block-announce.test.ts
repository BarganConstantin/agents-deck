// #372: the deck announced the one thing a screen reader should never hear and
// stayed silent on the one thing it should.
//
// The topbar's stat strip was `<span className="status" role="status">` wrapped
// around, among other numbers, `stateRef.current.totalEvents` — which
// reducer.ts increments once per hook event, so on a fan-out it moves tens of
// times a second. `role="status"` is `aria-live="polite"`, so every one of those
// increments queued an utterance; and — the half the issue got wrong in the
// direction of understating it — `role="status"` also carries an implicit
// `aria-atomic="true"` (ARIA 1.2), so the utterance was not the bare "1433" the
// report describes but the WHOLE strip re-read, "live 4 sessions 14 agents 1433
// events 4.21M tokens mcp $1164 cost", once per event. Either way it is
// continuous speech about nothing, which is how a page teaches its user to
// switch the screen reader off.
//
// The sessions, agents and events counters in that utterance were later removed
// from the strip outright. `totalEvents` still exists — reducer.ts increments it
// and group 4 below folds it through a real tool storm — it is simply no longer
// drawn. Nothing about the rule changes: what is left in the row still moves on
// its own, which is why the role stays off.
//
// The same deck said nothing at all when a session stopped on a permission
// prompt. That fact reached `document.title`, the favicon, the amber
// `.waiting-stat` chip and the card's own waiting row, and all four of those are
// things you have to look at.
//
// Three groups of cases here, and they are deliberately not restatements of one
// another:
//
//   1. the wording and the quietness, called directly as the pure functions the
//      app runs;
//   2. the wiring, read out of App.tsx as text, because a correct decision that
//      is never rendered into a live region is not a fix;
//   3. a transcript, folded over the REAL reducer — real hook payloads, real
//      `blockedSessions()`, real announcement functions — so the whole path from
//      "CC sent a Notification" to "a screen reader says a sentence" is pinned
//      end to end, and so is the path from "fifty tool events arrived" to
//      "nothing was said".
//
// Plain node, no jsdom, React cannot be rendered — which is the reason the
// decision lives in block-announce.ts at all, and the reason group 3 exists: it
// is the closest this suite can get to listening to the page.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALL_CLEAR, blockedAnnouncement, nextAnnouncement } from "../block-announce";
import { blockedSessions } from "../ambient-counts";
import {
  applyEvent,
  initialState,
  pruneOldAgents,
  sweepStaleSessions,
  type GraphState,
} from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A source file with its prose removed. The comments added by this fix quote
 *  the sentences, the role names and the markup they are explaining — that is
 *  what they are for — so every "appears nowhere" assertion below has to read
 *  the code only, the way display-name.test.ts and manage-block.test.ts do. */
const codeOf = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const app = read("../App.tsx");
const appCode = codeOf(app);

/** A blocked session as far as the wording is concerned. */
const at = (label: string) => ({ label });

// ── 1. what it says ─────────────────────────────────────────────────────────

describe("the sentence", () => {
  it("is empty when nothing is blocked, which is the resting state", () => {
    expect(blockedAnnouncement([])).toBe("");
  });

  it("names the session rather than counting to one", () => {
    // "1 session is waiting for your permission" makes the user go and find out
    // which. The name is the actionable half and it costs the same breath.
    expect(blockedAnnouncement([at("docs-site")])).toBe("docs-site is waiting for your permission.");
  });

  it("names the longest-blocked one and tallies the rest", () => {
    // `blockedSessions()` sorts oldest block first and the topbar chip's click
    // goes to that same session, so the announcement names the place the user is
    // about to be sent. Beyond the first they are counted: a live region is
    // heard serially and cannot be skimmed, so five labels in a row is five
    // seconds the user sits through to reach the number.
    expect(blockedAnnouncement([at("api"), at("web"), at("infra")]))
      .toBe("api and 2 more sessions are waiting for your permission.");
    expect(blockedAnnouncement([at("api"), at("web")]))
      .toBe("api and 1 more session are waiting for your permission.");
  });

  it("does not read out every label, however many are blocked", () => {
    const many = ["api", "web", "infra", "docs", "cli"].map(at);
    const said = blockedAnnouncement(many);
    expect(said).toContain("api");
    for (const label of ["web", "infra", "docs", "cli"]) expect(said).not.toContain(label);
  });

  it("says `permission`, because permission is the only kind counted", () => {
    // `blockedSessions()` filters on `isAlarming`, which is permission-only per
    // #348 — an idle block is a finished turn, not a stopped session. "waiting
    // for you" would claim the quieter kind is in the number when it is
    // deliberately not.
    expect(blockedAnnouncement([at("api")])).toContain("your permission");
    expect(blockedAnnouncement([at("api")])).not.toMatch(/waiting for you\b(?! r)/);
  });
});

// ── 2. when it says it, and when it says nothing ────────────────────────────

describe("the quietness", () => {
  it("says nothing on a deck that has never had a block", () => {
    expect(nextAnnouncement("", "")).toBe("");
  });

  it("speaks a block that has just begun", () => {
    expect(nextAnnouncement("", "api is waiting for your permission."))
      .toBe("api is waiting for your permission.");
  });

  it("returns the very same string when nothing changed — the whole mechanism", () => {
    // This is what makes the region silent rather than merely quiet. React bails
    // out of a state update to an identical string, so an unchanged announcement
    // does not re-render and therefore cannot re-announce. A version of this
    // that rebuilt an equal-but-fresh value every frame would speak on every
    // frame, which is exactly the defect being fixed one element to the left.
    const said = "api is waiting for your permission.";
    expect(nextAnnouncement(said, said)).toBe(said);
    expect(nextAnnouncement(ALL_CLEAR, "")).toBe(ALL_CLEAR);
  });

  it("retracts the claim when the last block clears", () => {
    // Not cosmetic. A block can clear with nobody having answered anything:
    // sweepStaleSessions reaps a session silent for ninety minutes and drops its
    // block (#350), and a subagent's own PostToolUse answers the prompt that
    // subagent raised (#361). What the eye sees in both cases is the amber chip
    // vanishing, which is a retraction only an eye gets.
    expect(nextAnnouncement("api is waiting for your permission.", "")).toBe(ALL_CLEAR);
  });

  it("stays on the all-clear rather than emptying the region", () => {
    // Clearing a live region to "" is a removal, and the default aria-relevant
    // is "additions text" — so emptying announces nothing in most screen readers
    // and is read out in some. Neither is wanted; the text simply stops moving.
    expect(nextAnnouncement(ALL_CLEAR, "")).toBe(ALL_CLEAR);
    expect(nextAnnouncement(nextAnnouncement(ALL_CLEAR, ""), "")).toBe(ALL_CLEAR);
  });

  it("speaks the SECOND block of the day, which is what the all-clear buys", () => {
    // The trap this whole design is shaped around. A live region only speaks
    // when its text changes, so without an explicit all-clear in between, the
    // region would hold "api is waiting…" through the quiet period and the next
    // identical block would write byte-identical text — a change of nothing, and
    // silence. The user would hear about the first block ever and none after it.
    const said = "api is waiting for your permission.";
    const afterFirst = nextAnnouncement("", said);
    const afterClear = nextAnnouncement(afterFirst, "");
    const afterSecond = nextAnnouncement(afterClear, said);
    expect(afterClear).not.toBe(afterFirst);
    expect(afterSecond).not.toBe(afterClear);
    expect(afterSecond).toBe(said);
  });

  it("speaks a swap that leaves the count alone", () => {
    // One session's block clears in the same render another's begins. A
    // count-shaped sentence goes 1 → 1 and says nothing, leaving the user
    // believing `api` is the one to go to when it is now `web`.
    const before = blockedAnnouncement([at("api")]);
    const after = blockedAnnouncement([at("web")]);
    expect(nextAnnouncement(before, after)).toBe(after);
    expect(after).not.toBe(before);
  });

  it("is idempotent, so a re-render cannot make it speak twice", () => {
    // React renders a component more than once for the same state — StrictMode
    // does it deliberately — and may throw a render away entirely. Feeding the
    // same pair back in has to be a no-op, or the extra pass is an extra
    // utterance.
    for (const [said, now] of [["", ""], ["", "api is waiting for your permission."],
                               ["api is waiting for your permission.", ""],
                               [ALL_CLEAR, ""]] as const) {
      const once = nextAnnouncement(said, now);
      expect(nextAnnouncement(once, now)).toBe(once);
    }
  });
});

// ── 3. what App.tsx actually renders ────────────────────────────────────────

describe("the stat strip is not a live region any more", () => {
  /** The opening tag of the element carrying `className="status"`. */
  const stripTag = /<span className="status"[^>]*>/.exec(appCode)?.[0];

  it("still renders the strip, so this file is not asserting over a deletion", () => {
    expect(stripTag, "the .status strip is gone from App.tsx entirely").toBeTruthy();
  });

  it("carries no role and no aria-live at all", () => {
    // The numbers stay exactly as readable as they were — the strip is
    // permanently on screen and a user can read it whenever they want one. What
    // it stops doing is reading itself out, unasked, once per hook event.
    expect(stripTag).not.toMatch(/\brole=/);
    expect(stripTag).not.toMatch(/\baria-live=/);
    expect(appCode).not.toContain(`<span className="status" role="status">`);
  });

  it("still holds a number that moves on its own, so the rule above is not vacuous", () => {
    // This case used to pin `{stateRef.current.totalEvents}` itself: the counter
    // was the evidence the strip was the wrong content for a live region, so a
    // "fix" that quietened the strip by moving the counter elsewhere would have
    // solved a different problem. The counter has since been removed from the
    // topbar entirely — a product call, not an accessibility one — and pinning a
    // deleted element would make this file a spec for something that no longer
    // exists.
    //
    // What has to survive is the half that is general: the strip is quiet
    // BECAUSE numbers that move constantly are the wrong content for a live
    // region, and that argument only means anything while the strip still holds
    // such a number. `totalTokens.sum` climbs on every event carrying usage, so
    // the assertion above stays a decision rather than an accident of an empty
    // row.
    expect(appCode).toContain(`<span className="count">{fmtTokens(totalTokens.sum)}</span>`);
  });
});

describe("the block is announced, and the region is always there to announce it", () => {
  it("renders a visually hidden polite region carrying the sentence", () => {
    expect(appCode).toContain(
      `<div className="vis-hidden" role="status" aria-atomic="true">{blockedSaid}</div>`,
    );
  });

  it("mounts it unconditionally, ahead of the chip that comes and goes", () => {
    // A screen reader registers a live region when it enters the accessibility
    // tree, and text that arrives in the same tick as the region is routinely
    // never announced. The chip is mounted only while something is blocked, so
    // wrapping THAT in role="status" — the fix the issue offers first — would
    // put the region and its first words on screen together, on the one
    // announcement that matters. It would also take the region away with the
    // chip, leaving nothing mounted to say the block had cleared.
    const region = appCode.indexOf(`<div className="vis-hidden" role="status"`);
    const guard = appCode.indexOf("{waitingSessions.length > 0 && (");
    expect(region).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(region, "the live region is inside the chip's conditional").toBeLessThan(guard);
  });

  it("leaves the chip itself a plain button, with no region of its own", () => {
    // The whole element, not just its opening tag: an arrow function in an
    // `onClick` carries a `>` of its own, so a regex ending at the first one
    // reads about a quarter of the attributes and passes for the rest.
    const opens = appCode.indexOf(`className="waiting-stat"`);
    expect(opens, "the waiting chip is gone from App.tsx").toBeGreaterThan(-1);
    const chip = appCode.slice(opens, appCode.indexOf("</button>", opens));
    expect(chip).not.toMatch(/\brole=/);
    expect(chip).not.toMatch(/\baria-live=/);
    // The name it already had is the one thing here that was right, and it stays.
    expect(chip).toMatch(/aria-label=/);
  });

  it("keeps role=alert for the connection banner and nothing else in the topbar", () => {
    // The one failure in this app that is genuinely interruption-grade: once the
    // stream is dead every number on the page is stale and the deck is quietly
    // lying, so an announcement deferred behind a long read is a user acting on
    // dead data. A blocked session is the other kind — it waits indefinitely, so
    // arriving one utterance later costs nothing, and assertive would talk over
    // the screen reader's own announcement of a page that replays an existing
    // block during mount.
    expect(appCode).toContain(`<div className="conn-banner" role="alert">`);
    expect(appCode).not.toMatch(/waiting[^\n]*role="alert"/);
    expect(appCode).not.toMatch(/role="alert"[^\n]*waiting/);
  });

  it("computes both halves through the shared module, not inline", () => {
    // The lesson #377 paid for: a rule spelled out inside a React component is
    // a rule this suite cannot call, and what cannot be called gets copied and
    // then drifts. Every case in group 1 above exercises the definition, so the
    // definition has to be the thing App.tsx runs.
    expect(appCode).toContain("blockedAnnouncement(waitingSessions)");
    expect(appCode).toContain("nextAnnouncement(said, blockedNow)");
    // And no second copy of the wording anywhere in the component.
    expect(appCode).not.toContain("waiting for your permission");
    expect(appCode).not.toContain("No sessions are waiting");
  });

  it("keys the effect on the sentence rather than on the session list", () => {
    // `waitingSessions` is rebuilt on every event by way of `lastSeq`, so a
    // list-shaped dependency re-runs this through every tool storm to discover
    // each time that nothing changed. A string dependency runs it only when the
    // words move.
    expect(appCode).toMatch(/setBlockedSaid\(said => nextAnnouncement\(said, blockedNow\)\);\s*\n\s*\}, \[blockedNow\]\);/);
  });
});

// ── 4. the transcript, through the real reducer ─────────────────────────────
//
// Nothing below restates a rule. Real hook payloads go into `applyEvent`, the
// resulting map goes into `blockedSessions()`, and the sentence that comes out
// is folded through `nextAnnouncement` exactly as the effect in App.tsx folds
// it — so what these cases collect is the list of things a screen reader would
// have said, in order, for a session that really happened.

const PERMISSION = { notification_type: "permission_prompt", message: "Claude needs your permission" };
const IDLE = { notification_type: "idle_prompt", message: "Claude is waiting for your input" };

let seq = 0;
function send(state: GraphState, session: string, payload: HookPayload, receivedAt?: number): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: receivedAt ?? 1_000 + seq,
    source: "hook",
    payload: { session_id: session, ...payload },
  };
  return applyEvent(state, env);
}

/**
 * A deck with a screen reader pointed at it.
 *
 * `said` is the text sitting in the live region, updated the way the effect
 * updates it; `heard` is every value it has actually CHANGED to, which is
 * precisely the set a screen reader speaks — a live region is silent on a write
 * that does not alter its text, and that equivalence is the thing making these
 * assertions meaningful rather than decorative.
 */
function deck() {
  let said = "";
  const heard: string[] = [];
  return {
    /** Read the board the way the render path reads it. */
    observe(state: GraphState) {
      const next = nextAnnouncement(said, blockedAnnouncement(blockedSessions(state.agents.values())));
      if (next !== said) heard.push(next);
      said = next;
    },
    get heard() { return heard; },
  };
}

describe("what a screen reader would have heard", () => {
  it("says nothing whatever through a tool storm, while the counter runs", () => {
    // The issue's headline claim, inverted and pinned. Fifty tool events move
    // `totalEvents` fifty times — that is the number the old live region read
    // the whole strip out for — and not one of them is worth a word.
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const d = deck();
    d.observe(state);

    const before = state.totalEvents;
    for (let i = 0; i < 25; i++) {
      state = send(state, "s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `t${i}` });
      state = send(state, "s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `t${i}` });
      d.observe(state);
    }
    expect(state.totalEvents - before, "the counter did not move, so this proves nothing").toBe(50);
    expect(d.heard).toEqual([]);
  });

  it("speaks once when a session blocks, and once when it is answered", () => {
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const d = deck();
    d.observe(state);

    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    d.observe(state);
    // Repeated frames while the block stands — the elapsed-time tick alone
    // re-renders this component once a second for as long as the deck is open.
    for (let i = 0; i < 10; i++) d.observe(state);

    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "yes" });
    d.observe(state);
    for (let i = 0; i < 10; i++) d.observe(state);

    expect(d.heard).toEqual(["api is waiting for your permission.", ALL_CLEAR]);
  });

  it("names the session the chip would take you to, and tallies the others", () => {
    // Three sessions block in turn. Each one is news — the count moved — and
    // each announcement names the oldest block, which is where `focusSession`
    // sends the click, so the words and the button agree about the destination.
    seq = 0;
    let state = initialState();
    for (const [id, cwd] of [["s1", "/srv/api"], ["s2", "/srv/web"], ["s3", "/srv/infra"]]) {
      state = send(state, id, { hook_event_name: "SessionStart", cwd });
      state = send(state, id, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    }
    const d = deck();
    d.observe(state);
    for (const id of ["s1", "s2", "s3"]) {
      state = send(state, id, { hook_event_name: "Notification", ...PERMISSION });
      d.observe(state);
    }
    expect(d.heard).toEqual([
      "api is waiting for your permission.",
      "api and 1 more session are waiting for your permission.",
      "api and 2 more sessions are waiting for your permission.",
    ]);
    expect(blockedSessions(state.agents.values())[0].label).toBe("api");
  });

  it("collapses simultaneous blocks into one sentence when they land in one frame", () => {
    // The render coalescer (coalesce.ts) merges a burst of SSE messages into a
    // single render, so a fan-out that blocks three sessions inside the 40ms
    // window is observed once. The announcement is a function of the board and
    // not of the deltas, so that frame produces one sentence carrying all three
    // rather than three sentences racing each other.
    seq = 0;
    let state = initialState();
    for (const [id, cwd] of [["s1", "/srv/api"], ["s2", "/srv/web"], ["s3", "/srv/infra"]]) {
      state = send(state, id, { hook_event_name: "SessionStart", cwd });
      state = send(state, id, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    }
    const d = deck();
    d.observe(state);
    for (const id of ["s1", "s2", "s3"]) {
      state = send(state, id, { hook_event_name: "Notification", ...PERMISSION });
    }
    d.observe(state);
    expect(d.heard).toEqual(["api and 2 more sessions are waiting for your permission."]);
  });

  it("says nothing at all about a session that merely ended its turn", () => {
    // #348: CC sends an idle_prompt about a minute after Stop on every session
    // nobody picks straight back up, and on the log that issue was measured
    // against those outnumbered permission prompts 16 to 5. Announcing them
    // would put three quarters noise into the one channel that has no way to be
    // skimmed past.
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    state = send(state, "s1", { hook_event_name: "Stop" }, 3_000);
    state = send(state, "s1", { hook_event_name: "Notification", ...IDLE }, 4_000);
    const d = deck();
    d.observe(state);
    expect(d.heard).toEqual([]);
    // And the block is still on the session — quietened, not discarded, so a fix
    // that silences idle by throwing it away fails here.
    expect(state.agents.get("s1")?.waiting?.kind).toBe("idle");
  });

  it("retracts a block a subagent answered, and only that one (#361)", () => {
    // A permission prompt the ROOT raised. Subagent-attributed traffic is not
    // evidence the human moved, so it must leave the block — and therefore the
    // sentence — exactly where it is; root-level traffic is.
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    state = send(state, "s1", { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    const d = deck();
    d.observe(state);
    expect(d.heard).toEqual(["api is waiting for your permission."]);

    state = send(state, "s1", { hook_event_name: "PostToolUse", agent_id: "sub-1", tool_name: "Read", tool_use_id: "t1" });
    d.observe(state);
    expect(d.heard, "a sibling's traffic retracted the alarm").toEqual([
      "api is waiting for your permission.",
    ]);

    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "yes" });
    d.observe(state);
    expect(d.heard).toEqual(["api is waiting for your permission.", ALL_CLEAR]);
  });

  it("retracts a block the stale sweep reaped, which nobody answered (#350)", () => {
    // Ninety minutes of silence and the session is settled with its block
    // dropped. Nothing the user did caused it, so nothing the user did tells
    // them about it — the chip simply stops being drawn. This is the case the
    // all-clear exists for.
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" }, 1_000);
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" }, 2_000);
    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION }, 3_000);
    const d = deck();
    d.observe(state);
    expect(d.heard).toEqual(["api is waiting for your permission."]);

    expect(sweepStaleSessions(state, 3_000 + 91 * 60_000, 90 * 60_000)).toBe(true);
    d.observe(state);
    expect(d.heard).toEqual(["api is waiting for your permission.", ALL_CLEAR]);
  });

  it("retracts a block whose session was evicted off the canvas", () => {
    // pruneOldAgents drops a finished agent out of the map outright, so a deck
    // that had announced a block and then lost the session would otherwise be
    // holding a sentence pointing at a card that is not there — and the chip's
    // click, which goes to the same session, has nowhere to land either.
    seq = 0;
    let state = initialState();
    for (const [id, cwd] of [["s1", "/srv/api"], ["s2", "/srv/web"]]) {
      state = send(state, id, { hook_event_name: "SessionStart", cwd });
      state = send(state, id, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      state = send(state, id, { hook_event_name: "Stop" }, 3_000);
      state = send(state, id, { hook_event_name: "Notification", ...PERMISSION }, 4_000);
    }
    const d = deck();
    d.observe(state);
    expect(d.heard).toEqual(["api and 1 more session are waiting for your permission."]);

    expect(pruneOldAgents(state, 1_000_000, 1, 0)).toBe(true);
    d.observe(state);
    expect(d.heard).toEqual([
      "api and 1 more session are waiting for your permission.",
      "web is waiting for your permission.",
    ]);
  });

  it("speaks every block of a long session, not only the first", () => {
    // The end-to-end version of the all-clear's mechanical job. Three identical
    // blocks on one session across a working afternoon: without the retraction
    // in between, blocks two and three write byte-identical text into the region
    // and are never spoken at all.
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/srv/api" });
    const d = deck();
    for (let i = 0; i < 3; i++) {
      state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
      state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
      d.observe(state);
      state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "yes" });
      d.observe(state);
    }
    expect(d.heard).toEqual([
      "api is waiting for your permission.", ALL_CLEAR,
      "api is waiting for your permission.", ALL_CLEAR,
      "api is waiting for your permission.", ALL_CLEAR,
    ]);
  });
});
