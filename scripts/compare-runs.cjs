#!/usr/bin/env node
/**
 * Paired, cell-level comparison of two `tests/real-scan-measure.test.ts` logs.
 *
 *   node scripts/compare-runs.cjs baseline.log candidate.log [--seed 1] [--boot 10000]
 *
 * Why this exists (Docs/17 §3.16): the review-total baseline moves 76–91 cells
 * just from re-feeding the same paper, while a typical change moves 0–5. A
 * plain total cannot tell "no effect" from "too coarse to see". This script
 * pairs every (student, field) cell between the two runs, lists the ones that
 * changed status, and bootstraps the per-student deltas so the report says
 * whether the total moved by more than the paper-noise floor.
 *
 * Statuses come from the log's per-field lines: ok / BLANK / WRONG. Anything
 * else (MISSING, OFF-only) is kept as its own label. A cell is "correct" when
 * ok, "wrong" when WRONG, "blank" otherwise.
 */
const fs = require('fs');

function parseLog(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const cells = new Map(); // key `p{page}|{field}` -> { status, got }
  let page = null;
  for (const raw of text.split(/\r?\n/)) {
    const p = /^--- student page (\d+) ---/.exec(raw);
    if (p) { page = Number(p[1]); continue; }
    if (page === null) continue;
    const m = /^\s+([a-z]+\.[A-Za-z0-9]+)\s+got=(\S+)\s+conf=\S+\s+src=\S+\s+(ok|BLANK|WRONG|MISSING|OFF)\b/.exec(raw);
    if (!m) continue;
    cells.set(`p${page}|${m[1]}`, { page, field: m[1], got: m[2], status: m[3] });
  }
  return cells;
}

function classify(status) {
  if (status === 'ok') return 'correct';
  if (status === 'WRONG') return 'wrong';
  return 'blank';
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMean(values, iterations, rng) {
  const n = values.length;
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += values[Math.floor(rng() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(means.length - 1, Math.floor(p * means.length))];
  return { lo: q(0.025), hi: q(0.975), mean: values.reduce((a, b) => a + b, 0) / n };
}

function signTestP(values) {
  // Two-sided exact sign test on the non-zero deltas.
  const nz = values.filter((v) => v !== 0);
  const k = nz.filter((v) => v > 0).length;
  const n = nz.length;
  if (n === 0) return 1;
  const choose = (a, b) => { let r = 1; for (let i = 1; i <= b; i += 1) r = (r * (a - b + i)) / i; return r; };
  const tail = (x) => { let s = 0; for (let i = 0; i <= x; i += 1) s += choose(n, i); return s / 2 ** n; };
  const smaller = Math.min(k, n - k);
  return Math.min(1, 2 * tail(smaller));
}

function main() {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length !== 2) {
    console.error('usage: node scripts/compare-runs.cjs baseline.log candidate.log [--seed N] [--boot N]');
    process.exit(2);
  }
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
  const seed = opt('--seed', 1);
  const boot = opt('--boot', 10000);
  const a = parseLog(files[0]);
  const b = parseLog(files[1]);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => {
    const [px, fx] = x.split('|'); const [py, fy] = y.split('|');
    return Number(px.slice(1)) - Number(py.slice(1)) || fx.localeCompare(fy);
  });

  const transitions = new Map();
  const perStudent = new Map(); // page -> { dCorrect, dWrong, dBlank }
  const changed = [];
  let onlyA = 0; let onlyB = 0;
  for (const key of keys) {
    const ca = a.get(key); const cb = b.get(key);
    if (!ca) { onlyB += 1; continue; }
    if (!cb) { onlyA += 1; continue; }
    const from = classify(ca.status); const to = classify(cb.status);
    const t = `${from}->${to}`;
    transitions.set(t, (transitions.get(t) || 0) + 1);
    const s = perStudent.get(ca.page) || { dCorrect: 0, dWrong: 0, dBlank: 0 };
    s.dCorrect += (to === 'correct') - (from === 'correct');
    s.dWrong += (to === 'wrong') - (from === 'wrong');
    s.dBlank += (to === 'blank') - (from === 'blank');
    perStudent.set(ca.page, s);
    if (from !== to || ca.got !== cb.got) {
      changed.push(`  p${ca.page} ${ca.field.padEnd(18)} ${ca.status}(${ca.got}) -> ${cb.status}(${cb.got})`);
    }
  }

  const rng = mulberry32(seed);
  const students = [...perStudent.keys()].sort((x, y) => x - y);
  const dC = students.map((p) => perStudent.get(p).dCorrect);
  const dW = students.map((p) => perStudent.get(p).dWrong);
  const dB = students.map((p) => perStudent.get(p).dBlank);
  const total = (arr) => arr.reduce((x, y) => x + y, 0);

  console.log(`baseline : ${files[0]} (${a.size} cells)`);
  console.log(`candidate: ${files[1]} (${b.size} cells)`);
  if (onlyA || onlyB) console.log(`unpaired cells: only-in-baseline ${onlyA}, only-in-candidate ${onlyB}`);
  console.log(`students paired: ${students.length}`);
  console.log('');
  console.log('transitions (baseline -> candidate):');
  for (const [t, n] of [...transitions.entries()].sort((x, y) => y[1] - x[1])) {
    if (!t.startsWith(t.split('->')[1] + '->')) console.log(`  ${t.padEnd(18)} ${n}`);
    else console.log(`  ${t.padEnd(18)} ${n}   (unchanged)`);
  }
  console.log('');
  console.log(`Δcorrect total ${total(dC)}, Δwrong total ${total(dW)}, Δblank total ${total(dB)}`);
  for (const [label, arr] of [['Δcorrect', dC], ['Δwrong', dW], ['Δblank', dB]]) {
    const bs = bootstrapMean(arr, boot, rng);
    const p = signTestP(arr);
    const per = students.length;
    console.log(`  ${label.padEnd(9)} per-student mean ${bs.mean.toFixed(3)}  95% CI [${bs.lo.toFixed(3)}, ${bs.hi.toFixed(3)}]`
      + `  => total CI [${(bs.lo * per).toFixed(1)}, ${(bs.hi * per).toFixed(1)}]  sign-test p=${p.toFixed(3)}`);
  }
  console.log('');
  console.log('verdict aids:');
  const wrongUp = total(dW) > 0;
  const ciCorrect = bootstrapMean(dC, boot, mulberry32(seed + 1));
  console.log(`  wrong increased: ${wrongUp ? 'YES -> reject (§5.4)' : 'no'}`);
  console.log(`  correct CI excludes 0: ${ciCorrect.lo > 0 || ciCorrect.hi < 0 ? 'YES (effect beyond re-feed noise at this sample)' : 'no (neutral or unmeasurable at 19 students)'}`);
  if (total(dW) < 0 && total(dB) > 0) {
    console.log(`  blank-per-wrong-removed: ${(total(dB) / -total(dW)).toFixed(1)} (limit 10, §5.4 exception)`);
  }
  console.log('');
  console.log(`changed cells (${changed.length}):`);
  for (const line of changed) console.log(line);
}

main();
