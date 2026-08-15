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
// Plain node, no DOM — so this tests the pure function, reads the two source
// files as text, and drives the reducer directly for the counting.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ambientSignal, FAVICON_HREF, type AmbientIcon } from "../ambient";
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
      expect(svg.match(/<circle/g) ?? [], `${icon} lost the ring or the dot`).toHaveLength(2);
    }
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
});

describe("what App.tsx does with it", () => {
  const app = read("../App.tsx");

  it("compares before it writes, on both surfaces", () => {
    // The effect recomputes on every SSE frame and both counts churn under a
    // title that is standing still — a subagent spawning moves `running` on a
    // deck whose title is plain and whose icon is already blue. Assigning an
    // identical title is a write the browser answers by re-rendering the tab.
    expect(app).toContain("if (prev?.title !== next.title) document.title = next.title;");
    expect(app).toContain("if (prev?.icon !== next.icon) {");
  });

  it("counts what the canvas holds rather than keeping a tally", () => {
    // pruneOldAgents evicts agents from the map outright, so any count
    // maintained alongside it would outlive what it was counting.
    expect(app).toContain("for (const a of stateRef.current.agents.values())");
    expect(app).not.toMatch(/set(Waiting|Running)Count/);
  });
});

// ── the counts, driven through the reducer ──────────────────────────────────
//
// The two numbers the signal is given come from the agents map, and the map is
// the thing that forgets. These cases are the edges #338 named: an evicted
// session must not leave a phantom in the title, and a replay must land on the
// truth rather than on the sum of what it replayed.

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

/** Exactly what App.tsx's two memos compute, over the same map. */
function counts(state: GraphState): { waiting: number; running: number } {
  let waiting = 0;
  const running = new Set<string>();
  for (const a of state.agents.values()) {
    if (a.kind === "root" && a.waiting) waiting++;
    if (a.state === "active") running.add(a.sessionId);
  }
  return { waiting, running: running.size };
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

  it("leaves no phantom in the title when an old session is evicted", () => {
    // Two finished sessions, each sitting on the idle prompt CC sends about a
    // minute after Stop — done, blocked, and therefore both counted AND
    // evictable. pruneOldAgents drops the oldest out of the map once it is over
    // cap, so a title kept as a running tally would report a session that is no
    // longer anywhere on the canvas, with nothing left to click through to.
    seq = 0;
    let state = initialState();
    for (const s of ["s1", "s2"]) {
      state = send(state, s, { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      state = send(state, s, { hook_event_name: "Stop" }, 3_000);
      state = send(state, s, { hook_event_name: "Notification", ...IDLE }, 4_000);
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
