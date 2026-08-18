// The two readers behind /api/cswap-auto, tested against the text the CLIs
// actually print (#383). Both were exported with no caller outside their module
// and both are the kind of thing the sweep that filed #383 was warned about: not
// dead code, but a decision made by one regex against output the deck does not
// control, with nothing pinning it.
//
//   - `readCswapConfig` parses `cswap config`. Its answer IS the auto-switch
//     settings panel, and it is also `tickInterval`'s only input — a value it
//     misreads becomes the interval the deck polls Anthropic on.
//   - `externalAutoRunning` decides whether the deck's own loop stays silent. A
//     wrong `true` is a feature that quietly never runs; a wrong `false` is two
//     engines moving the user's live Claude account with no single place showing
//     why. Its Windows half runs a completely different command from its POSIX
//     half, and neither could be seen from the other before this file.
//
// Nothing is spawned: `run` answers from the test, so a regression is a wrong
// parse rather than a real `ps` or a real PowerShell on the machine running the
// suite. Plain node throughout — these are string readers, not components.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

/** Every `run` call the module under test made, and the answer handed back. */
const exec = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  reply: (_cmd: string, _args: string[]) => ({ ok: true, code: 0, killed: false, stdout: "", stderr: "" }),
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    exec.calls.push({ cmd, args });
    return exec.reply(cmd, args);
  },
  runDetached: () => {},
}));

// cswapBin() probes the real filesystem for an installed claude-swap; the name
// it resolves to is irrelevant here and the probe is not.
vi.mock("../../server/cswap-install.mjs", () => ({ cswapBin: async () => "cswap" }));

// @ts-expect-error — .mjs server module, no types
const { readCswapConfig, externalAutoRunning } = await import("../../server/cswap-auto.mjs") as {
  readCswapConfig: () => Promise<Record<string, { value: string | null; isDefault: boolean }> | null>;
  externalAutoRunning: () => Promise<boolean>;
};

const ok = (stdout: string) => ({ ok: true, code: 0, killed: false, stdout, stderr: "" });
const fail = () => ({ ok: false, code: 1, killed: false, stdout: "", stderr: "boom" });

/** Answer the next `run` with this stdout, whatever it is asked. */
const answer = (stdout: string) => { exec.reply = () => ok(stdout); };

beforeEach(() => { exec.calls.length = 0; exec.reply = () => ok(""); });

// The platform branch inside externalAutoRunning reads process.platform at call
// time, so both halves are reachable from either host — which is the only way
// the Windows one stays right, since it exists entirely for machines this suite
// is rarely run on.
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const asPlatform = (value: string) =>
  Object.defineProperty(process, "platform", { value, configurable: true });
afterAll(() => { Object.defineProperty(process, "platform", realPlatform); });

// ── cswap config ────────────────────────────────────────────────────────────

// Real `cswap config` output: the key, the value, and a `(default)` marker on
// any row the user has not set for themselves.
const CONFIG = [
  "autoswitch.enabled             true       (default)",
  "autoswitch.intervalSeconds     120",
  "autoswitch.thresholdPct        85         (default)",
  "autoswitch.model               (none)     (default)",
].join("\n");

