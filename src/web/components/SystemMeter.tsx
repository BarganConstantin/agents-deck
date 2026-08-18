// The machine's own state, in the topbar, so the answer to "is this box coping"
// does not require another window.
//
// TWO METRICS, TWO FORMS, and that is the whole idea. CPU spikes — a build can
// saturate every core for four seconds and be gone before you look — so its
// history is the information and it draws as a 60-second sparkline. Memory moves
// on the scale of minutes, so its history is twenty copies of the same number
// and only the level matters; it draws as a bar. Form follows the dynamics of
// the data, which is the same reason the two are sampled at different rates
// server-side.
//
// NO COLOUR THRESHOLD ON CPU, deliberately, and it is the most load-bearing "no"
// here. QuotaBar turns amber at 70 and red at 90 because a quota at 90% means
// you are about to be cut off. A CPU at 90% means the machine is doing the work
// you asked for. Colouring it would make this red through every build and every
// parallel subagent run — precisely the sessions this deck exists to watch — and
// an indicator that alarms during the normal case teaches you to stop reading
// it. Memory keeps a warning because near-exhaustion there is real, and because
// the server computes genuine availability rather than os.freemem().
import React, { useEffect, useRef, useState } from "react";

/** Matches the server's CPU cadence, so the meter advances one bucket per poll
 *  rather than redrawing the same frame or skipping one. */
const POLL_MS = 3_000;
/** Server keeps 20 samples; the sparkline is sized to hold exactly that. */
const BUCKETS = 20;

const W = 36;
const SPARK_H = 8;

interface Memory { total: number; available: number; usedPct: number }
interface Snapshot {
  ok: boolean;
  cpu: number | null;
  cpuHistory: number[];
  cores: number;
  memory: Memory | null;
  loadavg: number[] | null;
  intervalMs: number;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Poll /api/system on our own timer, and stop while the tab is hidden.
 *
 * A background tab has nobody looking at it, and browsers throttle its timers
 * to once a minute anyway — which would leave the sparkline full of holes on
 * return. Dropping the poll and refetching on the way back gives a clean read
 * instead of a ragged one.
 */
function useSystem(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/system");
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.ok) setSnap(data);
      } catch { /* the deck is down; the connection pill already says so */ }
    };
    const start = () => {
      if (timer.current != null) return;
      load();
      timer.current = window.setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (timer.current == null) return;
      window.clearInterval(timer.current);
      timer.current = null;
    };
    // Coming back deserves a reading now, not on the next tick. `start()` is a
    // no-op while the interval is alive, so without this explicit load a tab
    // that regained focus showed its last pre-hidden value for up to POLL_MS.
    const onVis = () => {
      if (document.visibilityState === "hidden") { stop(); return; }
      start();
      load();
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return snap;
}

export default function SystemMeter() {
  const sys = useSystem();

  // Before the first reading the meter holds its slot and draws its two empty
  // tracks. Two separate rules are at work and they pull in opposite
  // directions: never print a number we have not measured, and never reflow a
  // strip that is already too full. An empty track satisfies both — it asserts
  // no value, and it stops the surrounding stats from jumping sideways when the
  // first sample lands a few seconds after paint. Returning null would trade a
  // three-second absence for a visible shove of every control to its right.
  if (!sys || sys.cpu == null || !sys.memory) {
    return (
      <span className="sysmeter idle" title="Sampling this machine…">
        <span className="sm-box" aria-hidden>
          <span className="sm-graphic">
            <svg className="sm-spark" width={W} height={SPARK_H} viewBox={`0 0 ${W} ${SPARK_H}`} />
            <span className="sm-ram" />
          </span>
        </span>
      </span>
    );
  }

  const { cpu, cpuHistory, cores, memory, loadavg } = sys;
  const ramWarn = memory.usedPct >= 90;

  // Oldest-left, newest-right, padded so a fresh server draws a short trace at
  // the right edge instead of stretching two samples across the full width.
  const bars = cpuHistory.slice(-BUCKETS);
  const pad = BUCKETS - bars.length;
  const barW = W / BUCKETS;

  const tip = [
    `CPU ${cpu.toFixed(0)}% of ${cores} cores`,
    loadavg ? `load ${loadavg[0]} · ${loadavg[1]} · ${loadavg[2]}  (1m · 5m · 15m)` : null,
    `Memory ${memory.usedPct.toFixed(0)}% used · ${gb(memory.available)} available of ${gb(memory.total)}`,
    "",
    "This machine, not this session.",
  ].filter(v => v !== null).join("\n");

  return (
    <span className="sysmeter" title={tip}>
      <span className="sm-box" aria-hidden>
        <span className="sm-graphic">
          <svg className="sm-spark" width={W} height={SPARK_H} viewBox={`0 0 ${W} ${SPARK_H}`}>
            {bars.map((v, i) => {
              const idx = pad + i;
              const h = Math.max(1, (v / 100) * SPARK_H);
              // Opacity ramps toward the newest sample so the trace reads
              // left-to-right as time without needing an axis.
              const o = 0.32 + 0.68 * ((i + 1) / bars.length);
              return (
                <rect
                  key={idx}
                  x={idx * barW}
                  y={SPARK_H - h}
                  width={Math.max(0.8, barW - 0.7)}
                  height={h}
                  rx={0.5}
                  fill="var(--accent)"
                  opacity={o}
                />
              );
            })}
          </svg>
          <span className="sm-ram">
            {/* A floor of 2%, so a machine reporting almost nothing in use
                still shows a sliver rather than an empty track that reads as
                "no data". */}
            <span
              className={`sm-ram-fill${ramWarn ? " warn" : ""}`}
              style={{ transform: `scaleX(${Math.max(2, memory.usedPct) / 100})` }}
            />
          </span>
        </span>
        {/* A middle dot, not a slash. Two independent percentages joined by "/"
            read as one fraction — "47 of 64" — which is a quantity this meter
            never reports. The dot separates without implying arithmetic. Units
            are in the tooltip: at 36px, "47%·64%" does not fit, and the pair
            that fits is the pair that stays. */}
        <span className="sm-read">
          <b>{cpu.toFixed(0)}</b>
          <i>·</i>
          <b>{memory.usedPct.toFixed(0)}</b>
        </span>
      </span>
      {/* The bars are decoration; this is the reading. Not a live region — it
          would announce every three seconds and make the strip unusable. */}
      <span className="sm-sr">
        CPU {cpu.toFixed(0)} percent, memory {memory.usedPct.toFixed(0)} percent used
      </span>
    </span>
  );
}
