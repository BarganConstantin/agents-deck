// The add-account dialog turned every refusal into the reason map's sentence
// before it ever looked at what the server wrote. Both of the failures that
// carry a remedy lost it that way: `cswap add` refused the macOS login keychain
// because the deck runs as a background service, and a `claude` that is not on
// PATH with the AGENTS_DECK_CLAUDE that fixes it. Reasons "add_failed" and
// "login_failed" both have map entries, so the user got "signed in, but
// claude-swap could not record the account" and nothing else — the failure card
// renders this same string, so the sentence saying what to do had nowhere left
// to appear. These pin the ranking that lets it through, and the reason the map
// still wins while the flow is alive: the login's `error` is older than the
// request whenever the flow can still move.
import { describe, it, expect } from "vitest";
import { explainFailure, REASONS } from "../admin-failure";
import { loginEndNotice } from "../login-flow";

// The exact wording of these is the server's business and is being sharpened
// separately; what is pinned here is that whatever it sends arrives intact.
const KEYCHAIN =
  "the login keychain is unreadable right now — start agents-deck from a Terminal window rather than a background service.";
const NOT_ON_PATH =
  "the claude CLI could not be run: not on PATH. Set AGENTS_DECK_CLAUDE to its full path.";

describe("explainFailure", () => {
  it("shows the keychain remedy instead of the map's summary of it", () => {
    expect(explainFailure({ reason: "add_failed", state: "failed", error: KEYCHAIN }, "x"))
      .toBe(KEYCHAIN);
  });

  it("shows the sentence naming AGENTS_DECK_CLAUDE when the CLI cannot be run", () => {
    expect(explainFailure({ reason: "login_failed", state: "failed", error: NOT_ON_PATH }, "x"))
      .toBe(NOT_ON_PATH);
    expect(explainFailure({ reason: "no_url", state: "failed", error: NOT_ON_PATH }, "x"))
      .toBe(NOT_ON_PATH);
  });

  it("passes the server's words through whatever they say, since the server knows the machine", () => {
    expect(explainFailure({ reason: "add_failed", state: "failed", error: "anything at all" }, "x"))
      .toBe("anything at all");
  });

  it("keeps the map's sentence while the flow can still move, where the error may predate the request", () => {
    // A rejected code leaves its sentence on a live flow; the next refusal is
    // about the empty box, not about that code.
    const stale = "that code was not accepted — copy it again from the browser";
    expect(explainFailure({ reason: "empty_code", state: "awaiting_code", error: stale }, "x"))
      .toBe(REASONS.empty_code);
    expect(explainFailure({ reason: "not_prompted", state: "awaiting_code", error: stale }, "x"))
      .toBe(REASONS.not_prompted);
    expect(explainFailure({ reason: "already_running", state: "registering", error: stale }, "x"))
      .toBe(REASONS.already_running);
  });

  it("treats a state it does not recognise as an ending, so a newer server's error still lands", () => {
    expect(explainFailure({ reason: "add_failed", state: "gave_up", error: KEYCHAIN }, "x"))
      .toBe(KEYCHAIN);
  });

  it("prefers the detail the server wrote for this one response", () => {
    expect(explainFailure({ reason: "import_failed", detail: "cswap import exited 1" }, "x"))
      .toBe("cswap import exited 1");
  });

  it("falls back to the map when an ended sign-in sent no error with it", () => {
    expect(explainFailure({ reason: "add_failed", state: "failed" }, "x")).toBe(REASONS.add_failed);
    expect(explainFailure({ reason: "not_a_share" }, "x")).toBe(REASONS.not_a_share);
  });

  it("says what the server said when a crash left it no reason at all", () => {
    expect(explainFailure({ error: "Cannot read properties of undefined" }, "the import failed"))
      .toBe("Cannot read properties of undefined");
  });

  it("never shows a bare reason code the build has no sentence for over a real message", () => {
    expect(explainFailure({ reason: "remove_failed", error: "cswap remove exited 1" }, "x"))
      .toBe("cswap remove exited 1");
    expect(explainFailure({ reason: "remove_failed" }, "x")).toBe("remove_failed");
  });

  it("falls back when the request never reached the server", () => {
    expect(explainFailure(null, "could not start the sign-in")).toBe("could not start the sign-in");
    expect(explainFailure({}, "the import failed")).toBe("the import failed");
  });
});

describe("the sentence the failure card ends up with", () => {
  // The dialog stores explainFailure()'s answer and hands it to loginEndNotice
  // as the local error, which outranks the polled one — so the remedy only
  // reaches the screen if it survives the ranking above first.
  const card = (out: { reason: string; state: string; error: string }) =>
    loginEndNotice({ state: out.state, serverError: out.error, localError: explainFailure(out, "x") });

  it("tells a background-service deck to start from a Terminal instead", () => {
    expect(card({ reason: "add_failed", state: "failed", error: KEYCHAIN }))
      .toEqual({ title: "Sign-in failed", message: KEYCHAIN });
  });

  it("tells a deck that cannot find claude which variable to set", () => {
    expect(card({ reason: "login_failed", state: "failed", error: NOT_ON_PATH }))
      .toEqual({ title: "Sign-in failed", message: NOT_ON_PATH });
  });
});
