// #338: a deck in a background tab said nothing at all.
//
// index.html's <title> is static markup and `document.title` was assigned
// nowhere in src/web/, so the tab strip — the one surface of this deck that is
// on screen while the deck is not — read identically whether five sessions were
// blocked on a permission prompt or nothing had moved since lunch.
//
// Three things are pinned here, and only one of them is the arithmetic.
//
// The first is the ORDER of the title. `(2) ccdeck` and `ccdeck (2)` differ by
// nothing a reviewer would defend and by everything a user sees: browsers
// truncate a tab title from the end, so the appended form is clipped away at
// exactly the widths a deck is read at. It looks like a mistake, which means
// somebody will eventually fix it — so the count is asserted at index 0 rather
// than merely present, and that fix fails here.
//
// The second is that the ICON IS DRAWN. It was a `<text>◉</text>` font glyph,
// which is a shape borrowed from whatever font the machine happened to resolve:
// three weights on the three platforms, and a tofu box wherever U+25C9 is
// missing. Decoration can survive that. State cannot — three states that all
// render as the same box are one state. So the markup is asserted to contain
// circles and no text, and the three fills are asserted to clear 3:1 against
// both a white tab strip and a #1f1f1f one, since the page has no way to ask
// which it is on.
//
// The third is that neither write happens on a frame that changed nothing. The
// effect sits on the SSE path, where `running` churns constantly under a title
// that is not moving.
//
// The fourth is WHAT COUNTS, which is the one this file got wrong. #348
// narrowed the alarm to `permission` blocks and left `idle` out of it; this
// file kept its own hand-written copy of the old expression and was not touched
// by that commit, so from #348 until #377 the suite asserted the superseded
// counting as correct behaviour — a green test standing over exactly the
// regression it was written to catch. The copy is gone: the counting cases
// below call ambient-counts.ts, which is the same module App.tsx and
// SessionList.tsx count with, so there is nothing left here that can drift from
// what ships.
//
// Plain node, no DOM — so this tests the pure functions, reads the two source
// files as text, and drives the reducer directly for the counting.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ambientSignal, FAVICON_HREF, type AmbientIcon } from "../ambient";
import { blockedSessions, runningSessionCount } from "../ambient-counts";
import { PRODUCT } from "../brand";
import { applyEvent, initialState, pruneOldAgents } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A source file with its prose removed, the way display-name.test.ts does it.
 *  The comments in ambient.ts quote the exact title format, which is the point
 *  of them being there — only the code may not spell the name out. */
const codeOf = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

describe("the title", () => {
  it("is exactly the product name when nothing is waiting", () => {
    // Not `(0) ccdeck`. Zero is the resting state and a badge that reports
    // nothing is wrong is a badge that stops being read at (1) as well.
    const title = ambientSignal({ waiting: 0, running: 0 }).title;
    expect(title).toBe(PRODUCT);
    expect(title).not.toContain("(");
    expect(title).toBe(title.trim());
  });

  it("stays exactly the product name while work is running", () => {
    // Running is not a thing to interrupt someone about. It gets the icon and
    // nothing else — a title that moves on every subagent is a title nobody
    // reads by the time it matters.
    expect(ambientSignal({ waiting: 0, running: 4 }).title).toBe(PRODUCT);
  });

  it("leads with the count, which is the entire point of the format", () => {
    // indexOf 0, not toContain: `ccdeck (2)` passes a containment check and
    // fails the user, because the tab it has to be legible in is a few
    // characters wide and browsers cut from the END.
    for (const waiting of [1, 7]) {
      const title = ambientSignal({ waiting, running: 0 }).title;
      expect(title).toBe(`(${waiting}) ${PRODUCT}`);
      expect(title.indexOf(`(${waiting})`)).toBe(0);
      expect(title.startsWith(PRODUCT)).toBe(false);
    }
  });

  it("names the deck with PRODUCT rather than a literal of its own", () => {
    // Asserted against the imported constant on purpose: a rename that reaches
    // brand.ts has to reach the tab, and a hardcoded "ccdeck" in ambient.ts
    // would keep this test green through exactly the drift it exists to catch
    // — so the source is checked too, with the prose stripped out, since the
    // comments there quote the format and are meant to.
    expect(ambientSignal({ waiting: 3, running: 0 }).title).toContain(PRODUCT);
    expect(codeOf(read("../ambient.ts"))).not.toContain(PRODUCT);
  });

  it("goes back to plain when the last block clears", () => {
    // The classic failure of this feature is a count that only ever goes up.
    expect(ambientSignal({ waiting: 1, running: 2 }).title).toBe(`(1) ${PRODUCT}`);
    expect(ambientSignal({ waiting: 0, running: 2 }).title).toBe(PRODUCT);
    expect(ambientSignal({ waiting: 0, running: 0 }).title).toBe(PRODUCT);
  });
});

