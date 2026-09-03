import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  analyzeChoiceGroup,
  calculateDarkPixelDensity,
  calculateTemplateInkDifference,
  isContestedRunnerUp,
  CONTESTED_RUNNERUP_MSCORE,
  detectContentBounds,
  detectPaperBounds,
  derivePaperBoundsThreshold,
  hasUsableFormBounds,
  ImageAnalysisData,
  loadImageAnalysisData,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { pinCancelVetoOff } from './helpers/cancelVeto';

// Synthetic marks, so the shipped path is the only thing this file can speak
// for: the hand-drawn "ring" below is a rectangular outline that reads
// crossingScore 1.00 / inkBboxFill 0.30, which is exactly the closed curve
// `crossingScore` is documented as unable to tell from a crossing. See
// `pinCancelVetoOff`.
pinCancelVetoOff();

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

function makePaperScene(paperValue: number, deskValue = 40) {
  const width = 320;
  const height = 480;
  const pixels = Buffer.alloc(width * height, deskValue);

  for (let y = 32; y < 448; y++) {
    for (let x = 32; x < 288; x++) {
      pixels[y * width + x] = paperValue;
    }
  }

  return { width, height, pixels };
}

describe('마킹 밀도 기반 선택지 분석', () => {
  it('marks only a high-confidence runner-up at or above the measured boundary', () => {
    expect(isContestedRunnerUp('high', CONTESTED_RUNNERUP_MSCORE - 0.0001, true)).toBe(false);
    expect(isContestedRunnerUp('high', CONTESTED_RUNNERUP_MSCORE, true)).toBe(true);
    expect(isContestedRunnerUp('medium', CONTESTED_RUNNERUP_MSCORE, true)).toBe(false);
    expect(isContestedRunnerUp('low', CONTESTED_RUNNERUP_MSCORE + 0.01, true)).toBe(false);
    expect(isContestedRunnerUp('high', CONTESTED_RUNNERUP_MSCORE + 0.01, false)).toBe(false);
    expect(isContestedRunnerUp('high', undefined, true)).toBe(false);
  });

  it('keeps a single-candidate high-confidence result uncontested', () => {
    const result = analyzeChoiceGroup(makeTestImage(), {
      field: 'cagi.q01',
      candidates: [
        { value: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
      ],
    });

    expect(result.confidence).toBe('high');
    expect(result.contested).toBe(false);
  });

  it('records the same floor and gap numbers that the decision string prints', () => {
    const result = analyzeChoiceGroup(makeTestImage(), {
      field: 'cagi.q01',
      candidates: [
        { value: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
        { value: 1, rect: { x: 0.6, y: 0.6, width: 0.3, height: 0.3 } },
      ],
    });
    const evidence = result.evidence;
    expect(evidence).toBeDefined();

    const floor = /floor=([^/]+)\/([^ (]+)/.exec(result.decision);
    const gap = /(?:^|\s)gap=([^/]+)\/([^ (]+)/.exec(result.decision);
    expect(Number(floor?.[1])).toBe(evidence?.winner?.score);
    expect(Number(floor?.[2])).toBe(evidence?.thresholds?.score);
    expect(Number(gap?.[1])).toBe(evidence?.gap);
    expect(Number(gap?.[2])).toBe(evidence?.thresholds?.gap);
  });

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
      contentBoundsSource: 'paper',
    })).toBe(true);
    expect(hasUsableFormBounds({
      ...image,
      contentBounds,
      contentBoundsSource: 'dark',
    })).toBe(false);
    // Audit B-1: frame bounds and page-less legacy edges register the sheet
    // for review but never unlock automatic values. Pinned after measuring
    // that the fallback produced the photo path's last wrong (2026-09-03).
    expect(hasUsableFormBounds({
      ...image,
      contentBounds,
      pageBounds: paperBounds || undefined,
      contentBoundsSource: 'frame',
    })).toBe(false);
    expect(hasUsableFormBounds({
      ...image,
      contentBounds,
      pageBounds: undefined,
      contentBoundsSource: 'paper',
    })).toBe(false);
  });

  it('derives a threshold between bright paper and a dark desk', () => {
    const image = makePaperScene(230);

    expect(derivePaperBoundsThreshold(image)).toBe(135);
    expect(detectPaperBounds(image)).toEqual({ left: 32, top: 32, right: 288, bottom: 448 });
  });

  it('finds paper whose observed brightness is below the old absolute cutoff', () => {
    const image = makePaperScene(165);

    expect(derivePaperBoundsThreshold(image)).toBe(103);
    expect(detectPaperBounds(image)).toEqual({ left: 32, top: 32, right: 288, bottom: 448 });
  });

  it('pins a full-white scan-like image to the old threshold and bounds', () => {
    const image = {
      width: 320,
      height: 480,
      pixels: Buffer.alloc(320 * 480, 255),
    };

    expect(derivePaperBoundsThreshold(image)).toBe(195);
    expect(detectPaperBounds(image)).toEqual({ left: 0, top: 0, right: 320, bottom: 480 });
  });

  it('does not invent paper bounds for a uniformly dark image', () => {
    const image = {
      width: 320,
      height: 480,
      pixels: Buffer.alloc(320 * 480, 40),
    };

    expect(derivePaperBoundsThreshold(image)).toBe(195);
    expect(detectPaperBounds(image)).toBeNull();
  });

  it('includes the selected paper threshold in the bounds decision trace', async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const filePath = path.join(fixtureDir, 'paper-threshold-trace.png');
    const scene = makePaperScene(165);
    await sharp(scene.pixels, {
      raw: { width: scene.width, height: scene.height, channels: 1 },
    }).png().toFile(filePath);

    const image = await loadImageAnalysisData(filePath);
    const result = analyzeChoiceGroup(image, {
      field: 'cagi.q05',
      candidates: [{ value: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }],
    });

    expect(image.paperBoundsThreshold).toBe(103);
    expect(result.decision).toContain('paper-threshold=103');
  });
});
