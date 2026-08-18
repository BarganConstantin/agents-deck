// How the browser NAMES the CLIs it watches. providers.ts holds the fact; this
// holds the words, and derives them from that fact instead of asserting them.
//
// Every string here replaces one that was written when the deck watched a single
// CLI and was never revisited when the second one landed (#404). The worst of
// them was the empty-state hint, which told a Codex user to install hooks: the
// deck stopped installing Codex hooks in the very commit that introduced Codex
// support, `installHooks` throws on that provider now, and the file the copy
// named — ~/.codex/hooks.json — is opened by nothing but the uninstaller. So a
// user whose canvas was empty for one of the three real reasons (started with
// --no-codex, no rollout written yet, CODEX_HOME pointing at another tree)
// hand-wrote a file the deck never reads and then hunted for a trust prompt that
// no longer exists.
//
// The fix is not to soften those sentences until they are true of everything.
// A deck that is not watching Codex can say so — /api/health reports `providers`
// since #402 — and "Codex capture is off" is both true and the one sentence that
// ends the search. Vagueness would have been the other way out and it helps
// nobody: a hint that names no path, no flag and no variable is a hint a user
// cannot act on.
//
// Kept out of App.tsx for the same reason scope.ts and providers.ts are: these
// branches can then be read and tested without rendering React, and the branch
// that matters most is the one nobody exercises by hand — a Codex-only machine.
import type { Providers } from "./providers";

/**
 * The CLIs this deck watches, named for the middle of a sentence.
 *
 * `null` when it watches neither — `--no-claude --no-codex`, which is a legal
 * pair of flags. Naming a CLI there would be a claim about a counter that can
 * only ever read zero, so the callers below drop the qualifier instead.
 */
function providerNames(p: Providers): string | null {
  if (p.claude && p.codex) return "Claude Code and Codex";
  if (p.claude) return "Claude Code";
  if (p.codex) return "Codex";
  return null;
}

/**
 * The names ccusage's own agent ids do not title-case into.
 *
 * ccusage reports one lowercase id per CLI it read — `claude`, `codex`,
 * `opencode`, `amp`, `droid`, `gemini` and a dozen more — and the deck prints
 * them beside dollar figures, so they have to be the names the products go by.
 * Only the ones a title-case cannot reach are listed: `claude` and `codex`
 * because this deck has always called them Claude Code and Codex, and the four
 * that carry an internal capital or a suffix in ccusage's own table. Everything
 * else — Amp, Droid, Goose, Gemini, Grok, Kilo, Kimi, Qwen, Codebuff, Hermes —
 * title-cases correctly and is deliberately NOT enumerated here: an id this
 * deck has never seen is far likelier to be a CLI ccusage learned about after
 * this line was written than a mistake, and printing it title-cased is a better
 * answer than dropping it or shipping a table that goes stale in silence.
 */
const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  copilot: "GitHub Copilot",
  pi: "pi-agent",
};

/** One of ccusage's agent ids, as a name to print. Unknown ids are title-cased
 *  rather than passed through raw, so a CLI added to ccusage after this build
 *  still reads as a product name; an empty id comes back empty.
 *
 *  `hasOwn` rather than truthiness (#474). The id is whatever ccusage put in its
 *  JSON, and an inherited member is truthy: `AGENT_NAMES["constructor"]` is a
 *  function, which would be printed beside a dollar figure instead of a name. */
export function agentLabel(id: string): string {
  const key = id.toLowerCase();
  if (Object.hasOwn(AGENT_NAMES, key)) return AGENT_NAMES[key];
  return key ? key[0].toUpperCase() + key.slice(1) : "";
}

/** A list of names for the middle of a sentence: "A", "A and B", "A, B and C".
 *  No Oxford comma, matching providerNames above, which has said "Claude Code
 *  and Codex" since it was written. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the usage-history modal says it is showing, under its title.
 *
 * The line used to be the constant "via ccusage · local Claude / Codex logs",
 * and #431 is about the gap between its two halves: it named two CLIs and the
 * chart below then added them together, so the subtitle promised a distinction
 * the panel refused to make. It was also wrong in a second direction nobody had
 * noticed — ccusage reads sixteen CLIs, not two, so a machine running OpenCode
 * had its spend in that number under a subtitle that denied it existed.
 *
 * So the line is derived, and from the run when there is one. `found` is the
 * agent ids the range actually came back with, which is a MEASUREMENT of whose
 * logs are in the figures on screen; `providers` is what the deck was started
 * to watch, which is a different fact and can honestly disagree — a deck run
 * with `--no-codex` still gets Codex spend out of ccusage, because ccusage
 * reads the logs on the machine rather than the deck's flags.
 *
 * The measurement wins when it exists, and `providers` is the fallback for
 * every state where there is nothing to measure: the first render, a run still
 * going, a run that failed, an empty range, and a ccusage too old to report the
 * split at all. That is the case #402 put `providers` in /api/health for — it
 * is the only thing that can keep a Claude-only machine from being told about
 * Codex, and a Codex-only machine from being told about Claude Code, before any
 * data exists to say otherwise.
 *
 * A deck watching neither CLI names none, for the same reason providerNames
 * returns null there: "local logs" claims nothing that can turn out to be
 * false.
 */
