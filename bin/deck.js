#!/usr/bin/env node
// The deck itself: registers hooks, starts the server, opens the browser.
// Launched by the supervisor in bin/agent-dag.js, which restarts it when it
// exits with RESTART_CODE. On a respawn (AGENTS_DECK_RESPAWN=1) everything that
// was already done once this session is skipped — that is what makes a restart
// take about a second instead of the better part of ten.
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dieOfSignal } from "../src/server/supervisor.mjs";
import {
  CURSOR_HIDE, CURSOR_SHOW, colorProfile, fit, glyphs, labelColumn, link, motionOK, palette,
  pulseText, spinnerFrames, statusLine, supportsHyperlinks, termColumns, unicodeOK,
  unregisteredDetail, wordmark,
} from "../src/server/term.mjs";
import { PRODUCT } from "../src/server/brand.mjs";
import { invokedName, renameNotice } from "../src/server/invoked-as.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
})();

// The command the user typed, handed down by the supervisor — our own argv[1]
// is this file under every one of the three names. Null when it cannot be
// proven, and null is the answer that prints nothing.
const INVOKED_AS = invokedName({ pkgRoot: PKG_ROOT });

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
    ? `${PRODUCT}: hooks removed from ${claude.settingsPath}`
    : `${PRODUCT}: no Claude hooks to remove`);
  // The sound toggle is a second entry in the same file, marked
  // __agent-dag-sound rather than __agent-dag, and uninstallHooks does not know
  // that mark — so it used to be left behind, playing on every turn after the
  // deck was supposedly gone. It also parks the user's own afplay/PowerShell
  // Stop hooks while it is on, and once the deck is uninstalled nothing else can
  // put them back, so this restores them too.
  const { uninstallSoundHook } = await import(pathToFileURL(join(PKG_ROOT, "src/server/sound-hook.mjs")).href);
  const sound = await uninstallSoundHook();
  if (sound.ok === false) {
    console.error(`${PRODUCT}: sound hook left in place — ${sound.message}`);
  } else {
    if (sound.removed) console.log(`${PRODUCT}: sound hook removed`);
    if (sound.restored) console.log(`${PRODUCT}: restored ${sound.restored} of your own sound hook(s)`);
  }
  if (hasCodexInstalled()) {
    const codex = await uninstallHooks({ provider: "codex" });
    console.log(codex.changed
      ? `${PRODUCT}: hooks removed from ${codex.settingsPath}`
      : `${PRODUCT}: no Codex hooks to remove`);
  }
  process.exit(0);
}

const port = Number(flags.port ?? process.env.AGENT_DAG_PORT ?? 4317);
// Default = machine-wide (capture every CC session on this box). Pass
// `--workspace <path>` (or `--scope`) to restrict to a single tree. Canonicalized
// just below, once the module that owns that rule is loaded.
const rawWorkspace = flags.workspace != null
  ? flags.workspace
  : (flags.scope ? process.cwd() : "");
const openBrowser = flags.noOpen !== true;
// The events log lives beside the discovery files, so it follows the Claude
// config dir rather than assuming ~/.claude — see src/server/claude-dir.mjs.
const { claudeConfigDir, hasClaudeInstalled } =
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
// CODEX_SESSIONS_DIR comes along because the banner below names the directory
// the watcher tails, and the watcher lives in that module. Recomputing the path
// here is how the banner came to print ~/.codex/sessions on machines whose
// sessions are somewhere else entirely — see the row further down.
const { startServer, hookToken, releaseRestart, CODEX_SESSIONS_DIR, canonicalWorkspace } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/index.mjs")).href);

// Resolved here rather than left as typed, for the reason the events log above
// is: the discovery file publishes this path, and the hook that reads it runs in
// a process whose cwd is the agent's — so a relative `--workspace ./sub` meant
// one directory to the Codex watcher inside this process and a different one per
// agent to the hook. One canonical spelling, computed in the one process that
// knows what the user meant, is what both capture paths compare against. See
// canonicalWorkspace.
const workspace = canonicalWorkspace(rawWorkspace);

