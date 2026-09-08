import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { generateFieldCropBuffer } from '../src/lib/recognition/fieldCrop';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

/**
 * ONE-OFF PROBE -- delete after the round (CLAUDE.md §3 standing instruction, 2026-09-08).
 *
 * Writes, for one page image and a list of fields, the crop the review screen
 * shows. Two modes:
 *
 *   template (default)  generateFieldCropBuffer(image, field, debug) -- the
 *                       template rect, which is what /api/uploads/crop serves.
 *   FAITHFUL=1          runs recognizeStudentForms on the page first and passes
 *                       its recognitionCropRects / recognitionCandidateRects /
 *                       recognitionCropSource through, exactly as
 *                       buildSourcePreview.ts does for the review screen's
 *                       cropDataUrls. This is the image the reviewer saw.
 *
 * Raw page pixels around the rect with the production 0.022 padding (0.07 +
 * overlay for the debug variant), resized to 520px; no blank-form subtraction,
 * no binarisation. The "system crop" side of the three-way comparison.
 *
 *   IMAGE=<page jpg> [SAT=<satisfaction page jpg>] FIELDS=basic.gender,... \
 *     OUT=<dir> [LABEL=set1-p3] [FAITHFUL=1] npx vitest run tests/_probe-system-crops.test.ts
 */

const IMAGE = process.env.IMAGE;
const SAT = process.env.SAT;
const OUT = process.env.OUT;
const FIELDS = (process.env.FIELDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = process.env.LABEL || path.basename(IMAGE || 'page', path.extname(IMAGE || ''));
const FAITHFUL = process.env.FAITHFUL === '1';

const run = IMAGE && OUT && FIELDS.length ? describe : describe.skip;

run('system crops', () => {
  it('writes the review-screen crop for each field', async () => {
    fs.mkdirSync(OUT!, { recursive: true });
    let cropRects: Record<string, any> = {};
    let candidateRects: Record<string, any> = {};
    let cropSource: Record<string, any> = {};
    let rejected: Record<string, any> = {};
    if (FAITHFUL) {
      // Same call the product makes; a CAGI-only field tolerates the CAGI page
      // standing in for the satisfaction sheet (the age probes do the same).
      const draft: any = await recognizeStudentForms(IMAGE!, SAT || IMAGE!, {});
      cropRects = draft.recognitionCropRects || {};
      candidateRects = draft.recognitionCandidateRects || {};
      cropSource = draft.recognitionCropSource || {};
      rejected = draft.recognitionRejectedCandidateRects || {};
      for (const field of FIELDS) {
        console.info(`[syscrop] ${LABEL} ${field}: cropRect=${cropRects[field] ? JSON.stringify(cropRects[field]) : 'none'} source=${cropSource[field] ?? '-'} value=${JSON.stringify(field.startsWith('basic.') ? draft.basic?.[field.slice(6)] : undefined)}`);
      }
    }
    for (const field of FIELDS) {
      const safe = field.replace(/[^\w.-]/g, '_');
      const tag = FAITHFUL ? '-faithful' : '';
      const plain = await generateFieldCropBuffer(IMAGE!, field, false, cropRects[field], candidateRects[field], cropSource[field], rejected[field]);
      const debug = await generateFieldCropBuffer(IMAGE!, field, true, cropRects[field], candidateRects[field], cropSource[field], rejected[field]);
      if (plain) fs.writeFileSync(path.join(OUT!, `${LABEL}-${safe}${tag}.png`), plain);
      if (debug) fs.writeFileSync(path.join(OUT!, `${LABEL}-${safe}${tag}-debug.png`), debug);
      console.info(`[syscrop] ${LABEL} ${field}${tag}: ${plain ? plain.length + 'B' : 'none'} (debug ${debug ? 'ok' : 'none'})`);
    }
  }, 600_000);
});
