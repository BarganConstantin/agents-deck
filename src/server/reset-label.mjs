// When a quota window resets, written one way — for the Claude lanes and the
// Codex lanes both, which land in the same panel.
//
// WHY THIS MODULE EXISTS (#374). quota.mjs had `fmtResetIso` and codex-quota.mjs
// had `fmtReset`. They passed identical option bags to `toLocaleString` and then
// post-processed the result differently, and codex-quota's own doc comment said
// of its copy: "matches the Claude quota formatting so both read alike." It did
// not. Over the same instant:
//
//   toLocaleString : "Jun 18, 4:09 PM"
//   quota.mjs      : "Jun 18, 4:09pm"
//   codex-quota.mjs: "jun 18 4:09pm"     ← comma stripped, month lower-cased
//
// Swept over 2,794 instants across 40 days, the two disagreed on every single
// one — not at a boundary, on all of them, because the difference is two
// unconditional string operations rather than a tier that rarely fires. Both
// strings surface in the same usage panel, one lane above the other.
//
// The Claude rendering is the one kept, on the comment's own terms: it is the
// one the other claimed to match, and it is the one that reads like a date —
// `Intl` capitalises the month and puts the comma in for the locale's own
// reasons, and stripping both is a hand edit to output that was already right.
// This is a FIX to what the Codex lanes print, not a neutral merge, and it is
// the only visible change in this consolidation.
//
// The one genuine difference between the copies was the input unit — Codex
// answers with a Unix timestamp in seconds and Anthropic with an ISO-8601
// string — so that is the wrapper below rather than a second formatter.
//
// A module of its own rather than one importing the other: quota.mjs reads
// Claude's OAuth credentials off disk, and having the Codex path import that to
// reach a date formatter would drag the whole Claude credential chain into a
// request that has nothing to do with it.

/** en-US on purpose, not the host locale. This string is generated on the
 *  server and shipped to a browser whose locale nobody here has asked, so a
 *  server set to de-DE would otherwise send "18. Juni, 16:09" into a panel
 *  written in English. Both copies already hardcoded en-US; it is written down
 *  here so the next reader knows it was a decision. */
const OPTS = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true };

/** The rendering itself, over a Date both entry points have already validated.
 *  The meridiem is lower-cased and its space removed — the only edit made to
 *  what `Intl` produces — because "4:09 PM" shouts in a lane label that is a
 *  few characters of chrome wide. */
function label(d) {
  return d.toLocaleString("en-US", OPTS).replace(/\s+(AM|PM)/, (_, p) => p.toLowerCase());
}

/** "Jun 18, 4:09pm" from a Unix timestamp in seconds, which is how the Codex
 *  usage endpoint spells a reset time. Null when there is no reset to name.
 *
 *  The validity check is inherited from the ISO copy, which had one where the
 *  seconds copy did not: a finite but absurd number — the only shape that gets
 *  past the falsy guard and still fails to be a date — used to render as the
 *  literal string "invalid date" in a quota lane. Nothing observed sends one,
 *  so this is hardening rather than a fix, and it is the safer of the two
 *  behaviours in the same way `isOlder`'s type guard is. */
export function resetLabel(unixSec) {
  if (!unixSec) return null;
  const d = new Date(unixSec * 1000);
  if (isNaN(d.getTime())) return null;
  return label(d);
}

/** The same label from an ISO-8601 instant, which is how Anthropic's usage
 *  endpoint spells a reset time. Invalid and absent both answer null, so a
 *  malformed field renders as no reset rather than "Invalid Date".
 *
 *  Not written as `resetLabel(d.getTime() / 1000)`: that would send an instant
 *  at the Unix epoch through the falsy guard above and answer null for a date
 *  this function has already established is valid. */
export function resetLabelIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return label(d);
}
