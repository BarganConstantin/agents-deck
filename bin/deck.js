#!/usr/bin/env node
// The deck itself: registers hooks, starts the server, opens the browser.
// Launched by the supervisor in bin/agent-dag.js, which restarts it when it
// exits with RESTART_CODE. On a respawn (AGENTS_DECK_RESPAWN=1) everything that
// was already done once this session is skipped — that is what makes a restart
// take about a second instead of the better part of ten.
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
})();

const argv = process.argv.slice(2);
const flags = parseArgs(argv);

// Exit codes the supervisor reads as "bring me back": 75 from the files on
// disk, 76 through npx — which is the only way an npx run reaches a newer
// version, since its directory is never upgraded in place. Anything else it
// forwards.
const RESTART_CODE = 75;
const UPGRADE_CODE = 76;
const RESPAWN = process.env.AGENTS_DECK_RESPAWN === "1";
const SUPERVISED = typeof process.send === "function";

if (flags.help) {
  printHelp();
  process.exit(0);
}

if (flags.uninstall) {
  const { uninstallHooks, hasCodexInstalled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
  const claude = await uninstallHooks({ provider: "claude" });
  console.log(claude.changed
    ? `agents-deck: hooks removed from ${claude.settingsPath}`
    : "agents-deck: no Claude hooks to remove");
  // The sound toggle is a second entry in the same file, marked
  // __agent-dag-sound rather than __agent-dag, and uninstallHooks does not know
  // that mark — so it used to be left behind, playing on every turn after the
  // deck was supposedly gone. It also parks the user's own afplay/PowerShell
  // Stop hooks while it is on, and once the deck is uninstalled nothing else can
  // put them back, so this restores them too.
  const { uninstallSoundHook } = await import(pathToFileURL(join(PKG_ROOT, "src/server/sound-hook.mjs")).href);
  const sound = await uninstallSoundHook();
  if (sound.ok === false) {
    console.error(`agents-deck: sound hook left in place — ${sound.message}`);
  } else {
    if (sound.removed) console.log("agents-deck: sound hook removed");
    if (sound.restored) console.log(`agents-deck: restored ${sound.restored} of your own sound hook(s)`);
  }
  if (hasCodexInstalled()) {
    const codex = await uninstallHooks({ provider: "codex" });
    console.log(codex.changed
      ? `agents-deck: hooks removed from ${codex.settingsPath}`
      : "agents-deck: no Codex hooks to remove");
  }
  process.exit(0);
}

const port = Number(flags.port ?? process.env.AGENT_DAG_PORT ?? 4317);
// Default = machine-wide (capture every CC session on this box). Pass
// `--workspace <path>` (or `--scope`) to restrict to a single tree.
const workspace = flags.workspace != null
  ? flags.workspace
  : (flags.scope ? process.cwd() : "");
const openBrowser = flags.noOpen !== true;
// The events log lives beside the discovery files, so it follows the Claude
// config dir rather than assuming ~/.claude — see src/server/claude-dir.mjs.
const { claudeConfigDir } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-dir.mjs")).href);
// Resolved here rather than left as typed: the discovery file publishes this
// path so the hook can tell which decks share one log and elect a single
// writer for it, and two spellings of one file would read as two files.
// startServer resolves it the same way, from this same process, so the two
// always name the same file.
const persist = flags.noPersist
  ? null
  : resolve(flags.history ?? join(claudeConfigDir(), "agent-dag", "events.jsonl"));

const { installHooks, keepDiscovery, removeDiscovery, hasCodexInstalled } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
const { startServer, hookToken } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/index.mjs")).href);

// Codex hooks install when ~/.codex/ exists, unless --no-codex was passed.
// --codex forces install even if the dir is missing (creates it).
const wantCodex = flags.noCodex
  ? false
  : (flags.codex === true || hasCodexInstalled());

const WEB_DIST = join(PKG_ROOT, "dist", "web", "index.html");
if (!existsSync(WEB_DIST)) {
  console.error("agents-deck: ui not built. run `npm run build` (or `pnpm build`) first.");
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
  // figlet slant font — hardcoded, no runtime dep
  const ART = [
    '                          __                 __          __  ',
    '  ____ _____ ____  ____  / /______      ____/ /__  _____/ /__',
    ' / __ `/ __ `/ _ \\/ __ \\/ __/ ___/_____/ __  / _ \\/ ___/ //_/',
    '/ /_/ / /_/ /  __/ / / / /_(__  )_____/ /_/ /  __/ /__/ ,<   ',
    '\\__,_/\\__, /\\___/_/ /_/\\__/____/      \\__,_/\\___/\\___/_/|_|  ',
    '     /____/                                                    ',
  ];
  const COLORS = [C.dim, C.blue, C.cyan, C.bCyan, C.magenta, C.dim];

  process.stdout.write('\n');

  if (tty) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    for (let i = 0; i < 8; i++) {
      process.stdout.write(`\r  ${C.bCyan}${frames[i % frames.length]}${C.reset}  ${C.dim}loading…${C.reset}`);
      await sleep(70);
    }
    process.stdout.write('\r' + ' '.repeat(28) + '\n');
    await sleep(40);
  }

  for (let i = 0; i < ART.length; i++) {
    process.stdout.write(` ${COLORS[i]}${ART[i]}${C.reset}\n`);
    if (tty) await sleep(38);
  }

  process.stdout.write(`\n  ${C.dim}v${PKG_VERSION}  ·  live agent DAG · Claude Code + Codex${C.reset}\n\n`);
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

let sp;

// Everything in here is once-per-session setup — hook install, tool probes,
// registry lookups, and about 600ms of deliberate banner animation. A respawn
// is the same session continuing, so it skips the lot and prints one line
// instead. This is the difference between a restart that feels instant and one
// that makes you wonder whether it worked.
if (!RESPAWN) {
await printBanner();

// ── Startup steps ─────────────────────────────────────────────────────────────
process.stdout.write(`  ${C.dim}workspace :${C.reset} ${workspace === "" ? C.yellow + "(all)" + C.reset : workspace}\n`);

sp = spinner("installing Claude hooks…");
let claudeInstall;
try {
  claudeInstall = await installHooks({ provider: "claude" });
} catch (err) {
  // Settings the installer cannot parse are settings it cannot rewrite without
  // losing them, so it refuses. That refusal has to be said out loud: the file
  // it names is one only the user can repair, and every Claude Code session on
  // this machine is reading it too.
  sp.stop(false, `Claude hooks     ${C.dim}not installed${C.reset}`);
  console.error(`\n  agents-deck: ${err.message}\n`);
  process.exit(1);
}
sp.stop(true, `Claude hooks     ${C.dim}→ ${claudeInstall.hookPath}${C.reset}`);

// Codex CLI hooks never fire on Windows (sandbox refuses to spawn the hook
// command). Instead the server tails Codex's rollout JSONL files directly, so
// there's nothing to install and no /hooks trust step. We just confirm Codex
// is present and let the watcher pick up sessions.
if (wantCodex) {
  process.stdout.write(`  ${C.green}✓${C.reset} Codex sessions    ${C.dim}→ watching ${join(homedir(), ".codex", "sessions")}${C.reset}\n`);
} else {
  process.stdout.write(`  ${C.dim}Codex watch skipped (no ~/.codex/, or --no-codex)${C.reset}\n`);
}

// claude-swap backs the multi-account panel. Installing it touches the user's
// global tool path, so unlike the ccusage install this one announces itself.
{
  const { ensureCswap } = await import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-install.mjs")).href);
  const csp = spinner("checking claude-swap…");
  const cs = await ensureCswap();
  if (cs.state === "present") {
    csp.stop(true, `claude-swap      ${C.dim}→ v${cs.version} (accounts panel enabled)${C.reset}`);
  } else if (cs.state === "installed") {
    csp.stop(true, `claude-swap      ${C.dim}→ installed v${cs.version} via ${cs.via}${C.reset}`);
  } else if (cs.state === "upgrading") {
    csp.stop(true, `claude-swap      ${C.dim}→ v${cs.version}, upgrading to v${cs.latest} in background${C.reset}`);
  } else if (cs.state === "skipped") {
    csp.stop(true, `claude-swap      ${C.dim}not installed (AGENTS_DECK_NO_INSTALL=1)${C.reset}`);
  } else {
    const how = cs.reason === "no_installer"
      ? "not installed — the accounts panel needs it"
      : cs.reason === "not_on_path"
        ? `installed via ${cs.via} but not on PATH — add ${
            process.platform === "win32" ? "%USERPROFILE%\\.local\\bin" : "~/.local/bin"
          }`
        : `install failed via ${cs.via}`;
    csp.stop(false, `claude-swap      ${C.dim}${how}${C.reset}`);
    // A URL is not an answer when someone just wants the panel to work. Print
    // the command for THIS machine, picked from what is already on it.
    if (cs.hint) process.stdout.write(`    ${C.dim}${cs.hint}${C.reset}\n`);
  }

  // A working claude-swap with an empty store still leaves the panel useless,
  // so the account already signed in is registered once. Bounded inside
  // seedFirstAccount: empty store only, once ever, never with NO_INSTALL set.
  if (cs.state === "present" || cs.state === "installed" || cs.state === "upgrading") {
    const { seedFirstAccount } = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
    const seed = await seedFirstAccount().catch(() => ({ state: "failed" }));
    if (seed.state === "added") {
      process.stdout.write(`  ${C.green}✓${C.reset} accounts         ${C.dim}registered the signed-in account (cswap add)${C.reset}\n`);
    } else if (seed.state === "failed" || seed.state === "nothing-to-add") {
      process.stdout.write(`  ${C.dim}  accounts panel empty — sign in to Claude Code, then run cswap add${C.reset}\n`);
    }
  }
}

// ccusage backs the usage-history modal. Primed here rather than on first
// open so a cold machine pays the install while the deck is still booting.
if (process.env.AGENTS_DECK_NO_INSTALL !== "1") {
  const { primeCcusage } = await import(pathToFileURL(join(PKG_ROOT, "src/server/ccusage.mjs")).href);
  const cu = primeCcusage();
  if (cu.state === "present")         process.stdout.write(`  ${C.green}✓${C.reset} ccusage          ${C.dim}→ v${cu.version}${C.reset}\n`);
  else if (cu.state === "updating")   process.stdout.write(`  ${C.green}✓${C.reset} ccusage          ${C.dim}→ v${cu.version}, checking for update${C.reset}\n`);
  else if (cu.state === "installing") process.stdout.write(`  ${C.green}✓${C.reset} ccusage          ${C.dim}installing in background${C.reset}\n`);
}

// A newer release on npm, said once, in the place the upgrade gets typed.
// Started here and collected below so the lookup overlaps the rest of boot, and
// hard-capped so a slow registry cannot delay the server — the answer is
// usually already cached in ~/.agents-deck/.self-update-check anyway. It has to
// resolve BEFORE the pulse indicator starts writing over the last line.
const selfCheck = import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href)
  .then(m => m.versionReport({ running: PKG_VERSION, pkgRoot: PKG_ROOT }))
  .catch(() => null);
const upgrade = await Promise.race([
  selfCheck.then(r => r?.notice?.kind === "upgrade" ? r : null),
  new Promise(r => setTimeout(() => r(null), 1200)),
]);
if (upgrade) {
  process.stdout.write(
    `  ${C.yellow}↑${C.reset} update           ${C.dim}v${upgrade.notice.to} available — ${C.reset}${C.yellow}${upgrade.command}${C.reset}\n`,
  );
}
} // end !RESPAWN

