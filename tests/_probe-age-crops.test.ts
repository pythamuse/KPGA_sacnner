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
} from '../src/lib/recognition/detectCheckmarks';
import { loadBlankFormBaseline } from '../src/lib/recognition/templateBaseline';
import { recognizeDigitsInRegionDetailed } from '../src/lib/recognition/ocrTextLines';

/**
 * ONE-OFF PROBE -- delete after the round
 * (Task/CYCLE3_AGE_OCR_PROBE_AGENT_REPORT_2026-09-05.md).
 *
 * Replays exactly the call sequence `recognizeStudentForms` makes to reach
 * `basic.age` (`src/lib/recognition/detectCheckmarks.ts` lines ~213-281),
 * over the 19 rendered CAGI pages, and asks the real OCR path
 * (`recognizeDigitsInRegionDetailed`) to dump its crop/work/stroke PNGs via
 * `AGE_OCR_DUMP_DIR` + `dumpLabel`. Reads no answer key and makes no
 * judgement -- it only reports what the pipeline saw and did.
 *
 *   CAGI_DIR="<dir with page-00NN.jpg>" OUT="<dump dir>" \
 *     npx vitest run tests/_probe-age-crops.test.ts
 */

const CAGI_DIR = process.env.CAGI_DIR;
const OUT = process.env.OUT;
const PAGE_COUNT = Number(process.env.PAGE_COUNT || 19);

const run = CAGI_DIR && OUT ? describe : describe.skip;

run('age crop dump', () => {
  it('replays the product basic.age OCR path for every page and dumps crop/work/stroke PNGs', async () => {
    fs.mkdirSync(OUT!, { recursive: true });
    // The env var the dump hook in ocrTextLines.ts is gated on. Set here,
    // for this process only, rather than assumed on the shell so the probe
    // is runnable with one command.
    process.env.AGE_OCR_DUMP_DIR = OUT;

    const cagiTemplate = getTemplate('cagi');
    const cagiBaseline = await loadBlankFormBaseline('cagi');
    const basicGroups = cagiTemplate.choiceGroups.filter((group) => group.field.startsWith('basic.'));

    for (let n = 1; n <= PAGE_COUNT; n++) {
      const label = `page-${String(n).padStart(4, '0')}`;
      const cagiPath = path.join(CAGI_DIR!, `${label}.jpg`);
      if (!fs.existsSync(cagiPath)) {
        console.info(`[age-crops] page=${label} SKIPPED missing file ${cagiPath}`);
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
        console.info(`[age-crops] page=${label} value=undefined gate=bounds-not-usable`);
        continue;
      }
      if (!ageRect) {
        console.info(`[age-crops] page=${label} value=undefined gate=no-age-rect`);
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
          dumpLabel: label,
        },
        cagiBaseline && templateAgeRect
          ? { image: cagiBaseline.image, rect: getAgeDigitsRect(templateAgeRect) }
          : undefined,
      );

      console.info(
        `[age-crops] page=${label} value=${ageResult.value ?? 'undefined'} `
        + `status=${ageResult.status} gate=${ageResult.diagnostic}`,
      );
    }
  }, 600_000);
});
