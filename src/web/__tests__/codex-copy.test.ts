// Six strings that told a Codex user something false (#404), and the field that
// would have let them orient themselves.
//
// They were all written when the deck watched one CLI, and none of them was
// revisited when the second one landed. The worst of them was the empty canvas:
// it told a user with nothing on screen to install hooks into
// ~/.codex/hooks.json and to grant them `/hooks` trust on first run. The deck
// stopped installing Codex hooks in the same commit that introduced Codex
// support — installHooks throws on that provider, and the only code that opens
// that file now is the uninstaller — so the one sentence the app offered sent
// that user to hand-write a file the deck never reads and to hunt for a prompt
// that no longer exists, while the three real causes (--no-codex, no rollout
// written yet, CODEX_HOME pointing elsewhere) went unnamed.
//
// The rest were quieter and the same shape: a pulse line asserting every 800ms
// that "hooks cannot find this deck" on a deck whose capture does not use hooks;
// two topbar counters that count both CLIs under tooltips naming one; a README
// tagline promising that Codex forks subagents, which it has never emitted; and
// an empty detail panel waiting for a "first hook" that Codex cannot fire.
//
// The two counters have since been removed from the topbar outright, and
// `sessionsCountTitle` / `eventsCountTitle` with them — a product call about
// which numbers earn a permanent slot, not a retraction of #404. So the block
// below no longer calls those two functions; it holds the rule they were an
// instance of, against the provider-blind numbers the strip still shows.
//
// The fix is gated on `providers` (#402) rather than reworded into vagueness. A
// sentence that is true because it names no path, no flag and no variable is not
// an improvement on a false one — it is the same dead end with better manners —
// so a deck that is not watching a CLI says exactly that.
//
// PLAIN NODE. Nothing here renders React: the component sources are read as
// text and the pure modules are imported. Comments are stripped before any
// "appears nowhere" assertion, because the comments in this repo quote the copy
// they retired and are supposed to.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ASSUMED, type Providers } from "../providers";
import { captureHints } from "../provider-copy";
import { emptyScope } from "../scope";

// @ts-expect-error — .mjs server module, no types
const { pulseText, unregisteredDetail } = await import("../../server/term.mjs");

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

/** What is left of a source file once the prose is gone. Every explanation in
 *  this codebase that retires a string quotes it, including the JSX
 *  `{/* … *\/}` kind, so a search for retired wording has to read code only. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !/^\s*\/\//.test(line))
    .join("\n");
}

const appCode = codeOf(read("src", "web", "App.tsx"));
const nodeCode = codeOf(read("src", "web", "components", "AgentNode.tsx"));
const deckCode = codeOf(read("bin", "deck.js"));
const readme = read("README.md");
const stubReadme = read("ccdeck", "README.md");

/** The four things /api/health can report, including the pair no UI drew before
 *  #402 and the `--no-claude --no-codex` pair that watches nothing. */
const BOTH: Providers = { kind: "reported", claude: true, codex: true };
const CLAUDE_ONLY: Providers = { kind: "reported", claude: true, codex: false };
const CODEX_ONLY: Providers = { kind: "reported", claude: false, codex: true };
const NEITHER: Providers = { kind: "reported", claude: false, codex: false };

/** One hint's sentence, spans rejoined the way the browser renders them. */
const say = (p: Providers, provider: "claude" | "codex") =>
  captureHints(p).find(h => h.provider === provider)!.spans.map(s => s.text).join("");

