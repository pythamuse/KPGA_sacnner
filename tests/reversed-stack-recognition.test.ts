import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';
import { matchBatch, type StackOrder } from '../src/lib/recognition/batchMatcher';

/**
 * Does the reversal flag actually re-pair a reversed back stack?
 *
 * What this measures is ASSIGNMENT, not recognition. A sheet is rendered and
 * read the same way whichever student it ends up under, so reversing cannot
 * make recognition better or worse -- it only decides which key row a sheet is
 * checked against. Counts below are "the sheet assigned to student i agrees
 * with key row i", and a low count means sheets landed on the wrong students.
 *
 * Scoring the reversed set with the flag on is only half an argument, because
 * a stack that was never reversed would also land correctly under `same`. The
 * flag is only shown to do something if it ALSO misassigns the sets that are
 * in forward order. Hence both settings on every set, and a diagonal.
 *
 * One screening stack is used as the front for every run, so the only thing
 * varying is which satisfaction sheet is paired with it. Each satisfaction page
 * is recognised once and the pairing `matchBatch` returns decides which student
 * it belongs to, which is the arithmetic under test.
 *
 *   REAL_SCAN_CAGI_PDF="cagi.pdf" \
 *   SAT_SETS="sat1.pdf|sat2.pdf|sat3-reversed.pdf" \
 *   REAL_SCAN_PAGES=19 npx vitest run tests/reversed-stack-recognition.test.ts
 *
 * Real scans carry student responses and are NEVER committed.
 */

const CAGI_PDF = process.env.REAL_SCAN_CAGI_PDF;
const SAT_SETS = (process.env.SAT_SETS || '').split('|').filter(Boolean);
const PAGES = Number(process.env.REAL_SCAN_PAGES || 19);
const RENDER = PDF_RENDER_OPTIONS[0];
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'reversed-check.txt');
const KEY_PATH = process.env.REAL_SCAN_ANSWER_KEY
  || path.join(process.cwd(), 'local-scans', 'answer-key.json');

const SAT_FIELDS = Array.from({ length: 10 }, (_, i) => `satisfaction.q${String(i + 1).padStart(2, '0')}`);

async function renderPdfPages(pdfPath: string, outDir: string, label: string) {
  const { createCanvas, Image, ImageData } = await import('canvas');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  class NodeCanvasFactory {
    create(width: number, height: number) {
      const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(cc: { canvas: { width: number; height: number } }, width: number, height: number) {
      cc.canvas.width = Math.max(1, width);
      cc.canvas.height = Math.max(1, height);
    }
    destroy(cc: { canvas: unknown; context: unknown }) {
      cc.canvas = null;
      cc.context = null;
    }
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.ImageData = g.ImageData || ImageData;
  g.Image = g.Image || Image;

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    isEvalSupported: false, useSystemFonts: true, CanvasFactory: NodeCanvasFactory,
  }).promise;

  const files: string[] = [];
  for (let n = 1; n <= Math.min(PAGES, doc.numPages); n += 1) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: RENDER.scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const file = path.join(outDir, `${label}-p${n}.jpg`);
    fs.writeFileSync(file, canvas.toBuffer('image/jpeg', { quality: RENDER.quality }));
    files.push(file);
  }
  return files;
}

/** satisfaction field -> value, `null` where the run did not auto-fill it. */
type Filled = Record<string, string | null>;

function readSatisfaction(draft: Record<string, unknown>): Filled {
  const source = (draft.recognitionValueSource || {}) as Record<string, string>;
  const values = (draft.satisfaction || {}) as Record<string, unknown>;
  const out: Filled = {};
  for (const field of SAT_FIELDS) {
    const key = field.slice('satisfaction.'.length);
    out[field] = source[field] === 'auto' && values[key] != null && values[key] !== ''
      ? String(values[key])
      : null;
  }
  return out;
}

describe.skipIf(!CAGI_PDF || SAT_SETS.length === 0)('reversed back stack', () => {
  it('checks which student each satisfaction sheet lands on, under both orders', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-reversed-'));
    const key = fs.existsSync(KEY_PATH)
      ? (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages: Array<Record<string, unknown>> }).pages
      : undefined;

    const cagiFiles = await renderPdfPages(CAGI_PDF!, tmp, 'cagi');

    // Recognise each satisfaction page once, indexed by the page it came from.
    // Which student it belongs to is decided afterwards, by matchBatch.
    const bySet: Array<{ label: string; files: string[]; byFile: Map<string, Filled> }> = [];
    for (let s = 0; s < SAT_SETS.length; s += 1) {
      const files = await renderPdfPages(SAT_SETS[s], tmp, `sat${s}`);
      const byFile = new Map<string, Filled>();
      for (let i = 0; i < files.length; i += 1) {
        const draft = await recognizeStudentForms(cagiFiles[i], files[i]);
        byFile.set(files[i], readSatisfaction(draft as unknown as Record<string, unknown>));
      }
      bySet.push({ label: path.basename(SAT_SETS[s]), files, byFile });
    }

    const report: string[] = ['\n============== REVERSED BACK STACK =============='];
    report.push(`front stack: ${path.basename(CAGI_PDF!)}   students: ${cagiFiles.length}`);
    report.push('satisfaction fields only (10 per student).');
    report.push('agrees/disagrees = does the sheet assigned to student i match key row i.');
    report.push('This is assignment, not recognition: the same sheet reads the same either way.');
    report.push('');
    report.push('  set                              order      auto   agrees  disagrees  blank-cell');
    const rows: Array<{ label: string; order: StackOrder; correct: number; wrong: number }> = [];

    for (const set of bySet) {
      for (const order of ['same', 'reversed'] as const) {
        const pairs = matchBatch(cagiFiles, set.files, order);
        let auto = 0, correct = 0, wrong = 0, violation = 0;
        pairs.forEach((pair, studentIndex) => {
          const values = set.byFile.get(pair.satisfactionPath)!;
          const row = key?.[studentIndex];
          for (const field of SAT_FIELDS) {
            const got = values[field];
            if (got == null) continue;
            auto += 1;
            if (!row) continue;
            const want = row[field];
            if (want === null) { violation += 1; wrong += 1; continue; }
            if (want === undefined) continue;
            if (String(want) === got) correct += 1; else wrong += 1;
          }
        });
        rows.push({ label: set.label, order, correct, wrong });
        report.push(`  ${set.label.padEnd(32)} ${order.padEnd(9)}`
          + ` ${String(auto).padStart(4)}  ${String(correct).padStart(7)}`
          + `  ${String(wrong).padStart(5)}  ${String(violation).padStart(10)}`);
      }
      report.push('');
    }

    report.push('--- reading ---');
    for (const set of bySet) {
      const same = rows.find((r) => r.label === set.label && r.order === 'same')!;
      const rev = rows.find((r) => r.label === set.label && r.order === 'reversed')!;
      const setting = same.correct > rev.correct ? 'same' : 'reversed';
      report.push(`  ${set.label.padEnd(32)} lands on the right students under "${setting}"`
        + `  (same ${same.correct}/${same.correct + same.wrong},`
        + ` reversed ${rev.correct}/${rev.correct + rev.wrong})`);
    }
    report.push('');
    report.push('A flag that did nothing would leave both columns equal. Neither column is a');
    report.push('recognition score, and the two are not comparable across sets: those come');
    report.push('from different scans and differ for reasons that have nothing to do with');
    report.push('the order. Only the two columns of one row may be compared.');

    // eslint-disable-next-line no-console
    console.log(report.join('\n'));
    fs.writeFileSync(OUT, report.join('\n'), 'utf8');
  }, 5_400_000);
});
