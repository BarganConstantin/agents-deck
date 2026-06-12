#!/usr/bin/env node
// ccgraph CLI entrypoint. Registers hooks, starts server, opens browser.
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flags = parseArgs(argv);

if (flags.help) {
  printHelp();
  process.exit(0);
}

if (flags.uninstall) {
  const { uninstallHooks } = await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
  const r = await uninstallHooks();
  console.log(r.changed ? "ccgraph: hooks removed from ~/.claude/settings.json" : "ccgraph: no hooks to remove");
  process.exit(0);
}

const port = Number(flags.port ?? process.env.CCGRAPH_PORT ?? 4317);
const workspace = flags.all ? "" : (flags.workspace ?? process.cwd());
const openBrowser = flags.noOpen !== true;
const persist = flags.noPersist
  ? null
  : (flags.history ?? join(homedir(), ".claude", "ccgraph", "events.jsonl"));

const { installHooks, writeDiscovery, removeDiscovery } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
const { startServer } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/index.mjs")).href);

const WEB_DIST = join(PKG_ROOT, "dist", "web", "index.html");
if (!existsSync(WEB_DIST)) {
  console.error("ccgraph: ui not built. run `npm run build` (or `pnpm build`) first.");
  process.exit(1);
}

console.log("ccgraph");
console.log("  workspace:", workspace === "" ? "(all)" : workspace);

const { settingsPath, hookPath, events } = await installHooks();
console.log("  hook installed:", hookPath);
console.log("  events:", events.join(", "));
console.log("  settings:", settingsPath);

const server = await startServer({ port, persist }).catch(err => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`\nccgraph: port ${port} in use. Try --port <N>.`);
  } else {
    console.error("ccgraph: server failed:", err.message);
  }
  process.exit(1);
});

const addr = server.address();
const realPort = typeof addr === "object" && addr ? addr.port : port;
const url = `http://127.0.0.1:${realPort}`;

const discoveryFile = await writeDiscovery({ port: realPort, workspace });
console.log(`  url: ${url}`);
if (persist) console.log(`  log: ${persist}`);

if (openBrowser) {
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {
    // open is optional; user can navigate manually.
  }
}

const shutdown = async () => {
  await removeDiscovery(discoveryFile);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", () => removeDiscovery(discoveryFile));

// --- helpers ---

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-p" || a === "--port") out.port = args[++i];
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--workspace") out.workspace = args[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--no-persist") out.noPersist = true;
    else if (a === "--history") out.history = args[++i];
  }
  return out;
}

function printHelp() {
  process.stdout.write(`ccgraph — live DAG of Claude Code agents

Usage:
  ccgraph [options]

Options:
  -p, --port <number>      Port for the server (default: 4317)
      --no-open            Don't open the browser automatically
      --workspace <path>   Workspace root (default: cwd)
      --all                Capture sessions from ALL workspaces (machine-wide)
      --history <path>     Override events log file (default: ~/.claude/ccgraph/events.jsonl)
      --no-persist         Don't write or replay events log (RAM-only)
      --uninstall          Remove ccgraph hook entries from ~/.claude/settings.json
  -h, --help               Show this help
`);
}