export function usageSubtitle(p: Providers, found: readonly string[] = []): string {
  const names = found.length ? joinNames(found.map(agentLabel)) : providerNames(p);
  return names ? `via ccusage · local ${names} logs` : "via ccusage · local agent logs";
}

/**
 * Where this deck's events physically come from.
 *
 * Two capture paths, and only one of them is hooks: Claude Code posts through
 * the hook entry in settings.json, while Codex is read out of the rollout JSONL
 * files the CLI writes for itself. A tooltip that calls all of them "hook
 * events" is wrong on a machine running Codex, and wrong in the direction that
 * sends the user to inspect a hook install that has nothing to do with it.
 */
function eventSourceNames(p: Providers): string | null {
  if (p.claude && p.codex) return "Claude Code hooks and Codex rollout files";
  if (p.claude) return "Claude Code hooks";
  if (p.codex) return "Codex rollout files";
  return null;
}

/**
 * The topbar's session counter, explained.
 *
 * `sessionCount` has counted both providers since Codex support landed, while
 * the tooltip read "Distinct CC sessions" — a string five days older than that
 * support, which survived the migration untouched. This number is the first
 * thing a user checks to confirm capture works at all, so labelling it as a
 * count of a different product's sessions makes a correct number read as
 * evidence of failure.
 */
export function sessionsCountTitle(p: Providers): string {
  const names = providerNames(p);
  return names ? `Distinct sessions — ${names}` : "Distinct sessions";
}

/** The topbar's event counter, explained — see eventSourceNames for why it can
 *  no longer be called a count of hook events. */
export function eventsCountTitle(p: Providers): string {
  const sources = eventSourceNames(p);
  return sources ? `Total events received — ${sources}` : "Total events received";
}

/** One run of the hint sentence. `code` marks the runs that render in <code>,
 *  which is every path, flag and variable in it — the parts a user retypes. */
export interface HintSpan {
  text: string;
  code?: boolean;
}

/** What the empty canvas is allowed to say about one capture path. */
export interface CaptureHint {
  /** Which path this line is about, and the React key for it. */
  provider: "claude" | "codex";
  /** False when this deck is not watching that CLI at all, which is the case
   *  the old copy could not express and the one that ends the search fastest. */
  watching: boolean;
  spans: HintSpan[];
}

/**
 * Why the canvas may still be empty, one line per capture path.
 *
 * Each line names what that path actually depends on, so the two never trade
 * advice: Claude Code depends on a hook entry in settings.json, and Codex
 * depends on nothing being installed at all — the server tails the rollout tree
 * itself. The three real reasons a Codex canvas stays empty are the flag, the
 * missing tree, and CODEX_HOME; none of them is a hook, and none of them was
 * named before.
 */
export function captureHints(p: Providers): CaptureHint[] {
  const claude: CaptureHint = p.claude
    ? {
        provider: "claude",
        watching: true,
        spans: [
          { text: "Claude Code sends its events through a hook in " },
          { text: "~/.claude/settings.json", code: true },
          { text: " — or in " },
          { text: "$CLAUDE_CONFIG_DIR/settings.json", code: true },
          { text: " when you have that set — which the deck installs on first run." },
        ],
      }
    : {
        provider: "claude",
        watching: false,
        spans: [
          { text: "Claude Code capture is off: no Claude Code was found on this machine, or the deck was started with " },
          { text: "--no-claude", code: true },
          { text: "." },
        ],
      };

  const codex: CaptureHint = p.codex
    ? {
        provider: "codex",
        watching: true,
        spans: [
          { text: "Codex installs nothing and needs no trust prompt — the deck reads " },
          { text: "~/.codex/sessions/", code: true },
          { text: " itself, so an empty canvas means no rollout has been written there yet, or that " },
          { text: "$CODEX_HOME", code: true },
          { text: " points at a different tree." },
        ],
      }
    : {
        provider: "codex",
        watching: false,
        spans: [
          { text: "Codex capture is off: no " },
          { text: "~/.codex/", code: true },
          { text: " was found — set " },
          { text: "$CODEX_HOME", code: true },
          { text: " if yours lives elsewhere — or the deck was started with " },
          { text: "--no-codex", code: true },
          { text: "." },
        ],
      };

  return [claude, codex];
}

