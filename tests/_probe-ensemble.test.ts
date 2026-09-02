import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * Docs/17 §3.15: re-feeding the same paper flips 76-91 cells of gating, and
 * most remaining wrongs appear in only one scan set. If a second raster of the
 * SAME page (different scale, so different sampling phase) disagrees with the
 * first exactly where the first is wrong, a two-raster agreement veto is a
 * gate tightening worth ordering. This measures that before any code changes:
 * per field, the production-scale value vs the second-scale value, joined to
 * the answer key.
 *
 *   SET=1 CAGI_PDF=.. SAT_PDF=.. [SAT_REVERSED=1] [SCALE_B=1.25] OUT=..jsonl
 *     npx vitest run tests/_probe-ensemble.test.ts
 */

const SET = process.env.SET || '?';
const OUT = process.env.OUT;
const PAGES = Number(process.env.PAGES || 19);
const SCALE_B = Number(process.env.SCALE_B || PDF_RENDER_OPTIONS[1].scale);
const KEY_PATH = process.env.REAL_SCAN_ANSWER_KEY
  || path.join(process.cwd(), 'local-scans', 'answer-key.json');
const A = PDF_RENDER_OPTIONS[0];

const FIELDS = [
  'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
  'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07', 'cagi.q08', 'cagi.q09',
  'satisfaction.q01', 'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05',
  'satisfaction.q06', 'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
];

async function renderPdf(pdfPath: string, outDir: string, tag: string, scale: number, quality: number): Promise<string[]> {
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
    destroy(cc: { canvas: unknown; context: unknown }) { cc.canvas = null; cc.context = null; }
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.ImageData = g.ImageData || ImageData;
  g.Image = g.Image || Image;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    isEvalSupported: false,
    useSystemFonts: true,
    CanvasFactory: NodeCanvasFactory,
  }).promise;
  const files: string[] = [];
  for (let p = 1; p <= Math.min(PAGES, doc.numPages); p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const out = path.join(outDir, `${tag}-s${scale}-p${p}.jpg`);
    fs.writeFileSync(out, canvas.toBuffer('image/jpeg', { quality }));
    files.push(out);
  }
  return files;
}

const ready = OUT && process.env.CAGI_PDF && process.env.SAT_PDF && fs.existsSync(KEY_PATH);
const run = ready ? describe : describe.skip;

run('two-raster agreement probe', () => {
  it('records per-field values from two rasters of the same page next to the key', async () => {
    const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages: Array<Record<string, unknown>> };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-'));
    const cagiA = await renderPdf(process.env.CAGI_PDF!, tmp, 'cagi', A.scale, A.quality);
    const cagiB = await renderPdf(process.env.CAGI_PDF!, tmp, 'cagi', SCALE_B, A.quality);
    let satA = await renderPdf(process.env.SAT_PDF!, tmp, 'sat', A.scale, A.quality);
    let satB = await renderPdf(process.env.SAT_PDF!, tmp, 'sat', SCALE_B, A.quality);
    if (process.env.SAT_REVERSED) { satA = [...satA].reverse(); satB = [...satB].reverse(); }

    const read = (draft: Record<string, unknown>, field: string) => {
      const [g, n] = field.split('.');
      const v = (draft[g] as Record<string, unknown> | undefined)?.[n];
      const src = (draft.recognitionValueSource as Record<string, string> | undefined)?.[field];
      const contested = (draft.recognitionContested as Record<string, boolean> | undefined)?.[field] === true;
      const value = src === 'auto' && v !== undefined && v !== null && v !== '' ? String(v) : null;
      return { value, contested };
    };

    const rows: unknown[] = [];
    const quiet = () => {};
    const realInfo = console.info; const realLog = console.log;
    for (let i = 0; i < Math.min(cagiA.length, satA.length); i += 1) {
      const page = i + 1;
      const keyRow = key.pages.find((p) => Number(p.page) === page) ?? {};
      console.info = quiet; console.log = quiet;
      let a: Record<string, unknown> = {}; let b: Record<string, unknown> = {};
      try {
        a = (await recognizeStudentForms(cagiA[i], satA[i], {})) as unknown as Record<string, unknown>;
        b = (await recognizeStudentForms(cagiB[i], satB[i], {})) as unknown as Record<string, unknown>;
      } finally { console.info = realInfo; console.log = realLog; }
      for (const field of FIELDS) {
        const ra = read(a, field); const rb = read(b, field);
        const want = keyRow[field];
        const wantStr = want === undefined || want === null ? null : String(want);
        rows.push({
          set: SET, page, field,
          a: ra.value, b: rb.value, contestedA: ra.contested,
          want: wantStr,
          agree: ra.value !== null && rb.value !== null && ra.value === rb.value,
          aStatus: ra.value === null ? 'blank' : (wantStr === null ? 'wrong-null' : (ra.value === wantStr ? 'correct' : 'wrong')),
        });
      }
      realInfo(`${SET} p${page} done`);
    }
    fs.writeFileSync(OUT!, rows.map((r) => JSON.stringify(r)).join('\n'));
    realInfo(`wrote ${rows.length} rows -> ${OUT}`);
  }, 3_600_000);
});
