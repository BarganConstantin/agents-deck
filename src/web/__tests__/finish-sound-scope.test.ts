// The finish-sound toggle said "Sound on turn finish" and meant "Claude Code
// turns only" (#394).
//
// The sound is one entry in Claude Code's settings.json — a `Stop` hook whose
// command is notify.js, executed by Claude Code itself at the end of a turn.
// Codex never reaches it: the deck installs no Codex hooks (it stopped in the
// commit that introduced Codex support, because they do not fire reliably on
// Windows) and reads the rollout JSONL files after the fact instead. So a Codex
// user turned the switch on and watched turn after turn finish in silence, with
// nothing anywhere to read that silence against — and correct behaviour is
// indistinguishable from a broken toggle when nothing says which it is.
//
// What is asserted here is that the two halves stay together: the mechanism is
// Claude-only, the button is drawn only where Claude Code is, and the sentence
// names the mechanism rather than only the limit. "Claude Code only" is a fact a
// user can act on; "sound" alone is not.
//
// #395 made the deck see the end of a Codex turn — task_complete and
// turn_aborted map to a synthetic `Stop` — so the moment IS known now, and a
// server-side sound became possible where it was not when this issue was filed.
// It is still not this fix, and finishSoundTitle records why: the Claude sound
// is a hook on the machine and fires once with no deck running at all, while a
// server-side one fires once per deck tailing that rollout, only inside that
// deck's workspace, and never with the deck down. The last test below pins the
// premise the whole sentence rests on, so a future provider cannot be added to
// the mechanism while the copy goes on claiming otherwise.
//
// PLAIN NODE. Nothing here renders React — the component source is read as text
// and the pure module is imported. Comments are stripped before every "appears
// nowhere" assertion, because the explanations in this repo quote the strings
// they retire and are supposed to.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ASSUMED, type Providers } from "../providers";
import { finishSoundTitle } from "../provider-copy";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

/** A source file with its prose gone — block comments, the JSX `{/* … *\/}`
 *  kind, and line comments — so a search for retired wording reads code only. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !/^\s*\/\//.test(line))
    .join("\n");
}

const appCode = codeOf(read("src", "web", "App.tsx"));

const BOTH: Providers = { kind: "reported", claude: true, codex: true };
const CLAUDE_ONLY: Providers = { kind: "reported", claude: true, codex: false };

/** The switch as it sits on a machine nobody has hand-written a hook on, which
 *  is every machine until someone does. */
const PLAIN = { clash: 0, parked: 0 };

describe("the finish-sound tooltip on a machine running both CLIs", () => {
  it("says which turns it covers, in both states", () => {
    for (const on of [true, false]) {
      const said = finishSoundTitle(BOTH, { on, ...PLAIN });
      expect(said).toContain("Claude Code turns only");
      expect(said).toContain("Codex turns finish in silence");
    }
  });

  it("names the mechanism, not just the limit", () => {
    // A user who reads "Claude Code only" and nothing else has a rule with no
    // reason, and no way to tell whether their own install is at fault. The
    // sentence names the hook that plays the sound and the reason the other
    // path has none, which are the two facts that end the search.
    const said = finishSoundTitle(BOTH, { on: false, ...PLAIN });
    expect(said).toContain("Stop hook");
    expect(said).toContain("rollout files");
  });

  it("still says what it is and what a click does", () => {
    // The lead is what the tooltip was for before any of this and it does not
    // move: the qualification is added to it, not swapped in for it.
    expect(finishSoundTitle(BOTH, { on: true, ...PLAIN }))
      .toContain("Sound on turn finish: on — click to remove the hook");
    expect(finishSoundTitle(BOTH, { on: false, ...PLAIN }))
      .toContain("Sound on turn finish: off — click to add a Stop hook");
  });

  it("leads with what the switch is before it qualifies it", () => {
    const said = finishSoundTitle(BOTH, { on: true, clash: 2, parked: 1 });
    expect(said.indexOf("Sound on turn finish")).toBe(0);
    // The scope comes ahead of the settings.json footnotes: those are about
    // hooks the user wrote, this is about which turns the switch covers at all.
    expect(said.indexOf("Claude Code turns only"))
      .toBeLessThan(said.indexOf("of your own in settings.json"));
  });
});

