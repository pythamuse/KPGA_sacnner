import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * Writes the crops the PRODUCT hands the reviewer (`cropDebugDataUrls`, with
 * the sampled rectangles drawn by the recognizer itself) to PNG files, so
 * they can be inspected at full size. Unlike `_probe-grid-crops`, this goes
 * through `recognizeStudentForms` -- registration frame, basic-checkbox
 * merge, V2 matcher, everything -- so what is drawn is what was scored.
 *
 *   CAGI_PDF=.. SAT_PDF=.. PAGE=3 [SAT_REVERSED=1] OUT=..dir
 *     npx vitest run tests/_probe-crop-urls.test.ts
 */

const OUT = process.env.OUT;
const PAGE = Number(process.env.PAGE || 3);
const R = PDF_RENDER_OPTIONS[0];

async function renderPage(pdfPath: string, pageNo: number, out: string) {
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
  const pageIndex = process.env.SAT_REVERSED && pdfPath === process.env.SAT_PDF
    ? doc.numPages - pageNo + 1
    : pageNo;
  const page = await doc.getPage(pageIndex);
  const viewport = page.getViewport({ scale: R.scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
  fs.writeFileSync(out, canvas.toBuffer('image/jpeg', { quality: R.quality }));
  return out;
}

const run = OUT && process.env.CAGI_PDF && process.env.SAT_PDF ? describe : describe.skip;

run('product crop dump', () => {
  it('writes the reviewer crops with the sampled rectangles', async () => {
    fs.mkdirSync(OUT!, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-urls-'));
    const cagi = await renderPage(process.env.CAGI_PDF!, PAGE, path.join(tmp, 'cagi.jpg'));
    const sat = await renderPage(process.env.SAT_PDF!, PAGE, path.join(tmp, 'sat.jpg'));
    const realInfo = console.info; const realLog = console.log;
    console.info = () => {}; console.log = () => {};
    let draft: Record<string, unknown>;
    try {
      draft = (await recognizeStudentForms(cagi, sat, {})) as unknown as Record<string, unknown>;
    } finally { console.info = realInfo; console.log = realLog; }
    const debug = (draft.cropDebugDataUrls || {}) as Record<string, string>;
    const plain = (draft.cropDataUrls || {}) as Record<string, string>;
    const source = (draft.recognitionCropSource || {}) as Record<string, string>;
    const registration = (draft.recognitionRegistration || {}) as Record<string, { status?: string }>;
    let n = 0;
    for (const [field, url] of Object.entries(debug)) {
      const m = /^data:image\/(\w+);base64,(.*)$/.exec(url);
      if (!m) continue;
      fs.writeFileSync(path.join(OUT!, `${field}.debug.${m[1]}`), Buffer.from(m[2], 'base64'));
      n += 1;
      realInfo(`${field}: src=${source[field] ?? '?'} status=${registration[field]?.status ?? '?'} plain=${plain[field] ? 'y' : 'n'}`);
    }
    realInfo(`wrote ${n} debug crops -> ${OUT}`);
  }, 600_000);
});
