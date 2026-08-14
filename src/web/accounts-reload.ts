// What the accounts panel says when a reload does not land, and which of two
// messages is still on screen once one does.
//
// The panel's ↻ and its 15-second poll shared one load() whose catch was empty
// and whose two `if (res.ok)` guards dropped a refusal on the floor. A thrown
// fetch and a 500 both left every piece of state exactly as it stood, so a
// reload that failed was indistinguishable from one that came back with the
// same numbers — and the very first load failing left "Checking…" on screen
// with no branch behind it, because the panel's only failure box lives inside
// the branch that needs data to render.
//
// The ranking is not a new one. These two routes refuse in the same shape the
// switch and auto-switch POSTs already do, so explainCommandFailure picks the
// words and the subprocess's own output stays in the title, where a traceback
// cannot fill a 288px box.
//
// Out here rather than in the component because the suite has no DOM: React
// cannot be rendered in it, so the rules live where they can be called
// directly — the same reason admin-failure.ts and login-flow.ts do.
import { type CommandFailure, commandOutput, explainCommandFailure } from "./admin-failure";

/**
 * What went wrong, and the words the tool used.
 *
 * `text` is the only half that is shown. `raw` is cswap's own stderr, which
 * this panel used to print instead — a traceback or a shell's "is not
 * recognized" in a 288px box at 10px — and it survives only as the title, close
 * enough to copy into an issue and far enough not to be the message.
 *
 * `reload` marks the messages this module produced. They are the only ones that
 * clear themselves, because the next reload is the thing that disproves them; a
 * refused switch is about a click, and stays until the user dismisses it or
 * clicks something else.
 */
export interface Failure {
  text: string;
  raw?: string;
  reload?: true;
}

/** One of the panel's two GETs, once it has come back. */
export interface ReloadAnswer {
  ok: boolean;
  status: number;
  body: CommandFailure;   // read only when the request failed
}

/** The half of a Response this module needs, so a test can be a plain object. */
interface Answerable {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Nothing came back at all.
 *
 * Covers the deck that is not there — fetch rejects — and the one that took the
 * connection and then wedged, which only ends because the caller aborts it.
 * From here those are one fact, and splitting them would promise the reader a
 * distinction the panel cannot actually make.
 */
export const RELOAD_UNREACHABLE: Failure = Object.freeze({
  text: "couldn't reach the deck server",
  reload: true,
});

/**
 * A response with its refusal body read — and only a refusal's.
 *
 * A 200 here carries the panel's data, which the caller has already taken, and
 * a body can only be read once.
 */
export async function answered(res: Answerable): Promise<ReloadAnswer> {
  if (res.ok) return { ok: true, status: res.status, body: null };
  return {
    ok: false,
    status: res.status,
    body: await res.json().catch(() => null) as CommandFailure,
  };
}

/**
 * The one message a completed reload leaves, or null when it landed.
 *
 * Argument order is the ranking: the roster is the panel, and the auto-switch
 * status is a strip along the bottom of it, so a roster that failed is what to
 * say even when both did.
 */
export function explainReload(answers: ReloadAnswer[]): Failure | null {
  const bad = answers.find(a => !a.ok);
  if (!bad) return null;
  // Neither GET has a reason code today — they answer 200 with `ok: false` and
  // say why in the body the panel already renders. A non-2xx from them is the
  // handler having thrown, which arrives as a bare 500, so the status is the
  // only fact there is. It goes through the same ranking anyway: the day one of
  // them grows a reason, it will be said in the product's voice rather than
  // added to a second map that has to be kept in step with COMMAND_REASONS.
  const raw = commandOutput(bad.body);
  return {
    text: explainCommandFailure(bad.body, `the deck server answered ${bad.status}`),
    ...(raw ? { raw } : {}),
    reload: true,
  };
}

/**
 * Which message is on screen after a reload — the old one, the new one, or none.
 *
 * Two things this must not do. A reload that landed cannot wipe a refused
 * switch: doSwitch sets its message and then reloads, so clearing on success
 * would delete the answer to the click that produced it. And a poll that keeps
 * failing cannot hand back a new object every 15 seconds — the box is
 * role="alert", and a fresh identity re-announces the same sentence to a screen
 * reader four times a minute.
 */
export function nextFailure(prev: Failure | null, verdict: Failure | null): Failure | null {
  if (!verdict) return prev?.reload ? null : prev;
  if (prev?.reload && prev.text === verdict.text && prev.raw === verdict.raw) return prev;
  return verdict;
}
