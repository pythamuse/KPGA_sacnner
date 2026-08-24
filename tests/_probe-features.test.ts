import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';
import { matchBatch, type StackOrder } from '../src/lib/recognition/batchMatcher';

/**
 * ONE-OFF PROBE -- delete after the round. §34.
 *
 * One row per (scan, student, field): every quantity the gate reads, what the
 * scorer's winning value was, what the key says, and whether the gate let it
 * through. Aggregates nothing -- the question is what a different decision rule
 * over these same numbers could do, so the rows have to stay raw.
 */

const RUNS = [
  { label: 'A', cagi: process.env.REAL_SCAN_CAGI_PDF, sat: process.env.REAL_SCAN_SAT_PDF, order: 'same' as StackOrder },
  { label: 'B', cagi: process.env.REPEAT_SCAN_CAGI_PDF, sat: process.env.REPEAT_SCAN_SAT_PDF, order: 'same' as StackOrder },
  {
    label: 'C',
    cagi: process.env.REPEAT3_SCAN_CAGI_PDF,
    sat: process.env.REPEAT3_SCAN_SAT_PDF,
    order: (process.env.REPEAT3_SCAN_ORDER === 'reversed' ? 'reversed' : 'same') as StackOrder,
  },
].filter((r) => r.cagi && r.sat);

const PAGES = Number(process.env.REAL_SCAN_PAGES || 19);
const RENDER = PDF_RENDER_OPTIONS[0];
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'features.csv');
const KEY_PATH = process.env.REAL_SCAN_ANSWER_KEY
  || path.join(process.cwd(), 'local-scans', 'answer-key.json');

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

const COLUMNS = [
  'run', 'student', 'field', 'outcome', 'refused', 'usesGrid',
  'floor', 'gap', 'contrast', 'size', 'compact', 'diag',
  'actualInk', 'baselineInk', 'shift', 'alignX', 'alignY', 'fit',
  'pitchX', 'pitchY', 'candidates', 'secondScore',
  // Already computed by the pipeline and ignored by the gate. §36 asks whether
  // any of them carries what the four thresholds are missing.
  'inner', 'bcoreCore', 'bcoreFill', 'wantX', 'wantY', 'gain',
  'edgeShare', 'edgeFraction', 'bal', 'pageSharp', 'blankSharp',
  'softBlank', 'softBoth', 'mscore',
  'secondInner', 'secondFit', 'secondBal', 'secondEdgeShare',
  'value', 'bestValue', 'keyValue', 'autoFilled', 'correct', 'correctIfFilled',
];

/** have side of a `name=have/need(x)` pair. */
function have(trace: string, name: string): number {
  const m = new RegExp(`(?:^|[ [])${name}=([0-9.]+)/`).exec(trace);
  return m ? Number(m[1]) : NaN;
}

function fromBest(best: string, re: RegExp): number {
  const m = re.exec(best);
  return m ? Number(m[1]) : NaN;
}

