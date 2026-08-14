// What the topbar's version chip says about itself.
//
// The chip is a button: clicking it asks npm now instead of reusing the answer
// cached on disk. Nothing about "v1.33.77" in dim 11px text says that, so the
// two strings below are the whole affordance — the tooltip a mouse finds, and
// the accessible name a screen reader gets instead of a bare version number.
//
// Kept out of App.tsx because it is the one part of the chip that can be wrong
// rather than merely plain: a chip that says "npm not reached yet" while npm
// answered perfectly well, or "click to check" while a click is already in
// flight, is worse than the plain caption it replaced.

export type VersionChipCopy = {
  /** The version rendered on the chip, already defaulted by the caller. */
  running: string;
  /** npm's newest installable version, or null while none is known. */
  latest?: string | null;
  /** A version npm's dist-tag names but cannot serve yet. Its presence means
   *  the registry WAS reached, which is the opposite of what a null `latest`
   *  alone would suggest. */
  latestPending?: string | null;
  /** Age of the last successful check, already worded — "12m ago", "just
   *  now" — or null when npm has never answered. */
  checkedAgo?: string | null;
  /** AGENTS_DECK_NO_UPDATE_CHECK=1 and friends — no lookup will ever run. */
  checkDisabled?: boolean;
  /** A forced check started by this chip has not come back yet. */
  checking?: boolean;
};

const CHECKS_OFF = "Update checks are off (AGENTS_DECK_NO_UPDATE_CHECK=1).";

/** The chip's tooltip: what npm last said, when it said it, and what a click
 *  would do about it. */
export function versionChipTitle(c: VersionChipCopy): string {
  if (c.checkDisabled) return CHECKS_OFF;
  if (c.checking) return "Asking npm for the newest release…";
  const state = c.latest
    ? `npm has v${c.latest}`
    : c.latestPending
      // Reached, but holding the version back: the dist-tag moves before the
      // tarball is servable, and offering it there ends in ETARGET.
      ? `npm's latest tag names v${c.latestPending}, which it cannot serve yet`
      : "npm not reached yet";
  const age = c.checkedAgo ? ` · checked ${c.checkedAgo}` : "";
  // The deck re-checks on its own now, so the chip must not claim to be the
  // only way — it is the way to not wait.
  return `${state}${age} · re-checked periodically · click to check npm now`;
}

/** The chip's accessible name. The visible text is a version number and the
 *  action is invisible, so this has to carry both. */
export function versionChipLabel(c: VersionChipCopy): string {
  const v = `Version v${c.running}`;
  if (c.checkDisabled) return `${v}, update checks are off`;
  if (c.checking) return `${v}, checking npm for a newer release`;
  return `${v}, check npm for a newer release`;
}
