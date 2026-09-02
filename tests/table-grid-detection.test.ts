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
  matchTemplateLinePattern,
} from '../src/lib/recognition/tableGridDetection';
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
      status: process.env.GRID_MATCH_V2 === '1' ? 'candidate' : 'verified',
    });
    if (process.env.GRID_MATCH_V2 === '1') {
      expect(registration.missingExpected?.columns).toContain(4);
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
      status: process.env.GRID_MATCH_V2 === '1' ? 'candidate' : 'verified',
    });
    expect(registration.inferredVerticalLines).toMatchObject({ found: 2, expected: 3 });
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
      status: process.env.GRID_MATCH_V2 === '1' ? 'candidate' : 'verified',
    });
    expect(registration.inferredVerticalLines).toMatchObject({ found: 4, expected: 6 });
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
      status: process.env.GRID_MATCH_V2 === '1' ? 'candidate' : 'verified',
    });
    expect(registration.inferredHorizontalLines).toMatchObject({ found: 2, expected: 3 });
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
      status: process.env.GRID_MATCH_V2 === '1' ? 'candidate' : 'verified',
      independentRegistration: true,
    });
    if (process.env.GRID_MATCH_V2 === '1') {
      expect(registration.missingExpected?.rows).toContain(4);
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

    if (process.env.GRID_MATCH_V2 === '1') {
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

  it('V2 rejects the set 4 p4 line shift instead of mapping the header rule to q01', () => {
    const groups = groupsFor(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]);
    const expected = deriveBoundaries(groups.map((group) => average(group.candidates.map(
      (candidate) => candidate.rect.y + candidate.rect.height / 2,
    )))).map((value) => value * 100);
    const detected = [29.47, 33.62, 38.70, 40.58, 42.37, 44.16, 45.95, 47.79];

    const match = withGridMatchV2(() => matchTemplateLinePattern(detected, expected));

    expect(match).not.toBeNull();
    expect(match?.matchedExpected).toEqual([1, 3, 4, 5, 6, 7]);
    expect(match?.matchedDetected).toEqual([1, 2, 3, 4, 5, 6]);
    expect(match?.matchedDetected).not.toContain(0);
    expect(match?.missingExpected).toEqual([0, 2]);
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
});

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
      return `<line x1="${xLines[0]}" y1="${y}" x2="${xLines[xLines.length - 1]}" y2="${y}" stroke="#000" stroke-width="4"/>`;
    }),
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
