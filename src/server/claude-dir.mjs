// Where Claude Code lives on this machine: its configuration directory, its
// binary, and the question of whether it is here at all.
//
// CLAUDE_CONFIG_DIR relocates that directory wholesale; it is a replacement for
// ~/.claude, not an overlay, so on a machine where it is set there is nothing in
// ~/.claude for Claude Code to read. Writing hook entries there is silent
// failure of the worst kind: the install reports success, no hook ever fires,
// and the deck stays empty with no error anywhere to explain it.
//
// Every module on the Claude side of the install resolves the directory through
// here, so the deck can never register its hooks in one file while Claude Code
// reads another. hook/hook.js repeats the rule inline rather than importing it:
// it is copied out of the package and run standalone by the host CLI, so it has
// no way back to this module, but it has to resolve the same directory.
//
// The binary list and the presence test moved in beside it for the same reason.
// The list used to sit in quota.mjs under the name quotaClaudeCandidates, where
// it read as a detail of one poller; it is nothing of the kind. It is the answer
// to "where does the `claude` command live", and the deck now asks that question
// at boot, before any quota exists, to decide whether this is a Claude machine
// at all. One list, one caller-visible name, no second spelling to drift.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, posix as posixPath, win32 as winPath } from "node:path";

/**
 * Absolute path of the Claude Code config dir: $CLAUDE_CONFIG_DIR or ~/.claude.
 *
 * The environment and the home directory are parameters purely so callers that
 * are already working from an injected environment can stay consistent with it;
 * every caller in the deck passes nothing and gets the real machine's answer.
 */
export function claudeConfigDir(env = process.env, home = homedir()) {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override ? resolve(override) : join(home, ".claude");
}

/**
 * Every place the `claude` CLI is known to live, in the order to try them.
 *
 * Pure, and the platform, environment and home directory are parameters, so the
 * Windows list can be checked from a Mac — which is the only way this list stays
 * right, since it exists entirely for machines the author is not sitting at.
 */
export function claudeCliCandidates(platform = process.platform, env = process.env, home = homedir()) {
  // The path flavour follows the PLATFORM ARGUMENT, not the host: node's `join`
  // would emit forward slashes when the Windows list is built on a Mac.
  const { join } = platform === "win32" ? winPath : posixPath;
  if (platform !== "win32") {
    return [
      "claude",
      join(home, ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ];
  }
  return [
    // The native installer, which ships a bare claude.exe and NO .cmd shim. It
    // was the one install this branch could not reach: the npm path below does
    // not exist on such a machine, and the bare-name fallback used to be spelled
    // `claude.cmd`, which cmd.exe cannot resolve to an .exe — PATHEXT supplies a
    // missing extension, it never substitutes one that is already there.
    join(home, ".local", "bin", "claude.exe"),
    // `npm i -g @anthropic-ai/claude-code`. npm's global prefix is %APPDATA%\npm
    // — Roaming rather than Local, deliberately, since it follows the user
    // between machines — and APPDATA is read from the environment because a
    // roaming profile puts it on a network share, not under the home directory.
    join(env.APPDATA || join(home, "AppData", "Roaming"), "npm", "claude.cmd"),
    // Last resort: the bare name, which cmd.exe resolves through PATH + PATHEXT
    // and so finds claude.exe and claude.cmd alike.
    "claude",
  ];
}

/**
 * The names Claude Code itself writes inside its config dir, and the deck never
 * does. Presence of any one of them is proof Claude Code has actually run here.
 *
 * The exclusions are the entire point. `settings.json` and `agent-dag/` are OURS
 * — installHooks writes the first and keepDiscovery creates the second — so a
 * test that accepted them would answer "Claude is installed" on any machine this
 * deck had ever been started on, including the Codex-only one this whole check
 * exists to recognise. That is not a hypothetical: every Codex-only machine that
 * ran an earlier ccdeck already has both sitting in a ~/.claude the deck created
 * for itself.
 *
 * `.credentials.json` is in the list but cannot carry it alone: macOS keeps the
 * OAuth token in the Keychain and writes no such file, so on the platform where
 * a credentials test is most tempting it is always negative (see #360). It earns
 * its place as one more way to say yes on Linux and Windows, never as the test.
 */
const CLAUDE_USE_MARKERS = [
  "projects",         // one directory per cwd, written from the first session on
  "history.jsonl",    // the prompt history, appended to on the first prompt
  "statsig",          // written at first launch, before any session completes
  "todos",
  "shell-snapshots",
  "ide",
  "plugins",
  ".credentials.json", // Linux + Windows OAuth store; absent on macOS by design
  ".claude.json",      // Claude Code's own state file, when the config dir moved
];

/**
 * Whether the `claude` binary is on this machine — on PATH, or in one of the
 * places its installers are known to put it.
 *
 * `run()` in exec.mjs can afford to hand a bare name to spawn and let the OS
 * resolve it. This cannot: it has to answer without launching anything. Boot is
 * the wrong place to spend a `claude --version` child process (quota.mjs
 * measured those at ~3.0s each), and a spawn probe would also have to decide
 * what a non-zero exit means, which is a question with no good answer. So the
 * PATH walk is done by hand, with PATHEXT applied on Windows exactly as cmd.exe
 * would — a `claude.cmd` shim from npm and a bare `claude.exe` from the native
 * installer both have to count, and neither is spelled `claude`.
 */
export function claudeCliOnDisk({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
} = {}) {
  const path = platform === "win32" ? winPath : posixPath;
  const bare = [];
  for (const candidate of claudeCliCandidates(platform, env, home)) {
    // A full path is worth a single stat; a bare name means "ask PATH", which
    // is the walk below. Same split quotaClaudeBin makes, for the same reason.
    if (candidate.includes(path.sep)) { if (exists(candidate)) return true; }
    else bare.push(candidate);
  }
  if (bare.length === 0) return false;

  // process.env is case-insensitive on Windows, but an injected plain object in
  // a test is not, and %Path% is how the variable is actually spelled there.
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  // The empty extension stays in the list: a Git-Bash or WSL-style shim on
  // Windows can be an extensionless file, and on POSIX it is the only entry.
  const exts = platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(e => e.trim()).filter(Boolean)]
    : [""];

  for (const entry of String(rawPath).split(path.delimiter)) {
    // Windows PATH entries are routinely quoted, and an empty entry means the
    // current directory — which is not a place to go looking for a CLI.
    const dir = entry.trim().replace(/^"+|"+$/g, "");
    if (dir === "") continue;
    for (const name of bare) {
      for (const ext of exts) if (exists(path.join(dir, name + ext))) return true;
    }
  }
  return false;
}

