import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { analyzeChoiceGroup, calculateDarkPixelDensity, ImageAnalysisData, loadImageAnalysisData } from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';

const fixtureDir = path.join(process.cwd(), 'tmp', 'test-mark-density');

afterAll(() => {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function makeTestImage(): ImageAnalysisData {
  const width = 10;
  const height = 10;
  const pixels = Buffer.alloc(width * height, 255);

  for (let y = 1; y < 4; y++) {
    for (let x = 1; x < 4; x++) {
      pixels[y * width + x] = 0;
    }
  }

  return { width, height, pixels, contentBoundsConfident: true };
}

describe('마킹 밀도 기반 선택지 분석', () => {
  it('ROI 안의 어두운 픽셀 비율을 계산한다', () => {
    const image = makeTestImage();

    const density = calculateDarkPixelDensity(image, {
      x: 0.1,
      y: 0.1,
      width: 0.3,
      height: 0.3,
    });

    expect(density).toBe(1);
  });

  it('가장 진하게 마킹된 선택지를 high confidence로 고른다', () => {
    const image = makeTestImage();
    const group: ChoiceGroup = {
      field: 'cagi.q01',
      candidates: [
        { value: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
        { value: 1, rect: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 } },
      ],
    };

    const result = analyzeChoiceGroup(image, group);

    expect(result.value).toBe(0);
    expect(result.confidence).toBe('high');
    expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score);
  });

  it('마킹 차이가 작으면 값을 확정하지 않고 low confidence로 둔다', () => {
    const image: ImageAnalysisData = {
      width: 10,
      height: 10,
      pixels: Buffer.alloc(100, 255),
      contentBoundsConfident: false,
    };
    const group: ChoiceGroup = {
      field: 'cagi.q02',
      candidates: [
        { value: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
        { value: 1, rect: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 } },
      ],
    };

    const result = analyzeChoiceGroup(image, group);

    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
  });

  it('종이 경계가 불확실하면 후보 점수만 남기고 자동값을 확정하지 않는다', () => {
    const image = makeTestImage();
    const group: ChoiceGroup = {
      field: 'cagi.q03',
      candidates: [
        { value: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
        { value: 1, rect: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 } },
      ],
    };

    const result = analyzeChoiceGroup(image, group, undefined, false);

    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.candidates[0].value).toBe(0);
  });

  it('긴 내부 표 선만 있는 이미지를 문서 프레임으로 신뢰하지 않는다', async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const filePath = path.join(fixtureDir, 'broken-inner-frame.png');
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400">
        <rect width="100%" height="100%" fill="#fff"/>
        <path d="M100 150 H900 M100 1250 H900" fill="none" stroke="#000" stroke-width="8"/>
        <path d="M200 400 V800 M800 400 V800" fill="none" stroke="#000" stroke-width="8"/>
      </svg>
    `;
    await sharp(Buffer.from(svg)).png().toFile(filePath);

    const analysis = await loadImageAnalysisData(filePath);

    expect(analysis.contentBoundsConfident).toBe(false);
  });

  it('얇지만 네 변이 이어진 외곽선은 문서 프레임으로 인정한다', async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const filePath = path.join(fixtureDir, 'thin-page-frame.png');
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400">
        <rect width="100%" height="100%" fill="#fff"/>
        <rect x="100" y="100" width="800" height="1200" fill="none" stroke="#000" stroke-width="2"/>
      </svg>
    `;
    await sharp(Buffer.from(svg)).png().toFile(filePath);

    const analysis = await loadImageAnalysisData(filePath);

    expect(analysis.contentBoundsConfident).toBe(true);
  });
});
