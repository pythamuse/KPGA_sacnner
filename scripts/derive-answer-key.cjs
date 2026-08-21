#!/usr/bin/env node
/**
 * Builds an answer key from the two workbooks a reviewer has already checked.
 *
 * The hand-made key covers 6 of 19 students, and the pages where recognition
 * fails worst sit outside it -- so changes aimed at them cannot be judged.
 * A completed review is ground truth for 21 of the 23 fields, so read it
 * back rather than transcribing 19 forms by hand.
 *
 * What it CANNOT recover: a cell the student left unmarked. Saving requires
 * every field to hold a valid value (validateStudent), so the reviewer had to
 * enter something there, and the workbook cannot say which entries were
 * inventions. Those cells are exactly the ones the key marks null to mean
 * "any auto-filled value is WRONG" -- the guard that keeps WRONG at 0. They
 * have to be named separately; --unmarked does that.
 *
 *   node scripts/derive-answer-key.cjs <cagi.xlsx> <satisfaction.xlsx> <out.json>
 *     [--students N] [--unmarked p3:basic.gender,p3:satisfaction.q01]
 *     [--compare local-scans/answer-key.json]
 */
const path = require('path');
const fs = require('fs');

const CAGI_COLUMNS = { 'basic.age': 'A', 'basic.gender': 'B', 'basic.schoolType': 'C', 'basic.grade': 'D' };
'123456789'.split('').forEach((n, i) => { CAGI_COLUMNS[`cagi.q0${n}`] = String.fromCharCode(69 + i); });
const SAT_COLUMNS = {};
for (let i = 1; i <= 10; i += 1) {
  SAT_COLUMNS[`satisfaction.q${String(i).padStart(2, '0')}`] = String.fromCharCode(69 + i - 1);
}
const NUMERIC = new Set(['basic.age', ...Object.keys(CAGI_COLUMNS).filter((k) => k.startsWith('cagi.')), ...Object.keys(SAT_COLUMNS)]);

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')
    ? process.argv[idx + 1]
    : fallback;
}

async function main() {
  const [cagiPath, satPath, outPath] = process.argv.slice(2).filter((a) => !a.startsWith('--')).slice(0, 3);
  if (!cagiPath || !satPath || !outPath) {
    console.error('usage: node scripts/derive-answer-key.cjs <cagi.xlsx> <satisfaction.xlsx> <out.json> [--students N] [--unmarked p3:basic.gender,...] [--compare key.json]');
    process.exit(2);
  }
  if (fs.existsSync(outPath)) {
    console.error(`refusing to overwrite ${outPath} -- name a path that does not exist yet`);
    process.exit(2);
  }

  const ExcelJS = require('exceljs');
  const read = async (file, sheetName) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const sheet = wb.getWorksheet(sheetName) || wb.worksheets[0];
    if (!sheet) throw new Error(`no worksheet in ${file}`);
    return sheet;
  };
  const cagiSheet = await read(cagiPath, '청소년도박문제선별검사');
  const satSheet = await read(satPath, '청소년예방교육만족도');

  const unmarked = new Set(
    (arg('unmarked', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^p/, '')),
  );

  const cell = (sheet, col, row) => {
    const value = sheet.getCell(`${col}${row}`).value;
    if (value === null || value === undefined || value === '') return null;
    return typeof value === 'object' && 'result' in value ? value.result : value;
  };

  // Trust the sheet's own extent rather than a count the caller guessed at.
  const declared = Number(arg('students', 0));
  const pages = [];
  const blankRows = [];
  for (let index = 0; ; index += 1) {
    const row = 3 + index;
    if (declared > 0 && index >= declared) break;
    const probe = cell(cagiSheet, 'A', row);
    if (declared <= 0 && probe === null) break;
    const page = { page: index + 1 };
    let filled = 0;
    const put = (sheet, columns) => {
      Object.entries(columns).forEach(([field, col]) => {
        if (unmarked.has(`${index + 1}:${field}`)) { page[field] = null; return; }
        const raw = cell(sheet, col, row);
        if (raw === null) { page[field] = null; return; }
        filled += 1;
        page[field] = NUMERIC.has(field) ? Number(raw) : String(raw).trim();
      });
    };
    put(cagiSheet, CAGI_COLUMNS);
    put(satSheet, SAT_COLUMNS);
    if (filled === 0) { blankRows.push(row); if (declared <= 0) break; }
    pages.push(page);
  }

  const out = {
    _note: 'Ground truth read from the scanned forms. Student responses - never commit.',
    _null: 'null means the form itself carries no mark: any auto-filled value is WRONG.',
    _derivedFrom: `${path.basename(cagiPath)} + ${path.basename(satPath)} (reviewer-verified)`,
    pages,
  };

  // A derived key that disagrees with the hand-made one is the interesting
  // case: either the mapping here is wrong or a reviewer let something
  // through. Say so instead of quietly replacing the old numbers.
  const comparePath = arg('compare', 'local-scans/answer-key.json');
  if (comparePath && fs.existsSync(comparePath)) {
    const existing = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    let same = 0;
    const diffs = [];
    existing.pages.forEach((old) => {
      const fresh = pages.find((p) => p.page === old.page);
      if (!fresh) return;
      Object.keys(old).filter((k) => k !== 'page').forEach((field) => {
        const a = old[field];
        const b = fresh[field];
        if (String(a) === String(b)) same += 1;
        else diffs.push(`  p${old.page} ${field.padEnd(18)} key=${String(a).padEnd(8)} excel=${String(b)}`);
      });
    });
    console.log(`compared against ${comparePath}: ${same} agree, ${diffs.length} differ`);
    if (diffs.length) {
      console.log(diffs.join('\n'));
      console.log('\nresolve these before trusting the derived key.');
    }
  }

  if (blankRows.length) console.log(`skipped empty rows: ${blankRows.join(', ')}`);
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  const nulls = pages.reduce((sum, p) => sum + Object.values(p).filter((v) => v === null).length, 0);
  console.log(`wrote ${outPath}: ${pages.length} pages, ${nulls} cells marked unmarked`);
  if (nulls === 0) {
    console.log('WARNING: no unmarked cells. A batch with genuinely blank boxes needs --unmarked,');
    console.log('or the key will bless whatever the reviewer entered there and stop protecting WRONG=0.');
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