describe("which icon wins", () => {
  it("is amber whenever anything is blocked, however much else is working", () => {
    // The tab strip is an alarm surface, not a status report: the four running
    // sessions will finish by themselves and the blocked one will not.
    expect(ambientSignal({ waiting: 1, running: 4 }).icon).toBe("waiting");
    expect(ambientSignal({ waiting: 9, running: 0 }).icon).toBe("waiting");
  });

  it("is blue when work is moving and nothing needs a human", () => {
    expect(ambientSignal({ waiting: 0, running: 1 }).icon).toBe("running");
  });

  it("is grey when there is nothing to say", () => {
    expect(ambientSignal({ waiting: 0, running: 0 }).icon).toBe("idle");
  });

  it("leaves the alarm the moment the block does", () => {
    expect(ambientSignal({ waiting: 2, running: 3 }).icon).toBe("waiting");
    expect(ambientSignal({ waiting: 0, running: 3 }).icon).toBe("running");
    expect(ambientSignal({ waiting: 0, running: 0 }).icon).toBe("idle");
  });
});

// ── the mark itself ─────────────────────────────────────────────────────────

const STATES: AmbientIcon[] = ["waiting", "running", "idle"];
const PREFIX = "data:image/svg+xml,";

/** The SVG a browser will actually parse out of the href. */
function svgFor(icon: AmbientIcon): string {
  const href = FAVICON_HREF[icon];
  expect(href.startsWith(PREFIX), `${icon} is not an SVG data URI`).toBe(true);
  return decodeURIComponent(href.slice(PREFIX.length));
}

