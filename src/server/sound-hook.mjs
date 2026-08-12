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

const PKG_ROOT      = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_DIR    = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const INSTALL_DIR   = join(CLAUDE_DIR, "agent-dag");
const NOTIFY_PATH   = join(INSTALL_DIR, "notify.js");

const MARK = "__agent-dag-sound";
const EVENT = "Stop";

// Commands that look like a hand-rolled sound hook. Used only to tell the user
// what is already there — never to modify or remove it.
const SOUND_HINTS = [/\bafplay\b/i, /Media\.SoundPlayer/i, /\bpaplay\b/i, /\baplay\b/i, /canberra-gtk-play/i];

async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Write settings.json back atomically — this file holds every hook the user
 * has, and a torn write costs them all of them.
 */
async function writeSettings(settings) {
  const tmp = `${SETTINGS_PATH}.agent-dag-${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  const { rename, unlink } = await import("node:fs/promises");
  try { await rename(tmp, SETTINGS_PATH); }
  catch (err) { await unlink(tmp).catch(() => {}); throw err; }
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

export async function soundHookStatus() {
  const settings = await readSettings();
  const group = settings?.hooks?.[EVENT];
  return {
    ok: true,
    enabled: Array.isArray(group) && group.some(isOurs),
    platform: process.platform,
    foreign: foreignSoundHooks(settings),
  };
}

export async function setSoundHook(enabled) {
  const settings = await readSettings();
  settings.hooks ??= {};
  const group = Array.isArray(settings.hooks[EVENT]) ? settings.hooks[EVENT] : [];
  const others = group.filter(g => !isOurs(g));

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
