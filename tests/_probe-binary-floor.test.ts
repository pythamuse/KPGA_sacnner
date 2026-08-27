import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round. Feeds M3's two constant choices:
 *
 * (a) the binary-question floor for photo-provenance sheets: for every
 *     satisfaction q02..q06 across the 19 photo students, the winner score,
 *     the gate outcome, and whether the key agrees -- so the floor is cut
 *     between the score of real marks and the score of the three noise passes,
 *     not guessed;
 * (b) p5 q10's full box inks -- the off-row band the current constants missed.
 */
const CAGI_DIR = process.env.PHOTO_CAGI_DIR;
const SAT_DIR = process.env.PHOTO_SAT_DIR;
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'binary-floor.txt');
const KEY_PATH = path.join(process.cwd(), 'local-scans', 'answer-key.json');
const BINARY_FIELDS = ['satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06'];

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));

describe.skipIf(!CAGI_DIR || !SAT_DIR)('binary floor probe', () => {
  it('collects winner scores for binary questions plus p5 q10 boxes', async () => {
    const cagiFiles = listImages(CAGI_DIR!).map((f) => path.join(CAGI_DIR!, f));
    const satFiles = listImages(SAT_DIR!).map((f) => path.join(SAT_DIR!, f));
    const key = (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages: Array<Record<string, unknown>> }).pages;

    process.env.MARK_DECISION_TRACE = '1';
    const lines: string[] = [];
    for (let i = 0; i < Math.min(cagiFiles.length, satFiles.length); i += 1) {
      const captured: string[] = [];
      const realInfo = console.info;
      console.info = (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[marks ')) { captured.push(first); return; }
        (realInfo as (...a: unknown[]) => void)(...args);
      };
      let flat: Record<string, unknown> = {};
      try {
        const draft = await recognizeStudentForms(cagiFiles[i], satFiles[i], {
          cagiPhotoProvenance: true,
          satisfactionPhotoProvenance: true,
        }) as unknown as Record<string, unknown>;
        flat = Object.fromEntries(Object.entries((draft.satisfaction || {}) as object)
          .map(([k, v]) => [`satisfaction.${k}`, v]));
      } finally {
        console.info = realInfo;
      }
      const keyRow = key[i] || {};
      for (const trace of captured) {
        const field = /field=([\w.]+)/.exec(trace)?.[1];
        if (!field) continue;
        if (BINARY_FIELDS.includes(field)) {
          const outcome = /outcome=(\w+)/.exec(trace)?.[1];
          const scores = (/scores=([0-9./]+)/.exec(trace)?.[1] || '').split('/').map(Number);
          const want = keyRow[field];
          const got = flat[field];
          const verdict = want === undefined ? '?' : want === null
            ? (got != null && got !== '' ? 'BLANK-VIOLATION' : 'blank-ok')
            : got == null || got === '' ? 'left-blank'
              : String(got) === String(want) ? 'CORRECT' : 'WRONG';
          lines.push(`p${String(i + 1).padStart(2)} ${field} outcome=${outcome} win=${scores[0]?.toFixed(3)} gap=${(scores[0] - (scores[1] ?? 0)).toFixed(3)} want=${want === null ? '-' : want} got=${got ?? '-'} ${verdict}`);
        }
        const outcomeAll = /outcome=(\w+)/.exec(trace)?.[1];
        if (outcomeAll === 'high') {
          const inks = (trace.split('boxes=[')[1] || '').split(' | ')
            .map((b) => /page=([0-9.]+)/.exec(b)).filter(Boolean).map((m) => Number(m![1]));
          if (inks.length >= 4) {
            const voids = inks.filter((v) => v <= 0.005).length;
            const minNonVoid = Math.min(...inks.filter((v) => v > 0.005));
            lines.push(`HIGHROW p${i + 1} ${field} n=${inks.length} voids=${voids} minNonVoid=${Number.isFinite(minNonVoid) ? minNonVoid.toFixed(3) : '-'} inks=${inks.map((v) => v.toFixed(3)).join('/')}`);
          }
        }
        if (field === 'satisfaction.q10' && (i + 1 === 5 || i + 1 === 4)) {
          const boxes = (trace.split('boxes=[')[1] || '').split(' | ')
            .map((b) => /^(\d+)@([0-9.]+):scr=([0-9.]+) page=([0-9.]+)/.exec(b))
            .filter(Boolean)
            .map((m) => `pos${m![1]}@${m![2]} scr=${m![3]} ink=${m![4]}`);
          lines.push(`p${i + 1} q10 BOXES: ${boxes.join(' | ')}  refused=${/refused=([\w,-]+)/.exec(trace)?.[1]}`);
        }
      }
    }
    const text = lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(text);
    fs.writeFileSync(OUT, text, 'utf8');
  }, 3_600_000);
});
