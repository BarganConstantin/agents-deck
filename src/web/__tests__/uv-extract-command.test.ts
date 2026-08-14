// The Windows half of the uv bootstrap unpacks a .zip by handing PowerShell a
// one-line program with the two paths written into it. Both paths sit under
// os.tmpdir(), which on Windows lives inside the user's own profile —
// C:\Users\O'Brien\AppData\Local\Temp — and an apostrophe is a legal character
// in a Windows account name. Written in raw, it closed the single-quoted string
// a dozen characters into the path, Expand-Archive failed to parse, and
// bootstrapUv answered "extract_failed" on a machine it was supposed to serve.
//
// Nothing here downloads, extracts or spawns anything: extractCommand only
// builds the argv, and homedir() is pointed at a scratch directory before the
// module loads so the real ~/.agents-deck is never even named.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-uv-extract-"));
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

// @ts-expect-error — .mjs server module, no types
const { extractCommand } = await import("../../server/uv-bootstrap.mjs");

/**
 * Read the single-quoted string literals out of a PowerShell command line the
 * way PowerShell's own parser does: a quote ends the literal unless the next
 * character is another quote, which stands for one apostrophe. Asserting on the
 * values this recovers is the point — it is what PowerShell will actually see,
 * rather than what the command line looks like to a reader.
 */
function psLiterals(command: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== "'") continue;
    let value = "";
    for (i++; i < command.length; i++) {
      if (command[i] === "'") {
        if (command[i + 1] !== "'") break;
        value += "'";
        i++;
        continue;
      }
      value += command[i];
    }
    out.push(value);
  }
  return out;
}

const WIN_TEMP = String.raw`C:\Users\O'Brien\AppData\Local\Temp\agents-deck-uv-4242`;
const WIN_ZIP = `${WIN_TEMP}\\uv-x86_64-pc-windows-msvc.zip`;

describe("the command that unpacks the uv artifact", () => {
  it("survives an apostrophe in the Windows temp path", () => {
    const { file, args } = extractCommand(WIN_ZIP, WIN_TEMP, "win32");

    expect(file).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    // PowerShell reads back exactly the two paths it was given — the apostrophe
    // is data inside the literal, not the end of it.
    expect(psLiterals(args[3])).toEqual([WIN_ZIP, WIN_TEMP]);
  });

  it("is the doubling PowerShell asks for, and only where it is needed", () => {
    const plain = String.raw`C:\Users\ada\AppData\Local\Temp\agents-deck-uv-7`;
    const { args } = extractCommand(`${plain}\\uv.zip`, plain, "win32");

    // No apostrophe, no escaping: an ordinary path is written straight through.
    expect(args[3]).toContain(`'${plain}'`);
    expect(args[3]).not.toContain("''");

    // The bug itself: without the doubling the literal ends at the apostrophe,
    // and PowerShell is handed a path that stops after "C:\Users\O".
    const naive = `Expand-Archive -LiteralPath '${WIN_ZIP}' -DestinationPath '${WIN_TEMP}' -Force`;
    expect(psLiterals(naive)[0]).not.toBe(WIN_ZIP);
  });

  it("keeps backslashes and spaces literal, since Expand-Archive gets -LiteralPath", () => {
    const spaced = String.raw`C:\Users\Ann O'Neil\Temp\deck [1]`;
    const { args } = extractCommand(`${spaced}\\uv.zip`, spaced, "win32");

    expect(psLiterals(args[3])).toEqual([`${spaced}\\uv.zip`, spaced]);
    expect(args[3]).toContain("-LiteralPath");
    expect(args[3]).toContain("-Force");
  });

  it("passes the paths to tar as arguments, where no quoting applies at all", () => {
    const dir = "/tmp/agents-deck-uv-9/O'Brien dir";
    const archive = `${dir}/uv-aarch64-apple-darwin.tar.gz`;

    for (const platform of ["darwin", "linux"]) {
      const { file, args } = extractCommand(archive, dir, platform);
      expect(file).toBe("tar");
      // Each path is its own argv entry, so it reaches tar byte for byte.
      expect(args).toEqual(["-xzf", archive, "-C", dir]);
    }
  });
});
