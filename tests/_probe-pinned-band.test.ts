import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * The last wrong value under the affine map (`p17 cagi.q01`) has every one of
 * its four candidates pinned at the alignment search radius, and the box the
 * key calls correct was emptied by the total-ink guard while a neighbour won.
 * "The search ran out of room on every box" is a statement about the band, not
 * about any one mark, so it is a candidate refusal -- but only if it is rare
 * among the cells that come out right.
 *
 * Counts, for every auto-filled group, how many of its candidates are pinned,
 * beside the key's verdict. If all-pinned is common among correct reads the
 * signature is worthless and this round ends with the map still behind its
 * flag.
 *
 *   MARK_AFFINE_TONE=1 PHOTO_CAGI_DIR=... PHOTO_SAT_DIR=... \
 *     npx vitest run tests/_probe-pinned-band.test.ts
 */

const CAGI_DIR = process.env.PHOTO_CAGI_DIR;
const SAT_DIR = process.env.PHOTO_SAT_DIR;
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'pinned-band.jsonl');
const KEY_PATH = path.join(process.cwd(), 'local-scans', 'answer-key.json');

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));

describe.skipIf(!CAGI_DIR || !SAT_DIR)('pinned band probe', () => {
  it('counts pinned alignments per auto-filled group', async () => {
    const cagiFiles = listImages(CAGI_DIR!).map((f) => path.join(CAGI_DIR!, f));
    const satFiles = listImages(SAT_DIR!).map((f) => path.join(SAT_DIR!, f));
    const key = (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as {
      pages: Array<Record<string, unknown>>;
    }).pages;

    process.env.MARK_DECISION_TRACE = '1';
    const records: string[] = [];

    for (let i = 0; i < Math.min(cagiFiles.length, satFiles.length); i += 1) {
      const captured: string[] = [];
      const realInfo = console.info;
      console.info = (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[marks ')) { captured.push(first); return; }
        (realInfo as (...a: unknown[]) => void)(...args);
      };
      let draft: Record<string, unknown> = {};
      try {
        draft = await recognizeStudentForms(cagiFiles[i], satFiles[i], {
          cagiPhotoProvenance: true,
          satisfactionPhotoProvenance: true,
        }) as unknown as Record<string, unknown>;
      } finally {
        console.info = realInfo;
      }

      const source = (draft.recognitionValueSource || {}) as Record<string, string>;
      const flat: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries((draft.basic || {}) as object).map(([k, v]) => [`basic.${k}`, v])),
        ...Object.fromEntries(Object.entries((draft.cagi || {}) as object).map(([k, v]) => [`cagi.${k}`, v])),
        ...Object.fromEntries(Object.entries((draft.satisfaction || {}) as object).map(([k, v]) => [`satisfaction.${k}`, v])),
      };
      const keyRow = key[i] || {};

      for (const trace of captured) {
        const field = /field=([\w.]+)/.exec(trace)?.[1];
        if (!field) continue;
        const want = keyRow[field];
        const got = flat[field];
        const filled = source[field] === 'auto' && got != null && got !== '';
        if (!filled || want === undefined || want === null) continue;

        // `align=x,y!` -- the trailing bang is set when the offset sits on the
        // edge of the search window, i.e. the search wanted to keep going.
        const entries = (trace.split('boxes=[')[1] || '').replace(/\]$/, '').split(' | ');
        const pins = entries.map((e) => / align=-?[0-9.]+,-?[0-9.]+!/.test(e));
        records.push(JSON.stringify({
          student: i + 1,
          field,
          candidates: entries.length,
          pinned: pins.filter(Boolean).length,
          allPinned: entries.length > 0 && pins.every(Boolean),
          verdict: String(got) === String(want) ? 'CORRECT' : 'WRONG',
        }));
      }
    }

    fs.writeFileSync(OUT, records.join('\n'), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${records.length} auto-filled groups to ${OUT}`);
  }, 3_600_000);
});
