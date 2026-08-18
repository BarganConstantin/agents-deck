// Everything the deck knows about the terminal it is printing into.
//
// The terminal is the first surface of this product and, for the seconds before
// the browser opens, the only one — so it gets the same treatment the canvas
// got. The rules below are the whole of it: detect what this terminal can do,
// then degrade, rather than picking the floor and printing the same 16 colours
// into a pipe, a CI log and a truecolor emulator alike.
//
// It lives here, apart from bin/deck.js, for the reason supervisor.mjs and
// npx.mjs do: bin/deck.js installs hooks and binds a port the moment it is
// imported, so none of this could be checked any other way — and "what does the
// output look like at 40 columns, with NO_COLOR, on a Windows console" is
// exactly the kind of question that is only ever answered by asserting it.
//
// Nothing here writes anything or reads process state on its own: every input
// (env, isTTY, platform, columns) is a parameter, defaulted from the real thing.
// The two exceptions are the cursor constants, which are strings the caller
// writes, because who restores the cursor and when is a lifecycle question and
// belongs with the lifecycle.

// ── colour profile ───────────────────────────────────────────────────────────
//
// Detected once, in the order the conventions themselves establish:
// NO_COLOR (no-color.org — present and non-empty means no colour, whatever the
// value) beats FORCE_COLOR beats what the terminal advertises. Truecolor is
// effectively universal now, and it is the only tier on which the deck's accent
// is actually the deck's accent rather than whatever the user's theme decided
// cyan is — so it is worth asking for, and worth degrading from cleanly.

/** Present and non-empty, which is what every one of these variables means. */
const set = (v) => v != null && v !== "";

/** Anything below a space, or DEL. A URL is going inside an escape sequence, so
 *  a control character in it would close that sequence early. */
const hasControl = (s) => [...String(s)].some((c) => c.charCodeAt(0) <= 0x20 || c.charCodeAt(0) === 0x7f);

/** Terminals that do truecolor without saying so in COLORTERM. */
const TRUECOLOR_PROGRAMS = new Set(["iTerm.app", "vscode", "WezTerm", "ghostty", "Hyper", "rio", "Tabby"]);

/** FORCE_COLOR's levels, as every CLI that honours it reads them. `undefined`
 *  means the variable is absent and detection continues. */
function forcedProfile(raw) {
  if (raw == null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "0" || v === "false") return "none";
  if (v === "2") return "ansi256";
  if (v === "3") return "truecolor";
  return "ansi16"; // "", "1", "true", anything else: colour, at the safe floor
}

/**
 * What this terminal can be asked for: "none" | "ansi16" | "ansi256" | "truecolor".
 *
 * A Windows TTY floors at ansi16 rather than none: libuv translates SGR into
 * console API calls for consoles that cannot parse escapes themselves, so the
 * 16 colours arrive on legacy conhost too. Nothing above that tier is assumed
 * there — Windows Terminal says so through WT_SESSION, and conhost never does.
 */
