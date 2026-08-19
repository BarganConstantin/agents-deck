// The system meter reports a machine, and the two questions it answers are
// asked differently on all three platforms. The parsers are pure and exported
// for exactly that reason: a Linux answer and a Windows answer both have to be
// checkable from whichever machine the author happens to be sitting at, the
// same rule codexHome()'s `platform` parameter encodes.
//
// The number under test is not a nicety. `(totalmem - freemem) / totalmem` reads
// 99.5% on an idle 32 GB Mac, because "free" excludes every page the kernel
// would hand over on request. A meter that opens on 99% sends the reader to
// Activity Monitor, which is the one outcome this readout exists to prevent.
import { describe, expect, it } from "vitest";
import {
  availableFromMeminfo,
  availableFromVmStat,
  parsePsProcesses,
  cpuFromDeltas,
  parseGetProcessJson,
  startSystemMetrics,
  stopSystemMetrics,
  swapFromMeminfo,
  swapFromSysctl,
  swapFromWmicJson,
  systemSnapshot,
} from "../../server/system-metrics.mjs";

// Trimmed from a real `vm_stat` on a 32 GB machine: 4 KiB pages, ~56k free but
// ~2.6M inactive. Naive "free" would call this 0.2 GB available; the truth is
// the free/speculative/inactive/purgeable sum.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                    56858.
Pages active:                                2632862.
Pages inactive:                              2628883.
Pages speculative:                              3067.
Pages throttled:                                   0.
Pages wired down:                            1609527.
Pages purgeable:                                 354.
`;

const MEMINFO = `MemTotal:       32780012 kB
MemFree:          412332 kB
MemAvailable:   18446120 kB
Buffers:          182044 kB
Cached:         14203112 kB
`;

const GB = 1024 ** 3;

describe("availableFromVmStat", () => {
  it("counts every page the kernel can reclaim, not just the free ones", () => {
    const avail = availableFromVmStat(VM_STAT, 32 * GB);
    // 56858 + 3067 + 2628883 + 354 = 2689162 pages x 4096
    expect(avail).toBe(2689162 * 4096);
    // The whole point, stated as the number a reader would see: ~34% available
    // rather than the 0.5% "free" alone would claim.
    expect(avail / (32 * GB)).toBeGreaterThan(0.3);
  });

  it("reads the page size from the header rather than assuming 4096", () => {
    const sixteenK = VM_STAT.replace("page size of 4096 bytes", "page size of 16384 bytes");
    expect(availableFromVmStat(sixteenK, 64 * GB)).toBe(2689162 * 16384);
  });

  it("returns null rather than a wrong number when the output is unusable", () => {
    expect(availableFromVmStat("", 32 * GB)).toBeNull();
    expect(availableFromVmStat("not vm_stat output", 32 * GB)).toBeNull();
    expect(availableFromVmStat(null, 32 * GB)).toBeNull();
  });

  it("refuses a total it cannot fit inside, so a misparse falls back instead of overstating", () => {
    // Same page counts against a machine with only 1 GB: impossible, so null.
    expect(availableFromVmStat(VM_STAT, 1 * GB)).toBeNull();
  });
});

describe("availableFromMeminfo", () => {
  it("takes MemAvailable, which is the kernel's own answer", () => {
    expect(availableFromMeminfo(MEMINFO)).toBe(18446120 * 1024);
  });

  it("does not settle for MemFree, which is the number that would be wrong", () => {
    // MemFree is 412332 kB here. Reading it would report 1.2% available on a
    // machine with 17 GB to give.
    expect(availableFromMeminfo(MEMINFO)).not.toBe(412332 * 1024);
  });

  it("returns null on a kernel too old to publish the field", () => {
    const old = MEMINFO.split("\n").filter(l => !l.startsWith("MemAvailable")).join("\n");
    expect(availableFromMeminfo(old)).toBeNull();
    expect(availableFromMeminfo("")).toBeNull();
  });
});

describe("systemSnapshot", () => {
  it("reports no CPU figure until a second sample gives it a delta", () => {
    stopSystemMetrics();
    const cold = systemSnapshot();
    // os.cpus() is a cumulative counter, so one reading is not a percentage.
    // Null, never 0: zero is a measurement, and we have not taken one.
    expect(cold.cpu).toBeNull();
    expect(cold.cpuHistory).toEqual([]);
  });

  it("always names the core count, so a saturated bar can be read against it", () => {
    stopSystemMetrics();
    expect(systemSnapshot().cores).toBeGreaterThan(0);
  });

  it("omits loadavg on Windows instead of printing three zeros as a reading", () => {
    stopSystemMetrics();
    const snap = systemSnapshot();
    if (process.platform === "win32") {
      expect(snap.loadavg).toBeNull();
    } else {
      // Elsewhere it is either a real triple or null — never [0, 0, 0] dressed
      // up as data.
      expect(snap.loadavg === null || snap.loadavg.length === 3).toBe(true);
    }
  });

  it("starts and stops without leaving its timers behind", () => {
    stopSystemMetrics();
    startSystemMetrics();
    startSystemMetrics(); // idempotent — a second call must not add a second pair
    stopSystemMetrics();
    expect(systemSnapshot().cpu).toBeNull();
  });
});

describe("swap, which is the reading a percentage cannot give you", () => {
  // A machine at "64% memory used" that is quietly paging 12 GB to disk is not
  // the same machine as one at 64% with an empty swap file, and the difference
  // is the one you can feel.
  it("reads macOS vm.swapusage, whose numbers carry their own unit", () => {
    const out = "total = 14336.00M  used = 12876.00M  free = 1460.00M  (encrypted)";
    expect(swapFromSysctl(out)).toEqual({
      total: 14336 * 1024 ** 2,
      used: 12876 * 1024 ** 2,
    });
  });

  it("honours a G suffix rather than assuming megabytes", () => {
    expect(swapFromSysctl("total = 8.00G  used = 2.00G  free = 6.00G"))
      .toEqual({ total: 8 * 1024 ** 3, used: 2 * 1024 ** 3 });
  });

  it("derives used from total minus free on Linux, which reports it that way", () => {
    const meminfo = "SwapTotal:       8388604 kB\nSwapFree:        6291452 kB\n";
    expect(swapFromMeminfo(meminfo)).toEqual({
      total: 8388604 * 1024,
      used: (8388604 - 6291452) * 1024,
    });
  });

  it("reports no swap rather than zero swap when the fields are absent", () => {
    expect(swapFromMeminfo("MemTotal: 100 kB")).toBeNull();
    expect(swapFromSysctl("")).toBeNull();
    expect(swapFromWmicJson("not json")).toBeNull();
  });

  it("reads Windows commit charge, where the same query means something else", () => {
    // Win32_OperatingSystem reports KB, and this is commit charge rather than a
    // swap file — named "Commit" in the UI for exactly that reason.
    const json = '{"TotalVirtualMemorySize":33554432,"FreeVirtualMemory":12582912}';
    expect(swapFromWmicJson(json)).toEqual({
      total: 33554432 * 1024,
      used: (33554432 - 12582912) * 1024,
    });
  });
});

describe("the process list", () => {
  const PS = `  PID  %CPU %MEM COMM
