// Fetches historical usage from the `ccusage` CLI (https://github.com/ccusage/ccusage).
// ccusage reads the local ~/.claude (and other agent) logs and reports cost +
// token usage grouped by day. We shell out to it via `npx -y ccusage@latest`
// — it is NOT a dependency; npx fetches it on first run (cached afterwards).
//
// The whole backend is: spawn the CLI with --json, slice the JSON out of stdout
// (npx can print banner noise), JSON.parse, cache. Ported from the task-board
// project's three Next.js routes, collapsed to one daily fetch.
import { spawn } from "node:child_process";

const CACHE_MS = 120_000; // 2 min — ccusage spawn is heavy; modal is manual-open
const TIMEOUT_MS = 90_000;

const _cache = new Map(); // key `${since}|${until}` → { result, at }

// Run `ccusage <args> --json` and resolve its raw stdout.
function runCcusage(args) {
  return new Promise((resolve, reject) => {
    // shell:true + windowsHide:true so `npx` resolves on Windows without a
    // popup console. ccusage@latest is pinned so behavior is stable.
    const child = spawn("npx", ["-y", "ccusage@latest", ...args], {
      shell: true,
      windowsHide: true,
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("ccusage timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `ccusage exited ${code}`));
    });
  });
}

// ccusage prints the JSON object somewhere in stdout; slice first { to last }.
function extractJson(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in ccusage output");
  return JSON.parse(out.slice(start, end + 1));
}

// YYYYMMDD for the CLI's --since/--until.
function toCliDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Fetch daily usage from ccusage for a date range.
 * @param {{ since?: string, until?: string, force?: boolean }} opts
 *        since/until are YYYYMMDD strings (CLI format). Defaults to last 30 days.
 * @returns {{ ok, days, totals, since, until, fetchedAt } | { ok:false, error }}
 */
export async function fetchCcusageDaily({ since, until, force = false } = {}) {
  const now = Date.now();
  const sinceArg = since || toCliDate(new Date(now - 30 * 86400_000));
  const key = `${sinceArg}|${until ?? ""}`;

  const cached = _cache.get(key);
  if (!force && cached && now - cached.at < CACHE_MS) return cached.result;

  let result;
  try {
    const args = ["daily", "--json", "--since", sinceArg];
    if (until) args.push("--until", until);
    const raw = extractJson(await runCcusage(args));
    const days = Array.isArray(raw.daily) ? raw.daily : [];
    result = {
      ok: true,
      days,
      totals: raw.totals ?? null,
      since: sinceArg,
      until: until ?? null,
      fetchedAt: now,
    };
  } catch (err) {
    console.error("agents-deck ccusage: fetch failed:", err?.message ?? err);
    result = { ok: false, error: String(err?.message ?? err), fetchedAt: now };
  }

  _cache.set(key, { result, at: now });
  return result;
}

export function invalidateCcusageCache() {
  _cache.clear();
}
