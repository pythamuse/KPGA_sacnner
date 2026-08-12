import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { loadImageAnalysisData, type ImageAnalysisData, type PixelRect } from '../src/lib/recognition/markDensity';
import {
  buildCagiGridDetection,
  buildSatisfactionGridDetection,
} from '../src/lib/recognition/tableGridDetection';
import { cagiTemplate, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';

/**
 * Root-cause isolation harness.
 *
 * Real scans carry student answers and contact traces, so they are NEVER
 * committed. Point these at files outside the repository:
 *
 *   REAL_SCAN_CAGI_PDF="C:/.../선별검사 샘플1.pdf" \
 *   REAL_SCAN_SAT_PDF="C:/.../만족도조사1.pdf" \
 *   REAL_SCAN_PAGES=2 npx vitest run tests/real-scan-measure.test.ts
 *
 * Without those variables the suite skips, so `npm test` stays green for
 * anyone who does not hold the scans.
 *
 * Headline numbers to record in the Task doc for every experiment branch:
 *   AUTO  = fields auto-filled (of 23)   -- the metric the work is judged on
 *   HIGH  = fields at 높음 confidence
 *   OFF   = fields whose detected row centre misses the measured template by >0.01
 */

const CAGI_PDF = process.env.REAL_SCAN_CAGI_PDF;
const SAT_PDF = process.env.REAL_SCAN_SAT_PDF;
const PAGES = Number(process.env.REAL_SCAN_PAGES || 2);

const measuredY: Record<string, number> = {
  'basic.gender': 0.1540, 'basic.schoolType': 0.1788, 'basic.grade': 0.2180,
  'cagi.q01': 0.3335, 'cagi.q02': 0.3592, 'cagi.q03': 0.3848, 'cagi.q04': 0.4018,
  'cagi.q05': 0.4189, 'cagi.q06': 0.4360, 'cagi.q07': 0.4531, 'cagi.q08': 0.5120,
  'cagi.q09': 0.5300,
  'satisfaction.q01': 0.2852, 'satisfaction.q02': 0.4293, 'satisfaction.q03': 0.4775,
  'satisfaction.q04': 0.5257, 'satisfaction.q05': 0.5610, 'satisfaction.q06': 0.5968,
  'satisfaction.q07': 0.7510, 'satisfaction.q08': 0.7815, 'satisfaction.q09': 0.8120,
  'satisfaction.q10': 0.8420,
};

const ALL_FIELDS = [
  'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
  ...Array.from({ length: 9 }, (_, i) => `cagi.q${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, i) => `satisfaction.q${String(i + 1).padStart(2, '0')}`),
];

async function renderPdfPages(pdfPath: string, pages: number, outDir: string, label: string) {
  const { createCanvas, Image, ImageData } = await import('canvas');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // pdf.js paints scanned pages through temporary canvases; in Node it needs a
  // factory returning node-canvas surfaces instead of DOM ones.
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
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    CanvasFactory: NodeCanvasFactory,
  }).promise;

  const out: string[] = [];
  for (let n = 1; n <= Math.min(pages, doc.numPages); n += 1) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const file = path.join(outDir, `${label}-p${n}.png`);
    fs.writeFileSync(file, canvas.toBuffer('image/png'));
    out.push(file);
  }
  return out;
}

function rowCentre(image: ImageAnalysisData, cells: PixelRect[]): number {
  const b = image.contentBounds || { top: 0, bottom: image.height };
  const top = Math.min(...cells.map((c) => c.top));
  const bottom = Math.max(...cells.map((c) => c.bottom));
  return ((top + bottom) / 2 - b.top) / (b.bottom - b.top);
}

async function countCoordinateMisses(cagiPng: string, satPng: string) {
  const cagiImage = await loadImageAnalysisData(cagiPng);
  const satImage = await loadImageAnalysisData(satPng);
  const sets: Array<[ImageAnalysisData, Record<string, PixelRect[]>, typeof cagiTemplate]> = [
    [cagiImage, buildCagiGridDetection(cagiImage).overrides, cagiTemplate],
    [satImage, buildSatisfactionGridDetection(satImage).overrides, satisfactionTemplate],
  ];
  let off = 0;
  let missing = 0;
  const detail: string[] = [];
  for (const [image, overrides, template] of sets) {
    for (const group of template.choiceGroups) {
      const cells = overrides[group.field];
      const expected = measuredY[group.field];
      if (!cells) { missing += 1; detail.push(`${group.field}=MISSING`); continue; }
      if (expected === undefined) continue;
      const d = rowCentre(image, cells) - expected;
      if (Math.abs(d) > 0.01) { off += 1; detail.push(`${group.field}=${d.toFixed(4)}`); }
    }
  }
  return { off, missing, detail };
}

describe.skipIf(!CAGI_PDF || !SAT_PDF)('real scan measurement', () => {
  it('reports auto-fill and coordinate accuracy per student page', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-scan-'));
    const cagiPngs = await renderPdfPages(CAGI_PDF!, PAGES, tmp, 'cagi');
    const satPngs = await renderPdfPages(SAT_PDF!, PAGES, tmp, 'sat');

    const report: string[] = ['\n================ REAL SCAN MEASUREMENT ================'];
    let totalAuto = 0;
    let totalHigh = 0;
    let totalOff = 0;
    let totalMissing = 0;

    for (let i = 0; i < Math.min(cagiPngs.length, satPngs.length); i += 1) {
      const draft = await recognizeStudentForms(cagiPngs[i], satPngs[i]);
      const values: Record<string, unknown> = {
        'basic.age': draft.basic.age,
        'basic.gender': draft.basic.gender,
        'basic.schoolType': draft.basic.schoolType,
        'basic.grade': draft.basic.grade,
        ...Object.fromEntries(Object.entries(draft.cagi || {}).map(([k, v]) => [`cagi.${k}`, v])),
        ...Object.fromEntries(Object.entries(draft.satisfaction || {}).map(([k, v]) => [`satisfaction.${k}`, v])),
      };

      const auto = ALL_FIELDS.filter((f) => values[f] !== undefined && values[f] !== null);
      const high = ALL_FIELDS.filter((f) => draft.confidence?.[f] === 'high');
      const coords = await countCoordinateMisses(cagiPngs[i], satPngs[i]);

      totalAuto += auto.length;
      totalHigh += high.length;
      totalOff += coords.off;
      totalMissing += coords.missing;

      report.push(`\n--- student page ${i + 1} ---`);
      report.push(`AUTO ${auto.length}/23   HIGH ${high.length}/23   OFF ${coords.off}   MISSING ${coords.missing}`);
      report.push(`  blank : ${ALL_FIELDS.filter((f) => !auto.includes(f)).join(', ') || '(none)'}`);
      if (coords.detail.length) report.push(`  coord : ${coords.detail.join(', ')}`);
      for (const f of ALL_FIELDS) {
        report.push(`  ${f.padEnd(18)} value=${String(values[f] ?? '-').padEnd(6)} conf=${String(draft.confidence?.[f] ?? '-').padEnd(7)} src=${draft.recognitionCropSource?.[f] ?? '-'}`);
      }
    }

    report.push('\n================ TOTAL ================');
    report.push(`AUTO ${totalAuto}/${23 * PAGES}   HIGH ${totalHigh}/${23 * PAGES}   OFF ${totalOff}   MISSING ${totalMissing}`);
    console.info(report.join('\n'));
  }, 900_000);
});
