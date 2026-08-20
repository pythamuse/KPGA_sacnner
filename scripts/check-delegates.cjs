#!/usr/bin/env node
/**
 * Liveness check for delegated Codex runs.
 *
 * A `codex exec` that hits an approval prompt with no TTY does not fail and
 * does not exit -- it sits there. The process stays in the task list, so
 * "is the process alive?" answers yes while nothing is happening. Two rounds
 * once burned 3.5 and 2.3 hours that way before anyone looked at the output.
 *
 * The signal that separates the two is CPU accrual: a working run gains
 * seconds within a minute, a hung one gains hundredths over hours.
 *
 *   node scripts/check-delegates.cjs [logDir]
 *
 * `logDir` defaults to the background-task directory this project uses; pass
 * the directory holding the `codex exec` output files if it differs.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAMPLE_MS = 8000;
// Below this, a process that has been up for a while is not doing work.
const WORKING_CPU_PER_MIN = 0.2;

function psCodex() {
  const script =
    "Get-Process codex -ErrorAction SilentlyContinue | " +
    "Select-Object Id,CPU,StartTime | ConvertTo-Json -Compress";
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function minutesUp(startTime) {
  if (!startTime) return null;
  const ms = /\/Date\((\d+)\)\//.exec(String(startTime));
  const started = ms ? Number(ms[1]) : Date.parse(startTime);
  if (!Number.isFinite(started)) return null;
  return (Date.now() - started) / 60000;
}

function logSizes(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.output'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        name,
        bytes: stat.size,
        ageMin: (Date.now() - stat.mtimeMs) / 60000,
      };
    })
    .sort((a, b) => a.ageMin - b.ageMin)
    .slice(0, 8);
}

const logDir =
  process.argv[2] ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'Temp',
    'claude',
    'C--Users-night-Desktop-----------',
  );

const first = psCodex();
if (first.length === 0) {
  console.log('no codex process running -- nothing delegated, or it finished');
} else {
  const start = new Map(first.map((p) => [p.Id, p.CPU]));
  const wait = Date.now() + SAMPLE_MS;
  while (Date.now() < wait) {
    // Busy-wait rather than pull in a timer: this script is meant to be a
    // single synchronous shot from a scheduled check.
  }
  const second = psCodex();

  console.log('pid      up(min)  cpu(s)  delta   verdict');
  for (const proc of second) {
    const before = start.get(proc.Id);
    const delta = before === undefined ? null : proc.CPU - before;
    const up = minutesUp(proc.StartTime);
    const rate = up && up > 0 ? proc.CPU / up : null;
    let verdict = 'unknown';
    if (delta !== null && delta > 0.05) verdict = 'WORKING (cpu rising now)';
    else if (up !== null && up < 2) verdict = 'starting -- check again shortly';
    else if (up !== null && up > 240)
      // The Codex desktop app sits in this list for days. A dispatched run that
      // has been up four hours is either finished or wedged, and either way it
      // is not what this column is for.
      verdict = 'long-lived -- the app, not a run';
    else if (rate !== null && rate < WORKING_CPU_PER_MIN)
      verdict = 'STUCK -- approval prompt, or waiting on stdin';
    else verdict = 'idle this sample -- re-check before acting';
    console.log(
      String(proc.Id).padEnd(9) +
        (up === null ? '?' : up.toFixed(1)).padEnd(9) +
        Number(proc.CPU).toFixed(2).padEnd(8) +
        (delta === null ? '-' : delta.toFixed(3)).padEnd(8) +
        verdict,
    );
  }
}

const logs = logSizes(logDir);
if (logs.length) {
  console.log('\nrecent delegate output files');
  for (const l of logs) {
    const flag =
      l.bytes === 0 && l.ageMin > 5 ? '  <-- EMPTY, and it should not be' : '';
    console.log(
      `  ${l.name.padEnd(26)} ${String(l.bytes).padStart(8)} bytes  ${l.ageMin.toFixed(0)}m old${flag}`,
    );
  }
}
