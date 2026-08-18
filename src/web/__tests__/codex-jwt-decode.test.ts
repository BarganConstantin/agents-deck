// `decodeJwt` is handed the contents of ~/.codex/auth.json, a file the deck
// does not write and cannot validate, and everything it decides is expensive to
// get wrong:
//
//   - `expiryMs` reads the `exp` claim out of the access token to decide whether
//     to refresh. OpenAI rotates the refresh token single-use, so a refresh the
//     deck did not need is a credential spent for nothing, and one it needed and
//     skipped is a deck that goes dark mid-session.
//   - `identityFrom` reads the plan, the account id, the FedRAMP flag and the
//     email out of the id_token, and each of those is a line on the accounts
//     panel.
//
// Neither reader can exercise the decode: `expiryMs` collapses the whole payload
// to one number, and `identityFrom` sits behind a full auth file and a refresh
// round-trip. So the parser is tested here directly — which is what its export
// is for (#383), since nothing outside codex-auth.mjs calls it.
//
// A throw is the failure that matters most. Nothing in codex-auth.mjs is allowed
// to throw — a rejected promise from a background poll takes the server down —
// and this function's body is `JSON.parse` over `Buffer.from(…, "base64url")`,
// two calls that both throw on input a stranger controls.
//
// Plain node: no DOM, no rendering, just the module's own parser.
import { describe, it, expect } from "vitest";

// @ts-expect-error — .mjs server module, no types
const { decodeJwt } = await import("../../server/codex-auth.mjs") as {
  decodeJwt: (token: unknown) => Record<string, unknown> | null;
};

/** Build a JWT whose payload is `claims`. The signature is never checked here —
 *  the deck reads claims out of a token OpenAI already issued and validated, it
 *  does not authenticate one — so any non-empty third segment will do. */
function jwt(claims: unknown, { header = { alg: "RS256", typ: "JWT" } } = {}): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${seg(header)}.${seg(claims)}.c2ln`;
}

describe("decodeJwt on the tokens a real auth.json carries", () => {
  it("reads the claims a Codex access token is refreshed on", () => {
    const exp = Math.floor(Date.UTC(2030, 0, 1) / 1000);
    expect(decodeJwt(jwt({ exp, sub: "user_abc" }))).toEqual({ exp, sub: "user_abc" });
  });

  it("reads the nested OpenAI claim block the accounts panel is built from", () => {
    // The real shape: a namespaced URI key holding the plan, the account id and
    // the FedRAMP flag. A decoder that flattened or renamed keys would leave the
    // panel blank with nothing to explain it.
    const claims = {
      email: "someone@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
        chatgpt_plan_type: "pro",
        chatgpt_account_is_fedramp: true,
      },
    };
    expect(decodeJwt(jwt(claims))).toEqual(claims);
  });

  it("decodes base64url, which is what a JWT is actually written in", () => {
    // Not the same alphabet as base64: `-` and `_` stand in for `+` and `/`, and
    // the `=` padding is dropped. A real token hits both substitutions within a
    // few hundred bytes, so a decoder that reached for plain base64 would fail
    // on some tokens and not others — the worst way for this to be wrong.
    // These claims are chosen so the encoded payload contains both characters.
    const claims = { sub: "ÿþý?>~}|{", exp: 4102444800 };
    const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    expect(encoded).toMatch(/[-_]/);
    expect(encoded).not.toContain("=");
    expect(decodeJwt(`aaa.${encoded}.bbb`)).toEqual(claims);
  });

  it("keeps non-ASCII claims intact, because a display name is one", () => {
    // The email and any name reach a panel the user reads. Decoding the bytes as
    // latin-1 — which is what `atob` and a missing "utf8" both give — turns
    // "Constantin Bărgan" into mojibake on the one surface that names them.
    const claims = { email: "ana@münchen.de", name: "Bărgan — 中文" };
    expect(decodeJwt(jwt(claims))).toEqual(claims);
  });
});

describe("decodeJwt on everything auth.json can hold that is not a token", () => {
  it("answers null rather than throwing, for every shape a stranger can write", () => {
    // The list is the point: each entry is something that has been or could be
    // in the `access_token` / `id_token` slot, and every one of them reaches
    // either `Buffer.from` or `JSON.parse`, both of which throw.
    const notTokens: unknown[] = [
      undefined, null, 0, 1, true, false, {}, [], () => {},
      "",                       // the field present and empty
      "opaque-token",           // an opaque token, which is not a JWT at all
      "a.b",                    // two segments
      "a.b.c.d",                // four
      "..",                     // three empty segments
      "a..c",                   // empty payload between real segments
      "a.!!!!.c",               // a payload that is not base64 in any alphabet
      "a.bm90LWpzb24.c",        // valid base64url, decodes to "not-json"
      `a.${Buffer.from("{\"unterminated\":", "utf8").toString("base64url")}.c`,
    ];
    for (const token of notTokens) {
      expect(() => decodeJwt(token), JSON.stringify(String(token))).not.toThrow();
      expect(decodeJwt(token), JSON.stringify(String(token))).toBeNull();
    }
  });

  it("refuses a payload that parses but is not an object", () => {
    // `JSON.parse` is happy with `null`, `7` and `"hi"`, and each of those would
    // reach `claims.email` and `claims["https://api.openai.com/auth"]` in
    // identityFrom. `null` is the one that actually throws there, which is why
    // the guard exists; the others would quietly answer undefined and leave the
    // panel blank with no error anywhere.
    for (const payload of [null, 7, "hi", true]) {
      expect(decodeJwt(jwt(payload)), JSON.stringify(payload)).toBeNull();
    }
  });

  it("lets a JSON array through, which is harmless and worth writing down", () => {
    // `typeof [] === "object"`, so the guard above does not catch an array, and
    // this pins that as the deliberate reading rather than an oversight the next
    // sweep re-opens. Both readers only ever do property reads on the result —
    // `.exp` in expiryMs, `.email` and the namespaced key in identityFrom — and
    // an array answers undefined to all three, which is the same outcome the
    // `null` above produces. Tightening the guard would change no behaviour, so
    // it is not worth the churn; a reader that started INDEXING the claims would
    // be, and that is the change this test is here to catch.
    expect(decodeJwt(jwt(["a"]))).toEqual(["a"]);
    expect((decodeJwt(jwt(["a"])) as Record<string, unknown>).exp).toBeUndefined();
    expect((decodeJwt(jwt(["a"])) as Record<string, unknown>).email).toBeUndefined();
  });

  it("is not fooled into reading the header instead of the payload", () => {
    // Segment order is the whole spec: header, payload, signature. Reading the
    // first segment would give `{alg, typ}` for every token on earth — an
    // `exp`-less object that reads as "no expiry known", which is the answer
    // that stops the deck refreshing at all.
    const decoded = decodeJwt(jwt({ exp: 4102444800 }));
    expect(decoded).not.toHaveProperty("alg");
    expect(decoded).toHaveProperty("exp");
  });

  it("does not care how long the token is, since a real ChatGPT one is fat", () => {
    // Real access tokens run to a couple of kilobytes. Nothing here should have
    // a size limit, and a padding-sensitive decoder tends to fail only at some
    // lengths — so several are tried rather than one.
    for (const n of [1, 2, 3, 100, 1000]) {
      const claims = { exp: 4102444800, scope: "x".repeat(n) };
      expect(decodeJwt(jwt(claims)), `${n} bytes of scope`).toEqual(claims);
    }
  });
});