27993  56.6  2.4 dotnet
54317  53.0  0.2 node (vitest 8)
64025  51.9  1.9 claude
`;

  it("drops the header and keeps the command name with its spaces", () => {
    const rows = parsePsProcesses(PS);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ pid: 27993, cpu: 56.6, mem: 2.4, name: "dotnet" });
    // `node (vitest 8)` has to survive intact — splitting on whitespace would
    // truncate every process whose name has a space in it.
    expect(rows[1].name).toBe("node (vitest 8)");
  });

  it("honours the row limit so the panel never becomes a scroll", () => {
    expect(parsePsProcesses(PS, 2)).toHaveLength(2);
  });

  it("survives output it cannot parse", () => {
    expect(parsePsProcesses("")).toEqual([]);
    expect(parsePsProcesses(null)).toEqual([]);
  });

  it("reads Get-Process, not the perf counter class that may not exist", () => {
    // Win32_PerfFormattedData_PerfProc_Process is published by perflib, and
    // perflib is deregistered often enough to matter: on a machine reported
    // from the field the class was absent outright, and `typeperf` failed the
    // same way, which puts the fault below WMI rather than in it. Get-Process
    // reads through NtQuerySystemInformation and depends on nothing that can be
    // unregistered.
    const json = JSON.stringify([
      { Id: 42, ProcessName: "node", CPU: 12.5, WorkingSetPrivate: 1024 ** 3 },
      { Id: 7, ProcessName: "chrome", CPU: 3.25, WorkingSetPrivate: 512 * 1024 ** 2 },
    ]);
    const rows = parseGetProcessJson(json, 32 * 1024 ** 3);
    expect(rows.map(r => r.name)).toEqual(["node", "chrome"]);
    expect(rows[0].cpuSec).toBe(12.5);
    expect(rows[0].mem).toBeCloseTo(3.1, 1);
  });

  it("keeps an unreadable CPU null rather than calling it zero", () => {
    // A system process we cannot query has an UNKNOWN cpu time. Zero would sort
    // it as idle, which is a claim the reading does not support.
    const json = '[{"Id":4,"ProcessName":"System","CPU":null,"WorkingSetPrivate":0}]';
    expect(parseGetProcessJson(json, 1024).map(r => r.cpuSec)).toEqual([null]);
  });

  it("derives a percentage from two readings, normalised by core count", () => {
    // 4 CPU-seconds burned over 2 wall-seconds on 2 cores = 100% of one machine.
    const rows = [{ pid: 1, name: "a", cpuSec: 10, mem: 1 }];
    const prev = new Map([[1, 6]]);
    expect(cpuFromDeltas(rows, prev, 2000, 2)[0].cpu).toBe(100);
  });

  it("reports null for a process that did not exist at the previous reading", () => {
    // Its whole lifetime is not a rate. Counting it would rank a compiler that
    // started a second ago as though it had been burning a core since boot.
    const rows = [{ pid: 9, name: "new", cpuSec: 30, mem: 1 }];
    expect(cpuFromDeltas(rows, new Map(), 2000, 4)[0].cpu).toBeNull();
  });

  it("discards a counter that went backwards, which means the pid was reused", () => {
    const rows = [{ pid: 1, name: "a", cpuSec: 2, mem: 1 }];
    expect(cpuFromDeltas(rows, new Map([[1, 90]]), 2000, 4)[0].cpu).toBeNull();
  });

  it("falls back to memory order until a percentage exists to sort on", () => {
    const rows = [
      { pid: 1, name: "small", cpuSec: 5, mem: 0.5 },
      { pid: 2, name: "big", cpuSec: 5, mem: 9.0 },
    ];
    // No previous reading -> no cpu anywhere -> memory is the honest ordering.
    expect(cpuFromDeltas(rows, null, 2000, 4).map(r => r.name)).toEqual(["big", "small"]);
  });

  it("returns nothing rather than throwing on unparseable output", () => {
    expect(parseGetProcessJson("<html>error</html>", 1)).toEqual([]);
    expect(parseGetProcessJson(null, 1)).toEqual([]);
  });
});