// Whether the server starts the Codex rollout watcher. Nothing is installed
// and no directory is created either way — Codex hooks are not used any more,
// so `--codex` only means "watch even though ~/.codex/ is not there yet",
// which is the right answer for a machine where Codex arrives later.
const wantCodex = flags.noCodex
  ? false
  : (flags.codex === true || hasCodexInstalled());

// The same question for the other CLI, and the one nobody was asking. README
// offers "Claude Code CLI or OpenAI Codex CLI (or both)"; a Codex-only machine
// nonetheless got a Python account-switcher installed for a CLI it does not
// have, an accounts panel open on first run, and a banner line telling it to
// sign into that CLI (#402). Everything the deck installs or opens on the
// Claude side now hangs off this one answer, and it is stated in the banner so
// a wrong answer is visible rather than mysterious.
//
// `--claude` is the escape hatch for a false negative, which is the failure
// that matters: hasClaudeInstalled looks for the binary and for traces of use,
// and a machine that hides Claude Code from both would otherwise lose its hooks
// with no way to ask for them back. `--no-claude` is the opt-out the Claude side
// never had — the mirror of --no-codex — and it is also what a Codex-only user
// with a settings.json the installer refuses to rewrite needs, since that
// refusal is fatal at boot on a component they do not use.
const wantClaude = flags.noClaude
  ? false
  : (flags.claude === true || hasClaudeInstalled());

const WEB_DIST = join(PKG_ROOT, "dist", "web", "index.html");
if (!existsSync(WEB_DIST)) {
  console.error(`${PRODUCT}: ui not built. run \`npm run build\` (or \`pnpm build\`) first.`);
  process.exit(1);
}

// ── the terminal we are printing into ─────────────────────────────────────────
// Asked once, degraded from there — see src/server/term.mjs, which is where all
// of this is decided and asserted. Below this point the deck writes no escape of
// its own: colour comes from `P`, glyphs from `G`, layout from statusLine. That
// is what makes NO_COLOR, a pipe, a CI log and a legacy Windows console one
// question rather than thirty separate ones nobody remembers to ask.
const tty = Boolean(process.stdout.isTTY);
const PROFILE = colorProfile({ isTTY: tty });
const P = palette(PROFILE);
const UNICODE = unicodeOK();
const G = glyphs(UNICODE);
const LINKS = supportsHyperlinks({ profile: PROFILE });
// The terminal's prefers-reduced-motion: nothing sleeps, spins or repaints in a
// pipe, under CI, or with NO_COLOR set.
const MOTION = motionOK({ isTTY: tty, profile: PROFILE });
const write = (s) => process.stdout.write(s);
// Read per line, never cached: a terminal can be resized while the deck runs,
// and the pulse below is still on screen hours later.
const cols = () => termColumns(process.stdout);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fileLink = (path) => link(path, pathToFileURL(path).href, LINKS);

// ── the cursor ────────────────────────────────────────────────────────────────
// Hidden for as long as anything of ours is moving — the reveal, the spinner,
// the pulse — and put back on every way out of this process: the ordinary exit,
// all three signals, and an uncaught throw, which reaches 'exit' after Node has
// printed it. Half of this is worse than none: a deck that dies with the cursor
// hidden leaves the user's shell with no cursor and nothing to do about it but
// `reset`.
let cursorHidden = false;
const showCursor = () => {
  if (!cursorHidden) return;
  cursorHidden = false;
  try { write(CURSOR_SHOW); } catch { /* stdout is gone; nothing left to restore */ }
};
if (MOTION) { cursorHidden = true; write(CURSOR_HIDE); }
process.on("exit", showCursor);
// SIGHUP is the one signal this process does not otherwise handle, so its
// default action would end us before 'exit' could run. Handled only to put the
// cursor back and then die of it exactly as before — the supervisor reads the
// signal, not an exit code.
process.on("SIGHUP", () => { showCursor(); dieOfSignal("SIGHUP"); });

// ── rows ──────────────────────────────────────────────────────────────────────
// The status column is computed from the longest label. It used to be counted
// into each string as trailing spaces, so any new row, or any label a character
// longer, silently broke the alignment of every other one.
const LABELS = [
  "workspace", "Claude hooks", "Codex sessions", "claude-swap", "accounts",
  "ccusage", "update", "name", "server ready", "log",
];
const LABEL_W = labelColumn(LABELS);