describe("the empty canvas", () => {
  it("no longer sends anyone to install Codex hooks, because nothing installs them", () => {
    expect(appCode).not.toContain("hooks.json");
    expect(appCode).not.toContain("/hooks");
    expect(appCode).not.toContain("trust on first run");
    expect(appCode).not.toContain("hooks are installed");
  });

  it("tells a Codex user the three things that really keep the canvas empty", () => {
    // Two of them belong to a deck that IS watching Codex — the rollout tree is
    // not there yet, or CODEX_HOME points at another one — and the third is the
    // flag, which the deck can now report as the answer rather than list as a
    // possibility. Between the two branches all three are named, and neither
    // names a hook.
    const watching = say(BOTH, "codex");
    expect(watching).toContain("~/.codex/sessions/");
    expect(watching).toContain("$CODEX_HOME");
    expect(watching).not.toContain("hooks.json");
    expect(say(CLAUDE_ONLY, "codex")).toContain("--no-codex");
    // The sentence that used to be here spelled out $CLAUDE_CONFIG_DIR "if you
    // set it" and never once mentioned the variable that does the same job on
    // the other side.
    expect(say(BOTH, "claude")).toContain("$CLAUDE_CONFIG_DIR");
  });

  it("says a capture path is off rather than leaving the user to guess", () => {
    expect(captureHints(CODEX_ONLY).find(h => h.provider === "claude")!.watching).toBe(false);
    expect(say(CODEX_ONLY, "claude")).toContain("Claude Code capture is off");
    expect(say(CODEX_ONLY, "claude")).toContain("--no-claude");
    expect(captureHints(CLAUDE_ONLY).find(h => h.provider === "codex")!.watching).toBe(false);
    expect(say(CLAUDE_ONLY, "codex")).toContain("Codex capture is off");
    expect(say(CLAUDE_ONLY, "codex")).toContain("--no-codex");
  });

  it("never trades one CLI's advice for the other's", () => {
    for (const p of [BOTH, CLAUDE_ONLY, CODEX_ONLY, NEITHER]) {
      expect(say(p, "claude")).not.toContain(".codex");
      expect(say(p, "codex")).not.toContain("settings.json");
      expect(say(p, "codex")).not.toContain("hook");
    }
  });

  it("shows both lines when the server could not be asked, which is what it always drew", () => {
    // ASSUMED is what an older deck, a failed request, or the first render
    // before the fetch lands produces. Hiding a path there would hide the only
    // advice a user with a genuinely broken install has.
    expect(captureHints(ASSUMED).every(h => h.watching)).toBe(true);
  });
});

