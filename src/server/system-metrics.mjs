// Machine-wide CPU and memory, sampled on our own timer so every open tab reads
// the same numbers.
//
// WHY THE SERVER SAMPLES INSTEAD OF ANSWERING ON DEMAND. CPU utilisation is not
// a value you can read; it is a ratio between two readings. `os.cpus()` returns
// cumulative tick counters, so a percentage only exists relative to a previous
// sample. If the sample were taken when a request arrived, two browser tabs
// polling half a second apart would compute their deltas from different
// baselines and print different percentages for the same machine. One timer in
// one process is the only arrangement where that cannot happen — and it is what
// lets `/api/system` hand back a real 60-second history rather than whatever a
// single tab has managed to collect since it was opened.
//
// WHY THIS NEVER TOUCHES pushEvent. Every event that goes through the deck's
// stream is persisted to events.jsonl and held in the 2000-entry ring buffer. A
// three-second sampler would put 1200 entries an hour into both, evicting real
// tool calls from the replay a reconnecting tab receives, and making an ambient
// readout the loudest producer in the application. So this is a plain poll
// endpoint, exactly like /api/quota and /api/codex-usage already are.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

/** CPU is the metric with spikes, so it is sampled often enough to catch one. */
const CPU_INTERVAL_MS = 3_000;
/** Memory moves on the scale of minutes. Sampling it at the CPU cadence would
 *  print the same number twenty times and, on macOS, cost a subprocess to do
 *  it — see readMemory. */
const MEM_INTERVAL_MS = 30_000;
/** 20 samples x 3s = the 60 seconds the sparkline draws. */
const HISTORY = 20;

let cpuTimer = null;
let memTimer = null;
let prevTicks = null;
/** Newest last. Seeded empty; the first tick produces no percentage because a
 *  delta needs two readings. */
const cpuHistory = [];
let memory = null;
let memInFlight = false;

/** Total and idle jiffies across every core, as one pair. */
function readTicks() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
    }
  }
  return { idle, total };
}

/**
 * Busy percentage across all cores since the previous reading, 0-100.
 *
 * Aggregate rather than per-core, and normalised rather than macOS's
 * 0-to-cores*100 convention, because it has to mean the same thing on all three
 * platforms and because a bar needs an end. The cost is that it saturates: a
 * machine at load 12 and a machine at load 18 both read 100. `loadavg` is what
 * carries that difference, which is why it rides along below on the platforms
 * that report it.
 */
function cpuPercent() {
  const now = readTicks();
  if (!prevTicks) { prevTicks = now; return null; }
  const dTotal = now.total - prevTicks.total;
  const dIdle = now.idle - prevTicks.idle;
  prevTicks = now;
  // A tick counter that did not move says nothing; it does not say "idle".
  if (dTotal <= 0) return null;
  const pct = (1 - dIdle / dTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/** Run a command and resolve its stdout, or null. Never rejects, never inherits
 *  a shell, and is killed rather than allowed to hang the sampler. */
function run(file, args, timeoutMs = 2_000) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { windowsHide: true }); }
    catch { return resolve(null); }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeoutMs);
    child.stdout?.on("data", d => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/**
 * Bytes of memory a new process could actually get, per platform.
 *
 * `os.freemem()` is the obvious call and it is the wrong one on two of the three
 * platforms, because "free" and "available" are different questions. Pages
 * holding cached files or inactive anonymous memory are not free, but the kernel
 * will hand them over the moment something asks. Reporting them as used is what
 * makes the naive `(total - free) / total` read 99.5% on an idle 32 GB Mac — a
 * number that would send the reader straight to Activity Monitor, which is the
 * one outcome this readout exists to prevent.
 *
 *   linux   /proc/meminfo MemAvailable — the kernel's own answer, a file read
 *   win32   os.freemem() already reports available physical memory
 *   darwin  vm_stat, because nothing in Node exposes the page classes
 *
 * Only darwin costs a subprocess, and only at MEM_INTERVAL_MS.
 */
/**
 * Available bytes out of `/proc/meminfo` text, or null when the field is absent.
 *
 * Pure and exported for the same reason codexHome() takes a platform: a Linux
 * answer has to be checkable from a Mac, and the only alternative is trusting
 * that a regex nobody has run is right.
 */
export function availableFromMeminfo(text) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(text ?? ""));
  return m ? Number(m[1]) * 1024 : null;
}