describe("the same tooltip where there is no Codex to be silent about", () => {
  it("does not warn a Claude-only machine off a CLI it does not have", () => {
    // The mirror of every other string derived from `providers`: a deck that is
    // not watching a CLI says nothing about it rather than hedging at everyone.
    for (const on of [true, false]) {
      expect(finishSoundTitle(CLAUDE_ONLY, { on, ...PLAIN })).not.toContain("Codex");
    }
  });

  it("warns before the server has answered, which is when both are assumed", () => {
    // ASSUMED is an older deck, a failed /api/health, or the first render. Both
    // fields read true there, and that is the safe direction: the caveat is
    // merely irrelevant on a machine with no Codex, and its absence on a
    // machine with one is the bug.
    expect(finishSoundTitle(ASSUMED, { on: true, ...PLAIN })).toContain("Claude Code turns only");
  });
});

describe("the two footnotes about the user's own hooks", () => {
  it("survived the move out of App.tsx word for word, singular and plural", () => {
    const one = finishSoundTitle(BOTH, { on: true, clash: 1, parked: 1 });
    expect(one).toContain("1 sound hook of your own in settings.json also runs here.");
    expect(one).toContain("1 of your own sound hook was set aside");
    expect(one).toContain("shift-click to put it back");

    const many = finishSoundTitle(BOTH, { on: true, clash: 3, parked: 2 });
    expect(many).toContain("3 sound hooks of your own in settings.json also run here.");
    expect(many).toContain("2 of your own sound hooks were set aside");
    expect(many).toContain("shift-click to put them back");
  });

  it("says nothing at all when there is nothing to say", () => {
    const said = finishSoundTitle(BOTH, { on: false, ...PLAIN });
    expect(said).not.toContain("of your own");
    expect(said).not.toContain("shift-click");
  });
});

describe("the topbar button", () => {
  it("is not drawn at all on a machine with no Claude Code", () => {
    // Gone rather than present and disabled, which is the rule the accounts
    // button already follows: a disabled control is a promise that something
    // could enable it, and nothing here can. Every entry point this switch has
    // writes to Claude Code's settings.json.
    expect(appCode).toContain("{providers.claude && soundOn !== null && (");
  });

  it("reads its tooltip out of the module that owns the words", () => {
    expect(appCode).toContain("finishSoundTitle(providers, { on: soundOn, clash: soundClash, parked: soundParked })");
  });

  it("keeps no unqualified copy of the old sentence in the component", () => {
    // The strings themselves moved; what must not survive is a second copy in
    // App.tsx that no longer goes past finishSoundTitle and so never picks up
    // the qualification.
    expect(appCode).not.toContain('"Sound on turn finish: on');
    expect(appCode).not.toContain('"Sound on turn finish: off');
  });

  it("names the CLI in the label a screen reader announces", () => {
    // `title` reaches assistive tech as a description at best, which is not
    // announced everywhere and not first anywhere. The name carries it too.
    expect(appCode).toContain('aria-label="Toggle Claude Code finish sound"');
    expect(appCode).not.toContain('aria-label="Toggle finish sound"');
  });
});

describe("the premise the sentence rests on", () => {
  it("holds: neither the toggle nor the sound it plays knows what Codex is", () => {
    // The issue's own verification, kept as a test. If a provider is ever added
    // to this mechanism, the tooltip above stops being true on the same day —
    // so this failing is the signal to rewrite finishSoundTitle, not to delete
    // the assertion. Comments are stripped first: the module header explains at
    // length why Codex is absent, and naming it there is the documentation
    // working, not the feature arriving.
    for (const parts of [["src", "server", "sound-hook.mjs"], ["hook", "notify.js"]]) {
      expect(codeOf(read(...parts)).toLowerCase(), parts.join("/")).not.toContain("codex");
    }
  });

  it("holds on the other side too: the hook is written where Claude Code reads", () => {
    // claudeConfigDir() honours $CLAUDE_CONFIG_DIR and resolves to ~/.claude —
    // one CLI's file, on the one event that CLI fires at the end of a turn.
    const source = read("src", "server", "sound-hook.mjs");
    expect(source).toContain('const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json")');
    expect(source).toContain('const EVENT = "Stop"');
  });
});