describe("the topbar readouts", () => {
  // The sessions and events counters this block was written for are gone from
  // the strip, and `sessionsCountTitle` / `eventsCountTitle` went with them —
  // #404 named the two tooltips it fixed, not a rule about tooltips in general.
  // What DOES generalise is the reason those strings were wrong: the strip's
  // numbers are provider-blind, so nothing in it may name one CLI. Tokens and
  // cost are the numbers left, they add up both CLIs exactly as the counters
  // did, and their tooltips are the ones that could drift the same way.
  const strip = appCode.slice(
    appCode.indexOf(`<span className="status">`),
    appCode.indexOf(`<div className="vis-hidden"`),
  );

  it("still has a strip with tooltipped numbers in it, so this block is not vacuous", () => {
    expect(strip, "the .status strip is gone from App.tsx entirely").toBeTruthy();
    expect(strip).toContain(`<span className="lbl">tokens</span>`);
    expect(strip).toContain("cost");
    expect((strip.match(/title=/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("labels no provider-blind number as one product's", () => {
    // The retired pair, first: neither string comes back anywhere.
    expect(appCode).not.toContain("Distinct CC sessions");
    expect(appCode).not.toContain("Total hook events received");
    // And nothing that remains in the strip names a CLI at all. `totalTokens`
    // and the cost aggregate walk every agent on the canvas, Codex ones
    // included, so any product name in these tooltips is the #404 defect again
    // on a different number.
    for (const name of ["Claude Code", "Codex", " CC ", "hook events"]) {
      expect(strip, `the status strip names ${name}`).not.toContain(name);
    }
  });
});

describe("the pulse line on a deck that watches no Claude Code", () => {
  it("stops repainting an alarm about a mechanism that deck does not use", () => {
    for (const columns of [40, 80, 200]) {
      const text = pulseText({ registered: false, claude: false, columns });
      expect(text).not.toContain("hooks cannot find this deck");
      expect(text).not.toContain("not registered");
      expect(text.trim()).toContain("listening");
    }
  });

  it("keeps the alarm wherever a hook really is looking for the deck", () => {
    // The default is Claude Code, so every existing caller and every deck that
    // watches both CLIs is unaffected.
    expect(pulseText({ registered: false, columns: 80 })).toContain("not registered");
    expect(pulseText({ registered: false, claude: true, columns: 80 })).toContain("not registered");
  });

  it("still pads every message to one width, because the line is redrawn over itself", () => {
    for (const columns of [40, 80, 200]) {
      const widths = new Set<number>();
      for (const claude of [true, false]) {
        for (const registered of [true, false]) {
          widths.add(pulseText({ registered, claude, columns }).length);
        }
      }
      expect(widths.size).toBe(1);
    }
  });
});

describe("the one-time report that a deck could not register", () => {
  it("no longer tells a Codex-only deck that no events arrive, because they do", () => {
    const said = unregisteredDetail({ file: "/tmp/deck.json", claude: false });
    expect(said).not.toContain("no events arrive");
    expect(said).toContain("events still arrive");
    expect(said).toContain("/tmp/deck.json");
  });

  it("still names the file, and what it costs, on a deck Claude Code hooks look for", () => {
    const said = unregisteredDetail({ file: "/tmp/deck.json", claude: true });
    expect(said).toContain("/tmp/deck.json");
    expect(said).toContain("no Claude Code events arrive");
  });

  it("is asked the question by the launcher rather than answered there", () => {
    expect(deckCode).toContain("unregisteredDetail({ file, claude: wantClaude })");
    expect(deckCode).toContain("claude: wantClaude");
    expect(deckCode).not.toContain("hooks find this deck through");
  });
});

describe("the empty detail panel while the scope is unknown", () => {
  it("waits for an event rather than a hook Codex cannot fire", () => {
    const scope = emptyScope(null);
    expect(scope.kind).toBe("unknown");
    expect(scope.lead).not.toContain("hook");
    expect(scope.lead).toContain("first event");
  });
});

describe("the README tagline, which is the npm page", () => {
  it("stops promising that Codex forks subagents", () => {
    // codexObjToPayload emits six event kinds and neither SubagentStart nor
    // SubagentStop, so a Codex session is a root and its tools — never a tree.
    for (const text of [readme, stubReadme]) {
      expect(text).not.toContain("OpenAI Codex fork subagents");
    }
    const server = read("src", "server", "index.mjs");
    const payload = server.slice(server.indexOf("export function codexObjToPayload"));
    expect(payload.slice(0, payload.indexOf("\n}\n"))).not.toContain("Subagent");
  });

  it("says the same thing in both packages, since both are published", () => {
    // Trimmed rather than compared raw: there is no .gitattributes here, so a
    // Windows checkout can hand these two files different line endings and the
    // comparison would fail on the \r rather than on the words.
    const tagline = (text: string) =>
      text.split("\n").map(l => l.trim()).find(l => l.startsWith("**A live canvas"));
    expect(tagline(readme)).toBeTruthy();
    expect(tagline(stubReadme)).toBe(tagline(readme));
    expect(tagline(readme)).toContain("Claude Code subagent");
  });
});

describe("the provider a node carries", () => {
  it("reaches a pixel on the cards that have no model to name it", () => {
    // README.md documents the model chip as how the two CLIs are told apart,
    // and it does not render on a synthetic node, a subagent with no model
    // event, or a root before its first ModelObserved.
    expect(nodeCode).toContain('data.provider === "codex"');
    expect(nodeCode).toContain(">Codex<");
  });

  it("does not print the reducer's default as if it were an observation", () => {
    // The reducer stamps "claude" on any event that names no provider, which is
    // how pre-multi-provider events replay — so it is an assumption, and the
    // card must not chip every model-less Claude node with it.
    expect(nodeCode).not.toContain(">Claude Code<");
  });
});
