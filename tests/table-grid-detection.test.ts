import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { ImageAnalysisData, loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import {
  buildCagiGridDetection,
  buildCagiGridOverrides,
  buildSatisfactionGridDetection,
  buildSatisfactionGridOverrides,
  deriveTemplateGridTolerances,
  detectVerticalLines,
  getAutomaticGridMissingKind,
  isAutomaticGridEligible,
  limitLinesToExpectedBands,
  matchRowLinesWithinExpectedBands,
  matchTemplateLinePattern,
  type FieldRegistration,
} from '../src/lib/recognition/tableGridDetection';
import { detectHorizontalLines } from '../src/lib/recognition/tableRowDetection';
import { cagiTemplate, satisfactionTemplate, type ChoiceGroup } from '../src/lib/recognition/roiTemplates';

const fixtureDir = path.join(process.cwd(), 'tmp', 'test-table-grid-detection');
const page = { width: 1000, height: 1400, left: 100, top: 100, right: 900, bottom: 1300 };

afterAll(() => {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('table grid detection', () => {
  it('detects vertical table rules as grouped line positions', () => {
    const pixels = Buffer.alloc(100 * 100, 255);
    for (const x of [20, 50, 80]) {
      for (let y = 10; y < 90; y++) {
        pixels[y * 100 + x] = 0;
      }
    }

    expect(detectVerticalLines({ width: 100, height: 100, pixels }, 10, 90, 10, 90).map((line) => line.x)).toEqual([20, 50, 80]);
  });

  it('maps CAGI response rows and columns to real cell-center rectangles', async () => {
    const filePath = path.join(fixtureDir, 'cagi-grid.png');
    await writeGridFixture(filePath, groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]));

    const image = await loadImageAnalysisData(filePath);
    const detection = buildCagiGridDetection(image);
    const overrides = detection.overrides;

    expect(Object.keys(overrides)).toContain('cagi.q01');
    expect(overrides['cagi.q03']).toHaveLength(4);
    expect(overrides['cagi.q03'][0].left).toBeLessThan(overrides['cagi.q03'][1].left);
    expect(overrides['cagi.q03'][0].top).toBeGreaterThan(overrides['cagi.q02'][0].top);
    expect(detection.diagnostics?.['cagi.q03']).toBeUndefined();
  });

  it('accepts a uniformly translated CAGI grid when the local geometry is valid', async () => {
    const filePath = path.join(fixtureDir, 'cagi-grid-uniform-x-offset.png');
    await writeGridFixture(filePath, groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]), {
      verticalLineOffsets: { 0: -32, 1: -32, 2: -32, 3: -32, 4: -32 },
    });

    const detection = buildCagiGridDetection(await loadImageAnalysisData(filePath));
    const registration = detection.registrations['cagi.q01'];

    expect(registration).toMatchObject({
      source: 'grid',
      status: process.env.GRID_MATCH_V2 !== '0' ? 'candidate' : 'verified',
    });
    if (process.env.GRID_MATCH_V2 !== '0') {
      expect(registration.diagnostic).toContain('V2 line match refused');
    } else {
      expect(registration.candidateCenterOffset?.x).toBeLessThan(-0.03);
      expect(registration.candidateCenterSpread?.x).toBeLessThan(0.01);
    }
    expect(detection.overrides['cagi.q01']).toHaveLength(4);
  });

  it('maps the two-column satisfaction grid independently from the scale grid', async () => {
    const filePath = path.join(fixtureDir, 'satisfaction-grid.png');
    await writeGridFixture(filePath, groupsFor(satisfactionTemplate.choiceGroups, [
      'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06',
    ]));

    const image = await loadImageAnalysisData(filePath);
    const overrides = buildSatisfactionGridOverrides(image);

    expect(overrides['satisfaction.q02']).toHaveLength(2);
    expect(overrides['satisfaction.q06'][0].top).toBeGreaterThan(overrides['satisfaction.q02'][0].top);
    // Each printed table is an independent registration unit. A two-column
    // table must never fabricate coordinates for the five-point table below.
    expect(overrides['satisfaction.q07']).toBeUndefined();
  });

  it('recovers a two-column table when only the inner and left rules survive rasterization', async () => {
    const filePath = path.join(fixtureDir, 'satisfaction-binary-missing-right-rule.png');
    await writeGridFixture(filePath, groupsFor(satisfactionTemplate.choiceGroups, [
      'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06',
    ]), {
      verticalLineIndexes: [0, 1],
      omitPageFrame: true,
    });

    const detection = buildSatisfactionGridDetection(await loadWithFixtureBounds(filePath));
    const registration = detection.registrations['satisfaction.q02'];

    expect(detection.overrides['satisfaction.q02']).toHaveLength(2);
    expect(registration).toMatchObject({
      source: 'grid',
      status: 'verified',
    });
    expect(registration.inferredVerticalLines).toMatchObject({ found: 2, expected: 3 });
    if (process.env.GRID_MATCH_V2 !== '0') {
      expect(registration.missingExpected?.columns).toEqual([2]);
      expect(registration.diagnostic).toContain('affine reconstruction');
    }
  });

  it('recovers a five-point scale from four measured internal column rules', async () => {
    const filePath = path.join(fixtureDir, 'satisfaction-scale-missing-outer-rules.png');
    await writeGridFixture(filePath, groupsFor(satisfactionTemplate.choiceGroups, [
      'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
    ]), {
      verticalLineIndexes: [1, 2, 3, 4],
      omitPageFrame: true,
    });

    const detection = buildSatisfactionGridDetection(await loadWithFixtureBounds(filePath));
    const registration = detection.registrations['satisfaction.q07'];

    expect(detection.overrides['satisfaction.q07']).toHaveLength(5);
    expect(registration).toMatchObject({
      source: 'grid',
      status: 'verified',
    });
    expect(registration.inferredVerticalLines).toMatchObject({ found: 4, expected: 6 });
    if (process.env.GRID_MATCH_V2 !== '0') {
      expect(registration.missingExpected?.columns).toEqual([0, 5]);
      expect(registration.diagnostic).toContain('affine reconstruction');
    }
  });

  it('recovers a CAGI late-table row when the internal horizontal rule is faint', async () => {
    const filePath = path.join(fixtureDir, 'cagi-late-missing-middle-row-rule.png');
    await writeGridFixture(filePath, groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q08', 'cagi.q09',
    ]), {
      horizontalLineIndexes: [0, 2],
      verticalLinePadding: 100,
      omitPageFrame: true,
    });

    const detection = buildCagiGridDetection(await loadWithFixtureBounds(filePath));
    const registration = detection.registrations['cagi.q08'];

    expect(detection.overrides['cagi.q08']).toHaveLength(4);
    expect(registration).toMatchObject({
      source: 'grid',
      status: 'verified',
    });
    expect(registration.inferredHorizontalLines).toMatchObject({ found: 2, expected: 3 });
    if (process.env.GRID_MATCH_V2 !== '0') {
      expect(registration.missingExpected?.rows).toEqual([1]);
      expect(registration.diagnostic).toContain('affine reconstruction');
    }
  });

  it('verifies a locally translated lower satisfaction scale without requiring the upper table to match', async () => {
    const filePath = path.join(fixtureDir, 'satisfaction-scale-local-y-offset.png');
    await writeGridFixture(filePath, groupsFor(satisfactionTemplate.choiceGroups, [
      'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
    ]), {
      horizontalLineOffsets: { 0: -42, 1: -42, 2: -42, 3: -42, 4: -42 },
    });

    const detection = buildSatisfactionGridDetection(await loadImageAnalysisData(filePath));
    const registration = detection.registrations['satisfaction.q07'];

    expect(detection.overrides['satisfaction.q07']).toHaveLength(5);
    expect(registration).toMatchObject({
      tableId: 'satisfaction.scale',
      source: 'grid',
      status: 'verified',
      independentRegistration: true,
    });
    if (process.env.GRID_MATCH_V2 !== '0') {
      expect(registration.missingExpected?.rows).toEqual([4]);
      expect(registration.diagnostic).toContain('affine reconstruction');
    } else {
      expect(registration.candidateCenterOffset?.y).toBeLessThan(-0.02);
    }
  });

  it('does not fabricate cells from dark printed content when table rules are absent', () => {
    const image = makeRegisteredCagiImage();
    const overrides = buildCagiGridOverrides(image);

    expect(overrides['cagi.q01']).toBeUndefined();
    expect(overrides['cagi.q07']).toBeUndefined();
  });

  it('reports lines_undetected for a blank grid region', () => {
    const detection = buildCagiGridDetection({
      width: 1000,
      height: 1400,
      pixels: Buffer.alloc(1000 * 1400, 255),
      contentBounds: page,
      contentBoundsConfident: true,
    });

    expect(detection.overrides['cagi.q01']).toBeUndefined();
    expect(detection.diagnostics?.['cagi.q01']).toBe('격자: lines_undetected (가로선 0/8개, 세로선 0/5개)');
    expect(detection.diagnostics?.['cagi.q08']).toContain('lines_undetected');
  });

  it('reports insufficient_lines with found and required counts', async () => {
    const filePath = path.join(fixtureDir, 'cagi-grid-insufficient.png');
    await writeGridFixture(filePath, groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]), { horizontalLineIndexes: [0], verticalLineIndexes: [0] });

    const detection = buildCagiGridDetection(await loadImageAnalysisData(filePath));
    const diagnostic = detection.diagnostics?.['cagi.q01'];

    expect(detection.overrides['cagi.q01']).toBeUndefined();
    expect(diagnostic).toContain('insufficient_lines');
    expect(diagnostic).toContain('1/8');
    expect(diagnostic).toMatch(/세로선 \d+\/5개/);
  });

  it('keeps a heavily mismatched grid as a review candidate instead of auto-registering it', async () => {
    const filePath = path.join(fixtureDir, 'cagi-grid-gap-mismatch.png');
    await writeGridFixture(filePath, groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]), { horizontalLineYs: [500, 510, 550, 560, 620, 625, 630, 650] });

    const detection = buildCagiGridDetection(await loadImageAnalysisData(filePath));
    const diagnostic = detection.diagnostics?.['cagi.q01'];

    if (process.env.GRID_MATCH_V2 !== '0') {
      expect(detection.overrides['cagi.q01']).toHaveLength(4);
      expect(detection.registrations['cagi.q01']).toMatchObject({
        source: 'grid',
        status: 'candidate',
      });
      expect(diagnostic).toContain('V2 line match refused');
      return;
    }

    expect(detection.overrides['cagi.q01']).toHaveLength(4);
    expect(detection.registrations['cagi.q01']).toMatchObject({
      source: 'grid',
      status: 'candidate',
    });
    expect(diagnostic).toContain('grid candidate');
    expect(detection.registrations['cagi.q01'].gapDeviation?.rows).toBeGreaterThan(0.08);
  });

  it('V2 rejects the set 4 p4 line shift when its absolute endpoints are out of bounds', () => {
    const groups = groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]);
    const expected = deriveBoundaries(groups.map((group) => average(group.candidates.map(
      (candidate) => candidate.rect.y + candidate.rect.height / 2,
    )))).map((value) => value * 100);
    const detected = [29.47, 33.62, 38.70, 40.58, 42.37, 44.16, 45.95, 47.79];

    const match = withGridMatchV2(() => matchTemplateLinePattern(detected, expected));

    expect(match).toBeNull();
  });

  it('V2 ranks the unshifted OLD p4 subset ahead of a one-row-shifted subset', () => {
    const expected = [32, 34.5, 37, 39, 41, 43, 45, 47];
    const unshifted = [32.08, 34.42, 37.11, 38.93, 41.12, 42.91, 45.09, 46.94];
    const shifted = expected.map((line) => line * 1.02 - 1.3);
    const detected = [29.47, ...unshifted, ...shifted, 49.8].sort((a, b) => a - b);

    const match = withGridMatchV2(() => matchTemplateLinePattern(detected, expected));

    expect(detected).toHaveLength(18);
    expect(match).not.toBeNull();
    expect(match?.missingExpected).toEqual([]);
    expect(match?.absoluteCenterShift).toBeLessThan(0.2);
    expect(match?.score).toBeLessThan(0.5);
    expect(match?.lines).toEqual(unshifted);
  });

  it('V2 records one missing expected boundary while reconstructing the complete pattern', () => {
    const match = withGridMatchV2(() => matchTemplateLinePattern(
      [100, 140, 220, 260, 300],
      [100, 140, 180, 220, 260, 300],
    ));

    expect(match).not.toBeNull();
    expect(match?.matchedExpected).toHaveLength(5);
    expect(match?.missingExpected).toEqual([2]);
    expect(match?.lines).toHaveLength(6);
    expect(match?.lines[2]).toBeCloseTo(180, 6);
  });

  it('allows one missing interior boundary for a verified eight-boundary grid', () => {
    const registration = makeVerifiedGridRegistration([2]);

    expect(registration.status).toBe('verified');
    expect(getAutomaticGridMissingKind(registration)).toBe('interior');
    expect(isAutomaticGridEligible(registration)).toBe(true);
  });

  it('blocks a verified grid when either end boundary is missing', () => {
    for (const missingRows of [[0], [7]]) {
      const registration = makeVerifiedGridRegistration(missingRows);

      expect(getAutomaticGridMissingKind(registration)).toBe('end');
      expect(isAutomaticGridEligible(registration)).toBe(false);
    }
  });

  it('blocks a verified grid when two boundaries are missing', () => {
    const registration = makeVerifiedGridRegistration([2, 5]);

    expect(getAutomaticGridMissingKind(registration)).toBe('multi');
    expect(isAutomaticGridEligible(registration)).toBe(false);
  });

  it('keeps a verified grid with only a missing column eligible', () => {
    const registration = makeVerifiedGridRegistration([]);
    registration.missingExpected = { rows: [], columns: [2] };

    expect(getAutomaticGridMissingKind(registration)).toBe('none');
    expect(isAutomaticGridEligible(registration)).toBe(true);
  });

  it('V2 ignores one spurious detected boundary without losing expected matches', () => {
    const match = withGridMatchV2(() => matchTemplateLinePattern(
      [100, 120, 140, 180, 220],
      [100, 140, 180, 220],
    ));

    expect(match).not.toBeNull();
    expect(match?.matchedExpected).toEqual([0, 1, 2, 3]);
    expect(match?.matchedDetected).toEqual([0, 2, 3, 4]);
    expect(match?.missingExpected).toEqual([]);
  });

  it('derives V2 uniform offset limits from each table minimum spacing', () => {
    const cagiGroups = groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]);
    const cagiColumnCenters = cagiGroups[0].candidates.map(
      (candidate) => candidate.rect.x + candidate.rect.width / 2,
    );
    const cagiRowCenters = cagiGroups.map((group) => average(group.candidates.map(
      (candidate) => candidate.rect.y + candidate.rect.height / 2,
    )));
    const cagiTolerances = deriveTemplateGridTolerances(
      'cagi.primary',
      deriveBoundaries(cagiColumnCenters),
      deriveBoundaries(cagiRowCenters),
      1,
      1,
      cagiColumnCenters,
      cagiRowCenters,
    );
    const scaleGroups = groupsFor(satisfactionTemplate.choiceGroups, [
      'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
    ]);
    const scaleColumnCenters = scaleGroups[0].candidates.map(
      (candidate) => candidate.rect.x + candidate.rect.width / 2,
    );
    const scaleRowCenters = scaleGroups.map((group) => average(group.candidates.map(
      (candidate) => candidate.rect.y + candidate.rect.height / 2,
    )));
    const scaleTolerances = deriveTemplateGridTolerances(
      'satisfaction.scale',
      deriveBoundaries(scaleColumnCenters),
      deriveBoundaries(scaleRowCenters),
      1,
      1,
      scaleColumnCenters,
      scaleRowCenters,
    );

    expect(cagiTolerances.maxUniformCandidateOffsetX).toBeCloseTo(0.02565, 5);
    expect(scaleTolerances.maxUniformCandidateOffsetY).toBeCloseTo(0.0135, 5);
    expect(scaleTolerances.maxAnchorCandidateDeviationY).toBeCloseTo(0.0165, 5);
  });

  // The three fixtures below reproduce the browser raster of set 1 p4: seven
  // spurious rules above the five-point table, three real row boundaries found
  // at the table's 0.2 dark ratio, and the two boundaries at 942/975 that only
  // appear below it. Measured positions: Task/FIELD_TEST_2026-08-21.md.
  it('limits V2 row candidates to a band around each expected boundary', () => {
    const detected = [842, 861, 865, 873.5, 884.5, 891, 895, 916.5, 1012.5, 1048.5, 1062.5, 1139];

    const band = limitLinesToExpectedBands(detected, p4ExpectedRows);

    // 0.75 x the 32.5px minimum pitch.
    expect(band?.band).toBeCloseTo(24.375, 6);
    expect(band?.lines).toEqual([891, 895, 916.5, 1012.5, 1048.5, 1062.5]);
    expect(band?.outOfBand).toBe(6);
    expect(band?.missingExpected).toEqual([1, 2]);
  });

  it('rescues the two faint boundaries inside their own bands and matches all five rows', () => {
    const image = makeRowProbeImage([
      ...p4SpuriousRows.map((y) => ({ y })),
      { y: 916 },
      { y: 1012 },
      { y: 1048 },
      { y: 951, coverage: 0.15 },
      { y: 989, coverage: 0.15 },
    ]);
    const detected = detectHorizontalLines(
      image,
      p4RowSearch.top,
      p4RowSearch.bottom,
      p4RowSearch.left,
      p4RowSearch.right,
      0.2,
      200,
    ).map((line) => line.y);

    expect(detected).toEqual([...p4SpuriousRows, 916, 1012, 1048]);
    // Flag off: the same detections give V2 nothing, because two of five
    // expected boundaries are absent and the budget is one.
    expect(withGridMatchV2(() => matchTemplateLinePattern(detected, p4ExpectedRows))).toBeNull();

    const result = withGridMatchV2(() => matchRowLinesWithinExpectedBands(
      image,
      detected,
      p4ExpectedRows,
      p4RowSearch,
      0.2,
      200,
    ));

    expect(result.outOfBand).toBe(5);
    expect(result.rescued.map((line) => [line.expectedIndex, line.y])).toEqual([[1, 951], [2, 989]]);
    expect(result.rescued.every((line) => Math.abs(line.darkRatio - 0.12) < 1e-9)).toBe(true);
    expect(result.match?.matchedExpected).toEqual([0, 1, 2, 3, 4]);
    expect(result.match?.missingExpected).toEqual([]);
    expect(result.match?.lines).toEqual([916, 951, 989, 1012, 1048]);
  });

  it('rescues nothing when the bands hold no ink at all', () => {
    const image = makeRowProbeImage(p4SpuriousRows.map((y) => ({ y })));
    const detected = detectHorizontalLines(
      image,
      p4RowSearch.top,
      p4RowSearch.bottom,
      p4RowSearch.left,
      p4RowSearch.right,
      0.2,
      200,
    ).map((line) => line.y);

    const result = withGridMatchV2(() => matchRowLinesWithinExpectedBands(
      image,
      detected,
      p4ExpectedRows,
      p4RowSearch,
      0.2,
      200,
    ));

    expect(detected).toEqual(p4SpuriousRows);
    expect(result.rescued).toEqual([]);
    expect(result.match).toBeNull();
  });

  it('registers the five-point scale by default and leaves it unregistered under GRID_BAND_V2=0', async () => {
    const groups = groupsFor(satisfactionTemplate.choiceGroups, [
      'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
    ]);
    const rowLines = toPagePixels(
      deriveBoundaries(groups.map((group) => average(group.candidates.map(
        (candidate) => candidate.rect.y + candidate.rect.height / 2,
      )))),
      page.top,
      page.bottom,
    );
    const pitch = Math.min(...rowLines.slice(1).map((line, index) => line - rowLines[index]));
    // satisfaction.scale searches 0.1 of the page height around the table.
    const searchTolerance = Math.max(12, Math.round((page.bottom - page.top) * 0.1));
    const bandPx = pitch * 0.75;
    const room = searchTolerance - bandPx - 8;
    const spurious = Array.from({ length: 7 }, (_, index) => Math.round(
      rowLines[0] - bandPx - 4 - (room * index) / 6,
    ));
    expect(room).toBeGreaterThan(24);

    const filePath = path.join(fixtureDir, 'satisfaction-scale-faint-inner-rows.png');
    await writeGridFixture(filePath, groups, {
      faintHorizontalLineIndexes: [1, 2],
      faintHorizontalLineWidthRatio: 0.12,
      extraHorizontalLineYs: spurious,
      omitPageFrame: true,
    });
    const image = await loadWithFixtureBounds(filePath);

    const withoutBand = withGridBandV2(false, () => buildSatisfactionGridDetection(image));
    const withBand = withGridBandV2(true, () => buildSatisfactionGridDetection(image));

    // Under GRID_BAND_V2=0 V2 refuses and the V1 fallback lands a row too high --
    // the same shape the browser raster of p4 produces.
    const withoutBandRegistration = withoutBand.registrations['satisfaction.q07'];
    expect(withoutBandRegistration.status).toBe('candidate');
    expect(withoutBandRegistration.diagnostic).toContain('V2 line match refused');
    expect(isAutomaticGridEligible(withoutBandRegistration)).toBe(false);
    expect(withoutBandRegistration.gapDeviation?.rows).toBeGreaterThan(0.1);

    const withBandRegistration = withBand.registrations['satisfaction.q07'];
    expect(withBandRegistration).toMatchObject({
      tableId: 'satisfaction.scale',
      source: 'grid',
      status: 'verified',
    });
    expect(withBandRegistration.missingExpected?.rows ?? []).toEqual([]);
    expect(withBandRegistration.gapDeviation?.rows).toBeLessThan(0.01);
    expect(isAutomaticGridEligible(withBandRegistration)).toBe(true);
    expect(withBand.overrides['satisfaction.q07']).toHaveLength(5);
  });
});

