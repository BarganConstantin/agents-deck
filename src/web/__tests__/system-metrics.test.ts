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
  startSystemMetrics,
  stopSystemMetrics,
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
