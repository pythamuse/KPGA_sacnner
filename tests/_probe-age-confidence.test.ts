import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round. Calibrates AGE_OCR_MIN_CONFIDENCE.
 *
 * V-B records the confidence into the age decision trace on every path
 * (`[ageOcrConfidence=<n> photo=yes accepted=<bool>]`). This reads it back for
 * all 19 photo students beside the key, so the floor is cut between the
 * confidence of correct reads and the confidence of the wrong one instead of
 * being guessed.
 */
const CAGI_DIR = process.env.PHOTO_CAGI_DIR;
const SAT_DIR = process.env.PHOTO_SAT_DIR;
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'age-conf.txt');
const KEY_PATH = path.join(process.cwd(), 'local-scans', 'answer-key.json');

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));

describe.skipIf(!CAGI_DIR || !SAT_DIR)('age confidence probe', () => {
  it('reports age OCR confidence beside the key for every student', async () => {
    const cagiFiles = listImages(CAGI_DIR!).map((f) => path.join(CAGI_DIR!, f));
    const satFiles = listImages(SAT_DIR!).map((f) => path.join(SAT_DIR!, f));
    const key = (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages: Array<Record<string, unknown>> }).pages;

    const lines: string[] = [];
    for (let i = 0; i < Math.min(cagiFiles.length, satFiles.length); i += 1) {
      const draft = await recognizeStudentForms(cagiFiles[i], satFiles[i], {
        cagiPhotoProvenance: true,
        satisfactionPhotoProvenance: true,
      }) as unknown as Record<string, unknown>;
      const basic = (draft.basic || {}) as Record<string, unknown>;
      const trace = ((draft.recognitionDecisionTrace || {}) as Record<string, string>)['basic.age'] || '';
      const conf = /ageOcrConfidence=([0-9.]+|none)/.exec(trace)?.[1] ?? '?';
      const accepted = /accepted=(\w+)/.exec(trace)?.[1] ?? '?';
      const want = key[i]?.['basic.age'];
      const got = basic.age;
      const verdict = want === undefined ? '?'
        : got == null || got === '' ? 'left-blank'
          : String(got) === String(want) ? 'CORRECT' : 'WRONG';
      lines.push(`p${String(i + 1).padStart(2)} conf=${String(conf).padStart(6)} accepted=${accepted} want=${want ?? '-'} got=${got ?? '-'} ${verdict}`);
    }
    const text = lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(text);
    fs.writeFileSync(OUT, text, 'utf8');
  }, 3_600_000);
});
