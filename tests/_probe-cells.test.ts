import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import { cagiTemplate, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

// PDF_RENDER_OPTIONS is the LADDER; production renders with its first rung.
// Reading .scale off the array itself yields undefined and pdf.js dies inside
// its JPEG decoder with a message that names neither -- CLAUDE.md §2, check
// what the instrument is measuring.
const PRODUCTION_RENDER = PDF_RENDER_OPTIONS[0];

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * §2, instrument before fixing. FIELD_TEST §24 describes p16's satisfaction
 * q02-q06 as "X 취소를 답으로 읽음" and calls stroke topology the only remaining
 * candidate. Those five are the ONLY wrong cells the node and browser rasters
 * agree on, which makes them the one target this project can iterate on in 36
 * seconds instead of a browser run.
 *
 * Before moving any threshold, look at the paper. This asserts nothing; it
 * renders the real page at the production scale and writes one crop per field
 * plus a strip across all five, so the described mechanism can be confirmed or
 * refuted by eye. The description has been wrong before -- §8's Stage A read a
 * boolean as a count, and §13.8 had two synthetics disagreeing about a case the
 * photographs settled.
 *
 *   PDF="<path>" TEMPLATE=cagi|sat PAGE=3 FIELDS=gender \
 *     OUT="<dir>" npx vitest run tests/_probe-cells.test.ts
 */

const PDF = process.env.PDF || process.env.SAT_PDF;
const OUT = process.env.OUT;
const PAGE = Number(process.env.PAGE || 16);
const TEMPLATE = (process.env.TEMPLATE || 'sat').toLowerCase();
const FIELDS = (process.env.FIELDS || 'q02,q03,q04,q05,q06').split(',');

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

run('p16 cells', () => {
  it('writes crops of the disputed fields', async () => {
    fs.mkdirSync(OUT!, { recursive: true });
    const pagePath = path.join(OUT!, `${TEMPLATE}-p${PAGE}.jpg`);
    await renderPage(PDF!, PAGE, pagePath);

    const img = await loadImageAnalysisData(pagePath);
    const b = img.contentBounds!;
    const W = b.right - b.left;
    const H = b.bottom - b.top;
    console.info(`page ${img.width}x${img.height}  content ${b.left},${b.top}..${b.right},${b.bottom}`);

    const tmpl = TEMPLATE === 'cagi' ? cagiTemplate : satisfactionTemplate;
    const groups = tmpl.choiceGroups as Array<{
      id?: string; field?: string; candidates: Array<{ rect: { x: number; y: number; width: number; height: number } }>;
    }>;
    console.info(`group ids: ${groups.map((g) => g.id ?? g.field).join(' ')}`);

    const picked = FIELDS
      .map((f) => groups.find((g) => (g.id ?? g.field ?? '').includes(f)))
      .filter(Boolean) as typeof groups;

    const allY: number[] = [];
    for (const grp of picked) {
      const xs = grp.candidates.map((c) => c.rect.x);
      const xe = grp.candidates.map((c) => c.rect.x + c.rect.width);
      const ys = grp.candidates.map((c) => c.rect.y);
      const ye = grp.candidates.map((c) => c.rect.y + c.rect.height);
      allY.push(Math.min(...ys), Math.max(...ye));
      // pad left generously so the row's printed question is visible -- a crop
      // without its label cannot show whether the right row was measured.
      const left = Math.max(0, Math.round(b.left + (Math.min(...xs) - 0.34) * W));
      const right = Math.min(img.width, Math.round(b.left + (Math.max(...xe) + 0.02) * W));
      const top = Math.max(0, Math.round(b.top + (Math.min(...ys) - 0.008) * H));
      const bottom = Math.min(img.height, Math.round(b.top + (Math.max(...ye) + 0.008) * H));
      const name = (grp.id ?? grp.field ?? 'field').replace(/[^\w.-]/g, '_');
      await sharp(pagePath)
        .extract({ left, top, width: right - left, height: bottom - top })
        .resize({ width: Math.min(1400, (right - left) * 3) })
        .png()
        .toFile(path.join(OUT!, `${name}.png`));
      console.info(`${name}  ${right - left}x${bottom - top}  cands=${grp.candidates.length}`);
    }

    // What did the scorer actually see here? MARK_DECISION_TRACE prints every
    // group; recognising this ONE page keeps the output readable instead of
    // hunting p16 inside a 19-page log by position.
    if (process.env.TRACE) {
      process.env.MARK_DECISION_TRACE = '1';
      await recognizeStudentForms(pagePath, pagePath)
        .catch((e: unknown) => console.info('recognize threw: ' + String(e).slice(0, 200)));
    }

    if (allY.length) {
      const top = Math.max(0, Math.round(b.top + (Math.min(...allY) - 0.03) * H));
      const bottom = Math.min(img.height, Math.round(b.top + (Math.max(...allY) + 0.03) * H));
      await sharp(pagePath)
        .extract({ left: b.left, top, width: b.right - b.left, height: bottom - top })
        .resize({ width: 1500 })
        .png()
        .toFile(path.join(OUT!, 'strip.png'));
      console.info('strip written');
    }
  }, 300_000);
});
