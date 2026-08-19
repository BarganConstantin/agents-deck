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
  psArgs,
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

  it("derives a percentage from two readings, per core like the Unix column", () => {
    // 4 CPU-seconds burned over 2 wall-seconds = two cores' worth = 200, the
    // same reading `ps -o pcpu` gives for the same work. Not 100: that was the
    // core-count division of #493, which made this the only column on the deck
    // whose meaning depended on the machine it ran on.
    const rows = [{ pid: 1, name: "a", cpuSec: 10, mem: 1 }];
    const prev = new Map([[1, 6]]);
    expect(cpuFromDeltas(rows, prev, 2000)[0].cpu).toBe(200);
  });

  it("reports null for a process that did not exist at the previous reading", () => {
    // Its whole lifetime is not a rate. Counting it would rank a compiler that
    // started a second ago as though it had been burning a core since boot.
    const rows = [{ pid: 9, name: "new", cpuSec: 30, mem: 1 }];
    expect(cpuFromDeltas(rows, new Map(), 2000)[0].cpu).toBeNull();
  });

  it("discards a counter that went backwards, which means the pid was reused", () => {
    const rows = [{ pid: 1, name: "a", cpuSec: 2, mem: 1 }];
    expect(cpuFromDeltas(rows, new Map([[1, 90]]), 2000)[0].cpu).toBeNull();
  });

  it("falls back to memory order until a percentage exists to sort on", () => {
    const rows = [
      { pid: 1, name: "small", cpuSec: 5, mem: 0.5 },
      { pid: 2, name: "big", cpuSec: 5, mem: 9.0 },
    ];
    // No previous reading -> no cpu anywhere -> memory is the honest ordering.
    expect(cpuFromDeltas(rows, null, 2000).map(r => r.name)).toEqual(["big", "small"]);
  });

  it("returns nothing rather than throwing on unparseable output", () => {
    expect(parseGetProcessJson("<html>error</html>", 1)).toEqual([]);
    expect(parseGetProcessJson(null, 1)).toEqual([]);
  });
});

// The parsers had fixtures; the command that produces the fixture had none, and
// that is the half that differs per platform. `ps -Aceo pid,pcpu,pmem,comm -r`
// shipped for both Unixes in 1.36.0 and 1.36.1, and `-r` is a CPU sort on BSD
// and a filter on state `R` in PID order on procps. The Linux table was never
// empty and never errored — it was just not the busiest processes (#492).
describe("the ps invocation, which is not the same on both Unixes", () => {
  it("never passes -r on Linux, where it filters to state R instead of sorting", () => {
    expect(psArgs("linux")).not.toContain("-r");
  });

  it("asks procps for the sort it does understand", () => {
    // --sort=-pcpu is procps' own way to say what -r says on BSD.
    expect(psArgs("linux")).toContain("--sort=-pcpu");
  });

  it("keeps macOS on the flags that were right there all along", () => {
    // Unchanged from 1.36.0: -r sorts by CPU on BSD, -c prints the accounting
    // name instead of the argument vector.
    expect(psArgs("darwin")).toEqual(["-Aceo", "pid,pcpu,pmem,comm", "-r"]);
  });

  it("leaves the other BSDs on the BSD form rather than a GNU long option", () => {
    // --sort is procps-only; handing it to FreeBSD's ps would exit non-zero and
    // blank a table that works today. Linux is the platform that was wrong, so
    // linux is the only branch that changes.
    expect(psArgs("freebsd")).toEqual(psArgs("darwin"));
    expect(psArgs("openbsd")).toEqual(psArgs("darwin"));
  });

  it("asks for the same four columns in the same order, so one parser reads both", () => {
    // The parser takes pid, pcpu, pmem and then everything left on the line as
    // the name. A different column order on Linux would mean silently reading
    // the memory column as CPU.
    for (const platform of ["darwin", "linux"]) {
      const spec = psArgs(platform).find(a => a.includes("pid,"));
      expect(spec).toBe("pid,pcpu,pmem,comm");
    }
  });

  it("never asks for argv on either Unix, which is what keeps a prompt out of the UI", () => {
    // `comm` is the executable name. `args`/`command` would put the full command
    // line — every prompt and every token typed on one — into the panel.
    for (const platform of ["darwin", "linux"]) {
      const joined = psArgs(platform).join(" ");
      expect(joined).not.toMatch(/\bargs\b|\bcommand\b/);
    }
  });

  it("parses real procps output, truncated 15-character comm and all", () => {
    // Shaped like `ps -eo pid,pcpu,pmem,comm --sort=-pcpu` on procps: a wider
    // PID column, a COMMAND header rather than COMM, and names capped at 15
    // characters by /proc/<pid>/comm. The rows are sorted by CPU descending and
    // include sleeping processes — which is the whole difference from the state
    // R filter that shipped.
    const PROCPS = `    PID %CPU %MEM COMMAND
   4821 98.7  3.1 node
   1290 51.9  1.9 containerd-shim
      1  0.1  0.4 systemd
`;
    const rows = parsePsProcesses(PROCPS);
    expect(rows.map(r => r.pid)).toEqual([4821, 1290, 1]);
    expect(rows.map(r => r.cpu)).toEqual([98.7, 51.9, 0.1]);
    // Truncation shortens the name; it must not shift a column or drop a row.
    expect(rows[1]).toEqual({ pid: 1290, cpu: 51.9, mem: 1.9, name: "containerd-shim" });
  });
});