function row({ mark = " ", tone = P.ok, label = "", detail = "", detailTone = P.muted, keep = false }) {
  return statusLine({
    mark, label, detail, keep, labelWidth: LABEL_W, columns: cols(), ellipsis: G.ellipsis,
    paint: {
      mark: (s) => `${tone}${s}${P.reset}`,
      detail: (s) => `${detailTone}${s}${P.reset}`,
    },
  }) + "\n";
}

// ── the wordmark ──────────────────────────────────────────────────────────────
async function printBanner() {
  const { lines } = wordmark({ columns: cols(), version: PKG_VERSION, profile: PROFILE, unicode: UNICODE, pal: P });
  for (const line of lines) {
    write(line + "\n");
    // A reveal, not a wait. The once-per-session work is already running under
    // it (see startupWork), so the art costs the boot nothing and the deck is
    // ready about when the last row lands. What used to be here — 560ms of
    // spinner at "loading…" before a single art line — was dead time in a tool
    // whose documented entry point is `npx ccdeck`.
    if (MOTION && line) await sleep(45);
  }
}

// ── a step, with a spinner only if it is slow enough to need one ──────────────
// The interval's first frame is 80ms away, so anything already settled when we
// get here paints nothing at all and the row below is the only trace of it.
async function step(label, work) {
  if (!MOTION) return work;
  const frames = spinnerFrames(UNICODE);
  // Kept inside the terminal: a label that wraps is a label the \r below can
  // only half erase, and what is left of it stays under the row that follows.
  const text = fit(label, cols() - 6, G.ellipsis);
  let i = 0;
  const iv = setInterval(() => {
    write(`\r  ${P.accent}${frames[i++ % frames.length]}${P.reset}  ${P.muted}${text}${P.reset}`);
  }, 80);
  try {
    return await work;
  } finally {
    clearInterval(iv);
    // Cleared rather than overwritten: the row that follows is a different
    // length, and relying on it to be the longer of the two is how a spinner
    // leaves its own tail on screen. Nothing to clear if it never painted.
    if (i) write("\r" + " ".repeat(text.length + 5) + "\r");
  }
}

/**
 * The once-per-session work, all of it started at once and none of it awaited.
 *
 * Hook install, the claude-swap probe and the registry lookup have nothing to
 * do with each other and nothing to do with the wordmark, so they run underneath
 * the reveal instead of queueing behind it — the animation then costs the boot
 * nothing and the deck is ready about when the last art row lands. Every one of
 * them is given its rejection handler here, at the moment it is created, since a
 * promise that settles before anything awaits it is otherwise an unhandled
 * rejection.
 */
function startupWork() {
  // Every job below this line serves Claude Code and only Claude Code: the
  // hooks go in Claude Code's settings.json, claude-swap switches Claude
  // accounts, and ccusage reads Claude Code's own session logs. On a machine
  // without Claude Code all three are work done for a CLI that is not there —
  // two of them installs the user did not ask for — so they are not started at
  // all rather than started and then reported as failures. `null` is how each
  // one says "not attempted", which reportStartup tells apart from "tried and
  // could not".

  // Settings the installer cannot parse are settings it cannot rewrite without
  // losing them, so it refuses — and that refusal is reported rather than
  // thrown, because it is the only thing the user can act on.
  const hooks = wantClaude
    ? installHooks({ provider: "claude" }).then(v => ({ ok: true, v }), err => ({ ok: false, err }))
    : Promise.resolve(null);

  // claude-swap backs the multi-account panel, and an empty store leaves that
  // panel useless even when the tool is there — so the account already signed
  // in is registered once. Bounded inside seedFirstAccount: empty store only,
  // once ever, never with NO_INSTALL set.
  const cswap = (async () => {
    if (!wantClaude) return null;
    const { ensureCswap } = await import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-install.mjs")).href);
    const cs = await ensureCswap();
    const usable = cs.state === "present" || cs.state === "installed" || cs.state === "upgrading";
    if (!usable) return { cs, seed: null };
    const { seedFirstAccount } = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
    return { cs, seed: await seedFirstAccount().catch(() => ({ state: "failed" })) };
  })().catch(() => null);

  // ccusage backs the usage-history modal. Primed at boot rather than on first
  // open so a cold machine pays the install while the deck is still starting.
  // Nothing is lost by skipping the prime: runCcusage falls back to npx, so the
  // modal still answers if it is ever opened — it just pays the wait itself.
  const ccusage = (async () => {
    if (!wantClaude) return null;
    if (process.env.AGENTS_DECK_NO_INSTALL === "1") return null;
    const { primeCcusage } = await import(pathToFileURL(join(PKG_ROOT, "src/server/ccusage.mjs")).href);
    return primeCcusage();
  })().catch(() => null);

  // A newer release on npm, said once, in the place the upgrade gets typed.
  // Hard-capped so a slow registry cannot delay the server — the answer is
  // usually already cached in ~/.agents-deck/.self-update-check anyway. It has
  // to resolve BEFORE the pulse indicator starts writing over the last line.
  const update = Promise.race([
    import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href)
      .then(m => m.versionReport({ running: PKG_VERSION, pkgRoot: PKG_ROOT }))
      .then(r => (r?.notice?.kind === "upgrade" ? r : null))
      .catch(() => null),
    new Promise(r => setTimeout(() => r(null), 1200)),
  ]);

  return { hooks, cswap, ccusage, update };
}

