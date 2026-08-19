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
let prevCoreTicks = null;
let cores = null;
let swap = null;
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

/** The same pair, per core, in `os.cpus()` order. */
function readCoreTicks() {
  return os.cpus().map(cpu => {
    let idle = 0;
    let total = 0;
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
    }
    return { idle, total };
  });
}

/**
 * Busy percentage per core since the previous reading.
 *
 * The aggregate figure the topbar draws hides the shape of the load, and the
 * shape is what tells a saturated machine from a machine running one hot
 * single-threaded job. Same delta arithmetic as `cpuPercent`, one row per core,
 * and the same refusal to invent a number before there are two readings.
 */
function corePercents() {
  const now = readCoreTicks();
  const prev = prevCoreTicks;
  prevCoreTicks = now;
  if (!prev || prev.length !== now.length) return null;
  return now.map((c, i) => {
    const dTotal = c.total - prev[i].total;
    const dIdle = c.idle - prev[i].idle;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
  });
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

/**
 * Swap out of macOS `sysctl -n vm.swapusage`, which prints
 * `total = 14336.00M  used = 12876.00M  free = 1460.00M  (encrypted)`.
 *
 * Swap is the reading a percentage cannot give you. A machine at "64% memory
 * used" that is quietly paging 12 GB to disk is not the same machine as one at
 * 64% with an empty swap file, and the difference is the one you can feel.
 */
export function swapFromSysctl(text) {
  const unit = s => {
    const m = /^([\d.]+)([KMG])?$/i.exec(s);
    if (!m) return null;
    const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] || "M").toLowerCase()] ?? 1;
    return Math.round(Number(m[1]) * mult);
  };
  const total = unit(/total\s*=\s*(\S+)/i.exec(String(text ?? ""))?.[1] ?? "");
  const used = unit(/used\s*=\s*(\S+)/i.exec(String(text ?? ""))?.[1] ?? "");
  if (total == null || used == null) return null;
  return { total, used };
}

/** Swap out of `/proc/meminfo`, where it is two fields rather than one line. */
export function swapFromMeminfo(text) {
  const s = String(text ?? "");
  const total = /^SwapTotal:\s+(\d+)\s*kB/m.exec(s);
  const free = /^SwapFree:\s+(\d+)\s*kB/m.exec(s);
  if (!total || !free) return null;
  const t = Number(total[1]) * 1024;
  return { total: t, used: Math.max(0, t - Number(free[1]) * 1024) };
}

/**
 * Windows has no swap file in the Unix sense; the comparable pressure signal is
 * commit charge, which `Win32_OperatingSystem` reports as total and free
 * virtual memory in KB. Labelled "commit" in the UI rather than "swap", because
 * calling it swap would be borrowing a word for a different mechanism.
 */
export function swapFromWmicJson(json) {
  try {
    const o = typeof json === "string" ? JSON.parse(json) : json;
    const total = Number(o?.TotalVirtualMemorySize) * 1024;
    const free = Number(o?.FreeVirtualMemory) * 1024;
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
    return { total, used: Math.max(0, total - free) };
  } catch { return null; }
}

async function readSwap(platform = process.platform) {
  if (platform === "darwin") {
    const out = await run("sysctl", ["-n", "vm.swapusage"]);
    return out ? swapFromSysctl(out) : null;
  }
  if (platform === "linux") {
    try { return swapFromMeminfo(await readFile("/proc/meminfo", "utf8")); }
    catch { return null; }
  }
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVirtualMemorySize,FreeVirtualMemory | ConvertTo-Json -Compress",
    ], 4_000);
    return out ? swapFromWmicJson(out.trim()) : null;
  }
  return null;
}

/** How many rows the process list keeps. Enough to see what is eating the
 *  machine, few enough that the panel never becomes a scroll. */
const TOP_N = 8;

/**
 * Rows out of `ps -Aceo pid,pcpu,pmem,comm -r`.
 *
 * `-c` gives the executable name without its full path and without the argv
 * that would leak a prompt or a token into the UI; `-r` sorts by current CPU,
 * which is the ordering that answers "what is eating this machine right now".
 */
export function parsePsProcesses(text, limit = TOP_N) {
  const lines = String(text ?? "").trim().split("\n");
  const out = [];
  for (const line of lines.slice(1)) {           // drop the header row
    const m = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]), name: m[4] });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Rows out of the Windows performance counter.
 *
 * `Get-Process` is the obvious call and the wrong one: its `CPU` property is
 * total processor SECONDS consumed since the process started, so sorting by it
 * ranks whatever has been running longest rather than whatever is busy now — a
 * different question, and not the one the panel asks. The formatted performance
 * counter publishes `PercentProcessorTime` directly, already a rate, so one
 * query gives the same thing `ps -r` gives on Unix without a second sample.
 *
 * `_Total` and `Idle` are pseudo-processes in that class and are dropped.
 */
export function parseWindowsProcesses(json, totalMem, limit = TOP_N) {
  let rows;
  try { rows = typeof json === "string" ? JSON.parse(json) : json; }
  catch { return []; }
  if (!rows) return [];
  if (!Array.isArray(rows)) rows = [rows];
  const cores = os.cpus().length || 1;
  return rows
    .filter(r => r && r.Name && r.Name !== "_Total" && r.Name !== "Idle")
    .map(r => ({
      pid: Number(r.IDProcess) || 0,
      // The counter is per-core-summed, exactly like macOS's 0-to-N00 scale, so
      // it is normalised here to the 0-100 the Unix branch already reports.
      cpu: Math.round((Number(r.PercentProcessorTime) || 0) / cores * 10) / 10,
      mem: totalMem > 0
        ? Math.round((Number(r.WorkingSetPrivate) || 0) / totalMem * 1000) / 10
        : 0,
      name: String(r.Name),
    }))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, limit);
}

/** The process list, on demand only — never on the ambient timer. */
export async function readProcesses(platform = process.platform) {
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object Name,IDProcess,PercentProcessorTime,WorkingSetPrivate | ConvertTo-Json -Compress",
    ], 6_000);
    return out ? parseWindowsProcesses(out.trim(), os.totalmem()) : [];
  }
  const out = await run("ps", ["-Aceo", "pid,pcpu,pmem,comm", "-r"], 4_000);
  return out ? parsePsProcesses(out) : [];
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
    // Same 30s cadence as memory, and for the same reason: it moves in minutes
    // and costs a subprocess on two of the three platforms.
    swap = await readSwap();
  } catch { /* keep the previous reading rather than blanking the meter */ }
  finally { memInFlight = false; }
}

function sampleCpu() {
  const per = corePercents();
  const pct = cpuPercent();
  if (pct == null) return;
  cores = per;
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
  prevCoreTicks = readCoreTicks();
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
  prevCoreTicks = null;
  cpuHistory.length = 0;
  memory = null;
  cores = null;
  swap = null;
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
    swap,
    perCore: cores,
    uptimeSec: Math.round(os.uptime()),
    platform: process.platform,
    loadavg: hasLoad ? load.map(n => Math.round(n * 100) / 100) : null,
    intervalMs: CPU_INTERVAL_MS,
    sampledAt: Date.now(),
  };
}
