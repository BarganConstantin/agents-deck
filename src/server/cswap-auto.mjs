// Auto-switch controls: read and write claude-swap's autoswitch settings and
// run a tick on a schedule.
//
// The engine is claude-swap's own — `cswap auto --once` evaluates one tick and
// exits, honouring the cooldown, quarantine and poll-budget state it keeps in
// its own files. Running that on an interval gets the same behaviour as the
// long-lived `cswap auto` loop while leaving all the decisions with the tool
// that owns them: nothing here decides when to switch, only when to ask.
//
// A tick can move the user's live Claude account, so it is off unless turned
// on and the setting survives restarts.
import { run } from "./exec.mjs";
import { cswapBin } from "./cswap-install.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_DIR  = join(homedir(), ".agents-deck");
const STATE_PATH = join(STATE_DIR, "cswap-auto.json");

const TICK_TIMEOUT_MS = 120_000;   // a tick can refresh a token and switch
const MIN_INTERVAL_S  = 15;        // claude-swap's own floor

// Only these may be written, and only with a value of the right shape. The
// value reaches an exec argument, and `cswap config set` will happily store
// whatever it is handed.
const SETTINGS = {
  "autoswitch.threshold":       { type: "number", min: 50, max: 99.9 },
  "autoswitch.intervalSeconds": { type: "number", min: 15, max: 3600 },
  "autoswitch.cooldownSeconds": { type: "number", min: 0,  max: 86400 },
  "autoswitch.hysteresisPct":   { type: "number", min: 0,  max: 50 },
  "autoswitch.model":           { type: "model" },
};

// ── settings ───────────────────────────────────────────────────────────────

/** Parse `cswap config` — "key   value   (default)" per line. */
export async function readCswapConfig() {
  const r = await run(await cswapBin(), ["config"]);
  if (!r.ok) return null;
  const out = {};
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\S+)\s+(.*?)\s*(\(default\))?\s*$/);
    if (!m || !m[1].includes(".")) continue;
    const raw = m[2].trim();
    out[m[1]] = {
      value:     raw === "(none)" ? null : raw,
      isDefault: Boolean(m[3]),
    };
  }
  return out;
}

/** Validate against SETTINGS, then hand to `cswap config set`. */
export async function setCswapConfig(key, value) {
  const spec = SETTINGS[key];
  if (!spec) return { ok: false, reason: "unknown_setting" };

  let str;
  if (spec.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) return { ok: false, reason: "out_of_range" };
    str = String(n);
  } else if (spec.type === "enum") {
    if (!spec.values.includes(value)) return { ok: false, reason: "bad_value" };
    str = value;
  } else {
    // Model names: a comma-separated list of plain words, or "all".
    str = String(value ?? "").trim();
    if (str && !/^[A-Za-z0-9 ,._-]{1,120}$/.test(str)) return { ok: false, reason: "bad_value" };
  }

  const r = await run(await cswapBin(), ["config", "set", key, str]);
  return r.ok ? { ok: true } : { ok: false, reason: "set_failed", detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}

// ── ticks ──────────────────────────────────────────────────────────────────

/** Last meaningful event from a `cswap auto --once --json` run. */
function summarise(stdout) {
  const events = stdout.split("\n")
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && typeof e === "object");

  const poll   = events.find(e => e.event === "poll") ?? null;
  const action = [...events].reverse().find(e => e.event !== "poll" && e.event !== "sleep") ?? null;

  return {
    event:     action?.event ?? "no-switch",
    reason:    action?.reason ?? null,
    detail:    action?.detail ?? null,
    from:      action?.from ?? null,
    to:        action?.to ?? null,
    active:    poll?.active ?? null,
    threshold: poll?.threshold ?? null,
    headroom:  poll?.headroomPct ?? null,
    windows:   poll?.windowsPct ?? null,
  };
}

/** Evaluate a tick for real. May switch the active account. */
async function runAutoTick() {
  const r = await run(await cswapBin(), ["auto", "--once", "--json"], { timeout: TICK_TIMEOUT_MS });
  if (!r.ok && !r.stdout) {
    return { ok: false, reason: "tick_failed", detail: (r.stderr || "").trim().slice(0, 300) };
  }
  return { ok: true, ...summarise(r.stdout) };
}