// Asking the supervisor to bring us back. It is the only party that can, and
// only after this process is gone — which is precisely what keeps the
// replacement from racing this listener onto a random fallback port.
let restarting = false;
const requestRestart = (mode) => {
  if (restarting) return;
  restarting = true;
  // "npx" means the newer code is not on this disk at all — the supervisor has
  // to fetch it — so there is no target version to name yet.
  const viaNpx = mode === "npx";
  const to = viaNpx ? null : restartTarget();
  process.stdout.write(
    viaNpx
      ? `\n  ${C.yellow}↻${C.reset}  ${C.dim}updating via npx…${C.reset}\n`
      : `\n  ${C.yellow}↻${C.reset}  ${C.dim}restarting${to ? ` → v${to}` : ""}…${C.reset}\n`,
  );
  shutdown(viaNpx ? UPGRADE_CODE : RESTART_CODE);
};
// What a restart would land on. Read from disk now rather than remembered from
// boot, because the whole point is that the two differ.
function restartTarget() {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? null; }
  catch { return null; }
}

if (!RESPAWN) sp = spinner("starting server…");
const server = await startServer({
  port, persist, workspace, codex: wantCodex,
  // Withheld when nothing is supervising us: without a parent, exiting is just
  // exiting, and /api/restart answers 501 so the UI hides the control.
  onRestart: SUPERVISED ? requestRestart : null,
}).catch(err => {
  if (sp) sp.stop(false, `server failed: ${err.message}`);
  else console.error(`agents-deck: server failed: ${err.message}`);
  process.exit(1);
});
const addr = server.address();
const realPort = typeof addr === "object" && addr ? addr.port : port;
const url = `http://127.0.0.1:${realPort}`;