/** The same work, said out loud, in a fixed order — a boot whose rows arrive in
 *  whatever order the network settled is a boot nobody can scan twice. */
async function reportStartup(jobs) {
  write(row({
    mark: G.ok, label: "workspace",
    detail: workspace === "" ? "(all)" : workspace,
    detailTone: workspace === "" ? P.warn : P.muted,
  }));

  const hooks = await step(`installing Claude hooks${G.ellipsis}`, jobs.hooks);
  if (hooks === null) {
    // Said in the same shape as the Codex row below, because it is the same
    // sentence: this deck is not watching that CLI, and here is why. It also
    // retires the one boot failure a Codex-only machine could hit — an
    // unparseable or unwritable settings.json used to exit(1) below, killing a
    // deck over a file belonging to a CLI the user does not run.
    write(row({ label: "Claude hooks", detail: `skipped ${G.dash} no Claude Code found, or --no-claude` }));
  } else if (!hooks.ok) {
    // The file it names is one only the user can repair, and every Claude Code
    // session on this machine is reading it too.
    write(row({ mark: G.fail, tone: P.err, label: "Claude hooks", detail: "not installed" }));
    console.error(`\n  ${PRODUCT}: ${hooks.err.message}\n`);
    process.exit(1);
  } else {
    write(row({ mark: G.ok, label: "Claude hooks", detail: fileLink(hooks.v.hookPath) }));
  }

  // Codex CLI hooks never fire on Windows (sandbox refuses to spawn the hook
  // command). Instead the server tails Codex's rollout JSONL files directly, so
  // there's nothing to install and no /hooks trust step. We just confirm Codex
  // is present and let the watcher pick up sessions.
  if (wantCodex) {
    // The directory the watcher actually tails, imported from the module that
    // owns it rather than rebuilt from homedir() here. CODEX_HOME relocates the
    // whole tree, and this row is the only diagnostic the deck prints about
    // Codex — so when sessions do not show up, a path computed a second way
    // sends the user to inspect a directory the deck never opened.
    write(row({ mark: G.ok, label: "Codex sessions", detail: `watching ${fileLink(CODEX_SESSIONS_DIR)}` }));
  } else {
    write(row({ label: "Codex sessions", detail: `skipped ${G.dash} no ~/.codex/, or --no-codex` }));
  }

  const swap = await step(`checking claude-swap${G.ellipsis}`, jobs.cswap);
  const cs = swap?.cs;
  if (!wantClaude) {
    // claude-swap is a Python tool that switches Claude Code accounts, and the
    // deck used to fetch a uv binary to install it on machines with no Claude
    // Code at all. Saying so is the point of the row: it is the one place a
    // user can learn that the accounts panel is missing on purpose.
    write(row({ label: "claude-swap", detail: `skipped ${G.dash} accounts are Claude-only` }));
  } else if (cs?.state === "present") {
    write(row({ mark: G.ok, label: "claude-swap", detail: `v${cs.version} (accounts panel enabled)` }));
  } else if (cs?.state === "installed") {
    write(row({ mark: G.ok, label: "claude-swap", detail: `installed v${cs.version} via ${cs.via}` }));
  } else if (cs?.state === "upgrading") {
    write(row({ mark: G.ok, label: "claude-swap", detail: `v${cs.version}, upgrading to v${cs.latest} in background` }));
  } else if (cs?.state === "skipped") {
    write(row({ mark: G.ok, label: "claude-swap", detail: "not installed (AGENTS_DECK_NO_INSTALL=1)" }));
  } else {
    const how = cs?.reason === "no_installer"
      ? `not installed ${G.dash} the accounts panel needs it`
      : cs?.reason === "not_on_path"
        ? `installed via ${cs.via} but not on PATH ${G.dash} add ${
            process.platform === "win32" ? "%USERPROFILE%\\.local\\bin" : "~/.local/bin"
          }`
        : `install failed${cs?.via ? ` via ${cs.via}` : ""}`;
    write(row({ mark: G.fail, tone: P.warn, label: "claude-swap", detail: how }));
    // A URL is not an answer when someone just wants the panel to work. Print
    // the command for THIS machine, picked from what is already on it.
    if (cs?.hint) write(row({ label: "", detail: cs.hint }));
  }

  if (swap?.seed?.state === "added") {
    write(row({ mark: G.ok, label: "accounts", detail: "registered the signed-in account (cswap add)" }));
  } else if (swap?.seed?.state === "failed" || swap?.seed?.state === "nothing-to-add") {
    write(row({ label: "accounts", detail: `panel empty ${G.dash} sign in to Claude Code, then run cswap add` }));
  }

  const cu = await jobs.ccusage;
  if (cu?.state === "present") write(row({ mark: G.ok, label: "ccusage", detail: `v${cu.version}` }));
  else if (cu?.state === "updating") write(row({ mark: G.ok, label: "ccusage", detail: `v${cu.version}, checking for update` }));
  else if (cu?.state === "installing") write(row({ mark: G.ok, label: "ccusage", detail: "installing in background" }));

  const upgrade = await jobs.update;
  if (upgrade) {
    write(row({
      mark: G.up, tone: P.warn, label: "update",
      detail: `v${upgrade.notice.to} available ${G.dash} ${upgrade.command}`,
    }));
  }

  // Which name this deck was started under, when that is knowable — a notice,
  // never a refusal. 95% of installs are on the two old names and the update
  // path runs through this very process, so a build that declined to boot under
  // one of them would kill the deck on the machine where the deck is what would
  // have explained why. Nothing at all is printed wherever the typed name
  // cannot be proven (a Windows global install, a git checkout): telling
  // somebody who already types `ccdeck` to type `ccdeck` is the one failure
  // that would make this row worth ignoring. See src/server/invoked-as.mjs.
  const rename = renameNotice({ invoked: INVOKED_AS, pkgRoot: PKG_ROOT, dash: G.dash });
  if (rename) {
    write(row({ mark: G.warn, tone: P.warn, label: "name", detail: rename.said }));
    // The line that carries the value: for a global install there is nothing to
    // install and nothing to download, only six different characters to type.
    write(row({ label: "", detail: rename.fix }));
  }
}

