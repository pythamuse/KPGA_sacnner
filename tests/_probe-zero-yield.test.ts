import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round. M4's instrumentation step.
 *
 * Eleven of nineteen photo students auto-fill nothing at all, and V-C's
 * two-stream geometry -- commissioned for exactly them -- moved none of them.
 * Before proposing a second fix, find out where their cells actually die:
 *
 *  - which refusal reason dominates for a zero-yield student versus a
 *    productive one (geometry? signal floor? shape? contrast?);
 *  - HOW FAR below each threshold they sit. A field at 0.85x its floor is a
 *    different problem from one at 0.05x -- the first says the signal is nearly
 *    there, the second says it is absent. That distinction decides whether the
 *    next round works on the image or on the scorer;
 *  - which grid stream V-C picked per sheet, and how many fields it found, so
 *    a geometry explanation can be confirmed or killed outright.
 *
 * Reads the key only to label students, never to steer anything.
 */

const CAGI_DIR = process.env.PHOTO_CAGI_DIR;
const SAT_DIR = process.env.PHOTO_SAT_DIR;
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'zero-yield.txt');
const KEY_PATH = path.join(process.cwd(), 'local-scans', 'answer-key.json');

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));

/** have side of a `name=have/need(x)` trace pair. */
function ratioOf(trace: string, name: string): number | null {
  const m = new RegExp(`(?:^|[ \\[])${name}=([0-9.]+)/([0-9.]+)\\(([0-9.]+)x\\)`).exec(trace);
  return m ? Number(m[3]) : null;
}

describe.skipIf(!CAGI_DIR || !SAT_DIR)('zero-yield probe', () => {
  it('locates where the dark-floor students lose their cells', async () => {
    const cagiFiles = listImages(CAGI_DIR!).map((f) => path.join(CAGI_DIR!, f));
    const satFiles = listImages(SAT_DIR!).map((f) => path.join(SAT_DIR!, f));
    const key = (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as {
      pages: Array<Record<string, unknown>>;
    }).pages;

    process.env.MARK_DECISION_TRACE = '1';
    type Row = {
      student: number; field: string; refused: string; base: number; cells: number;
      n: number; best: number; floorX: number | null; gapX: number | null; contrastX: number | null;
      keyed: boolean; filled: boolean;
    };
    const rows: Row[] = [];
    const boxLines: string[] = [];
    const sheets: string[] = [];

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

      const diag = (draft.recognitionCropDiagnostic || {}) as Record<string, string>;
      sheets.push(`p${i + 1} cagi[${diag['sheet.cagi'] ?? '-'}] sat[${diag['sheet.satisfaction'] ?? '-'}]`);

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
        const scores = (/scores=([0-9./]+)/.exec(trace)?.[1] || '').split('/').map(Number);
        // Winner box for the cells the key says carry a mark: a zero score can
        // mean "no ink found" or "ink found, but the blank template has just as
        // much", and those two want different fixes.
        if (process.env.BOXES_OUT && keyRow[field] !== undefined && keyRow[field] !== null) {
          const winner = (trace.split('boxes=[')[1] || '').split(' | ')[0] || '';
          boxLines.push(`${i + 1}|${field}|${winner.slice(0, 200)}`);
        }
        rows.push({
          student: i + 1,
          field,
          refused: /refused=([\w,:.-]+)/.exec(trace)?.[1] || 'none',
          base: Number(/base=(\d)/.exec(trace)?.[1] ?? 0),
          cells: Number(/cells=(\d)/.exec(trace)?.[1] ?? 0),
          n: Number(/n=(\d+)/.exec(trace)?.[1] ?? 0),
          best: scores[0] ?? 0,
          floorX: ratioOf(trace, 'floor'),
          gapX: ratioOf(trace, 'gap'),
          contrastX: ratioOf(trace, 'contrast'),
          keyed: keyRow[field] !== undefined && keyRow[field] !== null,
          filled: source[field] === 'auto' && flat[field] != null && flat[field] !== '',
        });
      }
    }

    // Productive vs zero-yield, decided by what the run actually produced.
    const filledByStudent = new Map<number, number>();
    rows.forEach((r) => filledByStudent.set(r.student, (filledByStudent.get(r.student) ?? 0) + (r.filled ? 1 : 0)));
    const zero = new Set([...filledByStudent].filter(([, n]) => n === 0).map(([s]) => s));

    const lines: string[] = ['================ ZERO-YIELD PROBE ================'];
    lines.push(`zero-yield students: ${[...zero].join(',')} (${zero.size})`);
    lines.push('');
    lines.push('--- grid stream chosen per sheet (V-C diagnostic) ---');
    sheets.forEach((s) => lines.push(`  ${s}`));

    const census = (subset: Row[], label: string) => {
      const keyed = subset.filter((r) => r.keyed);
      const counts = new Map<string, number>();
      keyed.forEach((r) => r.refused.split(',').forEach((reason) => {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }));
      lines.push('');
      lines.push(`--- ${label}: ${keyed.length} keyed cells ---`);
      [...counts].sort((a, b) => b[1] - a[1]).forEach(([reason, n]) => {
        lines.push(`  ${reason.padEnd(28)} ${String(n).padStart(4)}  (${((n / keyed.length) * 100).toFixed(0)}%)`);
      });
      const withFloor = keyed.map((r) => r.floorX).filter((v): v is number => v !== null).sort((a, b) => a - b);
      if (withFloor.length) {
        const q = (p: number) => withFloor[Math.floor(withFloor.length * p)].toFixed(2);
        lines.push(`  floor ratio (have/need):  min ${withFloor[0].toFixed(2)}  p25 ${q(0.25)}  med ${q(0.5)}  p75 ${q(0.75)}  max ${withFloor[withFloor.length - 1].toFixed(2)}`);
        lines.push(`    at/above 1.0x: ${withFloor.filter((v) => v >= 1).length}   0.5-1.0x: ${withFloor.filter((v) => v >= 0.5 && v < 1).length}   below 0.5x: ${withFloor.filter((v) => v < 0.5).length}`);
      }
      const baseless = keyed.filter((r) => r.base === 0).length;
      const cellless = keyed.filter((r) => r.cells === 0).length;
      lines.push(`  no template baseline (base=0): ${baseless}   no grid cells (cells=0): ${cellless}`);
    };

    census(rows.filter((r) => zero.has(r.student)), 'ZERO-YIELD students');
    census(rows.filter((r) => !zero.has(r.student)), 'PRODUCTIVE students');

    // Raw rows for cross-tabulation: the aggregate cannot answer whether a
    // cell refused at grid verification ALSO lacked signal, and that is the
    // question the next round turns on.
    if (process.env.BOXES_OUT) {
      fs.writeFileSync(process.env.BOXES_OUT, boxLines.join('\n'), 'utf8');
    }
    if (process.env.ROWS_OUT) {
      fs.writeFileSync(process.env.ROWS_OUT, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
    }

    const text = lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(text);
    fs.writeFileSync(OUT, text, 'utf8');
  }, 3_600_000);
});
