// The context panel lists the CLAUDE.md files Claude Code injects, and one
// group of them lives at ~/.claude/projects/<slug>/memory/*.md — found by
// re-deriving <slug> from the session's cwd. That derivation only replaced the
// path separators and the Windows drive colon, but CC flattens *every*
// non-alphanumeric character, so any cwd containing a dot produced a slug for a
// directory that does not exist: the readdir failed, the bare catch swallowed
// it, and the project's auto-memory files were silently missing from the panel.
// That is every .claude/worktrees/ session, plus ordinary folders like my.app.
//
// The rule below is transcribed from Claude Code 2.1.232 itself
// (`e.replace(/[^a-zA-Z0-9]/g,"-")`, then truncate at 200 with a hash of the
// original path) and matches the real ~/.claude/projects listing on the machine
// this was found on, where /Users/…/vcrm-core/.claude/worktrees/agent-mail-mobile
// is stored as -Users-…-vcrm-core--claude-worktrees-agent-mail-mobile and the
// Windows entries read C--Users-cbargan-….
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The server module resolves paths out of the home directory at import time.
// Nothing here touches the filesystem, but point HOME somewhere disposable
// anyway so importing it can never read the developer's own config.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-slug-"));
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;

// @ts-expect-error — .mjs server module, no types
const { ccProjectSlug } = await import("../../server/index.mjs");

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  rmSync(DIR, { recursive: true, force: true });
});

// resolve() answers in the running platform's own absolute form — "/Users/…"
// on macOS and Linux, "C:\Users\…" on Windows — so these compare tails rather
// than whole strings. The tail is the part the bug was in either way.
const tail = (p: string) => ccProjectSlug(resolve(p));

describe("ccProjectSlug", () => {
  it("flattens the dot in a worktree path, which is what CC's own directory does", () => {
    const slug = tail("/Users/me/vcrm-core/.claude/worktrees/agent-mail-mobile");
    expect(slug).not.toContain(".");
    // ".claude" → "-claude", so the separator before it and the dot itself
    // become the doubled dash seen on disk.
    expect(slug.endsWith("-Users-me-vcrm-core--claude-worktrees-agent-mail-mobile")).toBe(true);
  });

  it("flattens a dot inside a folder name too, not just a leading one", () => {
    expect(tail("/Users/me/src/VacationCRM.Customer").endsWith("-src-VacationCRM-Customer")).toBe(true);
  });

  it("flattens underscores, spaces and every other non-alphanumeric", () => {
    const slug = tail("/Users/me/my.app/some_dir/with space/a+b");
    expect(slug.endsWith("-Users-me-my-app-some-dir-with-space-a-b")).toBe(true);
    expect(/^[a-zA-Z0-9-]+$/.test(slug)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("turns the drive colon and the backslashes into dashes", () => {
    expect(ccProjectSlug("C:\\Users\\cbargan\\Desktop\\agent-dag")).toBe("C--Users-cbargan-Desktop-agent-dag");
  });

  it("truncates past 200 characters and keeps long sibling paths apart", () => {
    const deep = (leaf: string) =>
      resolve("/Users/me", Array.from({ length: 30 }, (_, i) => `segment-number-${i}`).join("/"), leaf);
    const a = ccProjectSlug(deep("alpha"));
    const b = ccProjectSlug(deep("beta"));
    // 200 characters, a dash, and a base-36 signed 32-bit hash — six digits at
    // most, since 36^6 is already past 2^31.
    expect(a.length).toBeLessThanOrEqual(207);
    expect(a.length).toBeGreaterThan(200);
    // The two paths agree for far more than 200 characters and differ only in
    // the leaf, so truncation alone would collide them.
    expect(a.slice(0, 200)).toBe(b.slice(0, 200));
    expect(a).not.toBe(b);
    expect(/^[a-zA-Z0-9-]+$/.test(a)).toBe(true);
  });

  it("hashes with CC's own string hash, so the suffix names CC's directory", () => {
    // h * 31 + c, kept signed 32-bit, over the *unencoded* absolute path.
    const ccHash = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return Math.abs(h).toString(36);
    };
    const abs = resolve("/Users/me", "x".repeat(150), "y".repeat(150));
    expect(ccProjectSlug(abs)).toBe(`${abs.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-${ccHash(abs)}`);
  });

  it("answers empty for a session with no cwd rather than slugging the process cwd", () => {
    expect(ccProjectSlug("")).toBe("");
    expect(ccProjectSlug(undefined)).toBe("");
  });
});
