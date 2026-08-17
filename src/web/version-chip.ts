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

/** What the chip is about once a drift has been found. */
export type VersionNoticeCopy = {
  /** "restart" — the new code is already on disk; "upgrade" — it is on npm. */
  kind: "restart" | "upgrade";
  /** The version this process is actually running. */
  from: string;
  /** The version it could be running. */
  to: string;
  /** Whether the banner this chip toggles is on screen right now. */
  open: boolean;
};

/** The accessible name of the chip's OTHER branch — the one that is lit
 *  because something is out of date (#381).
 *
 *  It had none, which meant its name fell back to its text: `v1.33.143`, byte
 *  for byte what the healthy chip beside it says. The branch that has news was
 *  the quieter of the two, and the drift it exists to report was carried
 *  entirely by an amber dot (`.v-dot`, aria-hidden) and a `title` — colour and
 *  a hover, which is WCAG 1.4.1 twice over.
 *
 *  The banner below says the same thing, and that is not a substitute: the
 *  banner is dismissible and this chip is deliberately not, so once it is
 *  dismissed the chip is the only surface left carrying the fact. */
export function versionNoticeLabel(n: VersionNoticeCopy): string {
  const what = n.kind === "restart"
    ? `v${n.to} is installed and waiting for a restart`
    : `v${n.to} is available on npm`;
  // The verb is what the NEXT click does, not what the chip is showing — a
  // toggle whose name describes its current state reads backwards to anyone
  // deciding whether to press it.
  return `Version v${n.from}, ${what} — ${n.open ? "hide" : "show"} the notice`;
}