describe.skipIf(RUNS.length === 0)('gate feature export', () => {
  it('writes one row per scan, student and field', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-feat-'));
    const key = fs.existsSync(KEY_PATH)
      ? (JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages: Array<Record<string, unknown>> }).pages
      : undefined;
    const rows: string[] = [COLUMNS.join(',')];
    const allTraces: string[] = [];

    for (const run of RUNS) {
      const cagiFiles = await renderPdfPages(run.cagi!, tmp, `${run.label}-cagi`);
      const satFiles = await renderPdfPages(run.sat!, tmp, `${run.label}-sat`);
      const pairs = matchBatch(cagiFiles, satFiles, run.order);

      for (let i = 0; i < pairs.length; i += 1) {
        const captured: string[] = [];
        const realInfo = console.info;
        console.info = (...args: unknown[]) => {
          const first = args[0];
          if (typeof first === 'string' && first.startsWith('[marks ')) { captured.push(first); return; }
          (realInfo as (...a: unknown[]) => void)(...args);
        };
        let draft: Record<string, unknown>;
        try {
          draft = await recognizeStudentForms(pairs[i].cagiPath, pairs[i].satisfactionPath) as unknown as Record<string, unknown>;
        } finally {
          console.info = realInfo;
        }

        const source = (draft.recognitionValueSource || {}) as Record<string, string>;
        const flat: Record<string, unknown> = {
          ...Object.fromEntries(Object.entries((draft.basic || {}) as object).map(([k, v]) => [`basic.${k}`, v])),
          ...Object.fromEntries(Object.entries((draft.cagi || {}) as object).map(([k, v]) => [`cagi.${k}`, v])),
          ...Object.fromEntries(Object.entries((draft.satisfaction || {}) as object).map(([k, v]) => [`satisfaction.${k}`, v])),
        };
        const keyRow = key?.[i];
        // Recorded for every candidate whether or not the gate let the field
        // through, so the value the scorer WOULD have filled is recoverable on
        // a refused cell. Reading it off `draft` instead of the trace also
        // means the schoolType and grade mappings are already applied.
        const measured = (draft.recognitionMeasurements || {}) as
          Record<string, Array<{ candidateValue: unknown; score: number }>>;

        allTraces.push(...captured.map((t) => `${run.label} p${i + 1} ${t}`));
        for (const trace of captured) {
          const field = /field=([\w.]+)/.exec(trace)?.[1];
          if (!field) continue;
          const best = (trace.split('boxes=[')[1] || '').split(' | ')[0] || '';
          const runnerUp = (trace.split('boxes=[')[1] || '').split(' | ')[1] || '';
          const scores = /scores=([0-9./]+)/.exec(trace)?.[1] || '';
          const value = flat[field];
          const want = keyRow ? keyRow[field] : undefined;
          const autoFilled = source[field] === 'auto' && value != null && value !== '';
          const correct = want === undefined ? ''
            : want === null ? '0'
              : (value != null && String(want) === String(value) ? '1' : '0');
          const ranked = [...(measured[field] || [])].sort((a, b) => b.score - a.score);
          const bestValue = ranked[0]?.candidateValue;
          // What the verdict would be if the gate simply let this cell through.
          // A cell the key marks blank counts as wrong however it reads.
          const correctIfFilled = want === undefined ? ''
            : want === null ? '0'
              : (bestValue != null && String(want) === String(bestValue) ? '1' : '0');

          rows.push([
            run.label, String(i + 1), field,
            /outcome=(\w+)/.exec(trace)?.[1] || '',
            /refused=([\w-]+)/.exec(trace)?.[1] || '',
            /cells=(\d+)/.exec(trace)?.[1] || '',
            have(trace, 'floor'), have(trace, 'gap'), have(trace, 'contrast'),
            have(trace, 'size'), have(trace, 'compact'), have(trace, 'diag'),
            fromBest(best, / page=([0-9.]+)/), fromBest(best, / blank=([0-9.]+)/),
            fromBest(best, / shift=(-?[0-9]+)/),
            fromBest(best, / align=(-?[0-9.]+),/), fromBest(best, / align=-?[0-9.]+,(-?[0-9.]+)/),
            fromBest(best, / fit=([0-9.]+)/),
            fromBest(trace, /page=([0-9.]+),[0-9.]+ blank=/), fromBest(trace, /page=[0-9.]+,([0-9.]+) blank=/),
            scores.split('/').length,
            fromBest(runnerUp, /scr=([0-9.]+)/),
            fromBest(best, / inner=([0-9.]+)/),
            fromBest(best, / bcore=([0-9.]+)\//), fromBest(best, / bcore=[0-9.]+\/([0-9.]+)/),
            fromBest(best, / want=(-?[0-9]+),/), fromBest(best, / want=-?[0-9]+,(-?[0-9]+)/),
            fromBest(best, / gain=(-?[0-9.]+)/),
            fromBest(best, / edge=([0-9.]+)\//), fromBest(best, / edge=[0-9.]+\/([0-9.]+)/),
            fromBest(best, / bal=([0-9.]+)/),
            fromBest(best, / sharp=([0-9.]+),/), fromBest(best, / sharp=[0-9.]+,([0-9.]+)/),
            fromBest(best, / soft=([0-9.]+),/), fromBest(best, / soft=[0-9.]+,([0-9.]+)/),
            fromBest(best, / mscore=([0-9.]+)/),
            fromBest(runnerUp, / inner=([0-9.]+)/), fromBest(runnerUp, / fit=([0-9.]+)/),
            fromBest(runnerUp, / bal=([0-9.]+)/), fromBest(runnerUp, / edge=([0-9.]+)\//),
            value == null ? '' : `"${String(value)}"`,
            bestValue == null ? '' : `"${String(bestValue)}"`,
            want === undefined ? '' : want === null ? '"BLANK"' : `"${String(want)}"`,
            autoFilled ? '1' : '0',
            correct,
            correctIfFilled,
          ].join(','));
        }
      }
    }

    fs.writeFileSync(OUT, rows.join(String.fromCharCode(10)), 'utf8');
    // Raw traces alongside, so adding another feature later costs a parse
    // rather than another hour of recognition.
    fs.writeFileSync(`${OUT}.traces.txt`, allTraces.join(String.fromCharCode(10)), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`wrote ${rows.length - 1} rows to ${OUT}`);
  }, 5_400_000);
});