// Everything above is once-per-session setup — hook install, tool probes,
// registry lookups, and the banner it now runs underneath. A respawn is the
// same session continuing, so it skips the lot and prints one line instead.
// This is the difference between a restart that feels instant and one that
// makes you wonder whether it worked.
if (!RESPAWN) {
  const jobs = startupWork();
  await printBanner();
  await reportStartup(jobs);
}

// Asking the supervisor to bring us back. It is the only party that can, and
// only after this process is gone — which is precisely what keeps the
// replacement from racing this listener onto a random fallback port.
let restarting = false;
// Outer bound on the supervisor's answer below. It cannot be reached today —
// the fetch has a deadline of its own and every path through it replies — but
// `restarting` is a latch, and a latch with no way out is how a deck ends up
// silently refusing every restart for the rest of its life.
const UPGRADE_ANSWER_MS = 150_000;
let upgradeTimer = null;

const requestRestart = (mode) => {
  if (restarting) return;
  restarting = true;
  // "npx" means the newer code is not on this disk at all, so it has to be
  // fetched — and this process keeps serving while that happens. Exiting first
  // is what made every failed upgrade an outage: the SSE stream dropped, hook
  // events fired into the gap were lost outright (hook/hook.js is
  // fire-and-forget with a 1s timeout and no retry), and the canvas came back
  // with whatever was in flight stuck until the stale sweeper reaped it — all
  // of it paid before anyone knew whether npm could even resolve the version.
  // Nothing is torn down here now; the supervisor answers when it knows.
  if (mode === "npx") {
    upgradeTimer = setTimeout(() => abandonUpgrade("no answer from the supervisor"), UPGRADE_ANSWER_MS);
    upgradeTimer.unref?.();
    // Armed before the ask, not after: a send that throws is a supervisor that
    // can no longer answer, and the deck has to come back out of the latch on
    // its own rather than wait out an answer that cannot arrive.
    try { process.send({ type: "upgrade" }); }
    catch (err) { abandonUpgrade(err?.message ?? "the supervisor is no longer listening"); }
    return;
  }
  const to = restartTarget();
  write(`\n  ${P.warn}${G.restart}${P.reset}  ${P.muted}restarting${to ? ` ${G.arrow} v${to}` : ""}${G.ellipsis}${P.reset}\n`);
  shutdown(RESTART_CODE);
};

