import { describe, expect, it } from 'vitest';
import path from 'path';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { loadImageAnalysisData, type ImageAnalysisData, type PixelRect } from '../src/lib/recognition/markDensity';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from '../src/lib/recognition/tableGridDetection';
import {
  cagiTemplate,
} from '../src/lib/recognition/roiTemplates';

const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'blank-form');
const cagiPath = path.join(fixtureDir, 'cagi-blank.png');
const satisfactionPath = path.join(fixtureDir, 'satisfaction-blank.png');

const cagiFields = Array.from({ length: 9 }, (_, index) => `cagi.q${String(index + 1).padStart(2, '0')}`);
const satisfactionFields = Array.from(
  { length: 10 },
  (_, index) => `satisfaction.q${String(index + 1).padStart(2, '0')}`,
);
const basicFields = ['basic.gender', 'basic.schoolType', 'basic.grade'];

// Measured against the committed blank-form fixture. These are intentionally
// independent from the old template anchors so a wrong-table match fails.
const measuredCagiYs = [0.3335, 0.3592, 0.3848, 0.4018, 0.4189, 0.4360, 0.4531, 0.5120, 0.5300];
const measuredSatisfactionYs = [0.2852, 0.4293, 0.4775, 0.5257, 0.5610, 0.5968, 0.7510, 0.7815, 0.8120, 0.8420];
const measuredBasicYs = [0.1540, 0.1788, 0.2180];
const measuredSatisfactionQ01Xs = [0.6911, 0.7712, 0.8515, 0.9419];

describe('real blank-form detection', () => {
  it('resolves every CAGI and satisfaction field from grid or row detection', async () => {
    const draft = await recognizeStudentForms(cagiPath, satisfactionPath, {
      // This test is for the pixel detector and its source selection. If pixel
      // matching regresses, do not let a slow OCR fallback hide the diagnostic.
      ocrDeadlineAt: Date.now(),
    });
    const fields = [...cagiFields, ...satisfactionFields, ...basicFields];
    const sources = Object.fromEntries(fields.map((field) => [
      field,
      draft.recognitionCropSource?.[field] || 'missing',
    ]));

    console.info('blank-form recognition sources', JSON.stringify(sources, null, 2));
    expect(draft.basic.age).toBeUndefined();
    expect(draft.confidence['basic.age']).toBe('medium');
    for (const field of fields) {
      expect(['grid', 'row'], `${field}: ${draft.recognitionCropDiagnostic?.[field] || 'no source'}`)
        .toContain(sources[field]);
    }
  });

  it('keeps detected row centres within 0.01 of the measured template coordinates', async () => {
    const cagiImage = await loadImageAnalysisData(cagiPath);
    const satisfactionImage = await loadImageAnalysisData(satisfactionPath);
    const cagiGrid = buildCagiGridDetection(cagiImage);
    console.info('blank coordinate comparison', JSON.stringify([
      ...summarizeGridCoordinates(cagiImage, cagiGrid.overrides, cagiFields, measuredCagiYs),
      ...summarizeGridCoordinates(cagiImage, cagiGrid.overrides, basicFields, measuredBasicYs),
      ...summarizeGridCoordinates(
        satisfactionImage,
        buildSatisfactionGridDetection(satisfactionImage).overrides,
        satisfactionFields,
        measuredSatisfactionYs,
      ),
    ], null, 2));

    expectGridCentres(cagiImage, cagiGrid.overrides, cagiFields, measuredCagiYs);
    const satisfactionGrid = buildSatisfactionGridDetection(satisfactionImage);
    expectGridCentres(
      satisfactionImage,
      satisfactionGrid.overrides,
      satisfactionFields,
      measuredSatisfactionYs,
    );
    expectGridCentres(cagiImage, cagiGrid.overrides, basicFields, measuredBasicYs);

    expectGridXCentres(
      satisfactionImage,
      satisfactionGrid.overrides,
      ['satisfaction.q01'],
      measuredSatisfactionQ01Xs,
    );
    expectTemplateXCentres(cagiImage, cagiGrid.overrides, basicFields);

  });
});

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

function summarizeGridCoordinates(
  image: ImageAnalysisData,
  overrides: Record<string, PixelRect[]>,
  fields: string[],
  referenceYs: number[],
) {
  const bounds = image.contentBounds || { left: 0, top: 0, right: image.width, bottom: image.height };
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;

  return fields.map((field) => {
    const cells = overrides[field] || [];
    const top = Math.min(...cells.map((cell) => cell.top));
    const bottom = Math.max(...cells.map((cell) => cell.bottom));
    return {
      field,
      source: 'grid',
      x: cells.map((cell) => Number((((cell.left + cell.right) / 2 - bounds.left) / baseWidth).toFixed(4))),
      y: Number((((top + bottom) / 2 - bounds.top) / baseHeight).toFixed(4)),
      referenceY: referenceYs[fields.indexOf(field)],
    };
  });
}

function expectGridXCentres(
  image: ImageAnalysisData,
  overrides: Record<string, PixelRect[]>,
  fields: string[],
  expectedXs: number[],
) {
  const bounds = image.contentBounds || { left: 0, right: image.width };
  const baseWidth = bounds.right - bounds.left;
  const cells = overrides[fields[0]];
  expect(cells, `${fields[0]}: grid was not detected`).toBeDefined();
  const actualXs = cells!.map((cell) => ((cell.left + cell.right) / 2 - bounds.left) / baseWidth);
  expectedXs.forEach((expectedX, index) => {
    expect(Math.abs(actualXs[index] - expectedX), `${fields[0]}: detected x ${actualXs[index]}`)
      .toBeLessThanOrEqual(0.01);
  });
}

function expectTemplateXCentres(
  image: ImageAnalysisData,
  overrides: Record<string, PixelRect[]>,
  fields: string[],
) {
  const bounds = image.contentBounds || { left: 0, right: image.width };
  const baseWidth = bounds.right - bounds.left;

  fields.forEach((field) => {
    const group = cagiTemplate.choiceGroups.find((item) => item.field === field);
    const cells = overrides[field];
    expect(group, `${field}: template group missing`).toBeDefined();
    expect(cells, `${field}: row was not detected`).toBeDefined();
    group!.candidates.forEach((candidate, index) => {
      const actualX = ((cells![index].left + cells![index].right) / 2 - bounds.left) / baseWidth;
      const expectedX = candidate.rect.x + candidate.rect.width / 2;
      expect(Math.abs(actualX - expectedX), `${field}: detected x ${actualX}`)
        .toBeLessThanOrEqual(0.01);
    });
  });
}
