// What the README's first screen spends itself on (#440), and where the hero
// image lives (#439).
//
// The prose was never the problem. `--workspace` explaining that every matching
// deck draws the session while the log still gets one copy, the WARNING on share
// blobs, the note that a restart is refused under --no-persist because there is
// nothing to replay — that is the writing of someone who has hit these cases,
// and none of it is deletable. What was wrong was the order: the two paragraphs
// that disclose what the deck writes and what leaves the machine sat in the two
// highest-value slots on the page — the second paragraph of "Why", and the line
// directly under `npx ccdeck` — where a reader who has not yet decided they want
// the tool met "it rewrites my auth file" and 109 words on 20-byte GETs before
// they had run anything. Both are now under "What it touches", where a reader
// who HAS decided goes looking, and both moved verbatim.
//
// So the regression this file guards is deletion and re-inlining, in both
// directions. A future tidy-up that drops either passage silently removes the
// only place the deck admits what it writes; one that pastes either back into
// "Why" or "Quick start" puts the objection back in front of the desire. The
// passages are therefore asserted word for word AND asserted to appear exactly
// once, since a copy left behind reads as an accident on a page this careful.
//
// The hero is asserted by location only. The shot itself still shows the
// pre-rename wordmark, which no test can see and no edit to this repo can fix —
// it needs re-taking on a current build. What CAN be pinned is that the file
// exists, that it is not embedded from the repo root under a screenshot tool's
// timestamped filename, and that it is reachable at full size, because GitHub
// renders it at roughly half scale. The caption that currently explains the old
// wordmark is deliberately NOT pinned: it has to go the day the shot is
// replaced, and a test holding it in place would be pinning a lie.
//
// PLAIN NODE. The READMEs are read as text; nothing here imports a module that
// touches the filesystem on its own.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");
const readme = read("README.md");

/** Where a heading starts, or -1. Headings are matched at line start so a
 *  mention of a section's name inside a paragraph is not mistaken for it. */
const at = (heading: string) => readme.indexOf(`\n${heading}\n`);

/** How many times a passage appears — the check that a move was a move. */
const times = (needle: string) => readme.split(needle).length - 1;

/** The two paragraphs, exactly as they read before they were moved. */
const WRITES =
  "It never steers an agent or edits your code, but it is not read-only either — besides the hook entry and its own event log, it manages the two tools it leans on, and it refreshes the Codex token it reads quota with, rewriting `~/.codex/auth.json` the way `codex` itself does.";
const NETWORK =
  "What does go out is short and ordinary: a ~20-byte version check against the npm registry";

describe("the disclosures the README must keep, and keep in one place", () => {
  it("gives them a section of their own", () => {
    expect(at("## What it touches")).toBeGreaterThan(-1);
  });

  it("still says, word for word, what the deck writes", () => {
    expect(readme).toContain(WRITES);
    expect(times(WRITES)).toBe(1);
  });

  it("still says, word for word, what leaves the machine", () => {
    expect(readme).toContain(NETWORK);
    expect(readme).toContain("`AGENTS_DECK_NO_INSTALL=1` turns off everything but the quota reads");
    expect(readme).toContain("no `uv` binary is fetched, the managed installs stay");
    expect(times(NETWORK)).toBe(1);
  });

  it("keeps both of them out of the two slots they used to occupy", () => {
    // The section a passage lands in is the whole point of the move, so the
    // test asks where it is rather than only that it exists somewhere.
    const touches = at("## What it touches");
    expect(touches).toBeGreaterThan(-1);
    expect(readme.indexOf(WRITES)).toBeGreaterThan(touches);
    expect(readme.indexOf(NETWORK)).toBeGreaterThan(touches);
  });

  it("leaves the three-beat line under the install command, and a way through to the rest", () => {
    // "No config file. No account. No telemetry." is the one claim on the page
    // most tools in this category cannot honestly make. Moving the detail out
    // from under it is only an improvement while the line itself stays put.
    const quick = at("## Quick start");
    const three = readme.indexOf("No config file. No account. No telemetry —");
    expect(three).toBeGreaterThan(quick);
    expect(three).toBeLessThan(at("## Requirements"));
    expect(readme).toContain("[What it touches](#what-it-touches)");
  });
});

