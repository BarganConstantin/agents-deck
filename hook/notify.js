#!/usr/bin/env node
// Plays a short sound when Claude Code finishes a turn. Installed by
// agents-deck as a Stop hook and toggled from the deck's topbar.
//
// The platform check happens HERE, at run time, rather than in the settings
// entry that invokes it. Hand-written sound hooks are almost always a single
// OS-specific command — `afplay` on a Mac, a PowerShell one-liner on Windows —
// which does nothing on any other machine, and typically ends in `|| true`, so
// the failure is silent. One script that picks its own player means the same
// settings.json works on every machine the user syncs it to.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// First entry whose file exists wins. Each is a [command, args] pair.
function players() {
  if (process.platform === "darwin") {
    const sound = ["/System/Library/Sounds/Glass.aiff", "/System/Library/Sounds/Ping.aiff"]
      .find(existsSync);
    return sound ? [["afplay", [sound]]] : [];
  }

  if (process.platform === "win32") {
    // PlaySync inside the hook process keeps the sound from being cut off when
    // the shell exits, which is what a bare Media.SoundPlayer call would do.
    const ps = "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\tada.wav').PlaySync()";
    return [["powershell.exe", ["-NoProfile", "-Command", ps]]];
  }

  // Linux and the BSDs: no single player is guaranteed, so try the common ones
  // in order of how likely they are to be present on a desktop install. The
  // freedesktop sound theme ships with most of them.
  const wav = [
    "/usr/share/sounds/freedesktop/stereo/complete.oga",
    "/usr/share/sounds/freedesktop/stereo/bell.oga",
  ].find(existsSync);
  return [
    ["canberra-gtk-play", ["--id", "complete"]],
    ...(wav ? [["paplay", [wav]], ["aplay", [wav]]] : []),
    // Last resort: the terminal bell. Silent under many configs, but costs
    // nothing to try and works over SSH where no audio device exists.
    ["printf", ["\\a"]],
  ];
}

// Try each candidate until one starts without ENOENT. Detached and unref'd so
// the hook returns immediately — Claude Code waits on hook processes, and a
// two-second sound should not be two seconds of latency at the end of a turn.
function play(candidates, i = 0) {
  if (i >= candidates.length) return;
  const [cmd, args] = candidates[i];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => play(candidates, i + 1));   // not installed — next
    child.unref();
  } catch {
    play(candidates, i + 1);
  }
}

play(players());
