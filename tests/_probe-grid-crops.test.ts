import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from '../src/lib/recognition/tableGridDetection';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * Crops the cells the recognizer ACTUALLY samples -- the grid-detection
 * overrides -- not the template fallback that _probe-cells draws. That
 * distinction cost a wrong reading once already (CAPTURE_GUIDANCE §16.5 #2).
 *
 * Built for §17 cycle 2: set 4 (grayscale, different device, content box 2.6%
 * shorter) loses 97 correct cells with grid coverage unchanged. Either the
 * detected rows are sitting off the marks (geometry) or the marks are simply
 * lighter where the rows are (tone). Looking at the sampled rectangles settles
 * which.
 *
 *   PDF=".." TEMPLATE=cagi|sat PAGE=3 FIELDS=q01,q03 OUT=".." \
 *     npx vitest run tests/_probe-grid-crops.test.ts
 */

const PDF = process.env.PDF;
const OUT = process.env.OUT;
const PAGE = Number(process.env.PAGE || 1);
const TEMPLATE = (process.env.TEMPLATE || 'cagi').toLowerCase();
const FIELDS = (process.env.FIELDS || 'q01').split(',');
const PRODUCTION_RENDER = PDF_RENDER_OPTIONS[0];

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
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: PRODUCTION_RENDER.scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
  fs.writeFileSync(out, canvas.toBuffer('image/jpeg', { quality: PRODUCTION_RENDER.quality }));
  return out;
}

const run = PDF && OUT ? describe : describe.skip;

run('grid crops', () => {
  it('writes the sampled cell rectangles', async () => {
    fs.mkdirSync(OUT!, { recursive: true });
    const pagePath = path.join(OUT!, `${TEMPLATE}-p${PAGE}.jpg`);
    await renderPage(PDF!, PAGE, pagePath);
    const img = await loadImageAnalysisData(pagePath);
    const det = TEMPLATE === 'cagi' ? buildCagiGridDetection(img) : buildSatisfactionGridDetection(img);
    const prefix = TEMPLATE === 'cagi' ? 'cagi.' : 'satisfaction.';

    for (const key of FIELDS) {
      const field = key.includes('.') ? key : prefix + key;
      const cells = det.overrides[field];
      const reg = det.registrations?.[field];
      if (!cells) { console.info(`${field}: no grid override (src would be fixed/row)`); continue; }
      const left = Math.max(0, Math.min(...cells.map((c) => c.left)) - 40);
      const right = Math.min(img.width, Math.max(...cells.map((c) => c.right)) + 10);
      const top = Math.max(0, Math.min(...cells.map((c) => c.top)) - 8);
      const bottom = Math.min(img.height, Math.max(...cells.map((c) => c.bottom)) + 8);
      // draw the sampled rectangles so the crop shows exactly what was scored
      const overlay = Buffer.from(
        `<svg width="${right - left}" height="${bottom - top}">` +
        cells.map((c) => `<rect x="${c.left - left}" y="${c.top - top}" width="${c.right - c.left}" height="${c.bottom - c.top}" fill="none" stroke="#e11" stroke-width="1.5"/>`).join('') +
        '</svg>',
      );
      // Two stages on purpose: sharp applies resize before composite regardless
      // of call order, so a single pipeline paints the overlay at output scale
      // and the rectangles come out a third of their size in the wrong place.
      const cropped = await sharp(pagePath)
        .extract({ left, top, width: right - left, height: bottom - top })
        .composite([{ input: overlay, top: 0, left: 0 }])
        .png()
        .toBuffer();
      await sharp(cropped)
        .resize({ width: Math.min(1400, (right - left) * 3), kernel: 'nearest' })
        .png()
        .toFile(path.join(OUT!, `${field}.png`));
      console.info(`${field}: cells=${cells.length} src=${reg?.source ?? '?'} status=${reg?.status ?? '?'} y=${cells[0].top}-${cells[0].bottom}`);
    }
  }, 300_000);
});
