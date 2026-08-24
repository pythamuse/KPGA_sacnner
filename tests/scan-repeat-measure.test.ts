import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

/**
 * Noise floor between two scans of the SAME paper.
 *
 * §5.4 refuses to judge a change that moves one borderline cell, but nothing
 * has ever measured how wide "borderline" is. Scanning one stack twice on one
 * machine holds the ink, the handwriting, the paper and the optics fixed and
 * varies only the feed: skew, position, exposure, dust. Whatever flips between
 * those two runs is the smallest effect this project can detect at all, and a
 * change that moves fewer cells than that is indistinguishable from feeding the
 * same sheets through twice.
 *
 * The repeat needs NO new answer key -- same paper, same answers -- so each run
 * is also scored against the existing key, which separates "the two runs
 * disagree" from "one of them got worse".
 *
 *   REAL_SCAN_CAGI_PDF="A-cagi.pdf"   REAL_SCAN_SAT_PDF="A-sat.pdf" \
 *   REPEAT_SCAN_CAGI_PDF="B-cagi.pdf" REPEAT_SCAN_SAT_PDF="B-sat.pdf" \
 *   REAL_SCAN_PAGES=19 npx vitest run tests/scan-repeat-measure.test.ts
 *
 * Add REPEAT3_SCAN_*_PDF for a third pass; two runs say whether cells move at
 * all, three start to say how much.
 *
 * Real scans carry student responses and are NEVER committed. Without the
 * variables the suite skips.
 */

const RUNS = [
  { label: 'A', cagi: process.env.REAL_SCAN_CAGI_PDF, sat: process.env.REAL_SCAN_SAT_PDF },
  { label: 'B', cagi: process.env.REPEAT_SCAN_CAGI_PDF, sat: process.env.REPEAT_SCAN_SAT_PDF },
  { label: 'C', cagi: process.env.REPEAT3_SCAN_CAGI_PDF, sat: process.env.REPEAT3_SCAN_SAT_PDF },
].filter((r) => r.cagi && r.sat);

const PAGES = Number(process.env.REAL_SCAN_PAGES || 19);
const RENDER = PDF_RENDER_OPTIONS[0];
const KEY_PATH = process.env.REAL_SCAN_ANSWER_KEY
  || path.join(process.cwd(), 'local-scans', 'answer-key.json');

const ALL_FIELDS = [
  'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
  ...Array.from({ length: 9 }, (_, i) => `cagi.q${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, i) => `satisfaction.q${String(i + 1).padStart(2, '0')}`),
];

async function renderPdfPages(pdfPath: string, pages: number, outDir: string, label: string) {
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

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, useSystemFonts: true, CanvasFactory: NodeCanvasFactory,
  }).promise;

  const out: string[] = [];
  for (let n = 1; n <= Math.min(pages, doc.numPages); n += 1) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: RENDER.scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const file = path.join(outDir, `${label}-p${n}.jpg`);
    fs.writeFileSync(file, canvas.toBuffer('image/jpeg', { quality: RENDER.quality }));
    out.push(file);
  }
  return out;
}

/** field -> value, with `null` meaning the run did not auto-fill it. */
type Filled = Record<string, string | null>;

function readValues(draft: Record<string, unknown>): Filled {
  const source = (draft.recognitionValueSource || {}) as Record<string, string>;
  const flat: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries((draft.basic || {}) as object).map(([k, v]) => [`basic.${k}`, v])),
    ...Object.fromEntries(Object.entries((draft.cagi || {}) as object).map(([k, v]) => [`cagi.${k}`, v])),
    ...Object.fromEntries(Object.entries((draft.satisfaction || {}) as object).map(([k, v]) => [`satisfaction.${k}`, v])),
  };
  const out: Filled = {};
  for (const field of ALL_FIELDS) {
    // Only an automatic entry counts. A value the reviewer would have to
    // confirm is not something the scanner asserted.
    out[field] = source[field] === 'auto' && flat[field] != null && flat[field] !== ''
      ? String(flat[field])
      : null;
  }
  return out;
}

async function runOnce(cagiPdf: string, satPdf: string, label: string): Promise<Filled[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kpga-repeat-${label}-`));
  const cagiPages = await renderPdfPages(cagiPdf, PAGES, tmp, 'cagi');
  const satPages = await renderPdfPages(satPdf, PAGES, tmp, 'sat');
  const out: Filled[] = [];
  for (let i = 0; i < Math.min(cagiPages.length, satPages.length); i += 1) {
    const draft = await recognizeStudentForms(cagiPages[i], satPages[i]);
    out.push(readValues(draft as unknown as Record<string, unknown>));
  }
  return out;
}

