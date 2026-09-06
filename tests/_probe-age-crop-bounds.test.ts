import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  applyTemplateRegistrationFrame,
  hasUsableFormBounds,
  loadImageAnalysisData,
} from '../src/lib/recognition/markDensity';
import { getTemplate } from '../src/lib/recognition/roiTemplates';
import { buildCagiGridDetection } from '../src/lib/recognition/tableGridDetection';
import { matchBasicCheckboxes } from '../src/lib/recognition/basicCheckboxDetection';
import {
  selectGridDetectionStream,
  mergeBasicCheckboxDetection,
  buildPageInkCalibration,
} from '../src/lib/recognition/detectCheckmarks';
import { loadBlankFormBaseline } from '../src/lib/recognition/templateBaseline';
import { recognizeDigitsInRegionDetailed } from '../src/lib/recognition/ocrTextLines';
import { classifyDigit } from '../src/lib/recognition/mnist12';

/**
 * ONE-OFF PROBE -- delete after the round.
 *
 * §2, instrument before fixing. Docs/18 §5.2 found that `getAgeDigitsRect`'s
 * 12% top inset cuts the tops off handwritten digits: p3 of set 1 splits into
 * zero strokes because the second digit is gone, and p4/p8/p16 read a topless
 * 3 or 5 as a 7. This sweeps the top inset and reports raw two-digit accuracy
 * against the answer key at each setting.
 *
 * WHAT KILLS THE HYPOTHESIS: if accuracy is flat or falls as the crop grows
 * upward, the digits were not being clipped and the misreads come from the
 * model or the scan, not the rectangle.
 *
 *   CAGI_DIR=<rendered pages> PAGES=19 KEY=<answer-key.json> \
 *     TOPS=0.12,0.06,0,-0.06,-0.12,-0.20 OUT=<file> \
 *     npx vitest run tests/_probe-age-crop-bounds.test.ts
 */

const CAGI_DIR = process.env.CAGI_DIR;
const PAGE_COUNT = Number(process.env.PAGES || 19);
const OUT = process.env.OUT;
const KEY = process.env.KEY;
const TOPS = (process.env.TOPS || '0.12,0.06,0,-0.06,-0.12,-0.20').split(',').map(Number);
const BOTTOM = Number(process.env.BOTTOM ?? 0.12);
const SIDE = Number(process.env.SIDE ?? 0.06);

type Rect = { left: number; right: number; top: number; bottom: number };

/** getAgeDigitsRect with the insets opened up, so one code path serves every variant. */
function ageRectWithInsets(rect: Rect, top: number, bottom: number, side: number): Rect {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  return {
    left: Math.round(rect.left + width * side),
    right: Math.round(rect.left + width * (1 - side)),
    top: Math.round(rect.top + height * top),
    bottom: Math.round(rect.top + height * (1 - bottom)),
  };
}

function emit(line: string): void {
  console.info(line);
  if (OUT) {
    try { fs.appendFileSync(OUT, `${line}\n`); } catch { /* instrumentation only */ }
  }
}

const run = CAGI_DIR ? describe : describe.skip;

