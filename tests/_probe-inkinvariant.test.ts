import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * FIELD_TEST §25.4: scan set 2 fills three cells the form leaves unmarked, two
 * of them on CLAUDE.md §3's must-be-blank list. Inventing a value is the worst
 * failure this project has.
 *
 * The trace for one of them (p3 basic.gender) says something specific. BOTH
 * candidates carry LESS ink than the blank form baseline -- page 0.029 against
 * blank 0.065, and page 0.074 against blank 0.095 -- and the scorer already
 * computes that as `inkInvariant=zeroed`. It just never acts on it here: the
 * guard is scoped to `affineToneEnabled() && photoProvenance`, so on the scan
 * path it is measured and reported and ignored.
 *
 * WHY THIS IS NOT THE GUARD THAT ALREADY FAILED. Zeroing an individual box's
 * score cost the scan path 21 correct cells (FEATURE_SPEC §14.2), because a
 * thin tick can add ink while the box still reads lighter than the printed
 * circle it sits on. The narrower statement is about the GROUP: if no candidate
 * anywhere in the row carries more ink than the blank, nobody marked anything.
 * That is a different claim and it has not been measured.
 *
 * WHAT WOULD KILL IT: groups where every candidate is ink-invariant and the
 * answer key nonetheless has a value. Each one is a correct cell a refusal
 * would destroy. This probe exists to count them, across ALL THREE sample sets
 * (CLAUDE.md §3.1), because measuring on one set is what hid §25.4 in the first
 * place.
 *
 *   CAGI_PDF=".." SAT_PDF=".." SET=1 [SAT_REVERSED=1] OUT="..jsonl" \
 *     npx vitest run tests/_probe-inkinvariant.test.ts
 */

const CAGI_PDF = process.env.CAGI_PDF;
const SAT_PDF = process.env.SAT_PDF;
const OUT = process.env.OUT;
const SET = process.env.SET || '?';
const SAT_REVERSED = Boolean(process.env.SAT_REVERSED);
const PAGES = Number(process.env.PAGES || 19);
const KEY_PATH = path.join(process.cwd(), 'local-scans', 'answer-key.json');
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

interface Box { rank: number; scr: number; page: number; blank: number; zeroed: boolean }

function parseTrace(line: string) {
  const field = /field=([\w.]+)/.exec(line)?.[1];
  const outcome = /outcome=(\w+)/.exec(line)?.[1];
  if (!field || !outcome) return null;
  const refused = /refused=([\w,-]+)/.exec(line)?.[1] ?? 'none';
  const floorRatio = Number(/floor=[0-9.]+\/[0-9.]+\(([0-9.]+)x\)/.exec(line)?.[1] ?? 'NaN');
  const boxesRaw = /boxes=\[(.*)\] pitch=/.exec(line)?.[1] ?? '';
  const boxes: Box[] = boxesRaw.split(' | ').map((seg) => {
    const rank = Number(/^(\d+)@/.exec(seg.trim())?.[1] ?? '0');
    const num = (k: string) => Number(new RegExp(`\\b${k}=(-?[0-9.]+)`).exec(seg)?.[1] ?? 'NaN');
    return {
      rank,
      scr: num('scr'),
      page: num('page'),
      blank: num('blank'),
      zeroed: /inkInvariant=zeroed/.test(seg),
    };
  }).filter((b) => Number.isFinite(b.scr));
  return { field, outcome, refused, floorRatio, boxes };
}

const ready = CAGI_PDF && SAT_PDF && OUT && fs.existsSync(KEY_PATH);
const run = ready ? describe : describe.skip;

run('ink-invariant groups', () => {
  it('dumps every group with its per-box ink, joined to the key', async () => {
    const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as { pages: Array<Record<string, unknown>> };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-ink-'));
    const cagi = await renderPdfPages(CAGI_PDF!, PAGES, tmp, 'cagi');
    const satRaw = await renderPdfPages(SAT_PDF!, PAGES, tmp, 'sat');
    const sat = SAT_REVERSED ? [...satRaw].reverse() : satRaw;

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
        realInfo(`p${page} threw: ${String(e).slice(0, 120)}`);
        continue;
      } finally {
        delete process.env.MARK_DECISION_TRACE;
        console.info = realInfo;
      }

      const byField = new Map<string, ReturnType<typeof parseTrace>>();
      for (const line of lines) {
        const t = parseTrace(line);
        if (!t) continue;
        const prev = byField.get(t.field);
        if (!prev || t.outcome !== 'low') byField.set(t.field, t);
      }

      const d = draft as Record<string, Record<string, unknown>>;
      const values: Record<string, unknown> = {
        'basic.age': d.basic?.age,
        'basic.gender': d.basic?.gender,
        'basic.schoolType': d.basic?.schoolType,
        'basic.grade': d.basic?.grade,
        ...Object.fromEntries(Object.entries(d.cagi || {}).map(([k, v]) => [`cagi.${k}`, v])),
        ...Object.fromEntries(Object.entries(d.satisfaction || {}).map(([k, v]) => [`satisfaction.${k}`, v])),
      };

      for (const [field, t] of Array.from(byField.entries())) {
        if (!t || t.boxes.length === 0) continue;
        const got = values[field];
        const want = keyRow[field];
        rows.push({
          set: SET,
          page,
          field,
          outcome: t.outcome,
          refused: t.refused,
          floorRatio: t.floorRatio,
          allZeroed: t.boxes.every((b) => b.zeroed),
          anyZeroed: t.boxes.some((b) => b.zeroed),
          winnerZeroed: t.boxes.find((b) => b.rank === 1)?.zeroed
            ?? t.boxes[0].zeroed,
          boxes: t.boxes,
          want: want === undefined ? null : want,
          got: got === undefined || got === null || got === '' ? null : got,
          keyHasNull: Object.prototype.hasOwnProperty.call(keyRow, field) && keyRow[field] === null,
        });
      }
      realInfo(`set${SET} p${page} groups=${byField.size}`);
    }

    fs.writeFileSync(OUT!, rows.map((r) => JSON.stringify(r)).join('\n'));
    realInfo(`wrote ${rows.length} rows -> ${OUT}`);
  }, 1_800_000);
});
