import { describe, expect, it } from 'vitest';
import path from 'path';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { loadImageAnalysisData, type ImageAnalysisData, type PixelRect } from '../src/lib/recognition/markDensity';
import {
  buildSatisfactionRowDetection,
  type RowYOverride,
} from '../src/lib/recognition/tableRowDetection';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from '../src/lib/recognition/tableGridDetection';
import {
  cagiLateQuestionYs,
  cagiQuestionYs,
  satisfactionBinaryYs,
  satisfactionScaleYs,
} from '../src/lib/recognition/roiTemplates';

const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'blank-form');
const cagiPath = path.join(fixtureDir, 'cagi-blank.png');
const satisfactionPath = path.join(fixtureDir, 'satisfaction-blank.png');

const cagiFields = Array.from({ length: 9 }, (_, index) => `cagi.q${String(index + 1).padStart(2, '0')}`);
const satisfactionFields = Array.from(
  { length: 10 },
  (_, index) => `satisfaction.q${String(index + 1).padStart(2, '0')}`,
);

describe('real blank-form detection', () => {
  it('resolves every CAGI and satisfaction field from grid or row detection', async () => {
    const draft = await recognizeStudentForms(cagiPath, satisfactionPath, {
      // This test is for the pixel detector and its source selection. If pixel
      // matching regresses, do not let a slow OCR fallback hide the diagnostic.
      ocrDeadlineAt: Date.now(),
    });
    const fields = [...cagiFields, ...satisfactionFields];
    const sources = Object.fromEntries(fields.map((field) => [
      field,
      draft.recognitionCropSource?.[field] || 'missing',
    ]));

    console.info('blank-form recognition sources', JSON.stringify(sources, null, 2));
    for (const field of fields) {
      expect(['grid', 'row'], `${field}: ${draft.recognitionCropDiagnostic?.[field] || 'no source'}`)
        .toContain(sources[field]);
    }
  });

  it('keeps detected row centres within 0.01 of the measured template coordinates', async () => {
    const cagiImage = await loadImageAnalysisData(cagiPath);
    const satisfactionImage = await loadImageAnalysisData(satisfactionPath);
    const cagiGrid = buildCagiGridDetection(cagiImage);
    const satisfactionDetection = buildSatisfactionRowDetection(satisfactionImage);

    expectGridCentres(cagiImage, cagiGrid.overrides, cagiFields, [
      ...cagiQuestionYs,
      ...cagiLateQuestionYs,
    ]);
    const satisfactionGrid = buildSatisfactionGridDetection(satisfactionImage);
    expectGridCentres(
      satisfactionImage,
      satisfactionGrid.overrides,
      satisfactionFields.slice(1),
      [...satisfactionBinaryYs, ...satisfactionScaleYs],
    );
    expectRowCentres(
      satisfactionImage,
      satisfactionDetection.overrides,
      ['satisfaction.q01'],
      [satisfactionBinaryYs[0]],
      true,
    );
  });
});

function expectRowCentres(
  image: ImageAnalysisData,
  overrides: Record<string, RowYOverride>,
  fields: string[],
  expectedYs: number[],
  useContentBounds = false,
) {
  const bounds = useContentBounds || image.contentBoundsConfident
    ? image.contentBounds!
    : { top: 0, bottom: image.height };
  const baseHeight = bounds.bottom - bounds.top;

  fields.forEach((field, index) => {
    const override = overrides[field];
    expect(override, `${field}: row was not detected`).toBeDefined();
    const centre = ((override!.top + override!.bottom) / 2 - bounds.top) / baseHeight;
    expect(Math.abs(centre - expectedYs[index]), `${field}: detected centre ${centre}`)
      .toBeLessThanOrEqual(0.01);
  });
}

function expectGridCentres(
  image: ImageAnalysisData,
  overrides: Record<string, PixelRect[]>,
  fields: string[],
  expectedYs: number[],
) {
  const bounds = image.contentBounds || { top: 0, bottom: image.height };
  const baseHeight = bounds.bottom - bounds.top;

  fields.forEach((field, index) => {
    const cells = overrides[field];
    expect(cells, `${field}: grid was not detected`).toBeDefined();
    const top = Math.min(...cells!.map((cell) => cell.top));
    const bottom = Math.max(...cells!.map((cell) => cell.bottom));
    const centre = ((top + bottom) / 2 - bounds.top) / baseHeight;
    expect(Math.abs(centre - expectedYs[index]), `${field}: detected centre ${centre}`)
      .toBeLessThanOrEqual(0.01);
  });
}
