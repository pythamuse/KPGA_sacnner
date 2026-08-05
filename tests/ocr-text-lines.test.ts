import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { detectOcrTextLines } from '../src/lib/recognition/ocrTextLines';

const fixtureDir = path.join(process.cwd(), 'tmp', 'test-ocr-text-lines');

afterAll(() => {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('OCR text line detection', () => {
  it(
    'detects approximate y positions for Korean text lines in a cropped region',
    async () => {
      const filePath = path.join(fixtureDir, 'korean-text-lines.png');
      const expectedBaselines = [220, 300, 380, 460];
      await writeSyntheticKoreanText(filePath, expectedBaselines);
      const imageBuffer = fs.readFileSync(filePath);
      const startedAt = Date.now();

      const lines = await detectOcrTextLines(imageBuffer, 1000, 700, 120, 560, 100, 900);
      const elapsedMs = Date.now() - startedAt;
      const observed = lines.map((line) => ({
        y: Math.round(line.y),
        confidence: Math.round(line.confidence),
      }));

      console.info('ocr-text-lines observation', { elapsedMs, observed });

      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(countApproximateMatches(lines.map((line) => line.y), expectedBaselines)).toBeGreaterThanOrEqual(3);
    },
    120_000,
  );

  it('returns immediately when the shared recognition OCR budget has expired', async () => {
    const lines = await detectOcrTextLines(
      Buffer.from('not-an-image'),
      100,
      100,
      10,
      90,
      10,
      90,
      { deadlineAt: Date.now() - 1 },
    );

    expect(lines).toEqual([]);
  });
});

async function writeSyntheticKoreanText(filePath: string, baselines: number[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const textLines = [
    '본인 자신의 도박 경험을 표시하세요',
    '친구들과 게임을 한 적이 있습니다',
    '가족과 약속을 지키는 것이 중요합니다',
    '설문 문항을 천천히 읽고 답하세요',
  ];
  const text = baselines
    .map(
      (baseline, index) =>
        `<text x="140" y="${baseline}" font-family="Malgun Gothic, Arial, sans-serif" font-size="42" fill="#000">${textLines[index]}</text>`,
    )
    .join('\n');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700">
      <rect width="100%" height="100%" fill="#fff"/>
      ${text}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

function countApproximateMatches(detectedYs: number[], expectedBaselines: number[]): number {
  return expectedBaselines.filter((expectedY) =>
    detectedYs.some((detectedY) => Math.abs(detectedY - expectedY) <= 45),
  ).length;
}
