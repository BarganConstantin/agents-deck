// The machine's own state, in the topbar, so the answer to "is this box coping"
// does not require another window.
//
// TWO METRICS, TWO FORMS, and that is the whole idea of the resting state. CPU
// spikes — a build can saturate every core for four seconds and be gone before
// you look — so its history is the information and it draws as a 60-second
// sparkline. Memory moves on the scale of minutes, so its history is twenty
// copies of the same number and only the level matters; it draws as a bar. Form
// follows the dynamics of the data, which is the same reason the two are
// sampled at different rates server-side.
//
// NO COLOUR THRESHOLD ON CPU, deliberately, and it is the most load-bearing "no"
// here. QuotaBar turns amber at 70 and red at 90 because a quota at 90% means
// you are about to be cut off. A CPU at 90% means the machine is doing the work
// you asked for. Colouring it would make this red through every build and every
// parallel subagent run — precisely the sessions this deck exists to watch — and
// an indicator that alarms during the normal case teaches you to stop reading
// it. Memory and swap keep a warning, because near-exhaustion there is real.
//
// THE PANEL IS WHERE THE ABSOLUTE NUMBERS LIVE. A percentage answers "how full",
// which is the ambient question; it cannot answer "how much of how much", which
// is the question you open a panel to ask. Everything below the fold is in bytes
// and cores, not ratios.
import React, { useEffect, useRef, useState } from "react";
import { readStored } from "../storage";

/** Matches the server's CPU cadence, so the meter advances one bucket per poll
 *  rather than redrawing the same frame or skipping one. */
const POLL_MS = 3_000;
/** The process list costs a subprocess on every platform, so it refreshes more
 *  slowly than the meter and only while the panel is open. */
const PROC_POLL_MS = 4_000;
/** Server keeps 20 samples; the sparkline is sized to hold exactly that. */
const BUCKETS = 20;

const W = 36;
const SPARK_H = 8;

/** In the `agent-dag.*` namespace like every other key here; brand.ts explains
 *  why the rename stops at the storage layer. */
const OPEN_KEY = "agent-dag.systemPanelOpen";

/**
 * Whether the panel was open when this tab was last looked at.
 *
 * Read through storage.ts rather than window.localStorage directly: this runs
 * inside a useState initialiser, and the property read throws outright on a
 * browser that blocks site data, which would take the whole topbar with it.
 *
 * Defaults to CLOSED, unlike the usage panel's default. Usage is the panel you
 * keep up; this one answers a question you asked once, and a machine readout
 * that reopens itself on every refresh would be occupying the rail on behalf of
 * a decision nobody made.
 */
function loadOpen(): boolean {
  return readStored(OPEN_KEY) === "1";
}
function saveOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch {}
}

interface Memory { total: number; available: number; usedPct: number }
interface Swap { total: number; used: number }
interface Proc { pid: number; cpu: number; mem: number; name: string }
interface Snapshot {
  ok: boolean;
  cpu: number | null;
  cpuHistory: number[];
  cores: number;
  memory: Memory | null;
  swap: Swap | null;
  perCore: number[] | null;
  uptimeSec: number;
  platform: string;
  loadavg: number[] | null;
  intervalMs: number;
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

/** The process list, fetched only while `on` is true. */
function useProcesses(on: boolean): Proc[] | null {
  const [procs, setProcs] = useState<Proc[] | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/system/processes");
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.ok) setProcs(data.procs ?? []);
      } catch { /* leave the previous list up rather than blanking it */ }
    };
    load();
    const iv = window.setInterval(load, PROC_POLL_MS);
    return () => { alive = false; window.clearInterval(iv); };
  }, [on]);
  return on ? procs : null;
}

export default function SystemMeter({ usageOpen = false }: { usageOpen?: boolean }) {
  const sys = useSystem();
  const [open, setOpen] = useState<boolean>(loadOpen);
  useEffect(() => { saveOpen(open); }, [open]);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Before the first reading the meter holds its slot and draws its two empty
  // tracks. Two separate rules are at work and they pull in opposite
  // directions: never print a number we have not measured, and never reflow a
  // strip that is already too full. An empty track satisfies both — it asserts
  // no value, and it stops the surrounding stats from jumping sideways when the
  // first sample lands a few seconds after paint.
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
    `Memory ${bytes(memory.total - memory.available)} of ${bytes(memory.total)} used`,
    "",
    "Click for detail. This machine, not this session.",
  ].filter(v => v !== null).join("\n");

  return (
    <span className="sysmeter-wrap">
      <button
        type="button"
        ref={btnRef}
        className="sysmeter"
        title={tip}
        aria-label="Toggle machine detail"
        aria-expanded={open}
        aria-controls={open ? "system-panel" : undefined}
        onClick={() => setOpen(o => !o)}
      >
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
              never reports. The dot separates without implying arithmetic. */}
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
      </button>
      {open && <SystemPanel sys={sys} usageOpen={usageOpen} onClose={() => { setOpen(false); btnRef.current?.focus(); }} />}
    </span>
  );
}