// The upgrade did not happen and this deck is still the deck. Said out loud
// because the terminal has just printed that a fetch was starting, and left
// unsaid it reads as a restart that hung.
const abandonUpgrade = (why) => {
  clearTimeout(upgradeTimer);
  restarting = false;
  // The server's own latch, which no longer has an exiting process to clear it.
  releaseRestart();
  write(
    `\n  ${P.warn}${G.cancel}${P.reset}  ${P.muted}update not applied ${G.dash} still on ${P.reset}v${PKG_VERSION}\n` +
    (why ? `     ${P.muted}${why}${P.reset}\n` : ""),
  );
};

// The supervisor's verdict on the fetch it was asked for. Only it can answer:
// the fetch is its child, and it is the process that will still be here when
// this one exits.
process.on("message", (m) => {
  if (!restarting || !m || typeof m !== "object") return;
  if (m.type === "upgrade-ready") {
    clearTimeout(upgradeTimer);
    // The replacement is on the machine now, so this is the last moment the
    // port is worth holding: exiting hands it straight over.
    write(`\n  ${P.warn}${G.restart}${P.reset}  ${P.muted}updating via npx${G.ellipsis}${P.reset}\n`);
    shutdown(UPGRADE_CODE);
  } else if (m.type === "upgrade-refused") {
    abandonUpgrade(m.error);
  }
});

// What a restart would land on. Read from disk now rather than remembered from
// boot, because the whole point is that the two differ.
function restartTarget() {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? null; }
  catch { return null; }
}

