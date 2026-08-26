import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * The photo path has never been scored against the key. Grid-field counts said
 * the coordinate frame stands; they say nothing about whether the values are
 * right, and `WRONG = 0` is the condition that outranks the correct count.
 *
 * The photos are the same students in the same order as the scan set, so
 * `local-scans/answer-key.json` pages 1..N apply directly. A cell the key marks
 * `null` must come back blank -- filling one is a failure however the total
 * moves (CLAUDE.md §3).
 *
 *   PHOTO_CAGI_DIR=... PHOTO_SAT_DIR=... npx vitest run tests/_probe-photo-accuracy.test.ts
 */

const CAGI_DIR = process.env.PHOTO_CAGI_DIR;
const SAT_DIR = process.env.PHOTO_SAT_DIR;
const LABEL = process.env.PHOTO_LABEL || 'photos';
// Lets a subset of students be scored against their real key rows -- only one
// pair warped on both sides, and its key row is page 2, not page 1.
const KEY_OFFSET = Number(process.env.PHOTO_KEY_OFFSET || 0);
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'photo-accuracy.txt');
const KEY_PATH = process.env.REAL_SCAN_ANSWER_KEY
  || path.join(process.cwd(), 'local-scans', 'answer-key.json');

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort();

describe.skipIf(!CAGI_DIR || !SAT_DIR)('photo accuracy probe', () => {
  it('scores recognised photo values against the answer key', async () => {
    const cagiFiles = listImages(CAGI_DIR!).map((f) => path.join(CAGI_DIR!, f));
    const satFiles = listImages(SAT_DIR!).map((f) => path.join(SAT_DIR!, f));
    const key = (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as {
      pages: Array<Record<string, unknown>>;
    }).pages;

    const lines: string[] = [`============ PHOTO ACCURACY: ${LABEL} ============`];
    lines.push(`${cagiFiles.length} cagi / ${satFiles.length} satisfaction`);
    lines.push('');

    let correct = 0;
    let wrong = 0;
    let blankLeft = 0;
    const wrongRows: string[] = [];
    const blankViolations: string[] = [];

    const pairs = Math.min(cagiFiles.length, satFiles.length);
    for (let i = 0; i < pairs; i += 1) {
      const draft = await recognizeStudentForms(cagiFiles[i], satFiles[i]) as unknown as Record<string, unknown>;
      const source = (draft.recognitionValueSource || {}) as Record<string, string>;
      const flat: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries((draft.basic || {}) as object).map(([k, v]) => [`basic.${k}`, v])),
        ...Object.fromEntries(Object.entries((draft.cagi || {}) as object).map(([k, v]) => [`cagi.${k}`, v])),
        ...Object.fromEntries(Object.entries((draft.satisfaction || {}) as object).map(([k, v]) => [`satisfaction.${k}`, v])),
      };
      const keyRow = key[i + KEY_OFFSET];
      if (!keyRow) continue;

      let studentCorrect = 0;
      let studentWrong = 0;
      let studentBlank = 0;
      for (const [field, want] of Object.entries(keyRow)) {
        if (field === 'page') continue;
        const value = flat[field];
        const autoFilled = source[field] === 'auto' && value != null && value !== '';

        if (want === null) {
          // The key says this cell is unmarked. Filling it is the failure the
          // whole gate exists to prevent -- a reviewer's blank is one keystroke,
          // a wrong value is stored as if a human confirmed it.
          if (autoFilled) {
            blankViolations.push(`p${i + 1} ${field} filled "${String(value)}"`);
            studentWrong += 1;
          }
          continue;
        }
        if (!autoFilled) { studentBlank += 1; continue; }
        if (String(want) === String(value)) studentCorrect += 1;
        else {
          studentWrong += 1;
          wrongRows.push(`p${i + 1} ${field} got "${String(value)}" want "${String(want)}"`);
        }
      }

      correct += studentCorrect;
      wrong += studentWrong;
      blankLeft += studentBlank;
      lines.push(`p${i + 1}  ${path.basename(cagiFiles[i])} + ${path.basename(satFiles[i])}`
        + `  -> key p${i + KEY_OFFSET + 1}   CORRECT ${studentCorrect}  WRONG ${studentWrong}  left-blank ${studentBlank}`);
    }

    lines.push('');
    lines.push(`TOTAL  CORRECT ${correct}   WRONG ${wrong}   left-blank ${blankLeft}`);
    if (blankViolations.length) {
      lines.push('');
      lines.push(`BLANK-CELL VIOLATIONS (${blankViolations.length}):`);
      blankViolations.forEach((v) => lines.push(`  ${v}`));
    }
    if (wrongRows.length) {
      lines.push('');
      lines.push(`WRONG VALUES (${wrongRows.length}):`);
      wrongRows.forEach((v) => lines.push(`  ${v}`));
    }

    const text = lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(text);
    fs.writeFileSync(OUT, text, 'utf8');
  }, 3_600_000);
});
