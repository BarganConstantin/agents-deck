// Pausing froze the canvas and left the toolbar saying "live", with the green
// dot still pulsing, because the pill was keyed on SSE connectivity alone — and
// pause is bound to Space, which is an easy key to hit by accident on a canvas
// UI. The pill was not wrong on its own terms (pause.ts holds arriving events
// rather than closing the stream, so the connection really is live), but the
// most prominent indicator in the toolbar looked the same whether the board was
// following the work or had stopped repainting it.
//
// The other half was the count: the Resume button read "Resume · 42" with no
// unit, no label and a title that still said "Pause/resume live updates
// (Space)", so the number could as easily have been a queue position, a second
// count or a percentage.
//
// These pin the three-state pill, the precedence between disconnected and
// paused, and the fact that every place the held queue is counted also says
// what it is counting.
import { describe, it, expect } from "vitest";
import { heldEvents, pauseButton, statusPill } from "../status-pill";

describe("the status pill", () => {
  it("says live only while the deck is connected and following the stream", () => {
    const pill = statusPill({ connected: true, paused: false, held: 0 });
    expect(pill.tone).toBe("live");
    expect(pill.label).toBe("live");
    expect(pill.title).toBe("Receiving events");
  });

  it("says paused, not live, once the canvas is frozen", () => {
    const pill = statusPill({ connected: true, paused: true, held: 12 });
    expect(pill.tone).toBe("paused");
    expect(pill.label).toBe("paused");
  });

  it("explains that a paused deck is still connected, and how many events that has held", () => {
    expect(statusPill({ connected: true, paused: true, held: 12 }).title)
      .toBe("Connected — 12 events held until you resume (Space)");
  });

  it("does not count a queue that is empty, since a pause with no traffic held nothing", () => {
    expect(statusPill({ connected: true, paused: true, held: 0 }).title)
      .toBe("Connected — updates held until you resume (Space)");
  });

  it("reports the dead stream ahead of the pause, because resuming cannot fix it", () => {
    const pill = statusPill({ connected: false, paused: true, held: 3 });
    expect(pill.tone).toBe("dead");
    expect(pill.label).toBe("offline");
    expect(pill.title).toContain("SSE disconnected");
    // Still says both: otherwise the user resumes, sees nothing arrive, and
    // has no idea the pause was never the thing stopping it.
    expect(pill.title).toContain("paused");
  });

  it("keeps the offline title short when nothing else is wrong", () => {
    expect(statusPill({ connected: false, paused: false, held: 0 }).title).toBe("SSE disconnected");
  });
});

describe("the pause button", () => {
  it("gives the held count a unit instead of leaving a bare number beside a verb", () => {
    expect(pauseButton({ paused: true, held: 42 }).label).toBe("Resume · 42 held");
  });

  it("says in full what the number means, where the title used to be generic", () => {
    const btn = pauseButton({ paused: true, held: 42 });
    expect(btn.title).toBe("42 events arrived while paused and will be applied in order when you resume (Space)");
    expect(btn.title).not.toBe("Pause/resume live updates (Space)");
  });

  it("drops the count when nothing has arrived, rather than showing a zero", () => {
    const btn = pauseButton({ paused: true, held: 0 });
    expect(btn.label).toBe("Resume");
    expect(btn.title).toContain("Nothing has arrived since you paused");
  });

  it("promises, while running, that pausing loses nothing", () => {
    const btn = pauseButton({ paused: false, held: 0 });
    expect(btn.label).toBe("Pause");
    expect(btn.title).toContain("applied when you resume");
  });

  it("counts one event in the singular, everywhere the queue is named", () => {
    expect(heldEvents(1)).toBe("1 event");
    expect(heldEvents(2)).toBe("2 events");
    expect(heldEvents(0)).toBe("0 events");
    expect(pauseButton({ paused: true, held: 1 }).title).toContain("1 event arrived");
    expect(statusPill({ connected: true, paused: true, held: 1 }).title).toContain("1 event held");
  });
});