run('age crop bounds sweep', () => {
  it('reports raw digit accuracy per top inset without changing any product default', async () => {
    const cagiTemplate = getTemplate('cagi');
    const cagiBaseline = await loadBlankFormBaseline('cagi');
    const basicGroups = cagiTemplate.choiceGroups.filter((group) => group.field.startsWith('basic.'));

    const key: Record<number, number | null> = {};
    if (KEY && fs.existsSync(KEY)) {
      const parsed = JSON.parse(fs.readFileSync(KEY, 'utf8')) as { pages?: Array<Record<string, unknown>> };
      for (const page of parsed.pages || []) key[Number(page.page)] = page['basic.age'] as number | null;
    }

    const tally: Record<string, { correct: number; wrong: number; noStrokes: number; blankOk: number; blankMissed: number }> = {};
    for (const top of TOPS) tally[String(top)] = { correct: 0, wrong: 0, noStrokes: 0, blankOk: 0, blankMissed: 0 };

    for (let n = 1; n <= PAGE_COUNT; n++) {
      const label = `page-${String(n).padStart(4, '0')}`;
      const cagiPath = path.join(CAGI_DIR!, `${label}.jpg`);
      if (!fs.existsSync(cagiPath)) { emit(`[agecrop] page=${n} missing-file`); continue; }

      const cagiImageData = await loadImageAnalysisData(cagiPath);
      const cagiRegisteredImage = applyTemplateRegistrationFrame(cagiImageData, cagiTemplate.registrationFrame);
      const cagiImageBuffer = fs.readFileSync(cagiPath);
      if (!hasUsableFormBounds(cagiRegisteredImage)) { emit(`[agecrop] page=${n} bounds-not-usable`); continue; }

      const cagiGridStream = await selectGridDetectionStream(cagiRegisteredImage, buildCagiGridDetection, false);
      const cagiImage = cagiGridStream.scoringImage;
      const basicCheckboxDetection = cagiBaseline?.basicCheckboxCandidateRects
        ? matchBasicCheckboxes(cagiImage, basicGroups, cagiBaseline.image, cagiBaseline.basicCheckboxCandidateRects)
        : undefined;
      const cagiGridDetection = mergeBasicCheckboxDetection(
        cagiGridStream.detection, basicGroups, basicCheckboxDetection, Boolean(cagiBaseline?.basicCheckboxCandidateRects),
      );
      const ageRect = cagiGridDetection.fieldRects['basic.age'];
      const templateAgeRect = cagiBaseline?.fieldRects['basic.age'];
      if (!ageRect) { emit(`[agecrop] page=${n} no-age-rect`); continue; }

      const cagiPreCalibration = buildPageInkCalibration(
        cagiImage, cagiTemplate.choiceGroups, cagiGridDetection.overrides, {},
        cagiGridDetection.registrations, cagiBaseline, basicGroups, false,
      );
      const want = key[n];
      const parts: string[] = [];

      for (const top of TOPS) {
        const result = await recognizeDigitsInRegionDetailed(
          cagiImageBuffer,
          cagiImage.width,
          cagiImage.height,
          ageRectWithInsets(ageRect, top, BOTTOM, SIDE),
          {
            photoProvenance: false,
            grayscaleScan: cagiPreCalibration?.inputClass === 'grayscale-scan',
            exposeStrokes: true,
          },
          cagiBaseline && templateAgeRect
            ? { image: cagiBaseline.image, rect: ageRectWithInsets(templateAgeRect, top, BOTTOM, SIDE) }
            : undefined,
        );
        const strokes = result.strokes ?? [];
        const reads = strokes.map((s) => classifyDigit(s.data, s.width, s.height));
        const t = tally[String(top)];
        let verdict: string;
        let value: number | undefined;
        if (strokes.length !== 2 || reads.some((r) => !r)) {
          verdict = `strokes${strokes.length}`;
          if (want === null) { t.blankOk += 1; verdict += '/blank-ok'; } else t.noStrokes += 1;
        } else {
          value = Number(`${reads[0]!.digit}${reads[1]!.digit}`);
          if (want === null) { t.blankMissed += 1; verdict = `${value}/BLANK-FILLED`; }
          else if (value === want) { t.correct += 1; verdict = `${value}/ok`; }
          else { t.wrong += 1; verdict = `${value}/WRONG(want ${want})`; }
        }
        const conf = reads.map((r) => (r ? r.confidence.toFixed(2) : '-')).join(',');
        parts.push(`top=${top}:${verdict}[${conf}]`);
      }
      emit(`[agecrop] page=${n} want=${want === null ? 'blank' : want}  ${parts.join('  ')}`);
    }

    emit('[agecrop] --- summary (raw two-digit read, no gates) ---');
    for (const top of TOPS) {
      const t = tally[String(top)];
      emit(`[agecrop] top=${top}  correct=${t.correct}  wrong=${t.wrong}  no-two-strokes=${t.noStrokes}`
        + `  blank-left-blank=${t.blankOk}  blank-filled=${t.blankMissed}`);
    }
  }, 1_800_000);
});
