// Pausing used to be wired through a React state variable the SSE effect
// listed as a dependency, so every Space keypress closed the EventSource and
// opened a new one. The new connection sends no Last-Event-ID, the server
// answers a missing id with its entire ring buffer, and the paused handler
// filed all 2000 replayed envelopes in the pause queue: "Resume · 2000" after
// zero new events, and a resume that re-applied the whole buffer only for the
// reducer's seq check to discard it — then reconnected and replayed it again.
//
// The gate holds the flag and the queue together in one mutable object, so the
// handler reads the pause state through a ref and the subscription stops
// depending on it. These tests pin the delivery contract that lets the stream
// stay open across a toggle: nothing is lost, nothing arrives twice, and order
// is arrival order.
import { describe, it, expect } from "vitest";
import { createPauseGate } from "../pause";

/** Stand-in for a HookEnvelope — the gate never looks inside an event. */
type Ev = { seq: number };
const ev = (seq: number): Ev => ({ seq });

/** Feed events through the gate the way the SSE handler does, collecting the
 *  ones it is told to deliver right away. */
function deliver(gate: ReturnType<typeof createPauseGate<Ev>>, events: Ev[]): Ev[] {
  const out: Ev[] = [];
  for (const e of events) if (gate.accept(e)) out.push(e);
  return out;
}

describe("createPauseGate", () => {
  it("delivers events straight through while running", () => {
    const gate = createPauseGate<Ev>();
    expect(gate.paused).toBe(false);
    expect(deliver(gate, [ev(1), ev(2), ev(3)])).toEqual([ev(1), ev(2), ev(3)]);
    expect(gate.size).toBe(0);
  });

  it("holds events while paused and releases them in arrival order", () => {
    const gate = createPauseGate<Ev>();
    gate.setPaused(true);
    expect(deliver(gate, [ev(1), ev(2), ev(3)])).toEqual([]);
    expect(gate.size).toBe(3);
    expect(gate.setPaused(false)).toEqual([ev(1), ev(2), ev(3)]);
    expect(gate.size).toBe(0);
    expect(gate.paused).toBe(false);
  });

  it("counts only what actually arrived while paused", () => {
    const gate = createPauseGate<Ev>();
    deliver(gate, [ev(1), ev(2)]);   // live traffic before the pause
    gate.setPaused(true);
    deliver(gate, [ev(3)]);
    // The old wiring replayed the server's whole ring buffer into the queue on
    // the toggle, so the button read a count nobody generated.
    expect(gate.size).toBe(1);
  });

  it("releases each held event exactly once", () => {
    const gate = createPauseGate<Ev>();
    gate.setPaused(true);
    deliver(gate, [ev(1), ev(2)]);
    expect(gate.setPaused(false)).toEqual([ev(1), ev(2)]);
    expect(gate.setPaused(false)).toEqual([]);
    gate.setPaused(true);
    expect(gate.setPaused(false)).toEqual([]);
  });

  it("keeps holding when paused again before resuming", () => {
    const gate = createPauseGate<Ev>();
    gate.setPaused(true);
    deliver(gate, [ev(1)]);
    expect(gate.setPaused(true)).toEqual([]); // re-pause must not spill
    expect(gate.size).toBe(1);
    expect(gate.setPaused(false)).toEqual([ev(1)]);
  });

  it("loses nothing across repeated pause toggles", () => {
    const gate = createPauseGate<Ev>();
    const seen: Ev[] = [];
    let seq = 0;
    for (let i = 0; i < 5; i++) {
      seen.push(...deliver(gate, [ev(++seq), ev(++seq)]));
      gate.setPaused(true);
      deliver(gate, [ev(++seq), ev(++seq)]);
      seen.push(...gate.setPaused(false));
    }
    expect(seen.map(e => e.seq)).toEqual(Array.from({ length: seq }, (_, i) => i + 1));
  });

  it("resuming with nothing held is a no-op", () => {
    const gate = createPauseGate<Ev>();
    gate.setPaused(true);
    expect(gate.setPaused(false)).toEqual([]);
    expect(gate.size).toBe(0);
  });

  it("hands back a queue the caller can keep without disturbing the gate", () => {
    const gate = createPauseGate<Ev>();
    gate.setPaused(true);
    deliver(gate, [ev(1)]);
    const held = gate.setPaused(false);
    held.push(ev(99));
    gate.setPaused(true);
    deliver(gate, [ev(2)]);
    expect(gate.setPaused(false)).toEqual([ev(2)]);
  });
});
