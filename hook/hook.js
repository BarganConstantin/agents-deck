#!/usr/bin/env node
// agent-dag hook forwarder. Invoked by Claude Code or Codex CLI as a command
// hook. Reads stdin (event JSON), tags it with the provider passed via
// `--provider <name>`, finds the matching agent-dag server via per-workspace
// discovery files in ~/.claude/agent-dag/, and POSTs the payload. Dead
// instances are cleaned up.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

// Hard cap so a stuck server can never wedge the host CLI.
setTimeout(() => process.exit(0), 1500);

// Single shared discovery dir — Claude Code and Codex CLI both register here
// via the installer. Lets one running agent-dag server receive both providers.
const DIR = path.join(os.homedir(), ".claude", "agent-dag");

function parseProvider(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider" && i + 1 < argv.length) return argv[i + 1];
  }
  return "claude";
}
const PROVIDER = parseProvider(process.argv.slice(2));

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { input += c; });
process.stdin.on("end", () => {
  let parsed;
  try { parsed = JSON.parse(input); } catch { return process.exit(0); }
  const cwd = parsed && parsed.cwd;
  if (!cwd) return process.exit(0);

  // Stamp provider so the server / reducer can branch on it without
  // re-sniffing payload shape.
  if (parsed && typeof parsed === "object" && !parsed.provider) {
    parsed.provider = PROVIDER;
  }
  const taggedInput = JSON.stringify(parsed);

  const resolvedCwd = normPath(cwd);

  let files;
  try {
    files = fs.readdirSync(DIR).filter(f => f.endsWith(".json"));
  } catch { return process.exit(0); }
  if (!files.length) return process.exit(0);

  const matches = [];
  for (const file of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")); } catch { continue; }
    if (typeof d.workspace !== "string" || !d.pid || !d.port) continue;

    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }

    if (d.workspace === "") {
      matches.push({ d, wsLen: 0 });
      continue;
    }
    const ws = normPath(d.workspace);
    if (resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep)) {
      matches.push({ d, wsLen: ws.length });
    }
  }

  if (!matches.length) return process.exit(0);

  matches.sort((a, b) => b.wsLen - a.wsLen);
  const bestLen = matches[0].wsLen;
  const targets = matches.filter(m => m.wsLen === bestLen);

  let pending = targets.length;
  const done = () => { if (--pending <= 0) process.exit(0); };

  for (const { d } of targets) {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; done(); };
    const req = http.request({
      hostname: "127.0.0.1",
      port: d.port,
      path: "/api/event",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 1000,
    }, res => { res.resume(); res.on("end", finish); });
    req.on("error", finish);
    req.on("timeout", () => req.destroy());
    req.write(taggedInput);
    req.end();
  }
});
