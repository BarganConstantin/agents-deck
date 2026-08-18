// What the deck can honestly say about a Codex session that might be blocked —
// which is not that it is blocked.
//
// #398 opens with a true observation: every attention surface this deck has is
// dead for Codex. `root.waiting` has exactly one writer, inside the reducer's
// `Notification` case, and the Codex path emits no `Notification` — it cannot,
// because it is not a hook stream at all but a reconstruction from the rollout
// JSONL Codex appends to $CODEX_HOME/sessions. So the card's waiting row, the
// sidebar's blocked row and its "N waiting" header, the topbar chip, the tab
// title, the favicon and #372's live region are all permanently silent for a
// Codex session parked on an approval prompt.
//
// THE OBVIOUS FIX IS THE WRONG ONE, and this module exists to hold the reason.
// The tempting move is to synthesise the block: the deck already holds a tool
// call that has been in flight with no result (#397 stopped erasing it into a
// fabricated failure, so the evidence survives) and it can now read the
// session's `approval_policy` (this file's sibling change) — so pair "policy
// can ask" with "call outstanding for a while" and light the alarm. That
// inference is not sound, and the surfaces it would light are the ones least
// able to survive being unsound:
//
//   * Codex writes NO approval record to a rollout. Sampled every rollout under
//     this machine's CODEX_HOME — 8 files, ~1,100 records, 20 distinct type
//     names — and nothing approval-shaped appears in any of them. That is not
//     merely an absence of evidence: the persist filter has a visible shape,
//     and the shape is that it keeps outcomes and drops requests.
//     `patch_apply_end` is written with no `patch_apply_begin`, `web_search_end`
//     with no `web_search_begin`, `item_completed` with no `item_started`,
//     `task_complete` with no `turn_started`. Every persisted half is the END
//     half. An approval REQUEST is the other half, and the CLI binary does carry
//     `exec_approval_request` among its event names — it simply never reaches
//     the file. `state_5.sqlite`'s `threads` table (37 columns) has
//     `approval_mode` and `sandbox_policy` but no status column, so the blocked
//     state the binary knows about is in-memory and nowhere else.
//
//   * A pending call is therefore the same on disk whether the session is
//     blocked or busy. Codex appends the call line at REQUEST time — measured,
//     117 call/output windows on this machine, none with a gap of zero, p50
//     134ms, max 3936ms — so an unanswered call is genuinely "no result yet",
//     and "no result yet" is what a five-minute `npm install` looks like too.
//     Under `on-request` the sandbox still runs most commands without asking, so
//     the false-positive case is not exotic; it is the ordinary one.
//
//   * The surfaces are the wrong ones to be approximately right on.
//     ambient-counts.ts spells out why the alarm was narrowed to permission
//     blocks in #348: the topbar chip, the tab title and the favicon are worth
//     having only because they are rare, and roughly three quarters noise was
//     enough to justify dropping idle prompts from them entirely. A guess with a
//     false-positive rate nobody can bound would not clear that bar, and a badge
//     that has cried wolf once is a badge that is ignored at the one that
//     counts. A fabricated alarm is worse than a missing one.
//
// So nothing here feeds `isAlarming`, `blockedSessions` or `ambientSignal`, and
// codex-approval-visibility.test.ts pins that: a Codex root with an outstanding
// call under a policy that can ask must still count zero blocked and must leave
// the tab strip exactly as it found it.
//
// What is left is the thing #398 also asks for and which IS honest — "there is
// no fallback tell: `provider` is stamped on the node and rendered nowhere, so a
// user cannot even see which rows the feature does not apply to". Two recorded
// facts answer that with no inference at all: the session is Codex, and its
// approval policy either can or cannot stop to ask. The deck cannot make the
// block visible; it can stop letting the blindness be invisible, which is the
// same move #416 made for a model with no published rate — say what cannot be
// known, in the slot where the answer would have gone, rather than rendering
// nothing and letting silence read as "all clear".
//
// Pure and importing only types, like ambient-counts.ts and for the same
// reason: the suite runs in bare node with no DOM, so a rule that decides what a
// card says has to be callable without rendering one.
import type { AgentNodeData } from "./types";

