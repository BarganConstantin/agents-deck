// Adding an account from the UI means driving two CLIs that were written for a
// human at a terminal. Everything below is a place where "it looked right in
// the terminal" and "it parses correctly" are different things — the sign-in
// link is printed twice inside escape sequences, the removal prompt has no
// --yes flag and must be answered by matching it, and a shared account is a
// live credential that has to stop working on its own.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { stripTerminalEscapes, extractLoginUrl, newSlot, wrapShare, unwrapShare, removePromptMatches, firstUseful, addFailureText, SHARE_TTL_MS } from "../../server/cswap-admin.mjs";

const AUTHORIZE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=ipcF4hM7&state=dSuby3fi";

// Byte-for-byte what `claude auth login` writes: OSC-8 opener carrying the url
// as the link TARGET, the same url again as the visible text, then an empty
// closer. Both terminated by BEL, verified against a real capture.
const REAL_OUTPUT =
  "Opening browser to sign in…\n" +
  "If the browser didn't open, visit: " +
  `\x1b]8;;${AUTHORIZE}\x07${AUTHORIZE}\x1b]8;;\x07` +
  "\nPaste code here if prompted > ";

describe("stripTerminalEscapes", () => {
  it("removes the hyperlink escapes and the duplicate url they carry", () => {
    const clean = stripTerminalEscapes(REAL_OUTPUT);
    expect(clean).not.toMatch(/\x1b/);
    expect((clean.match(/oauth\/authorize/g) ?? []).length).toBe(1);
  });

  it("keeps the prompt, which is what tells us the CLI is waiting", () => {
    expect(stripTerminalEscapes(REAL_OUTPUT)).toMatch(/Paste code here if prompted/);
  });

  it("removes ordinary colour codes too", () => {
    expect(stripTerminalEscapes("\x1b[1;32mok\x1b[0m")).toBe("ok");
  });
});

describe("extractLoginUrl", () => {
  it("returns the url exactly once, not the doubled string", () => {
    // The bug this prevents: /https:\/\/\S+/ on the raw bytes matches the link
    // target and the visible text as one run, producing a url that 404s.
    expect(extractLoginUrl(REAL_OUTPUT)).toBe(AUTHORIZE);
  });

  it("is null when there is no link — a failed launch, not a silent hang", () => {
    expect(extractLoginUrl("Already logged in as someone@example.com\n")).toBeNull();
    expect(extractLoginUrl("")).toBeNull();
    expect(extractLoginUrl(null)).toBeNull();
  });

  it("ignores urls that are not an authorize link", () => {
    expect(extractLoginUrl("see https://docs.claude.com/help for details")).toBeNull();
  });
});

describe("newSlot", () => {
  // `cswap add --json` is rejected by argparse, so the store is the only
  // trustworthy answer to "which slot did that land in".
  const store = (slots: string[]) => ({ slots, emails: {}, activeNum: null });

  it("names the slot that appeared", () => {
    expect(newSlot(store(["2", "3"]), store(["2", "3", "4"]))).toBe("4");
  });

  it("is null when the account was already managed and got refreshed in place", () => {
    // cswap overwrites the existing slot and prints "Updated credentials" —
    // a success, but not a new account, and the UI has to say the difference.
    expect(newSlot(store(["2", "3"]), store(["2", "3"]))).toBeNull();
  });

  it("is null rather than a guess when several slots appeared at once", () => {
    expect(newSlot(store(["2"]), store(["2", "3", "4"]))).toBeNull();
  });
});

describe("share envelope", () => {
  const NOW = 1_800_000_000_000;

  it("round-trips the payload", () => {
    const blob = wrapShare("{\"version\":1}", NOW);
    expect(blob.startsWith("ccdeck1:")).toBe(true);
    expect(unwrapShare(blob, NOW + 1000)).toEqual({ ok: true, payload: "{\"version\":1}" });
  });

  it("refuses a blob past its expiry", () => {
    // The whole point of the wrapper: a copy left in clipboard history stops
    // being an account.
    const blob = wrapShare("x", NOW);
    expect(unwrapShare(blob, NOW + SHARE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
    expect(unwrapShare(blob, NOW + SHARE_TTL_MS - 1).ok).toBe(true);
  });

  it("refuses anything that is not one of ours", () => {
    expect(unwrapShare("{\"version\":1}").reason).toBe("not_a_share");
    expect(unwrapShare("").reason).toBe("not_a_share");
    expect(unwrapShare(null).reason).toBe("not_a_share");
  });

  it("refuses a truncated paste rather than handing fragments to cswap", () => {
    const blob = wrapShare("payload", NOW);
    expect(unwrapShare(blob.slice(0, blob.length - 20), NOW).reason).toBe("corrupt");
  });

  it("refuses a version it does not know", () => {
    const future = "ccdeck1:" + btoa(JSON.stringify({ v: 2, exp: NOW + 1000, payload: "x" }));
    expect(unwrapShare(future, NOW).reason).toBe("wrong_version");
  });

  it("tolerates the whitespace a paste picks up", () => {
    const blob = wrapShare("payload", NOW);
    expect(unwrapShare(`  ${blob}\n`, NOW).ok).toBe(true);
  });
});

describe("removePromptMatches", () => {
  const prompt = (n: number) =>
    `Are you sure you want to permanently remove Account-${n} (a@b.c)? [y/N] `;

  it("answers the exact question cswap asked", () => {
    expect(removePromptMatches(prompt(4), 4)).toBe(true);
    expect(removePromptMatches(prompt(4), "4")).toBe(true);
  });

  it("refuses to confirm the removal of a different account", () => {
    // A blind "y" here deletes the wrong credentials, irrecoverably.
    expect(removePromptMatches(prompt(3), 4)).toBe(false);
  });

  it("refuses anything that is not that prompt", () => {
    expect(removePromptMatches("Warning: Account-4 (a@b.c) is currently active", 4)).toBe(false);
    expect(removePromptMatches("Enter account number to remove: ", 4)).toBe(false);
    expect(removePromptMatches("", 4)).toBe(false);
  });

  it("sees through colour codes", () => {
    expect(removePromptMatches(`\x1b[33m${prompt(4)}\x1b[0m`, 4)).toBe(true);
  });
});

describe("firstUseful / addFailureText", () => {
  it("takes the last real line, which is where a CLI puts its verdict", () => {
    expect(firstUseful("checking…\nError: No active Claude account found. Please log in first.\n"))
      .toBe("No active Claude account found. Please log in first.");
  });

  it("is empty rather than misleading when there is nothing to say", () => {
    expect(firstUseful("")).toBe("");
    expect(firstUseful("\n  \n---\n")).toBe("");
  });

  it("tells a Keychain failure what to actually do about it", () => {
    // The one failure a server hits that a terminal does not: without a GUI
    // session macOS refuses the credential read, and claude-swap's own message
    // stops short of naming the fix.
    const out = addFailureText({ stderr: "Error: The macOS Keychain is unreadable right now (locked).", code: 1 });
    expect(out).toMatch(/Keychain is unreadable/);
    expect(out).toMatch(/start agents-deck from a Terminal/i);
  });

  it("falls back to the exit code when the CLI said nothing at all", () => {
    expect(addFailureText({ stderr: "", stdout: "", code: 2 })).toBe("cswap add exited 2");
  });
});
