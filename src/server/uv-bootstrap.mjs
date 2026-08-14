// Last-resort acquisition of `uv`, so claude-swap can be installed on a machine
// with no Python tooling at all.
//
// The alternative everyone reaches for is `curl -LsSf https://astral.sh/uv/
// install.sh | sh`, which executes whatever that URL happens to serve, with the
// user's privileges, and drops files into their global tool path. This does the
// narrower thing instead: fetch one named release artifact from Astral's own
// GitHub releases, check it against the SHA-256 that release publishes beside
// it, and unpack it inside ~/.agents-deck. Nothing is executed until it has
// been verified, nothing lands outside a directory the deck already owns, and
// deleting that directory undoes all of it.
//
// It is still a network fetch of an executable, so it only happens when there
// is no other way: uv, pipx, and python -m pipx have all already been ruled out
// by the caller. AGENTS_DECK_NO_INSTALL=1 disables it along with everything else.
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm, chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { run } from "./exec.mjs";

const TOOL_DIR = join(homedir(), ".agents-deck", "tools");
const UV_DIR   = join(TOOL_DIR, "uv");

const RELEASE_API = "https://api.github.com/repos/astral-sh/uv/releases/latest";
const DOWNLOAD_BASE = "https://github.com/astral-sh/uv/releases/download";

// Used when the releases API cannot be reached — rate limiting is per-IP and
// unauthenticated, so this is a normal outcome rather than an error. Any
// reasonably recent uv can install claude-swap; it self-updates later.
const FALLBACK_VERSION = "0.12.3";

const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Release artifact for this machine, or null if uv does not publish one.
 *
 * Rosetta is deliberately not special-cased: an x64 Node on Apple Silicon
 * reports x64 and gets the x64 build, which runs.
 */
export function assetName(platform = process.platform, arch = process.arch) {
  const a = { x64: "x86_64", arm64: "aarch64", ia32: "i686" }[arch];
  if (!a) return null;
  // Apple publishes no i686 build, and never will.
  if (platform === "darwin") return a === "i686" ? null : `uv-${a}-apple-darwin.tar.gz`;
  if (platform === "win32")  return `uv-${a}-pc-windows-msvc.zip`;
  if (platform === "linux")  return `uv-${a}-unknown-linux-gnu.tar.gz`;
  return null;
}

/** Path to a uv this function installed earlier, or null. */
export function existingBootstrappedUv() {
  const bin = join(UV_DIR, process.platform === "win32" ? "uv.exe" : "uv");
  return existsSync(bin) ? bin : null;
}

