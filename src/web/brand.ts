// The name the client calls itself, in one place — because the last time it was
// written by hand it ended up in thirteen, and the rename to ccdeck reached the
// repo, the command, the README and the terminal banner but none of them.
//
// The line this constant draws is the whole point of it: this is the name a
// HUMAN reads — the tab title, the topbar wordmark, every banner, tooltip and
// empty state. It is not an identifier. The localStorage namespace stays
// `agent-dag.*` (renaming a key discards the saved layout, viewport and pins of
// everyone who upgrades), the on-disk state stays under ~/.claude/agent-dag/ and
// ~/.agents-deck/, and the npm package the in-app update installs is still
// `agents-deck` — App.tsx's fallback `npm install -g agents-deck@latest` names
// the package, not the product, and is correct as written.
//
// index.html cannot import this: its <title> is static markup parsed before any
// module runs. src/server/brand.mjs holds the same string for the console and
// src/server/term.mjs draws it as the banner wordmark. All three are pinned
// against each other in __tests__/display-name.test.ts.

/** What the deck calls itself on every surface a user reads. */
export const PRODUCT = "ccdeck";