export function colorProfile({ env = process.env, isTTY = false, platform = process.platform } = {}) {
  if (set(env.NO_COLOR)) return "none";
  const forced = forcedProfile(env.FORCE_COLOR);
  if (forced !== undefined) return forced;
  if (!isTTY) return "none";

  const term = String(env.TERM ?? "").toLowerCase();
  if (term === "dumb") return "none";

  const colorterm = String(env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (set(env.WT_SESSION)) return "truecolor";
  if (TRUECOLOR_PROGRAMS.has(String(env.TERM_PROGRAM ?? ""))) return "truecolor";
  if (term === "xterm-kitty" || term === "alacritty" || term.includes("truecolor")) return "truecolor";
  if (term.includes("256")) return "ansi256";
  // A TTY that advertises nothing still takes colour on every platform we
  // support; 16 is the tier nothing has to advertise to have.
  return "ansi16";
}

// ── colours ──────────────────────────────────────────────────────────────────

/** rgb → the nearest xterm-256 index: the 6×6×6 cube, or the 24-step grey ramp
 *  for anything neutral, which is where the muted tones land. */
function to256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

/**
 * One colour, expressed as far as this profile reaches.
 *
 * `fallback` is the 16-colour SGR to use when that is all there is — chosen per
 * colour rather than derived, because the nearest of eight hues to a pastel is
 * a question with a taste answer, not an arithmetic one.
 */
export function fg([r, g, b], profile, fallback) {
  if (profile === "truecolor") return `\x1b[38;2;${r};${g};${b}m`;
  if (profile === "ansi256") return `\x1b[38;5;${to256(r, g, b)}m`;
  if (profile === "ansi16") return fallback;
  return "";
}

// The canvas' own tokens (src/web/styles.css), so the terminal and the page are
// one product rather than two. The ramp is the wordmark's vertical gradient:
// lit at the top, settling into the deeper tone at the baseline.
const BRAND = {
  accentSoft: [[186, 230, 253], "\x1b[96m"],
  accent:     [[125, 211, 252], "\x1b[96m"],
  accentDeep: [[56, 189, 248],  "\x1b[36m"],
  ok:         [[134, 239, 172], "\x1b[32m"],
  warn:       [[252, 211, 77],  "\x1b[33m"],
  err:        [[252, 165, 165], "\x1b[31m"],
  muted:      [[126, 130, 140], "\x1b[2m"],
};

/**
 * The semantic names every call site uses — no raw escape ever appears in
 * bin/deck.js again. Empty strings under "none", so the same template literals
 * produce escape-free output in a pipe without a branch at each one.
 */
export function palette(profile) {
  const on = profile !== "none";
  const out = {
    reset: on ? "\x1b[0m" : "",
    bold: on ? "\x1b[1m" : "",
    dim: on ? "\x1b[2m" : "",
  };
  for (const [name, [rgb, fallback]] of Object.entries(BRAND)) out[name] = fg(rgb, profile, fallback);
  return out;
}

// ── hyperlinks ───────────────────────────────────────────────────────────────
//
// OSC 8 is an allowlist rather than a probe: a terminal that does not know the
// sequence is supposed to ignore it, and most do, but "most" is not a promise
// worth making to a legacy Windows console — and tmux below 3.4 passes the
// escape through mangled, which is worse than plain text. So links are emitted
// only where they are known to arrive.

const HYPERLINK_PROGRAMS = new Set(["iTerm.app", "vscode", "WezTerm", "ghostty", "Hyper", "rio", "Tabby"]);

export function supportsHyperlinks({ env = process.env, profile = "truecolor" } = {}) {
  // NO_COLOR takes hyperlinks with it: the convention is about decoration, and
  // an escape sequence wrapped around a path is decoration.
  if (profile === "none") return false;
  const term = String(env.TERM ?? "").toLowerCase();
  if (set(env.TMUX) || term.startsWith("screen")) return false;
  if (HYPERLINK_PROGRAMS.has(String(env.TERM_PROGRAM ?? ""))) return true;
  if (set(env.WT_SESSION)) return true;
  if (set(env.KITTY_WINDOW_ID) || term === "xterm-kitty") return true;
  if (set(env.KONSOLE_VERSION) || set(env.DOMTERM)) return true;
  const vte = Number.parseInt(String(env.VTE_VERSION ?? ""), 10);
  return Number.isFinite(vte) && vte >= 5000; // GNOME Terminal 3.26+
}

/** `text` as a link to `url`, or just `text`. BEL-terminated, which is the form
 *  the widest set of terminals accepts. A url carrying a control character is
 *  dropped rather than escaped — it could only have come from a path we should
 *  not be linking anyway. */
export function link(text, url, enabled) {
  if (!enabled || !url || hasControl(url)) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// ── glyphs ───────────────────────────────────────────────────────────────────
//
// Windows Terminal renders all of these; `cmd.exe` on a non-UTF-8 code page
// renders none of them, and this project's rule is that everything works on
// Windows. So there are two tiers and every glyph the deck prints — punctuation
// included, since an em dash is as absent from CP437 as a check mark — comes
// from one of them.

const UNICODE_GLYPHS = {
  ok: "✓", fail: "✗", warn: "⚠", stop: "◉", restart: "↻", cancel: "✕",
  up: "↑", play: "▶", pulse: "●",
  arrow: "→", ellipsis: "…", dash: "—", bullet: "·",
};

const ASCII_GLYPHS = {
  ok: "+", fail: "x", warn: "!", stop: "*", restart: "~", cancel: "x",
  up: "^", play: ">", pulse: "*",
  arrow: "->", ellipsis: "...", dash: "-", bullet: "-",
};

/**
 * Whether this terminal can be trusted with the box-drawing and arrow glyphs.
 *
 * Everywhere but Windows, yes — except the Linux virtual console, whose font is
 * 256 glyphs and none of them are these. On Windows it is the other way round:
 * an allowlist of the emulators that ship a real font and a UTF-8 code page,
 * because the default console does neither.
 */
export function unicodeOK({ env = process.env, platform = process.platform } = {}) {
  const term = String(env.TERM ?? "").toLowerCase();
  if (platform !== "win32") return term !== "linux" && term !== "dumb";
  if (set(env.WT_SESSION)) return true;
  if (String(env.TERM_PROGRAM ?? "") === "vscode") return true;
  if (set(env.ConEmuTask) || set(env.WSL_DISTRO_NAME)) return true;
  if (String(env.TERMINAL_EMULATOR ?? "") === "JetBrains-JediTerm") return true;
  return term.startsWith("xterm") || term === "alacritty";
}

export function glyphs(unicode) {
  return unicode ? { ...UNICODE_GLYPHS } : { ...ASCII_GLYPHS };
}

// One definition, for the banner, the step spinner and anything later. The
// braille frames are the nicest thing a terminal can do with one cell; the
// ASCII tier gets the rotating bar, which is the only spinner CP437 has.
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_FRAMES = ["|", "/", "-", "\\"];

export function spinnerFrames(unicode) {
  return unicode ? BRAILLE_FRAMES.slice() : ASCII_FRAMES.slice();
}

// ── motion ───────────────────────────────────────────────────────────────────

/**
 * Whether anything is allowed to move — the terminal's `prefers-reduced-motion`.
 *
 * A pipe, a file, a CI log and a NO_COLOR terminal all get the same treatment:
 * no sleeps, no `\r` repaints, no spinner, no pulse. Every one of those either
 * cannot show motion or is somebody's log file, and a log file full of carriage
 * returns is the artefact this rule exists to prevent.
 */
export function motionOK({ env = process.env, isTTY = false, profile = colorProfile({ env, isTTY }) } = {}) {
  if (!isTTY || profile === "none") return false;
  const ci = String(env.CI ?? "").trim().toLowerCase();
  if (set(ci) && ci !== "0" && ci !== "false") return false;
  return true;
}

// ── width ────────────────────────────────────────────────────────────────────

/** The visible text: SGR colour and OSC 8 hyperlinks removed. Everything that
 *  measures a line for layout measures it through here — a padded line that
 *  counted its own escapes is how a `\r` repaint starts leaving debris. */
export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\]8;;.*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

export function visibleWidth(s) {
  return stripAnsi(s).length;
}

/** How wide the terminal is, or 80 when it will not say — a pipe, a CI runner,
 *  a terminal that never sent SIGWINCH. 80 is the assumption every one of them
 *  is already built around, and the layout below never needs more than 40. */
export function termColumns(stream = process.stdout) {
  const c = stream?.columns;
  return Number.isInteger(c) && c > 0 ? c : 80;
}

/** The status column, computed from the labels rather than counted into each
 *  string by hand. A label one character longer used to break the alignment of
 *  every row silently. */
export function labelColumn(labels) {
  return labels.reduce((w, l) => Math.max(w, String(l).length), 0);
}

/**
 * `s` trimmed to `max` columns, from whichever end matters least.
 *
 * A path, a URL or a version has no spaces in it and is identified by its tail
 * — `…/agent-dag/hook.js` still says which file — so the head goes. A sentence
 * is identified by its head, and `…nel enabled)` says nothing at all, so its
 * tail goes instead. Below the width where the ellipsis plus a few characters
 * would still mean something, the detail is dropped rather than reduced to
 * punctuation; the label beside it already says which row this is.
 */
export function fit(s, max, ellipsis = "…") {
  const text = String(s);
  if (text.length <= max) return text;
  if (max < ellipsis.length + 3) return "";
  const room = max - ellipsis.length;
  return /\s/.test(text) ? text.slice(0, room) + ellipsis : ellipsis + text.slice(text.length - room);
}

const same = (s) => s;

/**
 * One aligned status row: `  ✓  label            detail`.
 *
 * Laid out on the plain text and painted afterwards, so colour and hyperlinks
 * never enter the arithmetic. The last cell of the line is left empty: a
 * terminal that fills its final column either wraps or leaves the cursor in a
 * place the next `\r` cannot recover from.
 *
 * `keep` is for the one detail nobody can act on a fragment of — the URL. When
 * it will not fit beside its label it moves to its own line under the gutter
 * rather than losing its port to an ellipsis; a truncated address is not a
 * shorter address, it is no address. The result then contains a newline, which
 * is why callers write it whole.
 */
export function statusLine({
  mark = " ", label = "", detail = "", labelWidth = 0, columns = 80, indent = 2, paint = {},
  ellipsis = "…", keep = false,
} = {}) {
  // A blank gutter is painted by nobody: colouring a space costs two escapes
  // and shows nothing, and rows with no mark are the majority of the quiet ones.
  const paintMark = stripAnsi(mark).trim() ? (paint.mark ?? same) : same;
  const paintLabel = paint.label ?? same;
  const paintDetail = paint.detail ?? same;
  const pad = " ".repeat(indent);
  const head = `${pad}${paintMark(mark)}  ${paintLabel(label)}`;

  if (!detail) return head;

  const padded = label.padEnd(Math.max(labelWidth, label.length));
  const used = indent + stripAnsi(mark).length + 2 + padded.length + 2;
  const room = columns - used - 1;
  const plain = stripAnsi(detail);
  if (keep && plain.length > room) {
    // Under the gutter if that still fits, then flush left, then wrapped —
    // there is nothing else to try when the address is wider than the terminal.
    const under = [indent + 3, indent, 0].find(n => n + plain.length < columns) ?? 0;
    return `${head}\n${" ".repeat(under)}${paintDetail(detail)}`;
  }
  const fitted = plain.length <= room ? detail : fit(plain, room, ellipsis);
  if (!fitted) return head;
  return `${pad}${paintMark(mark)}  ${paintLabel(padded)}  ${paintDetail(fitted)}`;
}

// ── wordmark ─────────────────────────────────────────────────────────────────
//
// Drawn, not pasted out of a figlet font — six letters on a 4×6 pixel grid,
// printed two pixel rows to a text row with the half-block characters, which is
// what gives it a lowercase with real ascenders in three lines instead of six.
// The old banner said `agents-deck`, a name the repo, the command, the README
// and the docs stopped using; this one says what the product is called.

const LETTERS = {
  c: ["....", "....", ".###", "#...", "#...", ".###"],
  d: ["...#", "...#", ".###", "#..#", "#..#", ".###"],
  e: ["....", "....", ".###", "####", "#...", ".###"],
  k: ["#...", "#...", "#.##", "##..", "#.#.", "#..#"],
};

/** Two pixel rows into one text row: ▀ upper only, ▄ lower only, █ both. */
function squash(top, bottom) {
  let out = "";
  for (let i = 0; i < top.length; i++) {
    const t = top[i] === "#";
    const b = bottom[i] === "#";
    out += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
  }
  return out;
}

function renderWord(word) {
  const rows = ["", "", ""];
  for (const [n, ch] of [...word].entries()) {
    const px = LETTERS[ch];
    for (let r = 0; r < 3; r++) rows[r] += (n ? " " : "") + squash(px[r * 2], px[r * 2 + 1]);
  }
  return rows.map((r) => r.replace(/\s+$/, ""));
}

export const WORDMARK_LINES = renderWord("ccdeck");
/** 29 columns of art, plus the two-space indent every other line uses. */
export const WORDMARK_WIDTH = 2 + LETTERS.c[0].length * 6 + 5;

/** The tagline, longest version that fits — the name and version are the part
 *  that must survive, the rest is context. */
function tagline(version, columns, bullet) {
  const v = `v${version}`;
  const options = [
    `${v} ${bullet} live agent DAG ${bullet} Claude Code + Codex`,
    `${v} ${bullet} live agent DAG`,
    v,
  ];
  return options.find((o) => o.length + 2 <= columns - 1) ?? v;
}

/**
 * The wordmark, in the largest form this terminal can hold.
 *
 *   "full"    — the drawn mark, three rows, on a vertical gradient
 *   "compact" — the name in the accent, for a terminal too narrow for the art
 *               or a console without the half-block glyphs
 *   "plain"   — no escapes at all: a pipe, a CI log, NO_COLOR
 *
 * Returns the lines to print, blank lines included, so the caller writes them
 * and nothing else decides how much air the banner gets.
 */
export function wordmark({
  columns = 80, version = "0.0.0", profile = "none", unicode = true, pal = palette(profile),
} = {}) {
  const g = glyphs(unicode);
  const tag = tagline(version, columns, g.bullet);

  if (profile === "none") return { kind: "plain", lines: ["", `  ccdeck ${tag}`, ""] };
  if (!unicode || columns < WORDMARK_WIDTH + 1) {
    return { kind: "compact", lines: ["", `  ${pal.bold}${pal.accent}ccdeck${pal.reset}  ${pal.muted}${tag}${pal.reset}`, ""] };
  }

  const ramp = [pal.accentSoft, pal.accent, pal.accentDeep];
  return {
    kind: "full",
    lines: [
      "",
      ...WORDMARK_LINES.map((l, i) => `  ${ramp[i]}${l}${pal.reset}`),
      "",
      `  ${pal.muted}${tag}${pal.reset}`,
      "",
    ],
  };
}

// ── the pulse line ───────────────────────────────────────────────────────────

/**
 * The one line that stays on screen for hours, sized to the terminal it is on.
 *
 * It is redrawn over itself with `\r`, so both messages are padded to one width
 * — the shorter has to cover the longer — and that width is clamped to the real
 * terminal: at 40 columns the old 58-character message wrapped, after which the
 * `\r` only ever reached the second row and every repaint left the first one
 * behind. A deck no hook can find is not listening in any sense the user cares
 * about, which is why that state has a message here at all.
 *
 * `claude` is what makes that last sentence conditional. A deck watching only
 * Codex is not waiting on a hook: startCodexWatcher is started by startServer
 * and never consults the discovery file, and writesCodexLog keeps a deck with no
 * record on disk writing its log. Capture and persistence both work perfectly
 * there, while this line used to repaint "hooks cannot find this deck" every
 * 800ms, forever (#404) — a permanent alarm about a mechanism that deck does not
 * use. The one-time report at boot still says what IS lost; see
 * unregisteredDetail.
 */
export function pulseText({ registered = true, claude = true, columns = 80, unicode = true, indent = 2 } = {}) {
  const g = glyphs(unicode);
  const room = Math.max(4, columns - indent - 3 - 1);
  const pick = (options) => options.find((o) => o.length <= room) ?? options[options.length - 1].slice(0, room);

  const ok = pick([`listening ${g.dash} Ctrl+C to stop`, "listening"]);
  const bad = pick([
    `listening, but not registered ${g.dash} hooks cannot find this deck`,
    `not registered ${g.dash} hooks cannot find this deck`,
    "not registered",
  ]);
  // Both branches are still measured, registered or not, because the line is
  // redrawn over itself and the shorter message has to cover the longer one on
  // the beat after a deck loses its registration.
  const width = Math.min(room, Math.max(ok.length, bad.length));
  return (registered || !claude ? ok : bad).padEnd(width);
}

/**
 * The second line of the "not registered" report, which bin/deck.js prints once
 * per change of state rather than every beat.
 *
 * What a missing discovery file costs is not the same on the two capture paths,
 * and the old sentence — "hooks find this deck through <file>, so until that
 * file exists no events arrive" — stated the Claude Code answer as if it were
 * both. On a Codex-only deck it is false twice over: no hook is looking for this
 * deck, and events do keep arriving, because the rollout watcher reads the files
 * directly. What that deck really loses is the writer election in
 * log-writer.mjs, which is how several decks tailing one rollout agree on which
 * of them appends it to a shared events log. A deck with no record on disk is
 * assumed to be writing, so nothing is dropped — the log can gain the same line
 * twice instead.
 *
 * @param file the discovery file that could not be written.
 * @param claude whether this deck is watching Claude Code at all.
 */
export function unregisteredDetail({ file, claude = true }) {
  if (claude) {
    return `Claude Code hooks find this deck through ${file}, so until that file exists no Claude Code events arrive.`;
  }
  return `Codex capture does not use ${file} — the deck tails the rollout files itself — so events still arrive. Only decks sharing one events log need it, to agree on which of them records.`;
}

// ── cursor ───────────────────────────────────────────────────────────────────
//
// Strings rather than writers: hiding the cursor is trivial and restoring it is
// not — it has to happen on the normal exit, on SIGINT/SIGTERM/SIGHUP and after
// an uncaught throw, and getting that half-right leaves the user's shell with
// no cursor after the deck is gone. The lifecycle owns it; see bin/deck.js.
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
