import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * p16's satisfaction q02-q06 are the five wrong cells the node and browser
 * rasters agree on. Looking at the paper (probe _probe-p16-cells) shows the
 * student marked 아니오, struck it out with a heavy X, and ticked 예. The X
 * carries more ink than the tick, so differential scoring picks the thing that
 * was cancelled.
 *
 * The traces say the runner-up -- the CORRECT box -- scores 0.045, 0.025,
 * 0.025, 0.047, 0.040, every one of them above the 0.021 floor. So "both boxes
 * carry real ink" describes all five. The question this probe exists to answer
 * is the other half, and it is the half that decides whether a refusal rule is
 * affordable:
 *
 *     on the cells the scorer currently gets RIGHT, what does the runner-up
 *     score?
 *
 * If right answers leave the loser near zero, a refusal costs almost nothing
 * and converts 5 wrong cells into 5 blanks -- which under this project's rule
 * is a straight win. If right answers routinely carry ink in both boxes, the
 * rule is unaffordable and stroke topology (§24.4) is the only way through.
 *
 * Emits JSONL so the distribution can be scored the same way every other
 * discriminator in this project has been: against a shuffled-label control.
 *
 *   CAGI_PDF=".." SAT_PDF=".." OUT="..jsonl" npx vitest run tests/_probe-runnerup.test.ts
 */

const CAGI_PDF = process.env.CAGI_PDF;
const SAT_PDF = process.env.SAT_PDF;
const OUT = process.env.OUT;
const PAGES = Number(process.env.PAGES || 19);
const KEY = path.join(process.cwd(), 'local-scans', 'answer-key.json');
const PRODUCTION_RENDER = PDF_RENDER_OPTIONS[0];

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
  const out: string[] = [];
  for (let n = 1; n <= Math.min(pages, doc.numPages); n += 1) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: PRODUCTION_RENDER.scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const file = path.join(outDir, `${label}-p${n}.jpg`);
    fs.writeFileSync(file, canvas.toBuffer('image/jpeg', { quality: PRODUCTION_RENDER.quality }));
    out.push(file);
  }
  return out;
}

/** `scores=0.081/0.045` -- winner first, then the rest in rank order. */
function parseTrace(line: string) {
  const field = /field=([\w.]+)/.exec(line)?.[1];
  const outcome = /outcome=(\w+)/.exec(line)?.[1];
  const n = Number(/\bn=(\d+)/.exec(line)?.[1] ?? '0');
  const scores = (/scores=([0-9./]+)/.exec(line)?.[1] ?? '').split('/').map(Number);
  const refused = /refused=([\w,-]+)/.exec(line)?.[1];
  if (!field || !outcome || scores.length < 1) return null;
  return { field, outcome, n, scores, refused };
}

const run = CAGI_PDF && SAT_PDF && OUT && fs.existsSync(KEY) ? describe : describe.skip;

run('runner-up distribution', () => {
  it('dumps winner and runner-up per group, joined to the key', async () => {
    const key = JSON.parse(fs.readFileSync(KEY, 'utf8')) as {
      pages: Array<Record<string, unknown>>;
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-runnerup-'));
    const cagi = await renderPdfPages(CAGI_PDF!, PAGES, tmp, 'cagi');
    const sat = await renderPdfPages(SAT_PDF!, PAGES, tmp, 'sat');

    const rows: unknown[] = [];
    const realInfo = console.info;

    for (let i = 0; i < Math.min(cagi.length, sat.length); i += 1) {
      const page = i + 1;
      const keyRow = key.pages.find((p) => Number(p.page) === page) ?? {};

      const lines: string[] = [];
      console.info = (...args: unknown[]) => { lines.push(String(args[0])); };
      process.env.MARK_DECISION_TRACE = '1';
      let draft: Record<string, unknown> = {};
      try {
        draft = (await recognizeStudentForms(cagi[i], sat[i])) as unknown as Record<string, unknown>;
      } catch (e) {
        console.info = realInfo;
        console.info(`p${page} recognize threw: ${String(e).slice(0, 160)}`);
        continue;
      } finally {
        delete process.env.MARK_DECISION_TRACE;
        console.info = realInfo;
      }

      // last accepted trace per field wins -- a group can be traced more than
      // once (a refused first pass, then the pass that produced the value).
      const byField = new Map<string, ReturnType<typeof parseTrace>>();
      for (const line of lines) {
        const t = parseTrace(line);
        if (!t) continue;
        const prev = byField.get(t.field);
        if (!prev || t.outcome !== 'low') byField.set(t.field, t);
      }

      const values = (draft.values ?? draft) as Record<string, unknown>;
      for (const [field, t] of Array.from(byField.entries())) {
        if (!t || t.n !== 2) continue;      // binary groups only
        const want = keyRow[field.replace(/^satisfaction\./, 'satisfaction.')] as unknown;
        const got = values?.[field] ?? (values as Record<string, Record<string, unknown>>)?.[field.split('.')[0]]?.[field.split('.')[1]];
        rows.push({
          page,
          field,
          outcome: t.outcome,
          refused: t.refused,
          winner: t.scores[0],
          runnerUp: t.scores[1],
          ratio: t.scores[1] > 0 ? Number((t.scores[0] / t.scores[1]).toFixed(3)) : null,
          want: want === undefined ? null : want,
          got: got === undefined ? null : got,
        });
      }
      realInfo(`p${page} groups=${byField.size}`);
    }

    fs.writeFileSync(OUT!, rows.map((r) => JSON.stringify(r)).join('\n'));
    realInfo(`wrote ${rows.length} rows -> ${OUT}`);
  }, 1_800_000);
});