// Both platforms report a CPU column and they were on different scales, so the
// same workload read roughly `cores`x smaller on Windows: on a 12-core machine
// six busy cores were 600 on macOS and 50 on Windows (#493). The test that stops
// this recurring pins the agreement rather than either number.
describe("one CPU scale across platforms", () => {
  /** One core, fully busy, expressed the way each platform reports it. */
  const unixCpu = (pcpu: string) =>
    parsePsProcesses(`  PID  %CPU %MEM COMM\n  42 ${pcpu}  1.0 busy\n`)[0].cpu;
  const winCpu = (cpuSecBurned: number, wallMs: number) =>
    cpuFromDeltas(
      [{ pid: 42, name: "busy", cpuSec: 100 + cpuSecBurned, mem: 1.0 }],
      new Map([[42, 100]]),
      wallMs,
    )[0].cpu;

  it("reads the same for one fully busy core through either parser", () => {
    // Unix: pcpu is a percentage of one core. Windows: 2 CPU-seconds burned over
    // 2 wall-seconds is one core held for the whole interval. Same machine state,
    // so the same number — whatever convention that number belongs to.
    expect(winCpu(2, 2000)).toBe(unixCpu("100.0"));
    expect(winCpu(2, 2000)).toBe(100);
  });

  it("agrees on the multi-core reading that a 0-100 column cannot express", () => {
    // The `dotnet 157` row from the issue: one and a half cores. Windows used to
    // print 13.1 for this on a 12-core machine.
    expect(winCpu(3.14, 2000)).toBe(unixCpu("157.0"));
    expect(winCpu(3.14, 2000)).toBe(157);
  });

  it("no longer caps Windows at 100, which hid every multi-threaded process", () => {
    // Six cores busy for the interval. The old clamp made this 50 on a 12-core
    // machine, in a column whose top value everywhere else is 1200.
    expect(winCpu(12, 2000)).toBe(600);
  });

  it("does not vary with the core count, because core count is no longer in reach", () => {
    // cpuFromDeltas takes no `cores` argument any more. The 4th positional is
    // the row limit, so a stray core count cannot quietly divide anything again.
    const rows = [
      { pid: 1, name: "a", cpuSec: 4, mem: 1 },
      { pid: 2, name: "b", cpuSec: 3, mem: 1 },
    ];
    const prev = new Map([[1, 2], [2, 2]]);
    expect(cpuFromDeltas(rows, prev, 1000, 1)).toEqual([
      { pid: 1, cpu: 200, mem: 1, name: "a" },
    ]);
  });
});