/** What the finish-sound toggle knows about itself, from /api/sound-hook. */
export interface FinishSoundState {
  /** Whether our Stop entry is currently in settings.json. */
  on: boolean;
  /** Sound hooks the user wrote themselves that also fire on this machine. */
  clash: number;
  /** Sound hooks of theirs the toggle has set aside so it controls the sound. */
  parked: number;
}

/**
 * The finish-sound toggle's tooltip — including the turns it does NOT cover.
 *
 * This switch is one line in Claude Code's settings.json: a `Stop` hook whose
 * command is notify.js, which Claude Code itself executes at the end of a turn.
 * Nothing about that reaches Codex. The deck installs no Codex hooks — it
 * stopped in the commit that introduced Codex support, because they do not fire
 * reliably on Windows — and reads the rollout JSONL files instead, after the
 * fact. So a Codex user turned this on, watched turn after turn finish in
 * silence, and had nothing anywhere to read it against (#394). An unqualified
 * "Sound on turn finish" is the whole of the problem: the silence is correct
 * behaviour and it is indistinguishable from a broken toggle.
 *
 * Two other endings were available and both were rejected:
 *
 *   - Play it in the browser with Web Audio. The hook plays with no tab open at
 *     all, because it runs on the machine; a tab cannot. It would also be
 *     silent in a tab that has never been clicked, which autoplay policy makes
 *     the normal state of a monitoring deck left in the background — the exact
 *     tab this feature exists for. One switch would then mean two different
 *     promises, and the weaker one only where the user is not looking.
 *
 *   - Spawn notify.js from the server when the rollout watcher emits its
 *     synthetic Codex `Stop` (#395 added that event, so the moment is known
 *     now). Closer, but the switch still would not mean one thing: the Claude
 *     sound is a hook on the machine, so it fires once whether zero decks or
 *     four are running and whatever `--workspace` they were given, while a
 *     server-side sound fires once PER deck tailing that rollout (the
 *     writesCodexLog election that de-dupes the log only runs under --persist),
 *     only inside that deck's workspace, and not at all when no deck is up. And
 *     the switch has nowhere honest to keep its state for a machine that has no
 *     Claude Code: turning it on writes a `Stop` hook into a settings.json for a
 *     CLI that is not installed, which is the class of bug #402 and #404 just
 *     removed. That is a feature with its own design, not this defect.
 *
 * So the toggle stays what it is and says what it is. The sentence names the
 * mechanism, not just the limit, because "Claude Code only" is a fact a user can
 * act on and "sound" alone is not — and it is added only on a machine that has a
 * Codex to be silent about. On a Claude-only machine there is nothing to warn
 * anyone off, and the deck does not draw the button at all without Claude Code.
 */
export function finishSoundTitle(p: Providers, s: FinishSoundState): string {
  const lead = s.on
    ? "Sound on turn finish: on — click to remove the hook"
    : "Sound on turn finish: off — click to add a Stop hook";

  // First, ahead of the settings.json footnotes below: those are about hooks the
  // user wrote, and this is about which of their turns the switch covers at all.
  const scope = p.codex
    ? "\n\nClaude Code turns only. The sound is a Stop hook Claude Code runs itself when a turn ends; " +
      "the deck installs nothing for Codex and reads its rollout files after the fact, " +
      "so Codex turns finish in silence."
    : "";

  const clash = s.clash > 0
    ? `\n\n${s.clash} sound hook${s.clash > 1 ? "s" : ""} of your own in settings.json also run${s.clash > 1 ? "" : "s"} here.`
    : "";

  const parked = s.parked > 0
    ? `\n\n${s.parked} of your own sound hook${s.parked > 1 ? "s were" : " was"} set aside so this switch actually controls the sound. ` +
      `Nothing was deleted — shift-click to put ${s.parked > 1 ? "them" : "it"} back.`
    : "";

  return lead + scope + clash + parked;
}