const p4ExpectedRows = [909.5, 942, 975.1, 1008.2, 1040.8];
const p4SpuriousRows = [842, 861, 865, 873, 884, 891, 895];
const p4RowSearch = { top: 830, bottom: 1100, left: 0, right: 200 };

function makeRowProbeImage(
  rows: Array<{ y: number; coverage?: number }>,
  width = 200,
  height = 1200,
): { width: number; height: number; pixels: Buffer } {
  const pixels = Buffer.alloc(width * height, 255);
  for (const row of rows) {
    const span = Math.round(width * (row.coverage ?? 1));
    for (let y = row.y - 1; y <= row.y + 1; y++) {
      for (let x = 0; x < span; x++) {
        pixels[y * width + x] = 0;
      }
    }
  }
  return { width, height, pixels };
}

function makeRegisteredCagiImage(): ImageAnalysisData {
  const width = 1000;
  const height = 1400;
  const pixels = Buffer.alloc(width * height, 255);
  const xScale = 0.8;
  const xOffset = 0.1;
  const yScale = 0.9;
  const yOffset = 0.08;

  for (const group of cagiTemplate.choiceGroups.filter((item) => item.field.startsWith('cagi.q'))) {
    for (const candidate of group.candidates) {
      const left = Math.round((xOffset + candidate.rect.x * xScale) * width);
      const top = Math.round((yOffset + candidate.rect.y * yScale) * height);
      const right = Math.round((xOffset + (candidate.rect.x + candidate.rect.width) * xScale) * width);
      const bottom = Math.round((yOffset + (candidate.rect.y + candidate.rect.height) * yScale) * height);
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          pixels[y * width + x] = 0;
        }
      }
    }
  }

  return {
    width,
    height,
    pixels,
    contentBounds: { left: 0, top: 0, right: width, bottom: height },
    contentBoundsConfident: true,
  };
}