/**
 * The detail, docked in the right rail beside the usage panel.
 *
 * NOT a dialog and not a popover, and the distinction is behavioural rather
 * than cosmetic. This is the same kind of thing the usage panel is: a region
 * you open, read alongside the canvas, and leave open while you work. So it
 * follows that idiom exactly — disclosure semantics on the button, no scrim, no
 * focus trap, and no dismissal when you click somewhere else, because clicking
 * the canvas while watching a build is not a request to close your instruments.
 *
 * It also means the two panels queue rather than overlap: with usage open this
 * sits to its left, and with usage closed it takes the slot usage would have
 * had. One rail, read right to left, nothing stacked on top of anything.
 */
function SystemPanel({ sys, usageOpen, onClose }: { sys: Snapshot; usageOpen: boolean; onClose: () => void }) {
  const procs = useProcesses(true);

  const { memory, swap, perCore, loadavg, cores, uptimeSec, platform } = sys;
  const used = memory ? memory.total - memory.available : 0;
  // Windows has no swap file in the Unix sense; what the same query reports
  // there is commit charge, so it is named for what it is.
  const swapLabel = platform === "win32" ? "Commit" : "Swap";
  const swapPct = swap && swap.total > 0 ? (swap.used / swap.total) * 100 : 0;

  return (
    <aside className={`sysdetail${usageOpen ? " shifted" : ""}`} id="system-panel" aria-label="Machine detail">
      <div className="sd-head">
        <span className="sd-title">This machine</span>
        <span className="sd-sub">up {uptime(uptimeSec)} · {cores} cores</span>
        <button type="button" className="sd-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
      </div>

      {perCore && perCore.length > 0 && (
        <div className="sd-section" role="group" aria-label="Cores">
          <div className="sd-h" aria-hidden>Cores</div>
          {/* One column per core. The aggregate in the topbar cannot tell a
              saturated machine from one hot single-threaded job; this can. */}
          <div className="sd-cores" style={{ "--n": perCore.length } as React.CSSProperties}>
            {perCore.map((v, i) => (
              <span key={i} className="sd-core" title={`core ${i + 1}: ${v}%`}>
                <span className="sd-core-fill" style={{ height: `${Math.max(2, v)}%` }} />
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="sd-section" role="group" aria-label="Memory">
        <div className="sd-h" aria-hidden>Memory</div>
        {memory && (
          <Row
            label="Physical"
            used={used}
            total={memory.total}
            pct={memory.usedPct}
            note={`${bytes(memory.available)} available`}
          />
        )}
        {swap && swap.total > 0 && (
          <Row
            label={swapLabel}
            used={swap.used}
            total={swap.total}
            pct={swapPct}
            note={swapPct >= 50 ? "paging to disk" : undefined}
          />
        )}
      </div>

      {loadavg && (
        <div className="sd-section" role="group" aria-label="Load average">
          <div className="sd-h" aria-hidden>Load average</div>
          <div className="sd-load">
            {loadavg.map((v, i) => (
              <span key={i} className={`sd-load-item${v > cores ? " over" : ""}`}>
                <b>{v.toFixed(2)}</b>
                <span>{["1m", "5m", "15m"][i]}</span>
              </span>
            ))}
          </div>
          {/* The one number the topbar bar cannot express: past 100% it
              saturates, and this says by how much. */}
          <div className="sd-note">
            {loadavg[0] > cores
              ? `${(loadavg[0] / cores).toFixed(1)}× more work queued than cores to run it`
              : `within ${cores} cores`}
          </div>
        </div>
      )}

      <div className="sd-section" role="group" aria-label="Busiest processes">
        <div className="sd-h" aria-hidden>Busiest processes</div>
        {procs == null ? (
          <div className="sd-note">reading…</div>
        ) : procs.length === 0 ? (
          <div className="sd-note">Could not read the process list on this platform.</div>
        ) : (
          <table className="sd-procs">
            <thead>
              <tr><th>cpu</th><th>mem</th><th>process</th></tr>
            </thead>
            <tbody>
              {procs.map(p => (
                <tr key={p.pid}>
                  {/* A process can exceed 100%: that is it using more than one
                      core, which is information rather than an error. */}
                  <td className="sd-num">{p.cpu.toFixed(0)}</td>
                  <td className="sd-num sd-dim">{p.mem.toFixed(1)}</td>
                  <td className="sd-proc-name" title={`pid ${p.pid}`}>{p.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}

function Row({ label, used, total, pct, note }: {
  label: string; used: number; total: number; pct: number; note?: string;
}) {
  const warn = pct >= 90;
  return (
    <div className="sd-row">
      <div className="sd-row-head">
        <span className="sd-row-label">{label}</span>
        {/* "How much of how much" — the question a percentage cannot answer and
            the reason this panel exists. */}
        <span className="sd-row-val">
          <b>{bytes(used)}</b> of {bytes(total)}
        </span>
      </div>
      <span className="sd-track">
        <span
          className={`sd-fill${warn ? " warn" : ""}`}
          style={{ transform: `scaleX(${Math.max(1, Math.min(100, pct)) / 100})` }}
        />
      </span>
      {note && <div className="sd-note">{note}</div>}
    </div>
  );
}