// The supervisor re-launches with this on --port. It has to be the port we
// actually got, not the one we asked for: those differ whenever the first
// launch found 4317 taken, and re-launching on the requested port would move
// the deck out from under every open tab.
try { process.send?.({ type: "listening", port: realPort }); } catch { /* not supervised */ }

if (RESPAWN) {
  process.stdout.write(`  ${C.green}↻${C.reset}  ${C.dim}restarted → ${C.reset}v${PKG_VERSION}${C.dim} · ${url}${C.reset}\n`);
} else {
  sp.stop(true, `server ready     ${C.dim}→ ${C.reset}${C.bCyan}${C.bold}${url}${C.reset}`);
  if (persist) process.stdout.write(`  ${C.dim}log       : ${persist}${C.reset}\n`);
  // Only when one is actually being opened. Under --no-open — which is how an
  // npx update relaunches, with a tab already waiting — this was announcing
  // something that never happened.
  if (openBrowser) process.stdout.write(`\n  ${C.green}${C.bold}▶  opening browser…${C.reset}\n\n`);
  else process.stdout.write("\n");
}

// The discovery file is the whole of how a hook finds this deck: hook.js
// enumerates that directory and nothing else. Writing it once at boot meant
// anything that later took it away left a deck that listened, served, and
// received not one event — with nothing on screen to say so. So it is checked
// on a timer, put back when it goes missing, and its absence is stated out loud
// rather than left to look like an idle afternoon.
//
// The token goes in with the port: it is what lets a hook tell this deck from
// whatever else may later be listening on the same number. See hookToken().
//
// The log path goes in with them, so a hook can see which decks share one events
// log and elect a single writer for it. See electWriters in hook/hook.js.
let registered = null;
const discovery = keepDiscovery({
  port: realPort,
  workspace,
  token: hookToken(),
  persist,
  onState: (state) => {
    const first = registered === null;
    registered = state.ok;
    if (!state.ok) reportUnregistered(state);
    else if (!first) reportReregistered(state);
  },
});
const discoveryFile = discovery.file;
// Now, not in five seconds: nothing should reach the pulse line below without
// the deck knowing whether the hooks can see it.
await discovery.check();

