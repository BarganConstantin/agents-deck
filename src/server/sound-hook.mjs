// Toggle for the "play a sound when the turn finishes" Stop hook.
//
// Hand-written versions of this hook are almost always one OS-specific
// command — `afplay …` on macOS, a PowerShell one-liner on Windows — ending in
// `|| true`. Each is a silent no-op on every other machine, so a settings.json
// synced across devices ends up with several of them stacked, none of which
// work everywhere. This installs a single entry pointing at notify.js, which
// picks its own player at run time.
//
// Only ever touches its own entry, tagged `__agent-dag-sound`. Hooks the user
// wrote themselves are left exactly as found — including the platform-specific
// ones this replaces, which are reported rather than deleted.
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readSettingsForWrite, writeFileAtomic } from "./installer.mjs";

const PKG_ROOT      = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_DIR    = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const INSTALL_DIR   = join(CLAUDE_DIR, "agent-dag");
const NOTIFY_PATH   = join(INSTALL_DIR, "notify.js");

const MARK = "__agent-dag-sound";
const EVENT = "Stop";
// Where a user's own sound hooks are kept while the toggle is off, so turning
// the feature off actually produces silence and nothing is destroyed.
const PARKED_PATH = join(homedir(), ".agents-deck", "parked-sound-hooks.json");

// Commands that look like a hand-rolled sound hook. Used only to tell the user
// what is already there — never to modify or remove it.
const SOUND_HINTS = [/\bafplay\b/i, /Media\.SoundPlayer/i, /\bpaplay\b/i, /\baplay\b/i, /canberra-gtk-play/i];

/**
 * Read settings.json, refusing to guess at a file that will not parse.
 *
 * Shared with the hook installer, because the danger is the same: this module
 * rewrites the whole file, so treating a damaged one as `{}` replaces every
 * permission, env var and hook the user has with nothing but the sound entry.
 * Only a missing file is an empty one — a stray comma, a BOM, a half-written
 * save from another process all throw SETTINGS_UNREADABLE instead.
 */
async function readSettings() {
  const { settings } = await readSettingsForWrite(SETTINGS_PATH);
  return settings;
}

const isUnreadable = (err) => err?.code === "SETTINGS_UNREADABLE";

/** What every entry point here answers with when it will not touch the file. */
function refusal(err) {
  return {
    ok: false,
    reason: "settings_unreadable",
    settingsPath: SETTINGS_PATH,
    message: err?.message ?? String(err),
  };
}

/**
 * Write settings.json back atomically — this file holds every hook the user
 * has, and a torn write costs them all of them.
 */
