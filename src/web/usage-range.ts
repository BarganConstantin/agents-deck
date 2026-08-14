// Pure date rule behind the usage-history range presets. Kept out of the
// component so it can be unit-tested without React or the DOM.

/**
 * First day of an N-day preset, as the `YYYYMMDD` that ccusage's `--since`
 * expects.
 *
 * ccusage buckets its daily rows by LOCAL calendar date, so the range start has
 * to be a local calendar date too. Deriving it from `toISOString()` read the
 * UTC date instead, and the two disagree for part of every day: a user at UTC-5
 * opening the modal at 20:00 is already on tomorrow's UTC date, so the 7d
 * preset asked for the local day minus five and drew six bars; east of UTC in
 * the early morning the same slip runs the other way and the 30d preset drew
 * thirty-one. The local calendar fields of `now` fix the endpoint, and the
 * subtraction runs in UTC where every day is exactly 24h, so no daylight-saving
 * transition inside the range can shift the result by a day.
 *
 * @param days   length of the preset in local days, inclusive of today.
 * @param now    instant to measure from; defaults to the current time.
 */
export function presetSince(days: number, now: Date = new Date()): string {
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)));
  return start.toISOString().slice(0, 10).replace(/-/g, "");
}