describe("readCswapConfig on what `cswap config` prints", () => {
  it("reads the value and whether it is still the default", () => {
    // The panel renders these two facts side by side: what the setting is, and
    // whether the user chose it. Collapsing them would make every untouched
    // setting look deliberately configured.
    answer(CONFIG);
    return readCswapConfig().then(cfg => {
      expect(cfg).toEqual({
        "autoswitch.enabled":         { value: "true", isDefault: true },
        "autoswitch.intervalSeconds": { value: "120", isDefault: false },
        "autoswitch.thresholdPct":    { value: "85", isDefault: true },
        "autoswitch.model":           { value: null, isDefault: true },
      });
    });
  });

  it("turns `(none)` into null rather than the four-letter string", () => {
    // "(none)" is claude-swap's way of printing "unset". Carried through as text
    // it renders in the panel as if the user had literally typed it, and any
    // `Number(...)` over it is NaN rather than the absent it means.
    answer("autoswitch.model     (none)");
    return readCswapConfig().then(cfg => {
      expect(cfg!["autoswitch.model"].value).toBeNull();
    });
  });

  it("skips every line that is not a dotted setting", () => {
    // The CLI is written for a human: it prints headers, rules and a trailing
    // hint, none of which is a setting. The dot in the key is what tells them
    // apart, and a parser that took them all would fill the panel with junk.
    answer([
      "Settings",
      "--------",
      "",
      "key                  value",
      "autoswitch.enabled   true",
      "Run `cswap config set <key> <value>` to change one.",
    ].join("\n"));
    return readCswapConfig().then(cfg => {
      expect(Object.keys(cfg!)).toEqual(["autoswitch.enabled"]);
    });
  });

  it("keeps the spaces inside a value and drops the ones around it", () => {
    // A model name is one token today, but the column is free text and the
    // parser must not turn "claude sonnet 4" into "claude".
    answer("autoswitch.model     claude sonnet 4     (default)");
    return readCswapConfig().then(cfg => {
      expect(cfg!["autoswitch.model"]).toEqual({ value: "claude sonnet 4", isDefault: true });
    });
  });

  it("reads the same settings off Windows line endings", () => {
    // claude-swap is a Python tool and prints CRLF on Windows. `split("\\n")`
    // leaves a carriage return on the end of every line, and it lands exactly
    // where the `(default)` marker is looked for — so a parser that did not
    // absorb it would report every Windows user's settings as user-set, or
    // hand the panel values with a control character glued to them.
    answer(CONFIG.split("\n").join("\r\n"));
    return readCswapConfig().then(cfg => {
      expect(cfg!["autoswitch.intervalSeconds"]).toEqual({ value: "120", isDefault: false });
      expect(cfg!["autoswitch.enabled"]).toEqual({ value: "true", isDefault: true });
      expect(cfg!["autoswitch.model"]).toEqual({ value: null, isDefault: true });
    });
  });

  it("answers null when the CLI fails, which is not the same as no settings", () => {
    // `autoStatus` reports `ok: config != null`. An empty object here would say
    // "claude-swap is fine and has no settings", and the panel would render
    // itself as working with every row blank.
    exec.reply = () => fail();
    return readCswapConfig().then(cfg => {
      expect(cfg).toBeNull();
    });
  });

  it("answers an empty map for a CLI that succeeds and prints nothing", () => {
    answer("");
    return readCswapConfig().then(cfg => {
      expect(cfg).toEqual({});
    });
  });
});

// ── who else is running the engine ──────────────────────────────────────────

/** `ps -Ao args=` output with these command lines in it, plus the noise a real
 *  process table carries. */
const psOutput = (...lines: string[]) => [
  "/sbin/launchd",
  "node /usr/local/lib/node_modules/agents-deck/bin/agent-dag.js",
  ...lines,
].join("\n");

