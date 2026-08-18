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
