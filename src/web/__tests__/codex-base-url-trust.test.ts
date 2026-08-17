// A live OpenAI Bearer token was sent wherever a config file said.
//
// codex-quota's readBaseUrl matched `chatgpt_base_url` out of
// ~/.codex/config.toml with a loose line regex, stripped the quotes, and used
// the result verbatim in
// `fetch(base + usagePath(base), {headers: {Authorization: `Bearer ${…}`}})`.
// Only chatgpt.com and chat.openai.com got special path handling; every other
// scheme and host — `http://`, a raw IP, anything — passed straight through. So
// anything able to write that TOML, or to set $CODEX_HOME and point it at its
// own, redirected a live ChatGPT session token to a host of its choosing, in
// cleartext if it liked. codex-auth had the same shape for
// $CODEX_REFRESH_TOKEN_URL_OVERRIDE, which chooses where the SINGLE-USE refresh
// token is POSTed.
//
// The Codex CLI honours both keys; the difference is that those credentials are
// its own, and the deck is a bystander that reads them. So the deck checks
// before it attaches anything, and says so rather than going quietly dark.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Sandboxed CODEX_HOME, set before the dynamic import: both codex modules read
// the path once at module load, and the real ~/.codex holds a real login.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-base-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = join(DIR, "codex");
if (!resolve(process.env.CODEX_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
mkdirSync(process.env.CODEX_HOME, { recursive: true });

// A credential file with no readable `exp` and no `last_refresh`, so
// shouldRefresh answers false and nothing here can spend a refresh token even
// if the guard under test were removed.
writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
  tokens: { access_token: "test-access-token-not-a-jwt", refresh_token: "test-refresh-token" },
}));

const config = (body: string) => writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), body);

// @ts-expect-error — plain JS module, no types
const { isCredentialHost } = await import("../../server/codex-auth.mjs");
// @ts-expect-error — plain JS module, no types
const { fetchCodexQuota } = await import("../../server/codex-quota.mjs");

describe("isCredentialHost", () => {
  it("accepts the hosts the Codex credentials belong to", () => {
    for (const url of [
      "https://chatgpt.com/backend-api",
      "https://chat.openai.com/backend-api",
      "https://api.openai.com/v1",
      "https://auth.openai.com/oauth/token",
      "https://some-tenant.chatgpt.com/backend-api",   // OpenAI moves subdomains
      "https://CHATGPT.COM/backend-api",               // hosts are case-insensitive
    ]) {
      expect(isCredentialHost(url), url).toBe(true);
    }
  });

  it("refuses plaintext http, whoever is on the other end", () => {
    expect(isCredentialHost("http://chatgpt.com/backend-api")).toBe(false);
    expect(isCredentialHost("http://127.0.0.1:9/")).toBe(false);
  });

  it("refuses a host that is merely spelled like one of ours", () => {
    for (const url of [
      "https://chatgpt.com.evil.example/",     // a different registrable domain
      "https://chatgpt.com@evil.example/",     // userinfo, not a host
      "https://evil.example/chatgpt.com",      // a path
      "https://notopenai.com/",                // suffix without the dot
      "https://openai.com.br/",
      "https://192.0.2.1/",
      "ftp://chatgpt.com/",
      "//chatgpt.com/",                        // not an absolute URL at all
      "chatgpt.com",
      "",
      null,
      undefined,
    ]) {
      expect(isCredentialHost(url), String(url)).toBe(false);
    }
  });
});

describe("fetchCodexQuota against an untrusted base URL", () => {
  const realFetch = globalThis.fetch;
  let calls: string[] = [];

  beforeAll(() => {
    // Recorded rather than stubbed to fail: a test that asserts "no request was
    // made" has to be able to see the request it is claiming did not happen.
    globalThis.fetch = ((input: unknown) => {
      calls.push(String((input as { url?: string })?.url ?? input));
      return Promise.reject(new Error("test: no network"));
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const k of ["HOME", "USERPROFILE", "CODEX_HOME"]) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    rmSync(DIR, { recursive: true, force: true });
  });

  beforeEach(() => { calls = []; vi.spyOn(console, "error").mockImplementation(() => {}); });

  it("makes no request at all when config.toml points somewhere else", async () => {
    config('chatgpt_base_url = "http://127.0.0.1:9/"\n');
    const r = await fetchCodexQuota({ force: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("untrusted_base_url");
    expect(calls).toEqual([]);
  });

  it("refuses an https host outside the allowlist too, not just plaintext", async () => {
    config('chatgpt_base_url = "https://collector.evil.example/backend-api"\n');
    const r = await fetchCodexQuota({ force: true });
    expect(r.reason).toBe("untrusted_base_url");
    expect(calls).toEqual([]);
  });

  it("says why, once, rather than going dark", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    config('chatgpt_base_url = "https://another.evil.example/"\n');
    await fetchCodexQuota({ force: true });
    await fetchCodexQuota({ force: true });
    const said = spy.mock.calls.map(c => c.join(" ")).filter(s => /another\.evil\.example/.test(s));
    // A 60-second poll must not turn one misconfiguration into a log flood.
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/chatgpt_base_url/);
  });

  it("still lets the real endpoint through, which is the case all this protects", async () => {
    config('chatgpt_base_url = "https://chatgpt.com/backend-api"\n');
    const r = await fetchCodexQuota({ force: true });
    // The stub rejects, so this ends as fetch_error — the point is that it got
    // as far as asking.
    expect(r.reason).toBe("fetch_error");
    expect(calls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
  });

  it("uses the default endpoint when there is no config.toml", async () => {
    rmSync(join(process.env.CODEX_HOME!, "config.toml"), { force: true });
    await fetchCodexQuota({ force: true });
    expect(calls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
  });
});
