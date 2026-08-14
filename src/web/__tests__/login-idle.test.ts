// The sign-in dialog polls a login that lives on the server, and the server can
// lose it: /api/claude-accounts/login answers {state:"idle"} whenever the
// in-memory flow is null — after a second tab's login-cancel, or after a
// restart whose exit handler killed the `claude auth login` child. The dialog
// had no branch for that state, so it polled every 1.5s forever under a spinner
// that could never resolve. These are the two rules that end it.
import { describe, it, expect } from "vitest";
import {
  isLoginOver,
  loginEndNotice,
  shouldPollLogin,
  LOGIN_VANISHED,
  LOGIN_FAILED,
} from "../login-flow";

describe("shouldPollLogin", () => {
  it("keeps polling while the server still has a flow that moves", () => {
    expect(shouldPollLogin("awaiting_url")).toBe(true);
    expect(shouldPollLogin("awaiting_code")).toBe(true);
    expect(shouldPollLogin("registering")).toBe(true);
  });

  it("stops on idle — the flow is gone, so no amount of asking brings it back", () => {
    expect(shouldPollLogin("idle")).toBe(false);
  });

  it("stops once the sign-in has a verdict", () => {
    expect(shouldPollLogin("done")).toBe(false);
    expect(shouldPollLogin("failed")).toBe(false);
  });

  it("does not poll before a sign-in has been started", () => {
    expect(shouldPollLogin(null)).toBe(false);
    expect(shouldPollLogin(undefined)).toBe(false);
  });

  it("stops on a state it does not recognise", () => {
    // The shape of the original bug: an unlisted state kept the interval alive.
    // A whitelist means a state added on the server ends the loop instead.
    expect(shouldPollLogin("something_new")).toBe(false);
  });
});

describe("isLoginOver", () => {
  it("counts idle as over, which is what the dialog was missing", () => {
    expect(isLoginOver("idle")).toBe(true);
  });

  it("counts failed as over", () => {
    expect(isLoginOver("failed")).toBe(true);
  });

  it("leaves a live sign-in alone", () => {
    expect(isLoginOver("awaiting_url")).toBe(false);
    expect(isLoginOver("awaiting_code")).toBe(false);
    expect(isLoginOver("registering")).toBe(false);
  });

  it("does not claim a successful sign-in is over — that branch has its own screen", () => {
    expect(isLoginOver("done")).toBe(false);
  });

  it("says nothing about a dialog that has not started one", () => {
    expect(isLoginOver(null)).toBe(false);
    expect(isLoginOver(undefined)).toBe(false);
  });

  it("gives an unrecognised state somewhere to render rather than a spinner", () => {
    expect(isLoginOver("something_new")).toBe(true);
  });
});

describe("loginEndNotice", () => {
  it("tells the truth about a sign-in the server forgot", () => {
    // Not "failed" — nothing was rejected. It stopped existing.
    expect(loginEndNotice({ state: "idle" })).toEqual({
      title: "Sign-in ended",
      message: LOGIN_VANISHED,
    });
  });

  it("never leaves the paragraph empty when the server reports no reason", () => {
    expect(loginEndNotice({ state: "failed", serverError: null }).message).toBe(LOGIN_FAILED);
  });

  it("prefers the server's own explanation of a failure", () => {
    expect(loginEndNotice({ state: "failed", serverError: "the sign-in window expired" })).toEqual({
      title: "Sign-in failed",
      message: "the sign-in window expired",
    });
  });

  it("prefers what this request already learned over the generic sentence", () => {
    // Posting a code after another tab cancelled answers not_waiting with
    // state:"idle" — that sentence is sharper than "the deck restarted".
    expect(loginEndNotice({
      state: "idle",
      localError: "that sign-in is no longer waiting for a code",
    })).toEqual({
      title: "Sign-in ended",
      message: "that sign-in is no longer waiting for a code",
    });
  });

  it("still reads as a failure when the flow never reached the server", () => {
    // start() failed outright: no state at all, only a local message.
    expect(loginEndNotice({ state: undefined, localError: "could not start the sign-in" })).toEqual({
      title: "Sign-in failed",
      message: "could not start the sign-in",
    });
  });
});