const starting = startServer({
  port, persist, workspace, codex: wantCodex, claude: wantClaude,
  // Withheld when nothing is supervising us: without a parent, exiting is just
  // exiting, and /api/restart answers 501 so the UI hides the control.
  onRestart: SUPERVISED ? requestRestart : null,
});
const server = await (RESPAWN ? starting : step(`starting server${G.ellipsis}`, starting)).catch(err => {
  // stderr, not a row: a deck that could not bind is not a status line, and
  // whatever launched it reads this stream.
  console.error(`${PRODUCT}: server failed: ${err.message}`);
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
  write(`  ${P.ok}${G.restart}${P.reset}  ${P.muted}restarted ${G.arrow} ${P.reset}v${PKG_VERSION}${P.muted} ${G.bullet} ${link(url, url, LINKS)}${P.reset}\n`);
} else {
  // The URL is the one detail an ellipsis would destroy — half an address is
  // not a shorter address — so it keeps its own line when the terminal is too
  // narrow to hold it beside the label. See statusLine's `keep`.
  write(row({
    mark: G.ok, label: "server ready",
    detail: link(url, url, LINKS), detailTone: `${P.accent}${P.bold}`, keep: true,
  }));
  if (persist) write(row({ label: "log", detail: fileLink(persist) }));
  // Only when one is actually being opened. Under --no-open — which is how an
  // npx update relaunches, with a tab already waiting — this was announcing
  // something that never happened.
  if (openBrowser) write(`\n  ${P.ok}${P.bold}${G.play}  opening browser${G.ellipsis}${P.reset}\n\n`);
  else write("\n");
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
// log and elect a single writer for it. See electWriters in hook/hook.js. The
// Codex setting goes in for the half of that election no hook is part of: the
// rollout files this deck tails itself, which a --no-codex deck must never be
// elected to record. See writesCodexLog in src/server/log-writer.mjs.
let registered = null;
const discovery = keepDiscovery({
  port: realPort,
  workspace,
  token: hookToken(),
  persist,
  codex: wantCodex,
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
// The whole line is rewritten each beat rather than just the dot: anything else
// on this deck that has something to say writes a newline first, and after that
// the line under the cursor is no longer the one we drew — a partial repaint
// would leave the message behind and pulse into empty space. Sized to the real
// terminal, because at 40 columns the old fixed 61-character line wrapped, and
// from then on \r only ever reached its second row.
if (MOTION) {
  let pi = 0;
  setInterval(() => {
    // The colour follows the words. A Codex-only deck keeps saying "listening"
    // when it is unregistered — see pulseText — and painting that sentence in
    // the warning tone would restore the alarm the sentence just retired.
    const alarm = !registered && wantClaude;
    const text = pulseText({ registered, claude: wantClaude, columns: cols(), unicode: UNICODE });
    const dot = pi++ % 2 === 0 ? (alarm ? P.warn : P.ok) : P.muted;
    const tone = alarm ? P.warn : P.muted;
    write(`\r  ${dot}${G.pulse}${P.reset}  ${tone}${text}${P.reset}`);
  }, 800).unref();
}

const shutdown = async (code = 0) => {
  // Also set as exitCode, not only passed to exit(): if the event loop empties
  // on its own before either timer runs, Node would otherwise exit 0 and the
  // supervisor would take that as "done" instead of "bring me back".
  process.exitCode = code;
  // Before anything that can take time: a Ctrl+C the user has to watch for a
  // second and a half is a second and a half without a cursor.
  showCursor();
  if (tty && code !== RESTART_CODE && code !== UPGRADE_CODE) {
    write(`\n\n  ${P.warn}${G.stop}  shutting down${G.ellipsis}${P.reset}\n`);
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

// The deck is up and the discovery file could not be written. Said in full —
// the path, the reason — because the alternative is what this replaced: an
// ordinary-looking deck that simply never shows a session.
//
// What that costs depends on which CLI this deck watches, so the sentence comes
// from term.mjs, where both answers are written down and tested.
function reportUnregistered({ file, error }) {
  const why = error?.message ? ` ${G.dash} ${error.message}` : "";
  write(
    `\n  ${P.warn}${G.warn}${P.reset}  ${P.bold}not registered${P.reset}${P.muted}${why}${P.reset}\n` +
    `     ${P.muted}${unregisteredDetail({ file, claude: wantClaude })}${P.reset}\n`,
  );
}

function reportReregistered({ file }) {
  write(`\n  ${P.ok}${G.ok}${P.reset}  ${P.muted}registered again ${G.arrow} ${fileLink(file)}${P.reset}\n`);
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
    else if (a === "--claude") out.claude = true;
    else if (a === "--no-claude") out.noClaude = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(`${PRODUCT} — live deck of Claude Code + Codex agents

Usage:
  ${PRODUCT} [options]

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
      --claude             Force-enable Claude capture even if Claude Code wasn't found
      --no-claude          Skip Claude entirely: no hooks, no claude-swap, no accounts panel
      --uninstall          Remove ${PRODUCT}'s hooks from ~/.claude/settings.json and
                           ~/.codex/hooks.json, and restore any sound hooks of yours it parked.
                           Hook entries only: the forwarder script, ~/.claude/agent-dag/,
                           the events log, ~/.agents-deck/ and claude-swap all stay
  -h, --help               Show this help
`);
}
