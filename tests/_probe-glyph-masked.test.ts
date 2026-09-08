import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  applyTemplateRegistrationFrame,
  hasUsableFormBounds,
  loadImageAnalysisData,
  type PixelRect,
} from '../src/lib/recognition/markDensity';
import { getTemplate } from '../src/lib/recognition/roiTemplates';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from '../src/lib/recognition/tableGridDetection';
import { matchBasicCheckboxes } from '../src/lib/recognition/basicCheckboxDetection';
import { selectGridDetectionStream, mergeBasicCheckboxDetection } from '../src/lib/recognition/detectCheckmarks';
import { loadBlankFormBaseline } from '../src/lib/recognition/templateBaseline';

/**
 * ONE-OFF PROBE -- delete after the round (Task/CONTAMINATION_2026-09-08.md §4).
 *
 * The options are printed circled digits; a tick adds a tenth of the glyph's
 * ink, and the blank asset's glyph is slightly darker than the page's, so the
 * whole-box subtraction goes negative and the tick is lost. This measures the
 * alternative reference: ink in the NON-glyph pixels only (glyph = where the
 * blank form is dark), where the blank contributes ~0 and any tick stroke that
 * leaves the glyph must show. Writes one JSONL row per candidate box:
 *   masked  = mean page ink over non-glyph pixels
 *   maskedBlank = same over the blank (residual noise floor)
 *   whole   = mean page ink over the whole box minus the blank's (today's basis)
 * Judges nothing; the offline join to the key decides.
 *
 *   SET=set1 CAGI_DIR=<dir> SAT_DIR=<dir> PAGES=19 OUT=<file.jsonl> \
 *     npx vitest run tests/_probe-glyph-masked.test.ts
 */

const SET = process.env.SET || 'set';
const CAGI_DIR = process.env.CAGI_DIR;
const SAT_DIR = process.env.SAT_DIR;
const PAGE_COUNT = Number(process.env.PAGES || 19);
const OUT = process.env.OUT;
const GLYPH_DARK = Number(process.env.GLYPH_DARK || 160); // blank pixel below this = printed glyph/rule
const DILATE = Number(process.env.DILATE || 1);

function cut(px: Buffer, width: number, r: PixelRect): { data: Uint8Array; w: number; h: number } {
  const l = Math.max(0, Math.floor(r.left)), t = Math.max(0, Math.floor(r.top));
  const w = Math.max(1, Math.ceil(r.right) - l), h = Math.max(1, Math.ceil(r.bottom) - t);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = px[(t + y) * width + l + x] ?? 255;
  return { data, w, h };
}
function resample(src: { data: Uint8Array; w: number; h: number }, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(src.w - 1, Math.floor((x + 0.5) * src.w / w));
    const sy = Math.min(src.h - 1, Math.floor((y + 0.5) * src.h / h));
    out[y * w + x] = src.data[sy * src.w + sx];
  }
  return out;
}
function measure(page: Uint8Array, blank: Uint8Array, w: number, h: number) {
  const glyph = new Uint8Array(w * h);
  for (let i = 0; i < glyph.length; i++) glyph[i] = blank[i] < GLYPH_DARK ? 1 : 0;
  if (DILATE > 0) {
    const g2 = new Uint8Array(glyph);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (glyph[y * w + x]) {
      for (let dy = -DILATE; dy <= DILATE; dy++) for (let dx = -DILATE; dx <= DILATE; dx++) {
        const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) g2[yy * w + xx] = 1;
      }
    }
    glyph.set(g2);
  }
  let mp = 0, mb = 0, n = 0, wp = 0, wb = 0;
  for (let i = 0; i < glyph.length; i++) {
    wp += (255 - page[i]) / 255; wb += (255 - blank[i]) / 255;
    if (!glyph[i]) { mp += (255 - page[i]) / 255; mb += (255 - blank[i]) / 255; n++; }
  }
  const N = glyph.length;
  return { masked: n ? mp / n : 0, maskedBlank: n ? mb / n : 0, whole: wp / N - wb / N, glyphFrac: 1 - n / N };
}

const run = CAGI_DIR && SAT_DIR && OUT ? describe : describe.skip;

run('glyph-masked ink', () => {
  it('measures non-glyph ink per candidate box on every page', async () => {
    const rows: string[] = [];
    for (const [kind, dir, tmplName, builder] of [
      ['cagi', CAGI_DIR!, 'cagi', buildCagiGridDetection],
      ['sat', SAT_DIR!, 'satisfaction', buildSatisfactionGridDetection],
    ] as const) {
      const template = getTemplate(tmplName);
      const baseline = await loadBlankFormBaseline(tmplName);
      if (!baseline) throw new Error('no baseline ' + tmplName);
      const basicGroups = template.choiceGroups.filter((g) => g.field.startsWith('basic.'));
      for (let n = 1; n <= PAGE_COUNT; n++) {
        const file = path.join(dir, `page-${String(n).padStart(4, '0')}.jpg`);
        if (!fs.existsSync(file)) continue;
        const data = await loadImageAnalysisData(file);
        const registered = applyTemplateRegistrationFrame(data, template.registrationFrame);
        if (!hasUsableFormBounds(registered)) continue;
        const stream = await selectGridDetectionStream(registered, builder as any, false);
        const image = stream.scoringImage;
        let detection: any = stream.detection;
        if (kind === 'cagi' && baseline.basicCheckboxCandidateRects) {
          const basic = matchBasicCheckboxes(image, basicGroups, baseline.image, baseline.basicCheckboxCandidateRects);
          detection = mergeBasicCheckboxDetection(stream.detection, basicGroups, basic, true);
        }
        for (const group of template.choiceGroups) {
          const cells: PixelRect[] | undefined = detection.overrides?.[group.field];
          const blankRects: PixelRect[] | undefined = (baseline.candidateRects as any)?.[group.field]
            ?? baseline.basicCheckboxCandidateRects?.[group.field];
          if (!cells || !blankRects || cells.length !== blankRects.length) continue;
          cells.forEach((cell, i) => {
            const pg = cut(image.pixels, image.width, cell);
            const bl = resample(cut(baseline.image.pixels, baseline.image.width, blankRects[i]), pg.w, pg.h);
            const m = measure(pg.data, bl, pg.w, pg.h);
            rows.push(JSON.stringify({ set: SET, page: n, field: group.field, cand: i, value: String(group.candidates[i]?.value ?? i),
              masked: +m.masked.toFixed(4), maskedBlank: +m.maskedBlank.toFixed(4), whole: +m.whole.toFixed(4), glyphFrac: +m.glyphFrac.toFixed(2) }));
          });
        }
      }
    }
    fs.mkdirSync(path.dirname(OUT!), { recursive: true });
    fs.writeFileSync(OUT!, rows.join('\n') + '\n');
    console.info(`[glyph] ${SET}: ${rows.length} boxes -> ${OUT}`);
  }, 1_800_000);
});
