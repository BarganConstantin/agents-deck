// Where Claude Code keeps its configuration — and therefore where the
// settings.json our hooks have to be registered in actually lives.
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
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Absolute path of the Claude Code config dir: $CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudeConfigDir() {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".claude");
}
