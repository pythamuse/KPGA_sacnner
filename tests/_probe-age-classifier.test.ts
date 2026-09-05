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
  getAgeDigitsRect,
  recognizeStudentForms,
  applyAgeDigitClassifierFallback,
} from '../src/lib/recognition/detectCheckmarks';
import { loadBlankFormBaseline } from '../src/lib/recognition/templateBaseline';
import { recognizeDigitsInRegionDetailed } from '../src/lib/recognition/ocrTextLines';
import { classifyDigit } from '../src/lib/recognition/mnist12';

/**
 * ONE-OFF PROBE (Task/AGE_CLASSIFIER_BRIEF_2026-09-05.md).
 *
 * Replays exactly the call sequence `tests/_probe-age-crops.test.ts` uses to
 * reach `basic.age`, but with `exposeStrokes: true` instead of a PNG dump, so
 * the two stroke bitmaps can be classified directly with `classifyDigit`.
 *
 * The expected age range depends on `basic.schoolType`/`basic.grade`, which
 * this file does not derive on its own -- it calls the real
 * `recognizeStudentForms` (flag left unset, so the fallback inside it never
 * runs) to get those two fields the same way the product does, then feeds
 * everything into the same `applyAgeDigitClassifierFallback` the product
 * calls, so the printed verdict is the real gate's decision, not a
 * reimplementation of it. The satisfaction sheet is not needed for
 * `basic.*`, so the CAGI page is passed twice; a mismatched second sheet
 * only affects the satisfaction section, which is caught independently and
 * never reached by anything read here.
 *
 * Reads no answer key and makes no correctness judgement -- it only reports
 * what the classifier saw and what the real gate would have decided. No
 * student value is written anywhere but this process's own log line.
 *
 *   CAGI_DIR="<dir with page-00NN.jpg>" [PAGES=19] [OUT="<log file>"] \
 *     npx vitest run tests/_probe-age-classifier.test.ts
 */

const CAGI_DIR = process.env.CAGI_DIR;
const PAGE_COUNT = Number(process.env.PAGES || 19);
const OUT = process.env.OUT;

function emit(line: string): void {
  console.info(line);
  if (OUT) {
    try {
      fs.appendFileSync(OUT, `${line}\n`);
    } catch {
      // Instrumentation only.
    }
  }
}

const run = CAGI_DIR ? describe : describe.skip;