// Never on a respawn: the tab that asked for the restart is still open and
// reconnecting on its own. A second one would be the deck talking over itself.
if (openBrowser && !RESPAWN) {
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {}
}

// ── Pulse indicator ───────────────────────────────────────────────────────────
if (tty) {
  const pulseFrames = [`${C.green}●${C.reset}`, `${C.dim}●${C.reset}`];
  const LISTENING = "listening — Ctrl+C to stop";
  // A deck no hook can find is not listening in any sense the user cares
  // about, and the pulse is the one line that stays on screen for hours — so
  // it is where this has to be said.
  const UNREGISTERED = "listening, but not registered — hooks cannot find this deck";
  // Padded on the plain text, before any colour: the line is redrawn over
  // itself with \r, so the shorter message has to cover the longer one.
  const width = UNREGISTERED.length + 3;
  let pi = 0;
  setInterval(() => {
    const text = (registered ? LISTENING : UNREGISTERED).padEnd(width);
    const colour = registered ? C.dim : C.yellow;
    process.stdout.write(`\r  ${pulseFrames[pi++ % 2]}  ${colour}${text}${C.reset}`);
  }, 800).unref();
}

const shutdown = async (code = 0) => {
  // Also set as exitCode, not only passed to exit(): if the event loop empties
  // on its own before either timer runs, Node would otherwise exit 0 and the
  // supervisor would take that as "done" instead of "bring me back".
  process.exitCode = code;
  if (tty && code !== RESTART_CODE && code !== UPGRADE_CODE) {
    process.stdout.write(`\n\n  ${C.yellow}◉  shutting down…${C.reset}\n`);
  }
  // Stopped first, always: a tick landing after the unlink would re-register a
  // deck that is on its way out, and leave the file behind for the hooks to
  // find once nothing is listening.
  discovery.stop();
  await removeDiscovery(discoveryFile);
  server.close(() => process.exit(code));
  // SSE connections never end by themselves, so close() alone would sit out the
  // full 1500ms fallback on every restart. Hanging them up is safe — the stream
  // sets retry: 1500 and replays from Last-Event-ID, so each tab reconnects and
  // catches up without being told anything.
  try { server.closeAllConnections?.(); } catch { /* Node < 18.2 */ }
  setTimeout(() => process.exit(code), 1500).unref();
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("beforeExit", () => { discovery.stop(); removeDiscovery(discoveryFile); });

// ── helpers ───────────────────────────────────────────────────────────────────

// The deck is up and the hooks cannot see it. Said in full — the path, the
// reason — because the alternative is what this replaced: an ordinary-looking
// deck that simply never shows a session.
function reportUnregistered({ file, error }) {
  const why = error?.message ? ` — ${error.message}` : "";
  process.stdout.write(
    `\n  ${C.yellow}⚠${C.reset}  ${C.bold}not registered${C.reset}${C.dim}${why}${C.reset}\n` +
    `     ${C.dim}hooks find this deck through ${file}, so until that file exists no events arrive.${C.reset}\n`,
  );
}

function reportReregistered({ file }) {
  process.stdout.write(`\n  ${C.green}✓${C.reset}  ${C.dim}registered again → ${file}${C.reset}\n`);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-p" || a === "--port") out.port = args[++i];
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--workspace") out.workspace = args[++i];
    else if (a === "--scope") out.scope = true;
    else if (a === "--all") out.all = true; // legacy no-op (now default)
    else if (a === "--no-persist") out.noPersist = true;
    else if (a === "--history") out.history = args[++i];
    else if (a === "--codex") out.codex = true;
    else if (a === "--no-codex") out.noCodex = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(`agents-deck — live deck of Claude Code + Codex agents

Usage:
  agents-deck [options]

Options:
  -p, --port <number>      Preferred port (default: 4317; falls back to random 4318–4400)
      --no-open            Don't open the browser automatically
      --workspace <path>   Only capture sessions whose cwd is inside <path>
      --scope              Restrict to current working directory
      --all                Capture every session (default)
      --history <path>     Override events log file (default: ~/.claude/agent-dag/events.jsonl)
      --no-persist         Don't write or replay events log (RAM-only)
      --codex              Force-enable Codex capture even if ~/.codex/ missing
      --no-codex           Skip Codex capture (Claude only)
      --uninstall          Remove agents-deck's hooks from ~/.claude/settings.json and
                           ~/.codex/hooks.json, and restore any sound hooks of yours it parked
  -h, --help               Show this help
`);
}
