import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from '../src/lib/recognition/tableGridDetection';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

const CAGI_PDF = process.env.REAL_SCAN_CAGI_PDF;
const SAT_PDF = process.env.REAL_SCAN_SAT_PDF;
const R = PDF_RENDER_OPTIONS[0];

async function render(pdfPath: string, n: number, outDir: string, tag: string) {
  const { createCanvas, Image, ImageData } = await import('canvas');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  class F {
    create(w: number, h: number) { const c = createCanvas(Math.max(1, w), Math.max(1, h)); return { canvas: c, context: c.getContext('2d') }; }
    reset(cc: { canvas: { width: number; height: number } }, w: number, h: number) { cc.canvas.width = Math.max(1, w); cc.canvas.height = Math.max(1, h); }
    destroy(cc: { canvas: unknown; context: unknown }) { cc.canvas = null; cc.context = null; }
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.ImageData = g.ImageData || ImageData; g.Image = g.Image || Image;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), isEvalSupported: false, useSystemFonts: true, CanvasFactory: F }).promise;
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: R.scale });
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c } as never).promise;
  const file = path.join(outDir, `${tag}${n}.jpg`);
  fs.writeFileSync(file, c.toBuffer('image/jpeg', { quality: R.quality }));
  return file;
}

/** Rough page skew: for each of a few horizontal bands, find the darkest row and fit a slope. */
function skewDegrees(img: { width: number; height: number; pixels: Uint8Array | Uint8ClampedArray | number[] }) {
  const dark = 200;
  const cols = 12;
  const step = Math.floor(img.width / (cols + 1));
  const tops: Array<{ x: number; y: number }> = [];
  for (let c = 1; c <= cols; c += 1) {
    const x = c * step;
    for (let y = Math.floor(img.height * 0.02); y < Math.floor(img.height * 0.35); y += 1) {
      let run = 0;
      for (let dx = -3; dx <= 3; dx += 1) {
        const px = x + dx;
        if (px < 0 || px >= img.width) continue;
        if ((img.pixels as never as number[])[y * img.width + px] < dark) run += 1;
      }
      if (run >= 6) { tops.push({ x, y }); break; }
    }
  }
  if (tops.length < 4) return null;
  const mx = tops.reduce((s, p) => s + p.x, 0) / tops.length;
  const my = tops.reduce((s, p) => s + p.y, 0) / tops.length;
  const den = tops.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (den <= 0) return null;
  const slope = tops.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den;
  return +(Math.atan(slope) * 180 / Math.PI).toFixed(3);
}

function inkRatio(img: { width: number; height: number; pixels: never }) {
  let dark = 0;
  const px = img.pixels as never as number[];
  for (let i = 0; i < px.length; i += 7) if (px[i] < 200) dark += 1;
  return +(dark / (px.length / 7)).toFixed(4);
}

describe.skipIf(!CAGI_PDF || !SAT_PDF)('page geometry vs registration', () => {
  it('reports per-page geometry for all 19 pages of both forms', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-geom-'));
    const lines: string[] = ['===== PAGE GEOMETRY ====='];
    lines.push('form page  W    H   contentL contentT contentW contentH  src        skew    ink     tables');
    for (const [tag, pdf] of [['C', CAGI_PDF!], ['S', SAT_PDF!]] as const) {
      for (let n = 1; n <= 19; n += 1) {
        const img = await loadImageAnalysisData(await render(pdf, n, tmp, tag));
        const cb = img.contentBounds;
        const det = tag === 'C' ? buildCagiGridDetection(img) : buildSatisfactionGridDetection(img);
        const regs = det.registrations || {};
        const byTable = new Map<string, string>();
        Object.values(regs).forEach((r) => { const rr = r as { tableId?: string; status?: string }; if (rr?.tableId) byTable.set(rr.tableId, String(rr.status)); });
        const tables = Array.from(byTable.entries()).map(([k, v]) => `${k}=${v}`).join(' ');
        lines.push([
          tag, String(n).padStart(4),
          String(img.width).padStart(5), String(img.height).padStart(5),
          String(cb ? cb.left : -1).padStart(8), String(cb ? cb.top : -1).padStart(8),
          String(cb ? cb.right - cb.left : -1).padStart(8), String(cb ? cb.bottom - cb.top : -1).padStart(8),
          String(img.contentBoundsSource ?? '-').padStart(10),
          String(skewDegrees(img as never) ?? '?').padStart(7),
          String(inkRatio(img as never)).padStart(7),
          ' ' + tables,
        ].join(' '));
      }
    }
    lines.push('=====END=====');
    console.log(lines.join(String.fromCharCode(10)));
  }, 1800000);
});