/** The fills the browser ends up painting, in document order. */
function fillsOf(svg: string): string[] {
  return [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/gi)].map(m => m[1].toLowerCase());
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const n = parseInt(hex.slice(i, i + 2), 16) / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("the favicon", () => {
  it("is drawn, not typed — no font decides the shape on any platform", () => {
    // A `<text>` element hands the mark to whatever font the OS resolves, which
    // is a different weight per platform and a tofu box where the codepoint is
    // missing. Three states rendered as the same box are one state.
    for (const icon of STATES) {
      const svg = svgFor(icon);
      expect(svg, `${icon} still draws with a glyph`).not.toMatch(/<text|font-|◉/);
      expect(svg.match(/<circle/g) ?? [], `${icon} draws nothing`).not.toHaveLength(0);
    }
  });

  it("gives each state its own silhouette, not just its own colour", () => {
    // Colour alone cannot carry this. Clearing 3:1 on a white strip caps a
    // fill's luminance at 0.300 and clearing it on a #1f1f1f one floors it at
    // 0.141, so every fill the icon is allowed to use sits in a band 1.83:1
    // wide end to end — brightness is out, which leaves hue, which is what a
    // dichromat viewer does not receive. Simulated, the three collapse to
    // within 1.25:1, and under protanopia the amber and the grey reach 1.01:1:
    // the alarm and the resting state as one mark. The shape is what survives,
    // so it is the shape this pins. Stripped of colour the three must still be
    // three different documents, and the ink must rise from idle to waiting.
    const geometry = STATES.map(icon => svgFor(icon).replace(/(?:fill|stroke)="#[0-9a-f]{6}"/gi, ""));
    expect(new Set(geometry).size, "two states are the same drawing").toBe(3);

    const [waiting, running, idle] = STATES.map(icon => svgFor(icon));
    expect(waiting, "waiting is not the solid one").toMatch(/<circle[^>]*r="14\.5"[^>]*fill="#/);
    expect(waiting.match(/<circle/g)!, "waiting should be one filled disc").toHaveLength(1);
    expect(running.match(/<circle/g)!, "running should be a ring around a dot").toHaveLength(2);
    expect(idle.match(/<circle/g)!, "idle should be a bare ring").toHaveLength(1);
    expect(idle, "idle's ring is filled in, so it cannot read as the empty state")
      .toMatch(/fill="none"/);
  });

  it("percent-encodes the hex fills, which are fragment delimiters raw", () => {
    // `#` unescaped ends the data URI mid-attribute. The browser gets a
    // truncated document, fails to parse it, and silently keeps the icon it
    // already had — a state change lost with nothing logged.
    for (const icon of STATES) {
      expect(FAVICON_HREF[icon], `${icon} would be cut at its first fill`).not.toContain("#");
      expect(FAVICON_HREF[icon]).toContain("%23");
    }
  });

  it("never animates", () => {
    // A pulsing favicon re-parses and re-rasterises a data URI for the life of
    // the tab, and is the most hated pattern in this genre.
    for (const icon of STATES) {
      expect(svgFor(icon)).not.toMatch(/<animate|animation|keyframes|dur=/i);
    }
  });

  it("says one state per icon, in one colour", () => {
    // Ring and dot share a fill: the mark reads as one object at 16px, and a
    // two-tone icon would have to know which tab strip it is on to pick the
    // second tone.
    for (const icon of STATES) {
      expect(new Set(fillsOf(svgFor(icon))).size, `${icon} is more than one colour`).toBe(1);
    }
  });

  it("uses a different colour for each of the three states", () => {
    const fills = STATES.map(icon => fillsOf(svgFor(icon))[0]);
    expect(new Set(fills).size).toBe(3);
  });

  it("reads on a white tab strip and on a #1f1f1f one alike", () => {
    // The page cannot ask what colour the tab strip is — there is no media
    // query and no API for browser chrome — so every fill has to clear 1.4.11's
    // 3:1 against both extremes rather than against the theme the deck is in.
    for (const icon of STATES) {
      const fill = fillsOf(svgFor(icon))[0];
      expect(contrastRatio(fill, "#ffffff"), `${icon} (${fill}) vanishes on a light strip`)
        .toBeGreaterThanOrEqual(3);
      expect(contrastRatio(fill, "#1f1f1f"), `${icon} (${fill}) vanishes on a dark strip`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the boot icon in index.html identical to the idle mark", () => {
    // index.html is parsed before any module runs, so this href cannot be
    // derived and is the second copy of the drawn mark. Drift means the tab
    // changes shape between the first frame and the second.
    expect(read("../index.html")).toContain(`href="${FAVICON_HREF.idle}"`);
  });

  it("hangs on exactly one link[rel=\"icon\"], which is the whole feature's handle", () => {
    // #378: the href was pinned and the SELECTOR was not, and the selector is
    // what the feature is. App.tsx reaches the element with
    // `document.querySelector('link[rel="icon"]')`, which is an exact attribute
    // match — so `rel="shortcut icon"`, the spelling half the web still uses,
    // returns null. Measured: renaming it that way left all 1849 tests green
    // while the icon stopped changing state for the life of the tab, with
    // nothing logged and nothing to notice, which is the entire #338 signal on
    // a background tab.
    //
    // Two ways to lose it, so two assertions. A second `rel="icon"` link added
    // above this one — a PNG for an old browser is the usual reason — is not
    // null but the WRONG node: querySelector returns the first in document
    // order and the deck would spend the session rewriting an href nothing
    // paints. Hence exactly one.
    const links = [...read("../index.html").matchAll(/<link\b[^>]*>/g)].map(m => m[0]);
    const icons = links.filter(tag => /\brel\s*=\s*"[^"]*\bicon\b[^"]*"/.test(tag));
    expect(icons, "index.html no longer declares exactly one icon link").toHaveLength(1);
    expect(icons[0], 'rel is not exactly "icon", so link[rel="icon"] misses it')
      .toMatch(/\brel="icon"/);
    expect(icons[0], "the boot icon is not the idle mark").toContain(`href="${FAVICON_HREF.idle}"`);
    // And the other end of the same fact: the selector App.tsx actually runs.
    // Matched loosely on everything but the selector string itself, which is
    // the only part of the line that has to be exact.
    expect(read("../App.tsx"), "App.tsx stopped asking for the element index.html declares")
      .toMatch(/querySelector<HTMLLinkElement>\(\s*'link\[rel="icon"\]'\s*\)/);
  });
});

describe("what App.tsx does with it", () => {
  const app = read("../App.tsx");

  it("compares before it writes, on both surfaces", () => {
    // The effect recomputes on every SSE frame and both counts churn under a
    // title that is standing still — a subagent spawning moves `running` on a
    // deck whose title is plain and whose icon is already blue. Assigning an
    // identical title is a write the browser answers by re-rendering the tab.
    //
    // Matched as a pattern rather than as a line of source (#378). The old form
    // was the exact 62 characters including the trailing semicolon, so wrapping
    // the body in braces — which changes nothing a user or a browser can see —
    // failed it, and a test that fails on a reformat is a test somebody deletes
    // the next time it does. What has to hold is the comparison guarding the
    // write, and that is what this now says: remove either guard and the
    // assignment no longer sits behind a `!==` on its own previous value.
    expect(app, "the tab title is written without comparing it first")
      .toMatch(/if\s*\(\s*prev\?\.title\s*!==\s*next\.title\s*\)\s*\{?\s*document\.title\s*=\s*next\.title\s*;/);
    expect(app, "the favicon href is rewritten without comparing the state first")
      .toMatch(/if\s*\(\s*prev\?\.icon\s*!==\s*next\.icon\s*\)\s*\{/);
  });

  it("counts through the shared module rather than spelling the rule out again", () => {
    // Not style policing. The rule was inline here once, a copy of it was
    // inline in SessionList.tsx and a third copy was inline in THIS file, and
    // #348 reached two of the three — which is how the suite ended up
    // certifying the counting it was supposed to forbid. One call site per
    // surface, one definition, and the cases below exercise the definition.
    expect(app, "App.tsx counts blocked sessions inline again")
      .toContain("blockedSessions(stateRef.current.agents.values())");
    expect(app, "App.tsx counts running sessions inline again")
      .toContain("runningSessionCount(stateRef.current.agents.values())");
    // The counts are derived per frame from the map the canvas draws from.
    // pruneOldAgents evicts agents outright, so a tally maintained alongside it
    // would outlive the thing it was counting; the eviction case below proves
    // the behaviour, and this keeps a tally from creeping back in beside it.
    expect(app).not.toMatch(/set(Waiting|Running)Count/);
  });
});

// ── the counts, driven through the reducer ──────────────────────────────────
//
// The two numbers the signal is given come from the agents map, and the map is
// the thing that forgets. These cases are the edges #338 named — an evicted
// session must not leave a phantom in the title, and a replay must land on the
// truth rather than on the sum of what it replayed — plus the one #348 added,
// which is that only a permission block is an alarm at all.
//
// Real hook payloads through the real reducer into the real counters, so the
// whole path from "CC sent a notification" to "the tab says (1) ccdeck" is
// pinned end to end and no step of it is a restatement of another step.

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

/** What App.tsx's two memos compute — by calling them, not by restating them.
 *
 *  This used to be a hand-written loop under the comment "exactly what App.tsx's
 *  two memos compute", and the comment was true when it was written and false
 *  ten commits later: #348 narrowed the alarm to permission blocks in App.tsx
 *  and SessionList.tsx, and a mirror nobody knew to update went on counting
 *  every block. A mirror is a promise the compiler does not check, so there is
 *  no mirror any more — `blockedSessions` and `runningSessionCount` here are the
 *  functions the app itself runs, which makes reverting the rule a change these
 *  cases fail on rather than one they bless. */
function counts(state: GraphState): { waiting: number; running: number } {
  return {
    waiting: blockedSessions(state.agents.values()).length,
    running: runningSessionCount(state.agents.values()),
  };
}

describe("the counts the signal is handed", () => {
  it("follows a session from started to blocked to answered", () => {
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "running" });

    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    expect(ambientSignal(counts(state))).toEqual({ title: `(1) ${PRODUCT}`, icon: "waiting" });

    // Answering it is the case that matters: a count that only goes up is the
    // classic failure here, and the icon has to fall back to running rather
    // than to idle because the session is still mid-turn.
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "yes" });
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "running" });

    state = send(state, "s1", { hook_event_name: "Stop" });
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "idle" });
  });

  it("counts each blocked session once and adds them up", () => {
    seq = 0;
    let state = initialState();
    for (const s of ["s1", "s2", "s3"]) {
      state = send(state, s, { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    }
    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    state = send(state, "s2", { hook_event_name: "Notification", ...PERMISSION });
    expect(ambientSignal(counts(state)).title).toBe(`(2) ${PRODUCT}`);
  });

  it("says nothing at all for a session that merely ended its turn", () => {
    // #348, and the case this file used to assert the opposite of. CC sends an
    // idle_prompt about a minute after Stop on every session that finishes and
    // is not picked straight back up, which on the log #348 was measured
    // against outnumbered permission prompts 16 to 5 — so counting it lit the
    // title and the favicon amber for roughly three quarters of the time they
    // were lit at all, over sessions whose nodes already read `done`. Three
    // surfaces worth having only while they are rare.
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    state = send(state, "s1", { hook_event_name: "Stop" }, 3_000);
    state = send(state, "s1", { hook_event_name: "Notification", ...IDLE }, 4_000);
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "idle" });
    // Not a claim that the block was dropped: it is on the root, it prints on
    // the card and it sorts the sidebar above the running rows. It just does
    // not shout, and this asserts both halves so a fix that quiets idle by
    // discarding it fails here.
    expect(state.agents.get("s1")?.waiting?.kind).toBe("idle");
  });

  it("adds up only the permission blocks when both kinds are on the board", () => {
    // The mixed board is the one that separates "counts the right kind" from
    // "counts nothing", and a suite that only ever shows it one kind at a time
    // passes under either mistake.
    seq = 0;
    let state = initialState();
    for (const s of ["s1", "s2", "s3"]) {
      state = send(state, s, { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    }
    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    state = send(state, "s2", { hook_event_name: "Notification", ...IDLE });
    state = send(state, "s3", { hook_event_name: "Notification", ...IDLE });
    expect(counts(state).waiting).toBe(1);
    expect(ambientSignal(counts(state))).toEqual({ title: `(1) ${PRODUCT}`, icon: "waiting" });
  });

  it("leaves no phantom in the title when an old session is evicted", () => {
    // Two finished sessions, each sitting on a permission prompt raised before
    // the turn ended — done, blocked, and therefore both counted AND evictable.
    // pruneOldAgents drops the oldest out of the map once it is over cap, so a
    // title kept as a running tally would report a session that is no longer
    // anywhere on the canvas, with nothing left to click through to.
    //
    // Stop lands BEFORE the notification so the roots keep `state: "done"` and
    // an `endedAt`, which is what makes them prunable at all — Notification does
    // not touch either field, so the block rides on a finished session the way
    // an unanswered prompt does when the human walks away mid-turn. The kind is
    // orthogonal to the eviction property being tested here; it is permission
    // because permission is what the count is of, and a case built on idle
    // proves nothing about a counter that correctly ignores idle.
    seq = 0;
    let state = initialState();
    for (const s of ["s1", "s2"]) {
      state = send(state, s, { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      state = send(state, s, { hook_event_name: "Stop" }, 3_000);
      state = send(state, s, { hook_event_name: "Notification", ...PERMISSION }, 4_000);
    }
    expect(ambientSignal(counts(state))).toEqual({ title: `(2) ${PRODUCT}`, icon: "waiting" });

    expect(pruneOldAgents(state, 1_000_000, 1, 0)).toBe(true);
    expect(state.agents.size).toBe(1);
    expect(ambientSignal(counts(state)).title).toBe(`(1) ${PRODUCT}`);
  });

  it("lands on the truth after a replay, not on the sum of it", () => {
    // The SSE stream reconnects and replays from the log. The same block
    // arriving twice is one block, and a block that cleared while the tab was
    // disconnected has to come back cleared.
    seq = 0;
    const replay = (upTo: number) => {
      let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
      state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
      if (upTo > 0) state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
      if (upTo > 1) state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "yes" });
      return state;
    };
    expect(ambientSignal(counts(replay(1))).title).toBe(`(1) ${PRODUCT}`);
    expect(ambientSignal(counts(replay(2))).title).toBe(PRODUCT);
  });
});
