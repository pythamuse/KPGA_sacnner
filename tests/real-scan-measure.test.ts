import { describe, it, expect } from 'vitest';
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
 * Real scans and their answer keys carry student responses, so they are NEVER
 * committed. Keep them in the gitignored `local-scans/` directory and point
 * these at files outside version control:
 *
 *   REAL_SCAN_CAGI_PDF="C:/.../선별검사 샘플1.pdf" \
 *   REAL_SCAN_SAT_PDF="C:/.../만족도조사1.pdf" \
 *   REAL_SCAN_PAGES=2 npx vitest run tests/real-scan-measure.test.ts
 *
 * Without those variables the suite skips, so `npm test` stays green for
 * anyone who does not hold the scans.
 *
 * Headline numbers to record in the Task doc for every experiment branch:
 *   CORRECT = auto-filled AND matching the answer key -- judge the work on this
 *   WRONG   = auto-filled but DIFFERENT from the key  -- must stay 0, asserted
 *   BLANK   = not auto-filled (safe: the reviewer fills it in)
 *
 * Counting filled fields instead of correct ones is what let a change that
 * added four wrong high-confidence values look like an improvement.
 */

const CAGI_PDF = process.env.REAL_SCAN_CAGI_PDF;
const SAT_PDF = process.env.REAL_SCAN_SAT_PDF;
const PAGES = Number(process.env.REAL_SCAN_PAGES || 2);
const KEY_PATH = process.env.REAL_SCAN_ANSWER_KEY
  || path.join(process.cwd(), 'local-scans', 'answer-key.json');

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

function loadAnswerKey(): Array<Record<string, unknown>> | undefined {
  if (!fs.existsSync(KEY_PATH)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages?: Array<Record<string, unknown>> };
  return parsed.pages;
}

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
  for (const [image, overrides, template] of sets) {
    for (const group of template.choiceGroups) {
      const cells = overrides[group.field];
      const expected = measuredY[group.field];
      if (!cells) { missing += 1; continue; }
      if (expected === undefined) continue;
      if (Math.abs(rowCentre(image, cells) - expected) > 0.01) off += 1;
    }
  }
  return { off, missing };
}

describe.skipIf(!CAGI_PDF || !SAT_PDF)('real scan measurement', () => {
  it('never auto-fills a value that disagrees with the answer key', async () => {
    const answerKey = loadAnswerKey();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-scan-'));
    const cagiPngs = await renderPdfPages(CAGI_PDF!, PAGES, tmp, 'cagi');
    const satPngs = await renderPdfPages(SAT_PDF!, PAGES, tmp, 'sat');

    const report: string[] = ['\n================ REAL SCAN MEASUREMENT ================'];
    if (!answerKey) {
      report.push(`(no answer key at ${KEY_PATH} — correctness not judged)`);
    }
    let tCorrect = 0;
    let tAnswerable = 0;
    let tWrong = 0;
    let tBlank = 0;
    let tOff = 0;
    let tMissing = 0;
    const wrongDetail: string[] = [];

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
      const key = answerKey?.[i];
      const coords = await countCoordinateMisses(cagiPngs[i], satPngs[i]);

      let correct = 0;
      let wrong = 0;
      let blank = 0;
      const rows: string[] = [];
      // A null answer means the form itself carries no mark there, so the only
      // right behaviour is to leave the field blank. It is not scored as
      // CORRECT (there is nothing to get right) but filling it is WRONG.
      const answerable = key
        ? ALL_FIELDS.filter((f) => f in key && key[f] !== null).length
        : ALL_FIELDS.length;

      for (const field of ALL_FIELDS) {
        const got = values[field];
        const hasKey = key ? field in key : false;
        const want = key?.[field];
        let verdict = '-';
        if (got === undefined || got === null || got === '') {
          blank += 1;
          verdict = hasKey && want === null ? 'blank (unmarked, correct)' : 'BLANK';
        } else if (!hasKey) {
          verdict = 'filled';
        } else if (want === null) {
          wrong += 1;
          verdict = 'WRONG (the form is unmarked here)';
          wrongDetail.push(`p${i + 1} ${field}: got ${got}, but the form is unmarked, conf=${draft.confidence?.[field]}`);
        } else if (String(got) === String(want)) {
          correct += 1;
          verdict = 'ok';
        } else {
          wrong += 1;
          verdict = `WRONG (want ${want})`;
          wrongDetail.push(`p${i + 1} ${field}: got ${got}, want ${want}, conf=${draft.confidence?.[field]}`);
        }
        rows.push(`  ${field.padEnd(18)} got=${String(got ?? '-').padEnd(7)} conf=${String(draft.confidence?.[field] ?? '-').padEnd(7)} src=${String(draft.recognitionCropSource?.[field] ?? '-').padEnd(12)} ${verdict}`);
      }

      tCorrect += correct; tWrong += wrong; tBlank += blank; tAnswerable += answerable;
      tOff += coords.off; tMissing += coords.missing;

      report.push(`\n--- student page ${i + 1} ---`);
      report.push(`CORRECT ${correct}/${answerable}   WRONG ${wrong}   BLANK ${blank}   OFF ${coords.off}   MISSING ${coords.missing}`);
      report.push(...rows);
    }

    report.push('\n================ TOTAL ================');
    report.push(`CORRECT ${tCorrect}/${tAnswerable}   WRONG ${tWrong}   BLANK ${tBlank}   OFF ${tOff}   MISSING ${tMissing}`);
    if (wrongDetail.length) {
      report.push('\n!!! WRONG AUTO-FILLED VALUES !!!');
      report.push(...wrongDetail.map((d) => `  ${d}`));
    }
    console.info(report.join('\n'));

    // A blank field costs the reviewer a keystroke; a wrong one is saved to the
    // central system as if a human had confirmed it. Never trade the second for
    // the first.
    expect(wrongDetail, `auto-filled values disagree with the answer key:\n${wrongDetail.join('\n')}`)
      .toEqual([]);
  }, 900_000);
});