describe("the order a first-time reader meets the page in", () => {
  it("answers what it is and what it does before how to run it", () => {
    expect(at("## Why")).toBeLessThan(at("## What you get"));
    expect(at("## What you get")).toBeLessThan(at("## Quick start"));
  });

  it("answers whether it runs here right after telling them to run it", () => {
    // The platform badge links to #requirements, which is a mitigation for a
    // section that used to be eleventh of twelve — badges get scanned, not
    // clicked, and "do I need Node, does this work on Windows" is a question a
    // stranger has before they have any reason to hunt for the answer.
    expect(readme).toContain("](#requirements)");
    expect(at("## Requirements")).toBeGreaterThan(at("## Quick start"));
    expect(at("## Requirements")).toBeLessThan(at("## How it works"));
  });

  it("puts the disclosures after the mechanism they disclose", () => {
    expect(at("## What it touches")).toBeGreaterThan(at("## How it works"));
  });

  it("leaves the post-install sections below the ones a converting reader wants", () => {
    // ## Updating and ### Restarting are 415 words answering a question only an
    // existing user has ever asked, and they used to sit above ## Options.
    expect(at("## Options")).toBeLessThan(at("## Updating"));
    expect(at("## Uninstall")).toBeLessThan(at("## Updating"));
    expect(at("### Restarting")).toBeGreaterThan(at("## Updating"));
  });

  it("carries the positioning line where a stranger reads it", () => {
    // "One canvas. No tabs. No kanban." is not a design note. Two of the tools
    // in this category advertise exactly those, one as tabs for multi-session
    // and one as a Kanban board. It used to be below Uninstall.
    const line = readme.indexOf("One canvas. No tabs. No kanban.");
    expect(line).toBeGreaterThan(at("## What you get"));
    expect(line).toBeLessThan(at("## Quick start"));
  });

  it("leads the feature table with the rows no competitor claims", () => {
    const table = readme.slice(at("## What you get"), at("## Quick start"));
    const rows = table.split("\n").filter(l => l.startsWith("| **"));
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]).toContain("**Blocked on you**");
    expect(rows[1]).toContain("**Cost and quota, live**");
  });
});

describe("the hero image", () => {
  /** Every path the README embeds, in order. */
  const embedded = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map(m => m[1])
    .filter(p => !/^https?:/.test(p));

  it("is one local file, and it is there", () => {
    expect(embedded).toHaveLength(1);
    expect(existsSync(join(repo, embedded[0]))).toBe(true);
  });

  it("is not a screenshot tool's filename sitting in the repo root", () => {
    // 13 entries in the root, sorted with directories first: a file named
    // image_<date>_<time>.png lands in a visitor's first field of view, above
    // the rendered README, on a repo whose whole pitch is care.
    expect(embedded[0]).toBe("assets/canvas.png");
    expect(embedded[0]).not.toMatch(/^image_/);
  });

  it("is reachable at full size, because GitHub renders it at about half scale", () => {
    // 1917px wide in a ~890px column. The node labels, model chips and the cost
    // table are a smear at that width; the link is what is left until the shot
    // is re-taken narrower.
    expect(readme).toContain(`[![`);
    expect(readme).toContain(`](${embedded[0]})](${embedded[0]})`);
  });
});

describe("the two npm badges, which name two different packages", () => {
  it("says which package the download count belongs to", () => {
    // Deliberate — one tarball goes out under three names and the counts are
    // per name — but `npm/v/ccdeck` beside an unlabelled `npm/dm/agents-deck`,
    // under an h1 that says ccdeck, reads as a copy-paste slip. Labelling it is
    // the honest fix; calling it "all names" would be a new false string, since
    // the badge counts one of the three.
    expect(readme).toContain("npm/dm/agents-deck");
    expect(readme).toContain("label=agents-deck%20downloads");
  });
});

describe("the stub package's README, which is the ccdeck npm page", () => {
  const stub = read("ccdeck", "README.md");

  it("embeds no image, so #439's hero is a one-file problem", () => {
    expect(stub).not.toContain("![");
  });

  it("carries no disclosure paragraph to move, only the three-beat line", () => {
    expect(stub).not.toContain(WRITES);
    expect(stub).not.toContain(NETWORK);
    expect(stub).toContain("No config file, no account, no telemetry.");
  });
});