function groupsFor(allGroups: ChoiceGroup[], fields: string[]): ChoiceGroup[] {
  return fields.map((field) => {
    const group = allGroups.find((item) => item.field === field);
    if (!group) throw new Error(`Missing template group: ${field}`);
    return group;
  });
}

async function writeGridFixture(
  filePath: string,
  groups: ChoiceGroup[],
  options: {
    horizontalLineIndexes?: number[];
    verticalLineIndexes?: number[];
    horizontalLineOffsets?: Record<number, number>;
    verticalLineOffsets?: Record<number, number>;
    horizontalLineYs?: number[];
    /** Rows drawn across only part of the table span: dark enough for the band rescue ratio, not for the table's own. */
    faintHorizontalLineIndexes?: number[];
    faintHorizontalLineWidthRatio?: number;
    /** Rules belonging to no expected boundary, e.g. the text underlines above a table. */
    extraHorizontalLineYs?: number[];
    verticalLineXs?: number[];
    verticalLinePadding?: number;
    omitPageFrame?: boolean;
  } = {},
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const columnCenters = groups[0].candidates.map((candidate) => candidate.rect.x + candidate.rect.width / 2);
  const rowCenters = groups.map((group) => average(group.candidates.map(
    (candidate) => candidate.rect.y + candidate.rect.height / 2,
  )));
  const xLines = toPagePixels(deriveBoundaries(columnCenters), page.left, page.right);
  const yLines = toPagePixels(deriveBoundaries(rowCenters), page.top, page.bottom);
  const selectedVerticalIndexes = options.verticalLineIndexes || xLines.map((_, index) => index);
  const selectedHorizontalIndexes = options.horizontalLineIndexes || yLines.map((_, index) => index);
  const lines = [
    ...selectedVerticalIndexes.map((index) => {
      const x = options.verticalLineXs?.[index]
        || xLines[index] + (options.verticalLineOffsets?.[index] || 0);
      const padding = options.verticalLinePadding || 0;
      return `<line x1="${x}" y1="${yLines[0] - padding}" x2="${x}" y2="${yLines[yLines.length - 1] + padding}" stroke="#000" stroke-width="4"/>`;
    }),
    ...selectedHorizontalIndexes.map((index) => {
      const y = options.horizontalLineYs?.[index]
        || yLines[index] + (options.horizontalLineOffsets?.[index] || 0);
      const right = options.faintHorizontalLineIndexes?.includes(index)
        ? xLines[0] + (xLines[xLines.length - 1] - xLines[0]) * (options.faintHorizontalLineWidthRatio ?? 0.12)
        : xLines[xLines.length - 1];
      return `<line x1="${xLines[0]}" y1="${y}" x2="${right}" y2="${y}" stroke="#000" stroke-width="4"/>`;
    }),
    ...(options.extraHorizontalLineYs || []).map((y) => (
      `<line x1="${xLines[0]}" y1="${y}" x2="${xLines[xLines.length - 1]}" y2="${y}" stroke="#000" stroke-width="4"/>`
    )),
  ].join('\n');
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}">
      <rect width="100%" height="100%" fill="#fff"/>
      ${options.omitPageFrame ? '' : `<rect x="${page.left}" y="${page.top}" width="${page.right - page.left}" height="${page.bottom - page.top}" fill="none" stroke="#000" stroke-width="4"/>`}
      ${lines}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

