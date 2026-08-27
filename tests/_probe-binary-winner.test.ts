import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round. M4 cycle 2's instrumentation.
 *
 * With the affine tone map armed, binary satisfaction questions produced six
 * wrong values where the OTHER box won outright (got 0, key says 1), and §13.1
 * showed no floor can separate them: the correct reads' winning scores
 * (0.043-0.226) and the wrong ones' (0.044-0.154) interleave completely.
 *
 * A floor asks "is the winner strong enough". The question a wrong winner
 * needs is different: "does the winner look like a mark, or like the loser
 * with slightly more noise on it". So dump BOTH boxes of every auto-filled
 * binary group, with every per-box feature the trace carries, and let the
 * comparison say whether any of them separates the two populations. If none
 * does, the honest answer is that binary questions cannot be auto-filled from
 * these photographs, and the fix is a refusal rather than a better rule.
 *
 *   MARK_AFFINE_TONE=1 PHOTO_CAGI_DIR=... PHOTO_SAT_DIR=... \
 *     npx vitest run tests/_probe-binary-winner.test.ts
 */

const CAGI_DIR = process.env.PHOTO_CAGI_DIR;
const SAT_DIR = process.env.PHOTO_SAT_DIR;
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'binary-winner.jsonl');
const KEY_PATH = path.join(process.cwd(), 'local-scans', 'answer-key.json');

/** q02..q06 are the two-choice questions; q07..q10 carry five. */
const BINARY = ['satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06'];

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));

function num(source: string, re: RegExp): number | null {
  const m = re.exec(source);
  return m ? Number(m[1]) : null;
}

/** Every per-box feature the trace prints, for one `boxes=[...]` entry. */
function readBox(entry: string) {
  return {
    pos: num(entry, /^(\d+)@/),
    atX: num(entry, /^\d+@([0-9.]+)/),
    scr: num(entry, /scr=([0-9.]+)/),
    page: num(entry, / page=([0-9.]+)/),
    blank: num(entry, / blank=([0-9.]+)/),
    inner: num(entry, / inner=([0-9.]+)/),
    fit: num(entry, / fit=([0-9.]+)/),
    bal: num(entry, / bal=([0-9.]+)/),
    edgeShare: num(entry, / edge=([0-9.]+)\//),
    edgeFraction: num(entry, / edge=[0-9.]+\/([0-9.]+)/),
    mscore: num(entry, / mscore=([0-9.]+)/),
    alignX: num(entry, / align=(-?[0-9.]+),/),
    alignY: num(entry, / align=-?[0-9.]+,(-?[0-9.]+)/),
    bcoreCore: num(entry, / bcore=([0-9.]+)\//),
    bcoreFill: num(entry, / bcore=[0-9.]+\/([0-9.]+)/),
    sharpPage: num(entry, / sharp=([0-9.]+),/),
    sharpBlank: num(entry, / sharp=[0-9.]+,([0-9.]+)/),
  };
}

describe.skipIf(!CAGI_DIR || !SAT_DIR)('binary winner probe', () => {
  it('dumps both boxes of every auto-filled binary group', async () => {
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
      const sat = Object.fromEntries(Object.entries((draft.satisfaction || {}) as object)
        .map(([k, v]) => [`satisfaction.${k}`, v]));
      const keyRow = key[i] || {};

      for (const trace of captured) {
        const field = /field=([\w.]+)/.exec(trace)?.[1];
        if (!field || !BINARY.includes(field)) continue;
        const want = keyRow[field];
        const got = sat[field];
        const filled = source[field] === 'auto' && got != null && got !== '';
        if (!filled || want === undefined || want === null) continue;

        const boxes = (trace.split('boxes=[')[1] || '').replace(/\]$/, '').split(' | ').map(readBox);
        records.push(JSON.stringify({
          student: i + 1,
          field,
          want: String(want),
          got: String(got),
          verdict: String(got) === String(want) ? 'CORRECT' : 'WRONG',
          tone: /tone=(\w+\([^)]*\))/.exec(trace)?.[1] ?? null,
          gap: num(trace, /gap=([0-9.]+)\//),
          boxes,
        }));
      }
    }

    fs.writeFileSync(OUT, records.join('\n'), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${records.length} auto-filled binary groups to ${OUT}`);
  }, 3_600_000);
});