async function writeSettings(settings) {
  await writeFileAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

const isOurs = (g) => g?.[MARK] === true;

/** Hand-written sound hooks on the Stop event, and whether they run here. */
function foreignSoundHooks(settings) {
  const group = settings?.hooks?.[EVENT];
  if (!Array.isArray(group)) return [];
  const found = [];
  for (const entry of group) {
    if (isOurs(entry)) continue;
    for (const h of entry.hooks ?? []) {
      const cmd = typeof h?.command === "string" ? h.command : "";
      if (!SOUND_HINTS.some(re => re.test(cmd))) continue;
      // A PowerShell hook on a Mac (or afplay on Windows) still runs — it just
      // fails, usually swallowed by a trailing `|| true`. Worth naming.
      const platform = /Media\.SoundPlayer|powershell/i.test(cmd) ? "win32"
                     : /\bafplay\b/i.test(cmd)                    ? "darwin"
                     : "linux";
      found.push({ command: cmd.slice(0, 120), platform, worksHere: platform === process.platform });
    }
  }
  return found;
}

async function readParked() {
  try {
    const parsed = JSON.parse(await readFile(PARKED_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeParked(entries) {
  try {
    if (!existsSync(dirname(PARKED_PATH))) await mkdir(dirname(PARKED_PATH), { recursive: true });
    await writeFile(PARKED_PATH, JSON.stringify(entries, null, 2) + "\n", "utf8");
  } catch { /* best-effort */ }
}

/**
 * True when this Stop entry plays a sound, on any platform.
 *
 * Deliberately not limited to the current one. settings.json is commonly
 * synced between machines — this user's own file carries Windows paths
 * alongside macOS ones — so parking only the hook that fires here leaves the
 * other in place, and the switch looks broken again on the other machine.
 */
function isSoundHook(entry) {
  if (isOurs(entry)) return false;
  return (entry.hooks ?? []).some(h =>
    SOUND_HINTS.some(re => re.test(typeof h?.command === "string" ? h.command : "")));
}

export async function soundHookStatus() {
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    // Reporting a healthy "off" here would be a lie the user acts on: the
    // toggle cannot do anything until they repair the file, so say which file
    // and why rather than offering a switch that will refuse.
    return { ...refusal(err), enabled: false, platform: process.platform, foreign: [], parked: (await readParked()).length };
  }
  const group = settings?.hooks?.[EVENT];
  const parked = await readParked();
  return {
    ok: true,
    enabled: Array.isArray(group) && group.some(isOurs),
    platform: process.platform,
    foreign: foreignSoundHooks(settings),
    parked: parked.length,
  };
}

/**
 * Put back the hooks the toggle set aside.
 *
 * Nothing is deleted, only moved, so a user who preferred their own command
 * can have it back exactly as it was.
 */
export async function restoreParkedSoundHooks() {
  const parked = await readParked();
  if (parked.length === 0) return { ok: true, restored: 0 };
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    // The parked file is left as it is, so the restore works once the user has
    // fixed settings.json. Nothing is lost by waiting.
    return refusal(err);
  }
  settings.hooks ??= {};
  const group = Array.isArray(settings.hooks[EVENT]) ? settings.hooks[EVENT] : [];
  settings.hooks[EVENT] = [...parked, ...group];
  await writeSettings(settings);
  await writeParked([]);
  return { ok: true, restored: parked.length };
}

export async function setSoundHook(enabled) {
  // Read before anything else. A file we cannot parse stops the toggle here,
  // with nothing parked, nothing copied and settings.json untouched.
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    return refusal(err);
  }
  settings.hooks ??= {};
  const group = Array.isArray(settings.hooks[EVENT]) ? settings.hooks[EVENT] : [];

  // Set aside any of the user's own hooks that play a sound on this machine.
  // Without this the toggle is a lie in both directions: off still plays their
  // afplay/PowerShell hook, and on plays twice. They are moved, not deleted —
  // restoreParkedSoundHooks puts them back untouched.
  const parking = group.filter(isSoundHook);
  if (parking.length > 0) {
    await writeParked([...(await readParked()), ...parking]);
  }
  const others = group.filter(g => !isOurs(g) && !isSoundHook(g));

  if (enabled) {
    if (!existsSync(INSTALL_DIR)) await mkdir(INSTALL_DIR, { recursive: true });
    await copyFile(join(PKG_ROOT, "hook", "notify.js"), NOTIFY_PATH);
    others.push({
      [MARK]: true,
      hooks: [{
        type: "command",
        // Absolute node path, matching how the event hooks are installed: the
        // shell a hook runs in does not necessarily have the user's PATH.
        command: `"${process.execPath}" "${NOTIFY_PATH}"`,
        timeout: 5,
      }],
    });
    settings.hooks[EVENT] = others;
  } else if (others.length) {
    settings.hooks[EVENT] = others;
  } else {
    delete settings.hooks[EVENT];   // don't leave an empty array behind
  }

  await writeSettings(settings);
  return { ok: true, enabled };
}

// Both paths are exported so a test can prove it is pointed at a sandbox
// before it writes anything — the real ones are the user's own settings.
export { SETTINGS_PATH, PARKED_PATH };
