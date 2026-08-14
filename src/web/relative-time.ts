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
// Locale is the host's, never assumed: the label is built from numbers, and the
// date parts come from Intl with a style rather than a hand-written pattern, so
// a browser set to de-DE or ja-JP gets its own order and separators. `locales`
// is a parameter only so tests can pin one; production passes nothing, which
// means "whatever this browser is set to".

/** "just now" / "12m ago" / "3h ago" / "5d ago". */
export function shortAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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
