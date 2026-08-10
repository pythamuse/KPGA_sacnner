import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  analyzeChoiceGroup,
  calculateDarkPixelDensity,
  calculateTemplateInkDifference,
  detectContentBounds,
  detectPaperBounds,
  hasUsableFormBounds,
  ImageAnalysisData,
  loadImageAnalysisData,
} from '../src/lib/recognition/markDensity';
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

  it('cell-grid pixel overrides score the actual selected cell instead of stale template coordinates', () => {
    const width = 100;
    const height = 60;
    const pixels = Buffer.alloc(width * height, 255);
    for (let y = 20; y < 40; y++) {
      for (let x = 60; x < 80; x++) {
        pixels[y * width + x] = 0;
      }
    }
    const image: ImageAnalysisData = { width, height, pixels, contentBoundsConfident: true };
    const group: ChoiceGroup = {
      field: 'cagi.q04',
      candidates: [
        { value: 0, rect: { x: 0.7, y: 0.1, width: 0.1, height: 0.1 } },
        { value: 1, rect: { x: 0.82, y: 0.1, width: 0.1, height: 0.1 } },
      ],
    };

    const result = analyzeChoiceGroup(image, group, undefined, true, [
      { left: 10, top: 20, right: 30, bottom: 40 },
      { left: 60, top: 20, right: 80, bottom: 40 },
    ]);

    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
  });

  it('subtracts the blank form print so a hand-drawn ring wins over identical printed circles', () => {
    const width = 48;
    const height = 24;
    const blankPixels = Buffer.alloc(width * height, 255);
    const actualPixels = Buffer.from(blankPixels);
    const first = { left: 4, top: 4, right: 20, bottom: 20 };
    const second = { left: 28, top: 4, right: 44, bottom: 20 };

    for (const rect of [first, second]) {
      for (let y = 10; y < 14; y++) {
        for (let x = rect.left + 6; x < rect.left + 10; x++) {
          blankPixels[y * width + x] = 0;
          actualPixels[y * width + x] = 0;
        }
      }
    }

    for (let x = second.left + 2; x < second.right - 2; x++) {
      actualPixels[(second.top + 2) * width + x] = 0;
      actualPixels[(second.bottom - 3) * width + x] = 0;
    }
    for (let y = second.top + 2; y < second.bottom - 2; y++) {
      actualPixels[y * width + second.left + 2] = 0;
      actualPixels[y * width + second.right - 3] = 0;
    }

    const image: ImageAnalysisData = { width, height, pixels: actualPixels, contentBoundsConfident: true };
    const baseline: ImageAnalysisData = { width, height, pixels: blankPixels, contentBoundsConfident: true };
    const group: ChoiceGroup = {
      field: 'cagi.q01',
      candidates: [
        { value: 0, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
        { value: 1, rect: { x: 0.6, y: 0.1, width: 0.2, height: 0.2 } },
      ],
    };

    const firstScore = calculateTemplateInkDifference(image, first, baseline, first);
    const secondScore = calculateTemplateInkDifference(image, second, baseline, second);
    const result = analyzeChoiceGroup(image, group, undefined, true, [first, second], false, {
      image: baseline,
      candidatePixelOverrides: [first, second],
    });

    expect(firstScore).toBeLessThan(0.01);
    expect(secondScore).toBeGreaterThan(0.04);
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
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

    expect(analysis.contentBoundsConfident).toBe(true);
    expect(analysis.contentBoundsSource).toBe('paper');
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

  it('페이지 중앙의 큰 내부 표도 문서 프레임으로 승격하지 않는다', async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const filePath = path.join(fixtureDir, 'large-inner-frame.png');
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400">
        <rect width="100%" height="100%" fill="#fff"/>
        <rect x="200" y="250" width="600" height="1000" fill="none" stroke="#000" stroke-width="4"/>
      </svg>
    `;
    await sharp(Buffer.from(svg)).png().toFile(filePath);

    const analysis = await loadImageAnalysisData(filePath);

    expect(analysis.contentBoundsConfident).toBe(true);
    expect(analysis.contentBoundsSource).toBe('paper');
  });

  it('uses the post-EXIF-rotation dimensions when indexing image pixels', async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const filePath = path.join(fixtureDir, 'orientation-6.jpg');
    await sharp({
      create: {
        width: 80,
        height: 120,
        channels: 3,
        background: '#ffffff',
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(filePath);

    const analysis = await loadImageAnalysisData(filePath);

    expect(analysis.width).toBe(120);
    expect(analysis.height).toBe(80);
    expect(analysis.pixels).toHaveLength(120 * 80);
  });

  it('registers a bright paper sheet instead of the dark photo background', () => {
    const width = 1000;
    const height = 1400;
    const pixels = Buffer.alloc(width * height, 64);

    for (let y = 90; y < 1320; y++) {
      for (let x = 110; x < 890; x++) {
        pixels[y * width + x] = 244;
      }
    }

    for (let y = 190; y < 1210; y += 58) {
      for (let x = 130; x < 870; x++) {
        pixels[y * width + x] = 24;
      }
    }

    const image = { width, height, pixels };
    const paperBounds = detectPaperBounds(image);
    const contentBounds = detectContentBounds(image);

    expect(paperBounds).not.toBeNull();
    expect(paperBounds?.left).toBeLessThan(130);
    expect(paperBounds?.right).toBeGreaterThan(870);
    expect(paperBounds?.top).toBeLessThan(110);
    expect(paperBounds?.bottom).toBeGreaterThan(1300);
    expect(contentBounds.left).toBeGreaterThan(115);
    expect(contentBounds.right).toBeLessThan(880);
    expect(contentBounds.top).toBeGreaterThan(120);
    expect(contentBounds.bottom).toBeLessThan(1280);

    expect(hasUsableFormBounds({
      ...image,
      contentBounds,
      pageBounds: paperBounds || undefined,
      contentBoundsConfident: true,
      contentBoundsSource: 'paper',
    })).toBe(true);
    expect(hasUsableFormBounds({
      ...image,
      contentBounds,
      contentBoundsConfident: false,
      contentBoundsSource: 'dark',
    })).toBe(false);
  });
});