describe("externalAutoRunning on a POSIX process table", () => {
  beforeEach(() => { asPlatform("linux"); });

  it("asks ps for full command lines, not pgrep", () => {
    // BSD pgrep ignores -a and prints bare PIDs, so a command-line match against
    // its output silently never fires — the failure mode this call shape exists
    // to avoid, and one no assertion on the return value can see.
    answer(psOutput());
    return externalAutoRunning().then(() => {
      expect(exec.calls).toHaveLength(1);
      expect(exec.calls[0].cmd).toBe("ps");
      expect(exec.calls[0].args).toEqual(["-Ao", "args="]);
    });
  });

  it("finds the user's own long-lived loop", () => {
    answer(psOutput("cswap auto"));
    return externalAutoRunning().then(r => expect(r).toBe(true));
  });

  it("finds it behind the absolute path uv and pipx install it at", () => {
    answer(psOutput("/home/dorin/.local/bin/cswap auto --verbose"));
    return externalAutoRunning().then(r => expect(r).toBe(true));
  });

  it("does not mistake the deck's own tick for a competing engine", () => {
    // The deck ticks with `--once`, and its ticks are in the same process table
    // it is reading. Counting one would make the deck stand down permanently the
    // moment it started working, which is a feature that switches itself off.
    answer(psOutput("/home/dorin/.local/bin/cswap auto --once --json"));
    return externalAutoRunning().then(r => expect(r).toBe(false));
  });

  it("does not mistake a cron user's one-shot for a loop either", () => {
    answer(psOutput("/bin/sh -c cswap auto --once"));
    return externalAutoRunning().then(r => expect(r).toBe(false));
  });

  it("requires the word cswap to be the command, not the end of another one", () => {
    // A path or a name that merely ENDS in cswap is somebody else's program. The
    // pattern anchors on a separator or the start of the line for exactly this.
    answer(psOutput("/opt/bin/mycswap auto", "python -m notcswap auto"));
    return externalAutoRunning().then(r => expect(r).toBe(false));
  });

  it("requires `auto` to be the subcommand and not a prefix of another", () => {
    answer(psOutput("cswap autopilot", "cswap automate --forever"));
    return externalAutoRunning().then(r => expect(r).toBe(false));
  });

  it("says no when ps prints nothing at all", () => {
    // A container without ps, or one whose ps is refused. "Cannot see" must read
    // as "nobody is running one", because the alternative is a deck that never
    // ticks on a machine where nothing was ever competing with it.
    answer("   \n  \n");
    return externalAutoRunning().then(r => expect(r).toBe(false));
  });
});

describe("externalAutoRunning on Windows", () => {
  beforeEach(() => { asPlatform("win32"); });

  it("asks CIM for command lines, because tasklist only knows image names", () => {
    // Every Python tool is python.exe to tasklist, which cannot tell cswap from
    // anything else on the machine.
    answer("");
    return externalAutoRunning().then(() => {
      expect(exec.calls).toHaveLength(1);
      expect(exec.calls[0].cmd).toBe("powershell.exe");
      expect(exec.calls[0].args.join(" ")).toContain("Win32_Process");
      expect(exec.calls[0].args).toContain("-NoProfile");
    });
  });

  it("finds the loop however Windows spells the executable", async () => {
    // uv and pipx leave a .exe; an npm-style or scoop shim leaves a .cmd or a
    // .bat. All three are the same program, and the deck has to stand down for
    // any of them.
    for (const exe of ["cswap.exe", "cswap.cmd", "cswap.bat", "cswap"]) {
      exec.calls.length = 0;
      answer(`C:\\Users\\dorin\\.local\\bin\\${exe} auto`);
      expect(await externalAutoRunning(), exe).toBe(true);
    }
  });

  it("matches whatever case the process table reports", () => {
    // Windows paths are case-insensitive and CIM reports them as they were
    // typed, so the same install shows up as CSWAP.EXE or cswap.exe depending on
    // how it was launched.
    answer("C:\\Users\\dorin\\.local\\bin\\CSWAP.EXE AUTO");
    return externalAutoRunning().then(r => expect(r).toBe(true));
  });

  it("still lets the deck's own --once tick through", () => {
    answer("C:\\Users\\dorin\\.local\\bin\\cswap.exe auto --once --json");
    return externalAutoRunning().then(r => expect(r).toBe(false));
  });

  it("says no when PowerShell is missing or the query is refused", () => {
    // Constrained language mode, an ExecutionPolicy that blocks the command, or
    // no powershell.exe at all. Same rule as the POSIX side: unable to see is
    // not the same as seeing one, and the deck goes on ticking.
    exec.reply = () => fail();
    return externalAutoRunning().then(r => expect(r).toBe(false));
  });

  it("reads a CIM listing with CRLF line endings", () => {
    // Get-CimInstance pipes through PowerShell's own formatter, which ends every
    // line with a carriage return. The pattern requires `auto` to be followed by
    // whitespace or end-of-line, and the trimming that makes that true for the
    // last word on a CRLF line is the whole reason this passes.
    answer(["notepad.exe", "C:\\bin\\cswap.exe auto", ""].join("\r\n"));
    return externalAutoRunning().then(r => expect(r).toBe(true));
  });
});