// ── external engine detection ──────────────────────────────────────────────

/**
 * True when the user is already running `cswap auto` themselves.
 *
 * Two engines would not corrupt anything — claude-swap serializes decisions
 * under its state lock — but they would double the tick rate against a request
 * budget that is already the scarce resource here, and the user would have two
 * things switching their account with no single place showing why. So the deck
 * reports it and stays out of the way.
 */
export async function externalAutoRunning() {
  // A line is the user's loop if it runs `cswap auto` without --once. Our own
  // ticks are --once, and so is a cron user's.
  const isLoop = (line) => /(^|[\\/])cswap(\.exe|\.cmd|\.bat)?\s+auto(\s|$)/i.test(line.trim())
                        && !/--once/i.test(line);

  if (process.platform === "win32") {
    // No `ps` on Windows, and `tasklist` reports the image name only — every
    // Python tool shows up as python.exe, which cannot tell cswap from
    // anything else. CIM is the one place the full command line is available.
    const r = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
    ], { timeout: 8_000 });
    if (!r.ok) return false;   // no PowerShell, or the query was refused
    return r.stdout.split("\n").some(isLoop);
  }

  // `ps`, not `pgrep -a`: BSD pgrep ignores -a and prints bare PIDs, so a
  // command-line match against its output silently never fires.
  const r = await run("ps", ["-Ao", "args="], { timeout: 5_000 });
  if (!r.stdout.trim()) return false;
  return r.stdout.split("\n").some(isLoop);
}

// ── deck-managed loop ──────────────────────────────────────────────────────

let _timer   = null;
let _lastTick = null;
let _enabled  = false;

async function loadState() {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")); } catch { return {}; }
}
async function saveState(state) {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  } catch { /* best-effort */ }
}

async function tickInterval() {
  const cfg = await readCswapConfig();
  const raw = Number(cfg?.["autoswitch.intervalSeconds"]?.value);
  return Math.max(MIN_INTERVAL_S, Number.isFinite(raw) ? raw : 60) * 1000;
}

async function tick() {
  // Re-check each time: the user can start their own loop at any point, and
  // the deck should fall silent rather than compete with it.
  if (await externalAutoRunning()) {
    _lastTick = { at: Date.now(), event: "skipped", reason: "external-engine" };
    return;
  }
  const result = await runAutoTick();
  _lastTick = { at: Date.now(), ...result };
}

async function startLoop() {
  if (_timer) return;
  const ms = await tickInterval();
  _timer = setInterval(() => { tick().catch(() => {}); }, ms);
  _timer.unref?.();
  tick().catch(() => {});   // don't make the user wait a full interval for the first one
}

function stopLoop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** Turn the deck-managed loop on or off, persisting the choice. */
export async function setAutoEnabled(enabled) {
  _enabled = Boolean(enabled);
  await saveState({ ...(await loadState()), enabled: _enabled });
  if (_enabled) await startLoop(); else stopLoop();
  return { ok: true, enabled: _enabled };
}

/** Restore the persisted setting at server boot. */
export async function initCswapAuto() {
  const state = await loadState();
  if (state.enabled) { _enabled = true; await startLoop(); }
}

export async function autoStatus() {
  const [config, external] = await Promise.all([readCswapConfig(), externalAutoRunning()]);
  return {
    ok:        config != null,
    enabled:   _enabled,
    external,                       // user is running their own `cswap auto`
    lastTick:  _lastTick,
    settings:  config ?? {},
  };
}

// ── per-account rotation flag ──────────────────────────────────────────────

/** Hold an account out of auto-rotation, or return it. */
export async function setAccountEnabled(accountNum, enabled) {
  const num = Number(accountNum);
  if (!Number.isInteger(num) || num < 1 || num > 999) return { ok: false, reason: "bad_account" };
  const r = await run(await cswapBin(), [enabled ? "enable" : "disable", String(num)]);
  return r.ok ? { ok: true } : { ok: false, reason: "command_failed", detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}