/**
 * Available bytes out of `vm_stat` output, or null when it does not parse.
 *
 * Everything the kernel can hand over without swapping: genuinely free pages,
 * read-ahead it can drop, inactive anonymous pages, and purgeable caches. This
 * is the number `os.freemem()` is missing — it reports only the first of the
 * four, which is why the naive formula reads ~99% on an idle 32 GB Mac.
 */
export function availableFromVmStat(text, total) {
  const out = String(text ?? "");
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]) || 4096;
  const pages = name => {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(out);
    return m ? Number(m[1]) : 0;
  };
  const reclaimable = pages("free") + pages("speculative")
    + pages("inactive") + pages("purgeable");
  if (reclaimable <= 0) return null;
  const avail = reclaimable * pageSize;
  return total != null && avail > total ? null : avail;
}

async function readAvailable(platform = process.platform) {
  const total = os.totalmem();

  if (platform === "linux") {
    try {
      const parsed = availableFromMeminfo(await readFile("/proc/meminfo", "utf8"));
      if (parsed != null) return parsed;
    } catch { /* fall through to freemem */ }
    return os.freemem();
  }

  if (platform === "darwin") {
    const out = await run("vm_stat", []);
    const parsed = out ? availableFromVmStat(out, total) : null;
    return parsed ?? os.freemem();
  }

  return os.freemem();
}

async function sampleMemory() {
  if (memInFlight) return;
  memInFlight = true;
  try {
    const total = os.totalmem();
    const available = await readAvailable();
    memory = {
      total,
      available,
      usedPct: Math.max(0, Math.min(100, Math.round(((total - available) / total) * 1000) / 10)),
    };
  } catch { /* keep the previous reading rather than blanking the meter */ }
  finally { memInFlight = false; }
}

function sampleCpu() {
  const pct = cpuPercent();
  if (pct == null) return;
  cpuHistory.push(pct);
  while (cpuHistory.length > HISTORY) cpuHistory.shift();
}

/**
 * Begin sampling. Idempotent, and both timers are unref'd so this can never be
 * the reason the process stays alive.
 */
export function startSystemMetrics() {
  if (cpuTimer) return;
  prevTicks = readTicks();          // baseline, so the first tick has a delta
  sampleMemory();
  cpuTimer = setInterval(sampleCpu, CPU_INTERVAL_MS);
  memTimer = setInterval(sampleMemory, MEM_INTERVAL_MS);
  cpuTimer.unref?.();
  memTimer.unref?.();
}

export function stopSystemMetrics() {
  if (cpuTimer) clearInterval(cpuTimer);
  if (memTimer) clearInterval(memTimer);
  cpuTimer = memTimer = null;
  prevTicks = null;
  cpuHistory.length = 0;
  memory = null;
}

/**
 * What /api/system answers.
 *
 * `cpu` is null until two samples exist — the meter draws its track and no fill
 * rather than printing a zero it has not measured. `loadavg` is omitted on
 * Windows, where the API returns [0, 0, 0]: three zeros are not a reading, and
 * showing them as one would be the same lie in a different place.
 */
export function systemSnapshot() {
  const cpu = cpuHistory.length ? cpuHistory[cpuHistory.length - 1] : null;
  const load = os.loadavg();
  const hasLoad = process.platform !== "win32" && load.some(n => n > 0);
  return {
    ok: true,
    cpu,
    cpuHistory: [...cpuHistory],
    cores: os.cpus().length,
    memory,
    loadavg: hasLoad ? load.map(n => Math.round(n * 100) / 100) : null,
    intervalMs: CPU_INTERVAL_MS,
    sampledAt: Date.now(),
  };
}
