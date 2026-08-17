// The share envelope's expiry is not a security control, and the UI used to say
// it was.
//
// `wrapShare` base64-encodes plain `{v, exp, payload}`. There is no MAC, no
// signature and no key anywhere over it, so anyone holding the text can decode
// it, write a later `exp`, re-encode and import it. The ten minutes is advisory.
//
// This file does NOT add a signature, because one would prove nothing. A MAC
// needs a secret both decks hold, and two decks that already shared a secret
// would not need a share blob; and even a verified envelope would only close
// this one import path, since the payload inside it is the account's OAuth token
// in the clear and `cswap import` takes it directly. What the expiry really buys
// is that a copy left in clipboard history or a chat window stops working
// through the dialog — hygiene against forgetting, not defence against anybody.
//
// So the property is pinned rather than assumed, and the strings that overstated
// it are pinned too. If someone later adds a real envelope MAC, the forgery test
// below is the one that will fail, and that failure is the signal to come back
// and re-read this comment rather than to delete it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain JS module, no types
import { wrapShare, unwrapShare, SHARE_TTL_MS } from "../../server/cswap-admin.mjs";

const PREFIX = "ccdeck1:";

/** Decode a blob back to the object `wrapShare` encoded. */
function decode(blob: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(blob.slice(PREFIX.length), "base64").toString("utf8"));
}

/** Re-encode an envelope the way `wrapShare` does — the forger's whole toolkit. */
function encode(env: unknown): string {
  return PREFIX + Buffer.from(JSON.stringify(env), "utf8").toString("base64");
}

describe("the share envelope's expiry", () => {
  it("refuses an expired blob before the payload is looked at", () => {
    // A negative TTL is an envelope that was already stale when it was made.
    expect(unwrapShare(wrapShare("secret-payload", 0, -1))).toEqual({ ok: false, reason: "expired" });
    // And one that ran out while it sat somewhere.
    const made = wrapShare("secret-payload", 1_000_000);
    expect(unwrapShare(made, 1_000_000 + SHARE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts the same blob with a hand-edited exp, because nothing signs it", () => {
    // The whole attack: decode, bump one number, re-encode. No key involved,
    // and the receiving deck cannot tell this apart from a fresh share.
    const expired = wrapShare("secret-payload", 0, -1);
    expect(unwrapShare(expired).ok).toBe(false);

    const env = decode(expired);
    env.exp = 9_999_999_999_999;
    expect(unwrapShare(encode(env))).toEqual({ ok: true, payload: "secret-payload" });
  });

  it("hands the payload back in the clear to anyone who decodes it", () => {
    // Which is why the forged expiry above is not even the shortest path: the
    // credential is readable straight out of the base64, and `cswap import`
    // accepts it with no envelope at all.
    expect(decode(wrapShare("secret-payload")).payload).toBe("secret-payload");
  });

  it("still keeps the checks that do work", () => {
    // Pinned so the honesty above is not mistaken for "the check is pointless
    // and can go". A stale copy is refused, a blob from a newer deck is named
    // rather than half-parsed, and anything that is not one of ours is rejected
    // on sight.
    expect(unwrapShare("not a share")).toEqual({ ok: false, reason: "not_a_share" });
    expect(unwrapShare(`${PREFIX}!!!not base64 json!!!`).ok).toBe(false);
    expect(unwrapShare(encode({ v: 2, exp: 9_999_999_999_999, payload: "x" })))
      .toEqual({ ok: false, reason: "wrong_version" });
    expect(unwrapShare(encode({ v: 1, payload: "x" }))).toEqual({ ok: false, reason: "expired" });
    expect(unwrapShare(encode({ v: 1, exp: 9_999_999_999_999, payload: "" })))
      .toEqual({ ok: false, reason: "corrupt" });
  });
});

// The strings are the fix for this item, so they are the thing under test. Read
// out of the source rather than rendered, because this suite has no DOM.
const panel = readFileSync(
  fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");

describe("what the accounts panel says a share is", () => {
  it("tells the reader the text IS the password", () => {
    expect(panel).toMatch(/treat it as the password/i);
    expect(panel).toMatch(/this is the password/i);
  });

  it("no longer offers the ten minutes as a protection", () => {
    // The old title: "The share carries a live login and expires in 10
    // minutes." — true clause, true clause, and together a claim that the
    // second one contains the first.
    expect(panel).not.toMatch(/carries a live login and expires in 10 minutes/);
    // Whatever the sentence becomes, the ten minutes has to be attributed to
    // the receiving deck rather than left standing on its own.
    expect(panel).toMatch(/other deck stops accepting it/i);
  });

  it("puts the warning colour on the warning rather than on the timer", () => {
    const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
    expect(panel).toMatch(/className="ap-share-warn"/);
    expect(css).toMatch(/\.ap-share-warn\s*\{[^}]*color:\s*var\(--warn\)/);
  });
});
