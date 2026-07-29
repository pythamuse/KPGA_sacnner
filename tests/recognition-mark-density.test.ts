import { describe, expect, it } from 'vitest';
import { analyzeChoiceGroup, calculateDarkPixelDensity, ImageAnalysisData } from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';

function makeTestImage(): ImageAnalysisData {
  const width = 10;
  const height = 10;
  const pixels = Buffer.alloc(width * height, 255);

  for (let y = 1; y < 4; y++) {
    for (let x = 1; x < 4; x++) {
      pixels[y * width + x] = 0;
    }
  }

  return { width, height, pixels };
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
});
