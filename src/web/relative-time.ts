// Timestamps in the deck's voice: elapsed on screen, absolute on hover.
//
// The prompt log broke that pattern — it rendered `toLocaleTimeString()`, a
// time of day with no date and no `title` behind it. On a session that has been
// open for more than a day, a prompt from yesterday and one from this afternoon
// both read "14:07:33" and there is nothing to hover for the difference. It was
// also the only absolute clock visible in the primary UI: the session list, the
// agent node, the accounts and usage panels and the version chip all show
// elapsed time and keep the exact moment in a tooltip.
//
// `shortAgo` moved here from App.tsx so the prompt log can reuse the same
// relative wording as the version chip rather than grow a second dialect.
//
// #374 found the second dialect anyway — the accounts panel had grown a private
// copy of `shortAgo`, and the accounts and usage panels had grown one countdown
// to the quota reset each. Both now live here, which is what the paragraph
// above was asking for: this module owns how long ago something was and how
// long until something is, for every surface, and a wording changed here
// reaches all of them at once.
//
// Locale is the host's, never assumed: the label is built from numbers, and the
// date parts come from Intl with a style rather than a hand-written pattern, so
// a browser set to de-DE or ja-JP gets its own order and separators. `locales`
// is a parameter only so tests can pin one; production passes nothing, which
// means "whatever this browser is set to".

/**
 * "just now" / "12m ago" / "3h ago" / "5d ago", from an age already in whole
 * seconds.
 *
 * WHY THE SECONDS FORM IS THE PRIMARY ONE (#374). The accounts panel carried a
 * private `ago(ms, nowSec)` with these four branch bodies byte-identical and
 * the same 60/3600/86400 thresholds — a second copy of the "second dialect"
 * this module's header was written to prevent, in one of the very surfaces that
 * header names. It could not simply call `shortAgo` though, because the panel
 * does not hold a millisecond `now`: it ticks a `nowSec` of
 * `Math.floor(Date.now() / 1000)`, and `shortAgo(nowSec * 1000 - at)` floors a
 * second time on a stamp that has a sub-second part, landing one second below
 * the panel's own arithmetic and moving every threshold by that second.
 *
 * Exposing the seconds form makes the merge exact rather than approximate: the
 * panel passes `nowSec - Math.floor(at / 1000)`, which is character for
 * character what its own copy computed, and `shortAgo` below is now defined in
 * terms of this so the two cannot answer differently.
 *
 * A clock set back leaves the age negative; it is clamped to zero, which lands
 * on "just now" — the same answer the unclamped copy gave, since any negative
 * count is also below sixty.
 */
export function shortAgoSec(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "just now" / "12m ago" / "3h ago" / "5d ago", from an age in milliseconds. */
export function shortAgo(ms: number): string {
  return shortAgoSec(Math.floor(ms / 1000));
}

/**
 * "3h 43m" / "6d 21h" / "12m" — how long until a quota window resets, or null
 * once it already has.
 *
 * Recomputed client-side from a tick rather than served as a string, so it can
 * never show a countdown the server calculated minutes ago.
 *
 * WHY THIS IS HERE (#374). The accounts panel and the usage panel each had one
 * of these — `countdown` and `fmtCountdown` — and both render the same thing:
 * the Anthropic 5h/7d quota reset, one per panel, which a user can have open in
 * sequence. They looked different, because one branched on `d > 0` and the
 * other on `h > 23`, and they are the same test: `d > 0` ⟺ `diff >= 86400` ⟺
 * `floor(diff / 3600) > 23`. Swept over every whole second from −100s to 40
 * days — 3,456,101 values — the two disagreed on none.
 *
 * The day form deliberately drops the minutes. A reset more than a day out does
 * not move at a minute's resolution in any way the reader cares about, and
 * "6d 21h 04m" is three columns of a number that is only ever glanced at.
 */
export function resetCountdown(resetAtSec: number, nowSec: number): string | null {
  const diff = resetAtSec - nowSec;
  if (diff <= 0) return null;
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Same local calendar day — the user's own day, in the browser's zone, which
 *  is the only "today" that means anything to the person reading it. */
export function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** What one entry of the prompt log shows, and what it says on hover. */
export interface PromptTime {
  label: string;
  title: string;
}

/**
 * Relative label, absolute tooltip — plus the date inline once the entry is not
 * from today, since that is the case where a bare elapsed count is easiest to
 * misread as recent.
 *
 * A clock that has been set back leaves `now` behind `at`; shortAgo clamps that
 * to "just now" rather than rendering a negative age.
 */
export function promptTime(at: number, now: number, locales?: string | string[]): PromptTime {
  const when = new Date(at);
  const ago = shortAgo(now - at);
  const label = sameLocalDay(when, new Date(now))
    ? ago
    : `${ago} · ${when.toLocaleDateString(locales, { month: "short", day: "numeric" })}`;
  return { label, title: when.toLocaleString(locales, { dateStyle: "medium", timeStyle: "medium" }) };
}