/**
 * The approval policies under which Codex will stop and ask a human.
 *
 * From Codex's own `approval_policy` values. `never` is the one that cannot
 * ask: Codex denies an escalation outright rather than prompting, which is why
 * a silent session there is genuinely working and must never be marked as
 * possibly-blocked. The other three all have a path that ends in a prompt —
 * `untrusted` asks before anything outside its allowlist, `on-request` asks when
 * the model requests an escalation, `on-failure` asks after a sandboxed attempt
 * fails.
 *
 * A Set of the ASKING policies rather than a check for `!== "never"`, so a
 * policy name this build has never heard of falls out as "unknown" instead of
 * being silently promoted into the asking group. An unrecognised value is a
 * Codex that changed under us, and the safe reading of that is the one that adds
 * no claim — see `codexApprovalTell`, where unknown and absent land together.
 *
 * Not exported: the set is the implementation of `canAskForApproval` below and
 * nothing else, and a caller holding the set instead of calling the function
 * would be a caller that has to remember the `never` case and the unknown case
 * on its own — which is the whole distinction this module exists to keep.
 */
const ASKING_APPROVAL_POLICIES: ReadonlySet<string> = new Set([
  "untrusted",
  "on-request",
  "on-failure",
]);

/** Can this policy stop the session to ask a human? `null` when the deck has
 *  not read a policy for the session yet, or read one it does not recognise —
 *  which is a different answer from "no" and is kept distinct all the way to the
 *  surface. */
export function canAskForApproval(policy: string | null | undefined): boolean | null {
  if (typeof policy !== "string" || !policy) return null;
  if (ASKING_APPROVAL_POLICIES.has(policy)) return true;
  if (policy === "never") return false;
  return null;
}

/** What a Codex root says in the slot a Claude card's waiting row occupies.
 *  `null` means it says nothing, which is the answer for every Claude session
 *  and for a Codex session that cannot be blocked. */
export interface ApprovalTell {
  /** The visible line. Short, because it sits on a card. */
  label: string;
  /** The tooltip, which is where the reason goes. */
  detail: string;
}

/**
 * The honest tell for one agent, or `null` for silence.
 *
 * SILENCE IS THE DEFAULT AND MOST NODES GET IT. This renders on a Codex ROOT
 * only — a subagent has no session-level policy and Codex has no subagents on
 * this deck anyway — and only while the session is `active`, because a session
 * that has finished cannot be sitting on a prompt and a finished card carrying
 * an approval caveat is exactly the permanent noise #348 removed from the alarm
 * surfaces. It is also suppressed the moment a real `waiting` block exists, so
 * that a future Codex which does emit one gets the real row and not a hedge
 * beside it.
 *
 * At `never` there is nothing to warn about — the session cannot be blocked, so
 * the card stays as quiet as a Claude card that is simply working. That is the
 * common case by a distance: 57 of the 58 `turn_context` records on this machine
 * are `never`, so the tell is rare, which is the property that lets it mean
 * something.
 *
 * At a policy that CAN ask, and at a policy the deck does not recognise, the
 * card says so — and says it as a statement about the DECK, not about the
 * session. "Approval prompts are invisible here" is a fact about this program;
 * "this session is waiting for you" would be a claim about a session the deck
 * cannot see. The first is always true when it renders; the second would be
 * false most of the time it rendered.
 */
export function codexApprovalTell(a: AgentNodeData): ApprovalTell | null {
  if (a.provider !== "codex" || a.kind !== "root") return null;
  // A real block, if one ever arrives, outranks a note about not being able to
  // see one. Nothing writes this for Codex today; the guard costs a comparison
  // and removes the one way this could ever double up with the real row.
  if (a.waiting) return null;
  if (a.state !== "active") return null;

  const asks = canAskForApproval(a.approvalPolicy);
  if (asks === false) return null;

  // Unknown and known-asking say the same thing for the same reason, and differ
  // only in how much of the why the tooltip can offer. Treating unknown as
  // silence would hide the caveat on precisely the sessions the deck understands
  // least, and treating it as `never` would be an assertion the deck has not
  // earned.
  const why = asks === true
    ? `This session's approval policy is "${a.approvalPolicy}", so Codex can stop and ask you to approve a command.`
    : "This session's approval policy has not been read yet, so it may be able to stop and ask you to approve a command.";

  return {
    label: "approvals not visible",
    detail:
      `${why}\n\n`
      + "Codex writes no approval request to its rollout files, which are the only "
      + "thing this deck can read — so when it does ask, this card, the sidebar, "
      + "the topbar count, the tab title and the favicon will all stay silent. "
      + "Check the terminal.",
  };
}