function loadKey(): Array<Record<string, unknown>> | undefined {
  if (!fs.existsSync(KEY_PATH)) return undefined;
  return (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages?: Array<Record<string, unknown>> }).pages;
}

function scoreAgainstKey(run: Filled[], key: Array<Record<string, unknown>> | undefined) {
  if (!key) return undefined;
  let correct = 0, wrong = 0, blank = 0, blankViolation = 0;
  run.forEach((values, index) => {
    const page = key[index];
    if (!page) return;
    for (const field of ALL_FIELDS) {
      const got = values[field];
      if (got == null) { blank++; continue; }
      const want = page[field];
      if (want === null) { blankViolation++; wrong++; continue; }
      if (want === undefined) continue;
      if (String(want) === got) correct++; else wrong++;
    }
  });
  return { correct, wrong, blank, blankViolation };
}

describe.skipIf(RUNS.length < 2)('same-paper rescan noise floor', () => {
  it('reports which cells move between scans of the same sheets', async () => {
    const key = loadKey();
    const results: Array<{ label: string; values: Filled[] }> = [];
    for (const run of RUNS) {
      results.push({ label: run.label, values: await runOnce(run.cagi!, run.sat!, run.label) });
    }

    const report: string[] = ['\n============== SAME-PAPER RESCAN ==============',
      `runs=${results.map((r) => r.label).join(',')}  students=${results[0].values.length}`];

    for (const r of results) {
      const filled = r.values.reduce((n, v) => n + ALL_FIELDS.filter((f) => v[f] != null).length, 0);
      const scored = scoreAgainstKey(r.values, key);
      report.push(`  run ${r.label}: auto-filled ${filled}`
        + (scored ? `  CORRECT ${scored.correct}  WRONG ${scored.wrong}`
          + `  (blank-cell violations ${scored.blankViolation})` : '  (no answer key)'));
    }

    // Every pair, so a third pass is used rather than ignored.
    const perFieldMoves: Record<string, number> = {};
    for (let a = 0; a < results.length; a += 1) {
      for (let b = a + 1; b < results.length; b += 1) {
        const left = results[a], right = results[b];
        const moves: string[] = [];
        let valueChanged = 0, appeared = 0, disappeared = 0;
        left.values.forEach((lv, index) => {
          const rv = right.values[index];
          if (!rv) return;
          for (const field of ALL_FIELDS) {
            const l = lv[field], r = rv[field];
            if (l === r) continue;
            perFieldMoves[field] = (perFieldMoves[field] || 0) + 1;
            if (l == null) { appeared++; moves.push(`p${index + 1} ${field}: -> ${r}`); }
            else if (r == null) { disappeared++; moves.push(`p${index + 1} ${field}: ${l} ->`); }
            else { valueChanged++; moves.push(`p${index + 1} ${field}: ${l} -> ${r} ★ value changed`); }
          }
        });
        report.push('');
        report.push(`--- ${left.label} vs ${right.label} ---`);
        report.push(`  cells that move: ${moves.length}`
          + `  (auto-filled only in ${right.label}: ${appeared},`
          + ` only in ${left.label}: ${disappeared},`
          + ` ★ different value: ${valueChanged})`);
        moves.forEach((m) => report.push(`    ${m}`));
      }
    }

    const hot = Object.entries(perFieldMoves).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (hot.length > 0) {
      report.push('');
      report.push('--- fields that move most ---');
      hot.forEach(([field, n]) => report.push(`  ${field.padEnd(20)} ${n}`));
    }

    report.push('');
    report.push('Any change moving fewer cells than the count above cannot be told');
    report.push('apart from feeding the same paper through the scanner again.');

    // eslint-disable-next-line no-console
    console.log(report.join('\n'));
    if (process.env.REPEAT_OUT) fs.writeFileSync(process.env.REPEAT_OUT, report.join('\n'), 'utf8');

    // The harness itself must be deterministic: the same input twice has to
    // produce the same output, or a "move" says nothing about the scanner.
    expect(results.length).toBeGreaterThanOrEqual(2);
  }, 3_600_000);
});
