import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';

const CAGI_PDF = process.env.REAL_SCAN_CAGI_PDF;
const SAT_PDF = process.env.REAL_SCAN_SAT_PDF;

/** Renders one page at the blank assets' own raster so the two are directly comparable. */
async function renderNative(pdfPath: string, n: number, outDir: string, tag: string) {
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
  const base = page.getViewport({ scale: 1 });
  const scale = 1654 / base.width;
  const vp = page.getViewport({ scale });
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c } as never).promise;
  const file = path.join(outDir, `${tag}n${n}.png`);
  fs.writeFileSync(file, c.toBuffer('image/png'));
  return file;
}

describe.skipIf(!CAGI_PDF || !SAT_PDF)('blank vs scan envelope at the same raster', () => {
  it('compares each blank against its own scans rendered at 1654 wide', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-native-'));
    const out: string[] = ['===== BLANK vs SCAN (native 1654) ====='];
    for (const [tag, pdf, blank] of [
      ['CAGI', CAGI_PDF!, 'cagi-blank.png'],
      ['SAT ', SAT_PDF!, 'satisfaction-blank.png'],
    ] as const) {
      const b = await loadImageAnalysisData(path.join(process.cwd(), 'src/lib/recognition/assets', blank));
      const bb = b.contentBounds!;
      out.push(`${tag} blank   ${b.width}x${b.height}  L=${bb.left} R=${bb.right} W=${bb.right - bb.left}  src=${b.contentBoundsSource}`);
      for (const n of [1, 7, 13, 19]) {
        const img = await loadImageAnalysisData(await renderNative(pdf, n, tmp, tag.trim()));
        const c = img.contentBounds!;
        out.push(`${tag} scan p${String(n).padStart(2)} ${img.width}x${img.height}  L=${c.left} R=${c.right} W=${c.right - c.left}  src=${img.contentBoundsSource}  ratio=${((c.right - c.left) / (bb.right - bb.left)).toFixed(4)}`);
      }
    }
    out.push('=====END=====');
    console.log(out.join(String.fromCharCode(10)));
  }, 900000);
});
