// What the toolbar says about whether the board is moving.
//
// The pill was keyed on SSE connectivity alone, so it read "live" with a
// pulsing green dot while the canvas was frozen — and Space, which pauses, is
// an easy key to hit by accident on a canvas UI. The pill was not lying (the
// stream really is connected and receiving while paused; the gate in pause.ts
// holds arrivals rather than closing the connection), but the most prominent
// indicator in the toolbar looked identical whether the deck was following the
// work or had stopped repainting it. The only signal was the Pause button
// flipping to an amber "Resume" — with a bare number appended to it, no unit,
// no label, and a title that still said "Pause/resume live updates".
//
// So: three states rather than two, and the held queue is named wherever it is
// counted. Disconnected outranks paused because a resume cannot fix it — but
// the title still says both, since resuming a deck whose stream is dead is a
// thing a user will otherwise try.
//
// Out of App.tsx because the precedence between the two flags is the whole
// rule, and there is no DOM here to render a pill in.

export interface StatusPill {
  /** Modifier class on `.pill`, and the word it shows. */
  tone: "live" | "paused" | "dead";
  label: string;
  title: string;
}

/** "1 event" / "42 events" — the unit the count never carried. */
export function heldEvents(held: number): string {
  const n = Math.max(0, Math.floor(held));
  return `${n} event${n === 1 ? "" : "s"}`;
}

export function statusPill(s: { connected: boolean; paused: boolean; held: number }): StatusPill {
  if (!s.connected) {
    return {
      tone: "dead",
      label: "offline",
      title: s.paused
        ? "SSE disconnected — and the canvas is paused, so resuming will not bring events back until it reconnects"
        : "SSE disconnected",
    };
  }
  if (s.paused) {
    return {
      tone: "paused",
      label: "paused",
      title: s.held > 0
        ? `Connected — ${heldEvents(s.held)} held until you resume (Space)`
        : "Connected — updates held until you resume (Space)",
    };
  }
  return { tone: "live", label: "live", title: "Receiving events" };
}

/** The Pause/Resume button. The count belongs to the queue, so it is said in
 *  the queue's terms rather than left as a number beside a verb. */
export function pauseButton(s: { paused: boolean; held: number }): { label: string; title: string } {
  if (!s.paused) return { label: "Pause", title: "Pause live updates — events keep arriving and are applied when you resume (Space)" };
  if (s.held <= 0) return { label: "Resume", title: "Nothing has arrived since you paused. Resume to follow the canvas again (Space)" };
  return {
    label: `Resume · ${s.held} held`,
    title: `${heldEvents(s.held)} arrived while paused and will be applied in order when you resume (Space)`,
  };
}
