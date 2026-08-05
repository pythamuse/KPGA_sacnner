import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { cagiTemplate, ChoiceGroup, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';

const fixtureDir = path.join(process.cwd(), 'tmp', 'test-satisfaction-recognition');

afterAll(() => {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('만족도 ROI 인식', () => {
  it('문항1~10 선택값을 만족도 draft에 반영한다', async () => {
    const cagiPath = path.join(fixtureDir, 'cagi.png');
    const satisfactionPath = path.join(fixtureDir, 'satisfaction.png');

    await writeMarkedForm(cagiPath, cagiTemplate.choiceGroups, {
      'basic.gender': 0,
      'cagi.q01': 0,
      'cagi.q02': 0,
      'cagi.q03': 0,
      'cagi.q04': 0,
      'cagi.q05': 0,
      'cagi.q06': 0,
      'cagi.q07': 0,
      'cagi.q08': 0,
      'cagi.q09': 0,
    }, true, true);
    await writeMarkedForm(satisfactionPath, satisfactionTemplate.choiceGroups, {
      'satisfaction.q01': 4,
      'satisfaction.q02': 1,
      'satisfaction.q03': 1,
      'satisfaction.q04': 1,
      'satisfaction.q05': 1,
      'satisfaction.q06': 1,
      'satisfaction.q07': 4,
      'satisfaction.q08': 4,
      'satisfaction.q09': 4,
      'satisfaction.q10': 4,
    }, true, true);

    const draft = await recognizeStudentForms(cagiPath, satisfactionPath);

    expect(draft.satisfaction).toMatchObject({
      q01: 4,
      q02: 1,
      q03: 1,
      q04: 1,
      q05: 1,
      q06: 1,
      q07: 4,
      q08: 4,
      q09: 4,
      q10: 4,
    });
    expect(draft.confidence['satisfaction.q01']).toBe('high');
    expect(draft.candidates?.['satisfaction.q10']?.[0]).toMatchObject({ value: 4 });
  });

  it('종이 경계를 찾지 못한 이미지는 자동값을 확정하지 않는다', async () => {
    const cagiPath = path.join(fixtureDir, 'cagi-no-frame.png');
    const satisfactionPath = path.join(fixtureDir, 'satisfaction-no-frame.png');

    await writeMarkedForm(cagiPath, cagiTemplate.choiceGroups, {
      'basic.gender': 0,
      'cagi.q01': 0,
    }, false);
    await writeMarkedForm(satisfactionPath, satisfactionTemplate.choiceGroups, {
      'satisfaction.q01': 4,
    }, false);

    const draft = await recognizeStudentForms(cagiPath, satisfactionPath);

    expect(draft.cagi.q01).toBeUndefined();
    expect(draft.satisfaction.q01).toBeUndefined();
    expect(draft.confidence['cagi.q01']).toBe('low');
    expect(draft.confidence['satisfaction.q01']).toBe('low');
    expect(draft.warnings).toHaveLength(2);
  });
});

async function writeMarkedForm(
  filePath: string,
  groups: ChoiceGroup[],
  selectedValues: Record<string, number | string>,
  includeFrame = true,
  includeTableGrids = false,
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const width = 1000;
  const height = 1400;
  const bounds = {
    left: 100,
    top: 100,
    width: 800,
    height: 1200,
  };

  const marks = groups.flatMap((group) => {
    const selectedValue = selectedValues[group.field];
    if (selectedValue === undefined) {
      return [];
    }

    const candidate = group.candidates.find((item) => item.value === selectedValue);
    if (!candidate) {
      return [];
    }

    const cx = bounds.left + (candidate.rect.x + candidate.rect.width / 2) * bounds.width;
    const cy = bounds.top + (candidate.rect.y + candidate.rect.height / 2) * bounds.height;
    const radius = Math.max(candidate.rect.width * bounds.width, candidate.rect.height * bounds.height) * 0.62;
    return [`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#000"/>`];
  });

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#fff"/>
      ${includeFrame ? `<rect x="${bounds.left}" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="#000" stroke-width="6"/>` : ''}
      ${includeTableGrids ? renderResponseGrids(groups, bounds) : ''}
      ${marks.join('\n')}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

function renderResponseGrids(
  groups: ChoiceGroup[],
  bounds: { left: number; top: number; width: number; height: number },
): string {
  const prefix = groups.some((group) => group.field.startsWith('cagi.')) ? 'cagi.' : 'satisfaction.';
  const specs = prefix === 'cagi.'
    ? [
      ['cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07'],
      ['cagi.q08', 'cagi.q09'],
    ]
    : [
      ['satisfaction.q01'],
      ['satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06'],
      ['satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10'],
    ];

  return specs.map((fields) => {
    const tableGroups = fields
      .map((field) => groups.find((group) => group.field === field))
      .filter((group): group is ChoiceGroup => Boolean(group));
    if (tableGroups.length !== fields.length) return '';

    const columnCenters = tableGroups[0].candidates.map((candidate) => candidate.rect.x + candidate.rect.width / 2);
    const rowCenters = tableGroups.map((group) => average(group.candidates.map(
      (candidate) => candidate.rect.y + candidate.rect.height / 2,
    )));
    const xLines = toPixels(deriveBoundaries(columnCenters), bounds.left, bounds.width);
    const yLines = toPixels(deriveBoundaries(rowCenters), bounds.top, bounds.height);
    return [
      ...xLines.map((x) => `<line x1="${x}" y1="${yLines[0]}" x2="${x}" y2="${yLines[yLines.length - 1]}" stroke="#000" stroke-width="3"/>`),
      ...yLines.map((y) => `<line x1="${xLines[0]}" y1="${y}" x2="${xLines[xLines.length - 1]}" y2="${y}" stroke="#000" stroke-width="3"/>`),
    ].join('\n');
  }).join('\n');
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

function toPixels(values: number[], offset: number, size: number): number[] {
  return values.map((value) => Math.round(offset + value * size));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
