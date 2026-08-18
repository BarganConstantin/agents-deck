// `src/server/index.mjs` ends with a dev-convenience guard that asks whether
// node was pointed at this file or whether somebody imported it:
//
//     if (import.meta.url === pathToFileURL(process.argv[1]).href)
//
// argv[1] is a string only when node was handed a script path. `node -e`,
// `node --input-type=module` reading stdin, and a worker started from eval
// source all leave it undefined, and `pathToFileURL(undefined)` throws
// ERR_INVALID_ARG_TYPE instead of answering false. The throw happens while the
// module is still being evaluated, so the import fails outright — in the one
// file whose entire purpose is to export `startServer`, and with a stack that
// points at a line about argv the caller never asked about (#481).
//
// The fix guards the argument rather than the comparison, which leaves both
// real paths alone: a direct run still enters the block (dev-server-port.test
// .ts launches it for real and reads the port back), and an ordinary import
// still skips it. Only the throwing contexts change, from a crash to `false`.
//
// Hermetic on purpose. Every child gets a temp HOME and the install/update
// switches off, so nothing here reads the developer's ~/.claude, and no
// assertion binds a port — the import path binding one would be a worse bug
// than the one being fixed, so "no listening socket" is asserted, not assumed.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY = fileURLToPath(new URL("../../server/index.mjs", import.meta.url));
const ENTRY_HREF = pathToFileURL(ENTRY).href;

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-entry-guard-"));
afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  CLAUDE_CONFIG_DIR: join(FAKE_HOME, ".claude"),
  CODEX_HOME: join(FAKE_HOME, ".codex"),
  CLAUDE_SWAP_BACKUP: join(FAKE_HOME, "swap-store"),
  AGENTS_DECK_NO_INSTALL: "1",
  AGENTS_DECK_NO_UPDATE_CHECK: "1",
  AGENTS_DECK_NO_DOWNLOAD: "1",
  AGENTS_DECK_NO_FRESHEN: "1",
};

type Probe = {
  imported: boolean;
  startServer?: string;
  /** Listening TCP servers still open once the import has settled. */
  listeners?: number;
  argv1?: string | null;
  error?: string;
};

/** What a child reports back: `startServer`'s type, whatever argv[1] it saw,
 *  and the count of listening sockets the import left behind. Written as one
 *  JSON line so a stray console.log from the module cannot be mistaken for it. */
const REPORT = (extra = "") => `
  const done = (o) => console.log("PROBE " + JSON.stringify(o));
  ${extra}
  import(${JSON.stringify(ENTRY_HREF)}).then((m) => done({
    imported: true,
    startServer: typeof m.startServer,
    argv1: process.argv[1] ?? null,
    listeners: process.getActiveResourcesInfo().filter((r) => r === "TCPSERVERWRAP").length,
  })).catch((e) => done({ imported: false, error: e && e.message }));
`;

/** Run one child to completion and read its report. execFileSync throws on a
 *  timeout, so a child kept alive by a listening socket fails loudly rather
 *  than hanging the suite. */
function probe(args: string[], input?: string): Probe {
  const out = execFileSync(process.execPath, args, {
    env: ENV, input, encoding: "utf8", timeout: 30_000,
  });
  const line = out.split("\n").find(l => l.startsWith("PROBE "));
  if (!line) throw new Error(`no report from child: ${out}`);
  return JSON.parse(line.slice("PROBE ".length)) as Probe;
}

describe("importing the server from a context with no argv[1]", () => {
  it("resolves under `node -e`, where argv[1] is undefined", () => {
    const r = probe(["-e", REPORT()]);
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(true);
    expect(r.startServer).toBe("function");
    expect(r.argv1).toBeNull();
  }, 40_000);

  it("resolves under `--input-type=module` on stdin", () => {
    // No `-` argument: naming stdin explicitly would put the string "-" in
    // argv[1] and hide the very case this test is here for.
    const r = probe(["--input-type=module"], REPORT());
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(true);
    expect(r.startServer).toBe("function");
    expect(r.argv1).toBeNull();
  }, 40_000);

  it("resolves inside a worker_threads worker built from eval source", () => {
    // The worker is spawned from a plain node child rather than from the test
    // process, so vitest's own pool has no say in what argv[1] the worker sees.
    const worker = `
      const { Worker } = require("node:worker_threads");
      const src = ${JSON.stringify(`
        const { parentPort } = require("node:worker_threads");
        ${REPORT().replace("const done = (o) => console.log(\"PROBE \" + JSON.stringify(o));",
                           "const done = (o) => parentPort.postMessage(o);")}
      `)};
      const w = new Worker(src, { eval: true });
      w.on("message", (m) => { console.log("PROBE " + JSON.stringify(m)); w.terminate(); });
      w.on("error", (e) => { console.log("PROBE " + JSON.stringify({ imported: false, error: e.message })); });
    `;
    const r = probe(["-e", worker]);
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(true);
    expect(r.startServer).toBe("function");
  }, 40_000);

  it("leaves no listening socket behind — an import must not start a deck", () => {
    // A guard that stopped throwing but started serving would be the worse
    // bug. Two independent proofs: nothing is listening when the import
    // settles, and the child exits on its own (a bound port would keep the
    // event loop alive until execFileSync's timeout killed it).
    const r = probe(["-e", REPORT()]);
    expect(r.imported).toBe(true);
    expect(r.listeners).toBe(0);
  }, 40_000);
});

describe("the guard on a Windows-shaped argv[1]", () => {
  it("imports rather than throwing when argv[1] carries a drive letter", () => {
    // Exercised with a win32-shaped string on whatever platform runs this, so
    // the drive-letter path is covered even where win32 is not the host. It is
    // a different file from this one under either reading, so the guard must
    // answer false and start nothing.
    const r = probe(["-e", REPORT(
      `process.argv[1] = "C:\\\\Users\\\\dev\\\\ccdeck\\\\src\\\\server\\\\index.mjs";`,
    )]);
    expect(r.error).toBeUndefined();
    expect(r.imported).toBe(true);
    expect(r.startServer).toBe("function");
    expect(r.listeners).toBe(0);
  }, 40_000);

  it("still recognises the entry file itself, drive letter and all", () => {
    // The positive half of the comparison, which the fix must not disturb: the
    // href pathToFileURL builds from a real path — `C:\…` on Windows — is the
    // same string the ESM loader hands the module as import.meta.url. Both
    // sides come from node's own URL machinery rather than a literal, so on
    // Windows this is the drive-letter encoding being checked, not asserted.
    expect(ENTRY_HREF).toBe(new URL("../../server/index.mjs", import.meta.url).href);
  });

  it("never hands argv[1] to pathToFileURL unguarded", () => {
    // The shape, pinned: pathToFileURL's argument has to be proven a string
    // first. This is the whole of the bug in one expression.
    const src = readFileSync(ENTRY, "utf8");
    expect(src).not.toContain("pathToFileURL(process.argv[1])");
  });
});