/**
 * Whether this machine has Claude Code at all — the mirror of hasCodexInstalled().
 *
 * README offers "Claude Code CLI or OpenAI Codex CLI (or both)", and until now
 * nothing anywhere asked which. A Codex-only machine got a Python
 * account-switcher installed for a CLI it does not have, an accounts panel open
 * on first run, and a banner telling it to sign into that CLI (#402).
 *
 * WHY TWO KINDS OF EVIDENCE, OR'd. Neither half is sufficient on its own:
 *
 *   - The binary alone misses the user whose `claude` lives somewhere no list
 *     knows (nvm, mise, volta, a corporate wrapper) and whose deck was launched
 *     from a desktop shortcut with a PATH that never sourced their shell rc.
 *     That user has run Claude Code for months; the config dir proves it.
 *   - The config dir alone misses the machine where Claude Code is installed and
 *     has never been launched, which is exactly the moment somebody installs
 *     both CLIs and starts the deck first. It also cannot be the test on its own
 *     for the opposite reason: THE DECK CREATES THAT DIRECTORY ITSELF. Hence
 *     CLAUDE_USE_MARKERS above, which is a list of things only Claude Code puts
 *     there.
 *
 * WHY NOT CREDENTIALS. A credentials file is not a presence test on macOS at
 * all — the token is in the Keychain and no file exists (#360) — so a machine
 * with Claude Code, signed in and in daily use, would read as Codex-only.
 *
 * WHY NOT "a Claude session was seen". It is the most direct evidence there is,
 * and it arrives far too late: the decision this answers is made at boot, before
 * the server is listening, and a machine whose first session has not started yet
 * would install nothing and show no panel until a restart.
 *
 * The bias is deliberate and one-way. A false yes leaves a Claude-only surface
 * on a Codex machine — today's bug, visible, and the user can pass --no-claude.
 * A false no takes the hooks away from somebody who has Claude Code, which is a
 * deck that stays empty forever. So every check here is generous, the banner
 * says out loud which way it went, and --claude overrides it.
 */
export function hasClaudeInstalled({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  configDir = claudeConfigDir(env, home),
  exists = existsSync,
} = {}) {
  if (claudeCliOnDisk({ platform, env, home, exists })) return true;
  const path = platform === "win32" ? winPath : posixPath;
  for (const marker of CLAUDE_USE_MARKERS) {
    if (exists(path.join(configDir, marker))) return true;
  }
  // ~/.claude.json is Claude Code's own state file on every install that never
  // moved the config dir, and it sits BESIDE the home directory rather than
  // inside ~/.claude — so the loop above cannot reach it there.
  return exists(path.join(home, ".claude.json"));
}
