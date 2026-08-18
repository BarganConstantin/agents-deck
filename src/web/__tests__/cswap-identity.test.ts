// Who the `claude` CLI says is signed in, and what the deck does with an answer
// it cannot read.
//
// `currentIdentity` is the gate at the end of the add-account flow. After the
// CLI has accepted the verification code, `submitLoginCode` asks this question
// and refuses the whole sign-in when it comes back null — "signed in, but the
// claude CLI still reports nobody logged in" — and when it does not, the email
// it carries is what matches the fresh credential to a cswap slot, which is what
// puts the account on the right row of the panel.
//
// Only the null half of that had any coverage before #383, and only by accident:
// the login test asserts `no_identity` because the machine running the suite has
// no signed-in claude to answer. The half that decides where a successful
// sign-in lands had none at all, and cannot get any that way — it needs a real
// signed-in CLI on the host. So the parse is driven here directly, which is what
// the export is for.
//
// Nothing is spawned: `run` answers from the test. Plain node, no DOM.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const cli = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  reply: { ok: true, code: 0, killed: false, stdout: "", stderr: "" } as Record<string, unknown>,
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      cli.calls.push({ cmd, args });
      return cli.reply;
    },
    runDetached: () => {},
  };
});

vi.mock("../../server/cswap-install.mjs", () => ({
  cswapBin: async () => "cswap",
  cswapVersion: async () => "0.25.0",
  installHint: () => "",
}));

// @ts-expect-error — .mjs server module, no types
const { currentIdentity } = await import("../../server/cswap-admin.mjs") as {
  currentIdentity: () => Promise<{ email: string; orgId: string } | null>;
};

/** The CLI answered, with this on stdout. */
const says = (stdout: string) => { cli.reply = { ok: true, code: 0, killed: false, stdout, stderr: "" }; };
/** The CLI did not answer at all. */
const cannotRun = () => { cli.reply = { ok: false, code: "ENOENT", killed: false, stdout: "", stderr: "" }; };

const prevClaude = process.env.AGENTS_DECK_CLAUDE;
beforeEach(() => { cli.calls.length = 0; delete process.env.AGENTS_DECK_CLAUDE; });
afterAll(() => {
  if (prevClaude === undefined) delete process.env.AGENTS_DECK_CLAUDE;
  else process.env.AGENTS_DECK_CLAUDE = prevClaude;
});

describe("currentIdentity reads the CLI's own answer", () => {
  it("asks claude for machine-readable output, not the human kind", async () => {
    // The whole function is `JSON.parse` over stdout, so asking without --json
    // would leave it parsing a sentence — and failing every time, silently, as
    // "nobody is logged in".
    says('{"loggedIn":true,"email":"dorin@example.com","orgId":"org_1"}');
    await currentIdentity();
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0].args).toEqual(["auth", "status", "--json"]);
  });

  it("carries the email that decides which slot the new account lands on", async () => {
    says('{"loggedIn":true,"email":"dorin@example.com","orgId":"org_1"}');
    expect(await currentIdentity()).toEqual({ email: "dorin@example.com", orgId: "org_1" });
  });

  it("keeps only the two fields the flow uses, whatever else the CLI adds", async () => {
    // The CLI is free to grow its output. Anything extra reaching the login flow
    // would be state nobody asked for travelling through a credential path.
    says(JSON.stringify({
      loggedIn: true, email: "a@b.c", orgId: "org_9",
      apiKeySource: "keychain", scopes: ["user:inference"], subscription: { plan: "max" },
    }));
    expect(await currentIdentity()).toEqual({ email: "a@b.c", orgId: "org_9" });
  });

  it("goes through the resolver, so a Windows shim is launched by its full path", async () => {
    // AGENTS_DECK_CLAUDE is what a user with a `claude` PATH cmd.exe cannot see
    // sets. Every mutation in this module used to bypass it and fail on Windows
    // with "is not recognized" while the read-only half of the panel worked.
    process.env.AGENTS_DECK_CLAUDE = "C:\\Users\\dorin\\.local\\bin\\claude.exe";
    says('{"loggedIn":true,"email":"a@b.c"}');
    await currentIdentity();
    expect(cli.calls[0].cmd).toBe("C:\\Users\\dorin\\.local\\bin\\claude.exe");
  });
});

describe("currentIdentity when the answer is no, or is not an answer", () => {
  it("is null when the CLI says nobody is logged in", async () => {
    // The one case the login flow is actually watching for: the code was
    // accepted, and Anthropic still does not consider this machine signed in.
    says('{"loggedIn":false}');
    expect(await currentIdentity()).toBeNull();
  });

  it("is null when the CLI cannot be run at all", async () => {
    // No claude on the machine, or a shim cmd.exe will not resolve. Reported as
    // "not signed in" rather than thrown, because a throw here would take down
    // the request that is mid-sign-in.
    cannotRun();
    expect(await currentIdentity()).toBeNull();
  });

  it("is null, and does not throw, for output that is not JSON", async () => {
    // A CLI that printed a warning first, an --json flag it does not have, an
    // update notice on stdout — all of them arrive here as text.
    for (const stdout of ["", "   ", "Not logged in.", "<html>", "{", "null", "[]", "7"]) {
      says(stdout);
      // eslint-disable-next-line no-await-in-loop
      await expect(currentIdentity(), JSON.stringify(stdout)).resolves.toBeNull();
    }
  });

  it("treats a missing loggedIn as no, rather than reading the fields anyway", async () => {
    // An email in the payload is not the claim being made. The flow's question
    // is "is this machine signed in", and only `loggedIn` answers it.
    says('{"email":"dorin@example.com","orgId":"org_1"}');
    expect(await currentIdentity()).toBeNull();
  });

  it("accepts a logged-in answer that names no email, as an empty string", async () => {
    // Not a hypothetical: an API-key login has no email. The slot match in
    // submitLoginCode then simply finds nothing and falls back to the new-slot
    // answer, which is the right outcome — but only because this is "" and not
    // undefined, which would make `after.emails[k] === identity.email` true for
    // every slot the store has no address for.
    says('{"loggedIn":true}');
    expect(await currentIdentity()).toEqual({ email: "", orgId: "" });
  });
});
