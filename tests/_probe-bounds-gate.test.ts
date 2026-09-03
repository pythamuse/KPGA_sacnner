import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * Audit finding B-1: the form-bounds gate accepts 'frame' and legacy bounds,
 * not only paper bounds. The verification round (DESIGN_AUDIT_VERIFICATION
 * §3.1) could not say how often that fallback actually fires on real input.
 * This counts it, per sheet, on scans (PDF) or already-warped photo dirs.
 *
 *   MARK_BOUNDS_TRACE=1 SET=1 CAGI_PDF=.. SAT_PDF=.. [SAT_REVERSED=1] OUT=..jsonl
 *   MARK_BOUNDS_TRACE=1 SET=p1 CAGI_DIR=.. SAT_DIR=.. PHOTO=1 OUT=..jsonl
 *     npx vitest run tests/_probe-bounds-gate.test.ts
 */

const SET = process.env.SET || '?';
const OUT = process.env.OUT;
const PHOTO = Boolean(process.env.PHOTO);
const PAGES = Number(process.env.PAGES || 19);
const PRODUCTION_RENDER = PDF_RENDER_OPTIONS[0];

const listImages = (dir: string) => fs.readdirSync(dir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0))
  .map((f) => path.join(dir, f));

async function renderPdf(pdfPath: string, outDir: string, tag: string): Promise<string[]> {
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
  const files: string[] = [];
  for (let p = 1; p <= Math.min(PAGES, doc.numPages); p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: PRODUCTION_RENDER.scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const out = path.join(outDir, `${tag}-p${p}.jpg`);
    fs.writeFileSync(out, canvas.toBuffer('image/jpeg', { quality: PRODUCTION_RENDER.quality }));
    files.push(out);
  }
  return files;
}

const ready = OUT && (PHOTO ? process.env.CAGI_DIR && process.env.SAT_DIR : process.env.CAGI_PDF && process.env.SAT_PDF);
const run = ready ? describe : describe.skip;

run('bounds gate probe', () => {
  it('records which bounds source reached the gate on every sheet', async () => {
    let cagi: string[];
    let sat: string[];
    if (PHOTO) {
      cagi = listImages(process.env.CAGI_DIR!);
      sat = listImages(process.env.SAT_DIR!);
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-gate-'));
      cagi = await renderPdf(process.env.CAGI_PDF!, tmp, 'cagi');
      sat = await renderPdf(process.env.SAT_PDF!, tmp, 'sat');
      if (process.env.SAT_REVERSED) sat = [...sat].reverse();
    }
    const rows: unknown[] = [];
    const realInfo = console.info;
    for (let i = 0; i < Math.min(cagi.length, sat.length); i += 1) {
      const lines: string[] = [];
      const realLog = console.log;
      console.info = (...args: unknown[]) => { lines.push(String(args[0])); };
      console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
      let draft: Record<string, unknown> = {};
      try {
        draft = (await recognizeStudentForms(cagi[i], sat[i], {
          cagiPhotoProvenance: PHOTO,
          satisfactionPhotoProvenance: PHOTO,
        })) as unknown as Record<string, unknown>;
      } finally {
        console.info = realInfo;
        console.log = realLog;
      }
      const source = (draft.recognitionValueSource || {}) as Record<string, string>;
      const registration = (draft.recognitionRegistration || {}) as Record<string, { status?: string }>;
      // Age OCR: value, source and the decision sentence (carries the tesseract
      // confidence), for re-deriving the acceptance floor from real sets.
      {
        const basic = (draft.basic || {}) as Record<string, unknown>;
        const traces = (draft.recognitionDecisionTrace || {}) as Record<string, string>;
        rows.push({ set: SET, page: i + 1, kind: 'age', got: basic.age ?? null, source: source['basic.age'] ?? null, trace: (traces['basic.age'] || '').slice(0, 400) });
      }
      for (const line of lines) {
        const bp = /^\[baseline-pair\] field=(\S+) maxDev=([\d.]+) pitchMin=([\d.]+) ok=(\d)/.exec(line);
        if (bp) {
          rows.push({ set: SET, page: i + 1, kind: 'baseline-pair', field: bp[1], maxDev: Number(bp[2]), pitchMin: Number(bp[3]), ok: bp[4] === '1' });
          continue;
        }
        const g = /^\[grid-fit\] (.*)$/.exec(line);
        if (g) {
          const kv: Record<string, string | number> = { set: SET, page: i + 1, kind: 'grid-fit' };
          for (const token of g[1].split(' ')) {
            const eq = token.indexOf('=');
            if (eq > 0) {
              const v = token.slice(eq + 1);
              kv[token.slice(0, eq)] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
            }
          }
          rows.push(kv);
          continue;
        }
        const m = /\[bounds-gate\] sheet=(\w+) source=(\S+) confident=(\d) usable=(\d) reason=(.*)$/.exec(line);
        if (!m) continue;
        const sheet = m[1];
        const prefix = sheet === 'cagi' ? /^(basic|cagi)\./ : /^satisfaction\./;
        const autoCount = Object.entries(source).filter(([k, v]) => prefix.test(k) && v === 'auto').length;
        const verified = Object.entries(registration).filter(([k, v]) => prefix.test(k) && v?.status === 'verified').length;
        rows.push({ set: SET, page: i + 1, kind: 'bounds-gate', sheet, source: m[2], confident: m[3] === '1', usable: m[4] === '1', reason: m[5], autoCount, verifiedFields: verified });
      }
      realInfo(`${SET} p${i + 1} ${lines.filter((l) => l.startsWith('[bounds-gate]')).join(' || ')}`);
    }
    fs.writeFileSync(OUT!, rows.map((r) => JSON.stringify(r)).join('\n'));
    realInfo(`wrote ${rows.length} rows -> ${OUT}`);
  }, 1_800_000);
});