function deriveBoundaries(centers: number[]): number[] {
  if (centers.length === 1) {
    return [centers[0] - 0.04, centers[0] + 0.04];
  }

  return [
    centers[0] - (centers[1] - centers[0]) / 2,
    ...centers.slice(1).map((center, index) => (centers[index] + center) / 2),
    centers[centers.length - 1] + (centers[centers.length - 1] - centers[centers.length - 2]) / 2,
  ];
}

function toPagePixels(values: number[], start: number, end: number): number[] {
  return values.map((value) => Math.round(start + value * (end - start)));
}

async function loadWithFixtureBounds(filePath: string): Promise<ImageAnalysisData> {
  const image = await loadImageAnalysisData(filePath);
  return {
    ...image,
    contentBounds: page,
    contentBoundsConfident: true,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function withGridMatchV2<T>(callback: () => T): T {
  const previous = process.env.GRID_MATCH_V2;
  process.env.GRID_MATCH_V2 = '1';
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.GRID_MATCH_V2;
    } else {
      process.env.GRID_MATCH_V2 = previous;
    }
  }
}

function withGridBandV2<T>(enabled: boolean, callback: () => T): T {
  const previous = process.env.GRID_BAND_V2;
  // The band path is the default, so "off" has to be stated, not unset.
  process.env.GRID_BAND_V2 = enabled ? '1' : '0';
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.GRID_BAND_V2;
    } else {
      process.env.GRID_BAND_V2 = previous;
    }
  }
}

function makeVerifiedGridRegistration(missingRows: number[]): FieldRegistration {
  const expected = 8;
  return {
    tableId: 'cagi.primary',
    source: 'grid',
    status: 'verified',
    horizontalLines: { found: expected - missingRows.length, expected },
    inferredHorizontalLines: { found: expected - missingRows.length, expected },
    missingExpected: { rows: missingRows, columns: [] },
  };
}
