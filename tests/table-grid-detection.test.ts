import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { ImageAnalysisData, loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import { buildCagiGridOverrides, buildSatisfactionGridOverrides, detectVerticalLines } from '../src/lib/recognition/tableGridDetection';
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
    const overrides = buildCagiGridOverrides(image);

    expect(image.contentBoundsConfident).toBe(true);
    expect(Object.keys(overrides)).toContain('cagi.q01');
    expect(overrides['cagi.q03']).toHaveLength(4);
    expect(overrides['cagi.q03'][0].left).toBeLessThan(overrides['cagi.q03'][1].left);
    expect(overrides['cagi.q03'][0].top).toBeGreaterThan(overrides['cagi.q02'][0].top);
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

  it('does not fabricate cells from dark printed content when table rules are absent', () => {
    const image = makeRegisteredCagiImage();
    const overrides = buildCagiGridOverrides(image);

    expect(overrides['cagi.q01']).toBeUndefined();
    expect(overrides['cagi.q07']).toBeUndefined();
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

async function writeGridFixture(filePath: string, groups: ChoiceGroup[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const columnCenters = groups[0].candidates.map((candidate) => candidate.rect.x + candidate.rect.width / 2);
  const rowCenters = groups.map((group) => average(group.candidates.map(
    (candidate) => candidate.rect.y + candidate.rect.height / 2,
  )));
  const xLines = toPagePixels(deriveBoundaries(columnCenters), page.left, page.right);
  const yLines = toPagePixels(deriveBoundaries(rowCenters), page.top, page.bottom);
  const lines = [
    ...xLines.map((x) => `<line x1="${x}" y1="${yLines[0]}" x2="${x}" y2="${yLines[yLines.length - 1]}" stroke="#000" stroke-width="4"/>`),
    ...yLines.map((y) => `<line x1="${xLines[0]}" y1="${y}" x2="${xLines[xLines.length - 1]}" y2="${y}" stroke="#000" stroke-width="4"/>`),
  ].join('\n');
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}">
      <rect width="100%" height="100%" fill="#fff"/>
      <rect x="${page.left}" y="${page.top}" width="${page.right - page.left}" height="${page.bottom - page.top}" fill="none" stroke="#000" stroke-width="4"/>
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

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
