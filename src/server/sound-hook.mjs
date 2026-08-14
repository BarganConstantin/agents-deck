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
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./claude-dir.mjs";
import { readSettingsForWrite, writeFileAtomic, installScript } from "./installer.mjs";

const PKG_ROOT      = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_DIR    = claudeConfigDir();
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

const isParkFailure = (err) => err?.code === "PARKED_UNREADABLE" || err?.code === "PARKED_UNWRITABLE";

/** The same refusal, for the file the parked hooks live in rather than settings.json. */
function parkRefusal(err) {
  return {
    ok: false,
    reason: err?.code === "PARKED_UNREADABLE" ? "parked_unreadable" : "parked_unwritable",
    parkedPath: PARKED_PATH,
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

function parkedError(code, why) {
  const err = new Error(
    code === "PARKED_UNREADABLE"
      ? `${PARKED_PATH} could not be read as JSON (${why}). It holds sound hooks you wrote yourself, ` +
        `so it is not being treated as empty — fix the file or move it aside, then try again.`
      : `${PARKED_PATH} could not be written (${why}). It is where your own sound hooks are kept while ` +
        `the toggle is on, so nothing was taken out of settings.json — they would have been in neither file.`,
  );
  err.code = code;
  err.parkedPath = PARKED_PATH;
  return err;
}

/**
 * Read the parked hooks, refusing to guess at a file that will not parse.
 *
 * Same bargain as readSettingsForWrite, for the same reason: this is the only
 * copy of hooks the user wrote by hand, and every caller either overwrites the
 * file or reports how much is in it. A truncated file — a kill mid-write, a full
 * disk — used to read as "nothing was ever parked", and the next toggle wrote
 * its own list over the remains. Only ENOENT is genuinely empty; the array is
 * not optional, because a JSON object here means the file is not ours to touch.
 */
async function readParked() {
  let raw;
  try {
    raw = await readFile(PARKED_PATH, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw parkedError("PARKED_UNREADABLE", err?.message ?? String(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw parkedError("PARKED_UNREADABLE", err?.message ?? String(err));
  }
  if (!Array.isArray(parsed)) throw parkedError("PARKED_UNREADABLE", "top level is not a JSON array");
  return parsed;
}

/**
 * Write the parked hooks, and never quietly fail to.
 *
 * This used to swallow every error, which made the park a suggestion: a
 * root-owned ~/.agents-deck, a full disk or a Windows lock on the file left the
 * write undone while setSoundHook went on to strip the same hooks out of
 * settings.json and report success. Atomic for the other half of it — a torn
 * parked file is a parked file that reads as empty.
 */
async function writeParked(entries) {
  try {
    if (!existsSync(dirname(PARKED_PATH))) await mkdir(dirname(PARKED_PATH), { recursive: true });
    await writeFileAtomic(PARKED_PATH, JSON.stringify(entries, null, 2) + "\n");
  } catch (err) {
    throw parkedError("PARKED_UNWRITABLE", err?.message ?? String(err));
  }
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
    return {
      ...refusal(err),
      enabled: false,
      platform: process.platform,
      foreign: [],
      // A parked file that will not read is a second refusal, and settings.json
      // is the one being reported. Count what can be counted.
      parked: await readParked().then(p => p.length, () => 0),
    };
  }
  const group = settings?.hooks?.[EVENT];
  const enabled = Array.isArray(group) && group.some(isOurs);
  let parked;
  try {
    parked = await readParked();
  } catch (err) {
    if (!isParkFailure(err)) throw err;
    // "parked: 0" on a file we cannot read is the lie that sends the user to
    // click the toggle, which is the thing that would overwrite it.
    return { ...parkRefusal(err), enabled, platform: process.platform, foreign: foreignSoundHooks(settings), parked: 0 };
  }
  return {
    ok: true,
    enabled,
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
  let parked;
  try {
    parked = await readParked();
  } catch (err) {
    if (!isParkFailure(err)) throw err;
    // The file is left exactly as it is. Answering "restored: 0" would be the
    // last word on hooks that are still in there, badly written but present.
    return parkRefusal(err);
  }
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
  // Emptying the park comes last and its failure is reported, not swallowed:
  // the hooks are safely back in settings.json now, but a park left behind is
  // one the next restore hands over a second time, duplicating them.
  try {
    await writeParked([]);
  } catch (err) {
    if (!isParkFailure(err)) throw err;
    return { ...parkRefusal(err), restored: parked.length };
  }
  return { ok: true, restored: parked.length };
}

/**
 * Take the toggle off the machine entirely, for `agents-deck --uninstall`.
 *
 * uninstallHooks only knows the `__agent-dag` mark the event forwarders carry;
 * this entry is marked `__agent-dag-sound` and its command points at notify.js,
 * so it used to survive an uninstall and keep playing a sound on every turn. The
 * user's own hooks were the worse half: parked here when the toggle went on,
 * they stayed in a file under ~/.agents-deck that nothing left on the machine
 * knew how to open. Removing the entry without putting those back would be the
 * same loss with a tidier settings.json, so the two go together.
 */
export async function uninstallSoundHook() {
  let settings;
  try {
    settings = await readSettings();
  } catch (err) {
    if (!isUnreadable(err)) throw err;
    // Same bargain as everywhere else here: a file we cannot parse is left
    // untouched, and the parked hooks stay parked until it is repaired.
    return refusal(err);
  }
  const group = settings?.hooks?.[EVENT];
  let removed = 0;
  if (Array.isArray(group)) {
    const others = group.filter(g => !isOurs(g));
    removed = group.length - others.length;
    if (removed > 0) {
      if (others.length) settings.hooks[EVENT] = others;
      else delete settings.hooks[EVENT];   // don't leave an empty array behind
      await writeSettings(settings);
    }
  }
  const restore = await restoreParkedSoundHooks();
  if (restore.ok === false) return restore;
  return { ok: true, removed, restored: restore.restored ?? 0 };
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
  //
  // Which only holds if the move lands first. The filter below drops exactly
  // these entries from the object written to settings.json, so a park that
  // failed and said nothing left the user's own Stop hook in neither file, with
  // ok:true on the way out. Nothing here is written until the park is on disk.
  const parking = group.filter(isSoundHook);
  if (parking.length > 0) {
    try {
      await writeParked([...(await readParked()), ...parking]);
    } catch (err) {
      if (!isParkFailure(err)) throw err;
      return parkRefusal(err);
    }
  }
  const others = group.filter(g => !isOurs(g) && !isSoundHook(g));

  if (enabled) {
    if (!existsSync(INSTALL_DIR)) await mkdir(INSTALL_DIR, { recursive: true });
    // Same reason the event forwarder is installed this way: the Stop hook fires
    // notify.js from sessions that are already running, and toggling the sound
    // on must not leave one of them executing a half-copied file.
    await installScript(join(PKG_ROOT, "hook", "notify.js"), NOTIFY_PATH);
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