async function latestVersion() {
  try {
    const res = await fetch(RELEASE_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agents-deck" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return FALLBACK_VERSION;
    const tag = (await res.json())?.tag_name;
    return typeof tag === "string" && /^\d/.test(tag) ? tag : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

async function download(url, { asText = false } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "agents-deck" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return asText ? (await res.text()) : Buffer.from(await res.arrayBuffer());
}

/**
 * A path as a PowerShell single-quoted string literal.
 *
 * Inside single quotes PowerShell expands nothing, so a doubled quote is both
 * the only escape it has and the only one needed. Windows filenames cannot
 * contain `"`, `<`, `>` or `|`, but they can contain an apostrophe — and the
 * archive lands under os.tmpdir(), which on Windows is inside the user's own
 * profile: C:\Users\O'Brien\AppData\Local\Temp. Pasted in raw, that apostrophe
 * ended the string mid-path and Expand-Archive died of a syntax error, so uv
 * could never be bootstrapped on an account whose owner has that name.
 */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The command that unpacks the artifact, as file + argv.
 *
 * `tar` is present on macOS, on Linux, and on Windows 10 1803 and later (as
 * bsdtar), but Windows ships .zip and older Windows has no tar at all — so zip
 * goes through PowerShell's Expand-Archive, which is always there.
 *
 * Exported, pure, and with the platform as a parameter, because the branch that
 * needs checking is the one that never runs on the machine running the tests.
 *
 * Only the tar branch gets to pass its paths as arguments. `powershell.exe
 * -Command` has no argument channel to pass them through — everything after
 * -Command is joined back into the script text — so the paths are part of a
 * PowerShell program either way, and quoting them for PowerShell is the whole
 * job. Nothing else is quoting them on the way there: powershell.exe is an .exe,
 * so exec.mjs spawns it directly with shell:false and the -Command string
 * arrives as one intact argv entry, never seeing cmd.exe.
 */
export function extractCommand(archivePath, destDir, platform = process.platform) {
  if (platform === "win32" && archivePath.endsWith(".zip")) {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -LiteralPath ${psQuote(archivePath)} ` +
        `-DestinationPath ${psQuote(destDir)} -Force`,
      ],
    };
  }
  return { file: "tar", args: ["-xzf", archivePath, "-C", destDir] };
}

/** Unpack the artifact. */
async function extract(archivePath, destDir) {
  const { file, args } = extractCommand(archivePath, destDir);
  const r = await run(file, args, { timeout: 120_000 });
  return r.ok;
}

/**
 * Find the uv executable somewhere under `dir`.
 *
 * The archives put it in a versioned subdirectory whose name has changed
 * between releases, so it is located rather than assumed.
 */
async function findUv(dir, depth = 0) {
  const wanted = process.platform === "win32" ? "uv.exe" : "uv";
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && e.name === wanted) return join(dir, e.name);
  }
  if (depth >= 2) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findUv(join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Download and verify uv into ~/.agents-deck/tools/uv.
 *
 * Returns { ok: true, bin, version } or { ok: false, reason }. Never throws:
 * every caller treats a missing uv as an expected state.
 */
export async function bootstrapUv() {
  const already = existingBootstrappedUv();
  if (already) return { ok: true, bin: already, version: "existing" };

  // Downloading an executable is a bigger step than installing a package with a
  // tool the user already chose, so it gets its own off switch as well as the
  // blanket one — someone may want the managed installs and not this.
  if (process.env.AGENTS_DECK_NO_DOWNLOAD === "1") return { ok: false, reason: "download_disabled" };

  const asset = assetName();
  if (!asset) return { ok: false, reason: "unsupported_platform" };

  const version = await latestVersion();
  const base = `${DOWNLOAD_BASE}/${version}/${asset}`;

  const staging = join(tmpdir(), `agents-deck-uv-${process.pid}`);
  try {
    const [archive, sumText] = await Promise.all([
      download(base),
      download(`${base}.sha256`, { asText: true }),
    ]);
    if (!archive) return { ok: false, reason: "download_failed" };

    // No published checksum means no way to know what was downloaded, and an
    // unverified binary is not something to run on someone's machine.
    const expected = sumText?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
      return { ok: false, reason: "no_checksum" };
    }
    const actual = createHash("sha256").update(archive).digest("hex");
    if (actual !== expected) return { ok: false, reason: "checksum_mismatch" };

    await mkdir(staging, { recursive: true });
    const archivePath = join(staging, asset);
    await writeFile(archivePath, archive);
    if (!(await extract(archivePath, staging))) return { ok: false, reason: "extract_failed" };

    const found = await findUv(staging);
    if (!found) return { ok: false, reason: "not_in_archive" };

    await mkdir(UV_DIR, { recursive: true });
    const dest = join(UV_DIR, process.platform === "win32" ? "uv.exe" : "uv");
    // Copy rather than rename: the staging dir is in the system temp directory,
    // which is often a different filesystem, and rename across one fails.
    const { copyFile } = await import("node:fs/promises");
    await copyFile(found, dest);
    if (process.platform !== "win32") await chmod(dest, 0o755);

    const check = await run(dest, ["--version"], { timeout: 15_000 });
    if (!check.ok) return { ok: false, reason: "does_not_run" };

    return { ok: true, bin: dest, version };
  } catch (err) {
    return { ok: false, reason: "error", detail: String(err?.message ?? err).slice(0, 200) };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