run('age digit-classifier probe', () => {
  it('reports per-page stroke classification and gate verdict without judging or storing a value', async () => {
    const cagiTemplate = getTemplate('cagi');
    const cagiBaseline = await loadBlankFormBaseline('cagi');
    const basicGroups = cagiTemplate.choiceGroups.filter((group) => group.field.startsWith('basic.'));

    for (let n = 1; n <= PAGE_COUNT; n++) {
      const label = `page-${String(n).padStart(4, '0')}`;
      const cagiPath = path.join(CAGI_DIR!, `${label}.jpg`);
      if (!fs.existsSync(cagiPath)) {
        emit(`[ageclf] page=${n} strokes=0 digits= range=none value=- gate=missing-file`);
        continue;
      }

      // --- exactly the sequence recognizeStudentForms runs to reach basic.age ---
      const cagiImageData = await loadImageAnalysisData(cagiPath);
      const cagiRegisteredImage = applyTemplateRegistrationFrame(cagiImageData, cagiTemplate.registrationFrame);
      const cagiImageBuffer = fs.readFileSync(cagiPath);
      const canAutoRecognizeCagi = hasUsableFormBounds(cagiRegisteredImage);

      const cagiGridStream = await selectGridDetectionStream(
        cagiRegisteredImage,
        buildCagiGridDetection,
        false, // photoProvenance -- these are scans, not photos
      );
      const cagiImage = cagiGridStream.scoringImage;
      const cagiGridBaseDetection = cagiGridStream.detection;
      const basicCheckboxDetection = cagiBaseline?.basicCheckboxCandidateRects
        ? matchBasicCheckboxes(cagiImage, basicGroups, cagiBaseline.image, cagiBaseline.basicCheckboxCandidateRects)
        : undefined;
      const cagiGridDetection = mergeBasicCheckboxDetection(
        cagiGridBaseDetection,
        basicGroups,
        basicCheckboxDetection,
        Boolean(cagiBaseline?.basicCheckboxCandidateRects),
      );

      const ageRect = cagiGridDetection.fieldRects['basic.age'];
      const templateAgeRect = cagiBaseline?.fieldRects['basic.age'];
      const cagiPreCalibration = buildPageInkCalibration(
        cagiImage,
        cagiTemplate.choiceGroups,
        cagiGridDetection.overrides,
        {},
        cagiGridDetection.registrations,
        cagiBaseline,
        basicGroups,
        false,
      );
      // --- end replayed sequence ---

      if (!canAutoRecognizeCagi) {
        emit(`[ageclf] page=${n} strokes=0 digits= range=none value=- gate=bounds-not-usable`);
        continue;
      }
      if (!ageRect) {
        emit(`[ageclf] page=${n} strokes=0 digits= range=none value=- gate=no-age-rect`);
        continue;
      }

      const ageResult = await recognizeDigitsInRegionDetailed(
        cagiImageBuffer,
        cagiImage.width,
        cagiImage.height,
        getAgeDigitsRect(ageRect),
        {
          photoProvenance: false,
          grayscaleScan: cagiPreCalibration?.inputClass === 'grayscale-scan',
          exposeStrokes: true,
        },
        cagiBaseline && templateAgeRect
          ? { image: cagiBaseline.image, rect: getAgeDigitsRect(templateAgeRect) }
          : undefined,
      );

      const strokes = ageResult.strokes ?? [];
      const digitsPart = strokes
        .map((stroke) => {
          const read = classifyDigit(stroke.data, stroke.width, stroke.height);
          return read ? `${read.digit}:${read.confidence.toFixed(2)}` : 'null';
        })
        .join(',');

      // The real basic.schoolType/basic.grade the product would have had at
      // this point -- via the real pipeline, flag left unset so its own
      // fallback never fires (that would try to fill basic.age here too,
      // which this probe does not want: it wants the pre-fallback state to
      // feed into `applyAgeDigitClassifierFallback` itself below).
      const contextDraft = await recognizeStudentForms(cagiPath, cagiPath, {});

      const fallback = applyAgeDigitClassifierFallback({
        ageValueSource: contextDraft.recognitionValueSource?.['basic.age'] ?? 'unresolved',
        schoolTypeValueSource: contextDraft.recognitionValueSource?.['basic.schoolType'] ?? 'unresolved',
        schoolType: contextDraft.basic.schoolType,
        gradeValueSource: contextDraft.recognitionValueSource?.['basic.grade'] ?? 'unresolved',
        grade: contextDraft.basic.grade,
        strokes: ageResult.strokes,
        existingTrace: contextDraft.recognitionDecisionTrace?.['basic.age'] ?? '',
      });

      const gradeMatch = contextDraft.recognitionValueSource?.['basic.grade'] === 'auto'
        ? /^([1-6])학년$/.exec(String(contextDraft.basic.grade))
        : null;
      const hasRange = contextDraft.recognitionValueSource?.['basic.schoolType'] === 'auto'
        && contextDraft.basic.schoolType === '중학교'
        && gradeMatch;
      const rangePart = hasRange
        ? `${12 + Number(gradeMatch![1]) - 1}-${12 + Number(gradeMatch![1]) + 1}`
        : 'none';

      let gate: string;
      if (fallback) {
        gate = 'passed';
      } else if (strokes.length !== 2) {
        gate = `not-two-strokes(${strokes.length})`;
      } else if (!hasRange) {
        gate = 'no-range';
      } else {
        gate = 'below-confidence-or-out-of-range';
      }

      emit(
        `[ageclf] page=${n} strokes=${strokes.length} digits=${digitsPart} `
        + `range=${rangePart} value=${fallback ? fallback.value : '-'} gate=${gate}`,
      );
    }
  }, 600_000);
});
