#!/usr/bin/env node
// agent-dag CLI entrypoint. Registers hooks, starts server, opens browser.
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
  console.log(r.changed ? "agent-dag: hooks removed from ~/.claude/settings.json" : "agent-dag: no hooks to remove");
  process.exit(0);
}

const port = Number(flags.port ?? process.env.AGENT_DAG_PORT ?? 4317);
const workspace = flags.all ? "" : (flags.workspace ?? process.cwd());
const openBrowser = flags.noOpen !== true;
const persist = flags.noPersist
  ? null
  : (flags.history ?? join(homedir(), ".claude", "agent-dag", "events.jsonl"));

const { installHooks, writeDiscovery, removeDiscovery } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
const { startServer } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/index.mjs")).href);

const WEB_DIST = join(PKG_ROOT, "dist", "web", "index.html");
if (!existsSync(WEB_DIST)) {
  console.error("agent-dag: ui not built. run `npm run build` (or `pnpm build`) first.");
  process.exit(1);
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const C = {
  reset:   tty ? "\x1b[0m"  : "",
  bold:    tty ? "\x1b[1m"  : "",
  dim:     tty ? "\x1b[2m"  : "",
  cyan:    tty ? "\x1b[36m" : "",
  blue:    tty ? "\x1b[34m" : "",
  magenta: tty ? "\x1b[35m" : "",
  yellow:  tty ? "\x1b[33m" : "",
  green:   tty ? "\x1b[32m" : "",
  white:   tty ? "\x1b[97m" : "",
  bCyan:   tty ? "\x1b[96m" : "",
  bMag:    tty ? "\x1b[95m" : "",
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Animated banner ───────────────────────────────────────────────────────────
async function printBanner() {
  const IW = 38; // inner visible width between ║ chars
  const pad = (visLen) => " ".repeat(Math.max(0, IW - visLen));
  const HR = "═".repeat(IW);

  // Each entry: [rendered string with ANSI, visible char count, left-border color, right-border color]
  const rows = [
    { l: `  ${C.bCyan}${C.bold}◉${C.reset}  ${C.white}${C.bold}agent-dag${C.reset}  ${C.dim}v1.0.4${C.reset}`, vis: 22, lc: C.blue,    rc: C.blue    },
    { l: `  ${C.dim}live DAG · Claude Code agents${C.reset}`,                                                   vis: 31, lc: C.magenta, rc: C.magenta },
    { l: `  ${C.yellow}watch agents fork  ${C.cyan}→${C.reset}  ${C.green}tools fire${C.reset}`,               vis: 34, lc: C.bMag,    rc: C.bMag    },
  ];

  const lines = [
    "",
    `  ${C.cyan}${C.bold}╔${HR}╗${C.reset}`,
    ...rows.map(r => `  ${r.lc}${C.bold}║${C.reset}${r.l}${pad(r.vis)}${r.rc}${C.bold}║${C.reset}`),
    `  ${C.cyan}${C.bold}╚${HR}╝${C.reset}`,
    "",
  ];
  for (const line of lines) {
    process.stdout.write(line + "\n");
    if (tty) await sleep(45);
  }
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function spinner(label) {
  if (!tty) { process.stdout.write(`  … ${label}\n`); return { stop: (ok, msg) => process.stdout.write(`  ${ok ? "✓" : "✗"} ${msg}\n`) }; }
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(`\r  ${C.cyan}${frames[i++ % frames.length]}${C.reset}  ${label}`);
  }, 80);
  return {
    stop(ok, msg) {
      clearInterval(iv);
      const icon = ok ? `${C.green}✓${C.reset}` : `${C.yellow}✗${C.reset}`;
      process.stdout.write(`\r  ${icon}  ${msg}\n`);
    }
  };
}

await printBanner();

// ── Startup steps ─────────────────────────────────────────────────────────────
process.stdout.write(`  ${C.dim}workspace :${C.reset} ${workspace === "" ? C.yellow + "(all)" + C.reset : workspace}\n`);

let sp = spinner("installing hooks…");
const { settingsPath, hookPath } = await installHooks();
sp.stop(true, `hooks installed  ${C.dim}→ ${hookPath}${C.reset}`);

sp = spinner("starting server…");
const server = await startServer({ port, persist }).catch(err => {
  sp.stop(false, `server failed: ${err.message}`);
  process.exit(1);
});
const addr = server.address();
const realPort = typeof addr === "object" && addr ? addr.port : port;
const url = `http://127.0.0.1:${realPort}`;
sp.stop(true, `server ready     ${C.dim}→ ${C.reset}${C.bCyan}${C.bold}${url}${C.reset}`);

if (persist) process.stdout.write(`  ${C.dim}log       : ${persist}${C.reset}\n`);

process.stdout.write(`\n  ${C.green}${C.bold}▶  opening browser…${C.reset}\n\n`);

const discoveryFile = await writeDiscovery({ port: realPort, workspace });

if (openBrowser) {
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {}
}

// ── Pulse indicator ───────────────────────────────────────────────────────────
if (tty) {
  const pulseFrames = [`${C.green}●${C.reset}`, `${C.dim}●${C.reset}`];
  let pi = 0;
  setInterval(() => {
    process.stdout.write(`\r  ${pulseFrames[pi++ % 2]}  ${C.dim}listening — Ctrl+C to stop${C.reset}   `);
  }, 800).unref();
}

const shutdown = async () => {
  if (tty) process.stdout.write(`\n\n  ${C.yellow}◉  shutting down…${C.reset}\n`);
  await removeDiscovery(discoveryFile);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", () => removeDiscovery(discoveryFile));

// ── helpers ───────────────────────────────────────────────────────────────────

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
  process.stdout.write(`agent-dag — live DAG of Claude Code agents

Usage:
  agent-dag [options]

Options:
  -p, --port <number>      Preferred port (default: 4317; falls back to random 4318–4400)
      --no-open            Don't open the browser automatically
      --workspace <path>   Workspace root (default: cwd)
      --all                Capture sessions from ALL workspaces (machine-wide)
      --history <path>     Override events log file (default: ~/.claude/agent-dag/events.jsonl)
      --no-persist         Don't write or replay events log (RAM-only)
      --uninstall          Remove agent-dag hook entries from ~/.claude/settings.json
  -h, --help               Show this help
`);
}
