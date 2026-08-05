import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import {
  buildCagiRowOverrides,
  buildSatisfactionRowOverrides,
  detectHorizontalLines,
  matchRowPattern,
} from '../src/lib/recognition/tableRowDetection';

const fixtureDir = path.join(process.cwd(), 'tmp', 'test-table-row-detection');

afterAll(() => {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('table row detection', () => {
  it('matches a contiguous subset of horizontal lines to an expected gap pattern', () => {
    const result = matchRowPattern(
      [{ y: 10 }, { y: 30 }, { y: 50 }, { y: 60 }, { y: 70 }, { y: 80 }, { y: 90 }],
      [1, 1, 1, 1],
    );

    expect(result).toEqual({
      lineYs: [50, 60, 70, 80, 90],
      confident: true,
    });
  });

  it('returns null when no detected subset matches the expected gap pattern', () => {
    const result = matchRowPattern(
      [{ y: 10 }, { y: 20 }, { y: 45 }, { y: 60 }, { y: 90 }],
      [1, 1, 1],
    );

    expect(result).toBeNull();
  });

  it('detects dark horizontal line groups in y order', async () => {
    const image = await makeSyntheticRows([80, 100, 125], 'detected-lines.png');

    const lines = detectHorizontalLines(image, 50, 150, 50, 350, 0.5);

    expect(lines.map((line) => Math.round(line.y))).toEqual([80, 100, 125]);
  });

  it('builds CAGI row overrides when the detected rows match the template gap pattern', async () => {
    const rowYs = [334, 358, 383, 401, 419, 436, 455, 512, 530];
    const filePath = path.join(fixtureDir, 'cagi-rows.png');
    await writeSyntheticRows(filePath, rowYs);
    const image = await loadImageAnalysisData(filePath);

    const overrides = buildCagiRowOverrides(image);

    expect(Object.keys(overrides)).toHaveLength(9);
    expect(overrides['cagi.q01']).toEqual({ top: 322, bottom: 345 });
    expect(overrides['cagi.q08']).toEqual({ top: 503, bottom: 520 });
    expect(overrides['cagi.q09']).toEqual({ top: 521, bottom: 538 });
  });

  it('returns empty CAGI overrides for images without a confident row structure', async () => {
    const filePath = path.join(fixtureDir, 'blank.png');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await sharp({
      create: {
        width: 1000,
        height: 1000,
        channels: 3,
        background: '#ffffff',
      },
    }).png().toFile(filePath);
    const image = await loadImageAnalysisData(filePath);

    expect(buildCagiRowOverrides(image)).toEqual({});
  });

  it('matches satisfaction row groups independently and skips q01', async () => {
    const filePath = path.join(fixtureDir, 'satisfaction-rows.png');
    await writeSyntheticRows(filePath, [430, 478, 526, 561, 596, 750, 780, 811, 841]);
    const image = await loadImageAnalysisData(filePath);

    const overrides = buildSatisfactionRowOverrides(image);

    expect(Object.keys(overrides).sort()).toEqual([
      'satisfaction.q02',
      'satisfaction.q03',
      'satisfaction.q04',
      'satisfaction.q05',
      'satisfaction.q06',
      'satisfaction.q07',
      'satisfaction.q08',
      'satisfaction.q09',
      'satisfaction.q10',
    ]);
    expect(overrides['satisfaction.q01']).toBeUndefined();
  });
});

async function makeSyntheticRows(rowYs: number[], fileName: string) {
  const filePath = path.join(fixtureDir, fileName);
  await writeSyntheticRows(filePath, rowYs, { width: 400, height: 220, left: 40, right: 360 });
  return loadImageAnalysisData(filePath);
}

async function writeSyntheticRows(
  filePath: string,
  rowYs: number[],
  options: { width?: number; height?: number; left?: number; right?: number } = {},
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const width = options.width || 1000;
  const height = options.height || 1000;
  const left = options.left || 100;
  const right = options.right || 900;
  const lines = rowYs
    .map((y) => `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#000" stroke-width="3"/>`)
    .join('\n');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#fff"/>
      ${lines}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}
