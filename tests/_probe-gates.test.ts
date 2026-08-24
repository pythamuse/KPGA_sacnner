import { describe, it } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { PDF_RENDER_OPTIONS } from '../src/lib/pdf/pdfRenderConfig';
import { matchBatch, type StackOrder } from '../src/lib/recognition/batchMatcher';

/**
 * ONE-OFF PROBE -- delete after the round. §25.2.
 *
 * For every cell, across three scans of the same paper: which gate is holding it
 * back, by how much, and how far does the deciding quantity move between scans.
 *
 * Changes nothing. The trace already prints all four gates as have/need(ratio);
 * this only reads them and joins them to the consensus classification, so the
 * question "is the wobble a variance problem or a threshold problem" can be
 * answered before anyone writes a fix.
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
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'gates.txt');
const CELLS = process.env.REPEAT_CELLS || path.join(os.tmpdir(), 'cells.json');

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

interface Gates {
  outcome: string;
  refused: string;
  floor: [number, number];
  gap: [number, number];
  contrast: [number, number];
  size: [number, number] | null;
}

function parseGates(trace: string): Gates | undefined {
  const pair = (name: string): [number, number] | null => {
    const m = new RegExp(`(?:^|[ \\[])${name}=([\\d.]+)/([\\d.]+)\\(`).exec(trace);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const floor = pair('floor'), gap = pair('gap'), contrast = pair('contrast');
  if (!floor || !gap || !contrast) return undefined;
  return {
    outcome: /outcome=(\w+)/.exec(trace)?.[1] || '?',
    refused: /refused=([\w-]+)/.exec(trace)?.[1] || '?',
    floor, gap, contrast, size: pair('size'),
  };
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
function cv(values: number[]): number {
  const m = mean(values);
  if (m === 0) return NaN;
  const variance = mean(values.map((x) => (x - m) * (x - m)));
  return Math.sqrt(variance) / Math.abs(m);
}
function median(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return NaN;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

describe.skipIf(RUNS.length < 3)('gate wobble', () => {
  it('says which gate blocks each cell and how much the quantity moves', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-gates-'));
    // run -> "pN field" -> gates
    const byRun: Array<Map<string, Gates>> = [];

    for (const run of RUNS) {
      const cagiFiles = await renderPdfPages(run.cagi!, tmp, `${run.label}-cagi`);
      const satFiles = await renderPdfPages(run.sat!, tmp, `${run.label}-sat`);
      const pairs = matchBatch(cagiFiles, satFiles, run.order);
      const map = new Map<string, Gates>();
      const captured: string[] = [];
      const realInfo = console.info;
      console.info = (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('[marks ')) { captured.push(first); return; }
        (realInfo as (...a: unknown[]) => void)(...args);
      };
      try {
        for (let i = 0; i < pairs.length; i += 1) {
          captured.length = 0;
          await recognizeStudentForms(pairs[i].cagiPath, pairs[i].satisfactionPath);
          for (const trace of captured) {
            const field = /field=([\w.]+)/.exec(trace)?.[1];
            const gates = field ? parseGates(trace) : undefined;
            if (field && gates) map.set(`p${i + 1} ${field}`, gates);
          }
        }
      } finally {
        console.info = realInfo;
      }
      byRun.push(map);
    }

    const cells = JSON.parse(fs.readFileSync(CELLS, 'utf8')) as
      Record<string, { readings: Array<string | null>; key: unknown }>;

    // Same buckets as §24, recomputed here so the two never drift apart.
    const bucketOf = (readings: Array<string | null>, key: unknown): string => {
      const filled = readings.filter((v) => v != null) as string[];
      if (filled.length === 0) return 'stableBlank';
      if (new Set(filled).size > 1) return 'unstableValue';
      const agrees = key !== null && key !== undefined && String(key) === filled[0];
      if (filled.length < readings.length) return agrees ? 'wobbleRight' : 'wobbleWrong';
      return agrees ? 'stableCorrect' : 'stableWrong';
    };

    const rows: string[] = ['cell,bucket,binding,floorMean,floorCV,gapMean,gapCV,contrastMean,contrastCV,sizeMean,sizeCV,marginAtBinding'];
    const lines: string[] = ['================ GATE WOBBLE ================'];
    const GATES = ['floor', 'gap', 'contrast', 'size'] as const;
    const perBucket: Record<string, { binding: Record<string, number>; cvs: Record<string, number[]>; margins: number[] }> = {};

    for (const [cellKey, cell] of Object.entries(cells)) {
      const bucket = bucketOf(cell.readings, cell.key);
      const readings = byRun.map((m) => m.get(cellKey)).filter(Boolean) as Gates[];
      if (readings.length < byRun.length) continue;
      perBucket[bucket] ||= { binding: {}, cvs: { floor: [], gap: [], contrast: [], size: [] }, margins: [] };
      const slot = perBucket[bucket];

      // Binding gate: the one with the least room, averaged over the runs.
      const ratios: Record<string, number> = {};
      for (const gate of GATES) {
        const values = readings.map((r) => r[gate]).filter(Boolean) as Array<[number, number]>;
        if (values.length < readings.length) continue;
        ratios[gate] = mean(values.map(([have, need]) => (need === 0 ? Infinity : have / need)));
        slot.cvs[gate].push(cv(values.map(([have]) => have)));
      }
      const binding = Object.entries(ratios).sort((a, b) => a[1] - b[1])[0];
      const stat = (gate: typeof GATES[number]) => {
        const values = readings.map((r) => r[gate]).filter(Boolean) as Array<[number, number]>;
        if (values.length < readings.length) return [NaN, NaN];
        const haves = values.map(([have]) => have);
        return [mean(haves), cv(haves)];
      };
      const cells4 = GATES.map((g) => stat(g));
      rows.push([
        `"${cellKey}"`, bucket, binding ? binding[0] : "none",
        ...cells4.flatMap(([m, c]) => [Number.isFinite(m) ? m.toFixed(5) : "", Number.isFinite(c) ? c.toFixed(4) : ""]),
        binding ? binding[1].toFixed(4) : "",
      ].join(","));
      if (binding) {
        slot.binding[binding[0]] = (slot.binding[binding[0]] || 0) + 1;
        slot.margins.push(binding[1]);
      }
    }

    for (const bucket of ['stableCorrect', 'wobbleRight', 'stableBlank', 'wobbleWrong', 'unstableValue']) {
      const slot = perBucket[bucket];
      if (!slot) continue;
      const total = Object.values(slot.binding).reduce((a, b) => a + b, 0);
      lines.push('');
      lines.push(`--- ${bucket}  (n=${total}) ---`);
      lines.push(`  binding gate: ${Object.entries(slot.binding).sort((a, b) => b[1] - a[1])
        .map(([g, n]) => `${g} ${n} (${(100 * n / Math.max(total, 1)).toFixed(0)}%)`).join('  ')}`);
      lines.push(`  margin at the binding gate, median: ${median(slot.margins).toFixed(2)}x`
        + `   within +-10% of the bar: ${slot.margins.filter((m) => Math.abs(m - 1) <= 0.1).length}`);
      lines.push(`  scan-to-scan CV: ${GATES.map((g) => `${g} ${median(slot.cvs[g]).toFixed(3)}`).join('  ')}`);
    }

    lines.push('');
    lines.push('--- §25.3 reading ---');
    const wob = perBucket.wobbleRight, stab = perBucket.stableCorrect;
    if (wob && stab) {
      for (const gate of GATES) {
        lines.push(`  CV(${gate}): wobbling ${median(wob.cvs[gate]).toFixed(3)}`
          + `  vs stable ${median(stab.cvs[gate]).toFixed(3)}`);
      }
      lines.push(`  margin: wobbling ${median(wob.margins).toFixed(2)}x  vs stable ${median(stab.margins).toFixed(2)}x`);
    }

    const text = lines.join('\n');
    // eslint-disable-next-line no-console
    console.log(text);
    fs.writeFileSync(OUT, text, 'utf8');
    fs.writeFileSync(`${OUT}.cells.csv`, rows.join(String.fromCharCode(10)), 'utf8');
  }, 5_400_000);
});
