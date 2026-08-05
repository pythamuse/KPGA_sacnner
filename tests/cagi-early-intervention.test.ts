import { describe, expect, it } from 'vitest';
import { detectCagiEarlyInterventionFromImage } from '../src/lib/recognition/cagiEarlyIntervention';
import type { ImageAnalysisData } from '../src/lib/recognition/markDensity';

const page = { width: 1000, height: 1400, left: 100, top: 100, right: 900, bottom: 1300 };

describe('CAGI 조기개입 개인정보 입력 감지', () => {
  it('name and contact entry traces together create a privacy-safe alert signal', () => {
    const image = makeCagiImage();
    fillNormalizedRect(image, 0.18, 0.72, 0.12, 0.018);
    fillNormalizedRect(image, 0.62, 0.72, 0.16, 0.018);

    expect(detectCagiEarlyInterventionFromImage(image)).toEqual({
      hasMarks: false,
      hasContactInformation: true,
    });
  });

  it('does not flag contact information when only one entry cell has writing', () => {
    const image = makeCagiImage();
    fillNormalizedRect(image, 0.18, 0.72, 0.12, 0.018);

    expect(detectCagiEarlyInterventionFromImage(image).hasContactInformation).toBe(false);
  });
});

function makeCagiImage(): ImageAnalysisData {
  const pixels = Buffer.alloc(page.width * page.height, 255);
  const image: ImageAnalysisData = {
    width: page.width,
    height: page.height,
    pixels,
    contentBounds: { left: page.left, top: page.top, right: page.right, bottom: page.bottom },
    contentBoundsConfident: false,
  };

  return image;
}

function fillNormalizedRect(image: ImageAnalysisData, x: number, y: number, width: number, height: number) {
  const left = Math.round(page.left + x * (page.right - page.left));
  const top = Math.round(page.top + y * (page.bottom - page.top));
  const right = Math.round(left + width * (page.right - page.left));
  const bottom = Math.round(top + height * (page.bottom - page.top));

  for (let currentY = top; currentY < bottom; currentY++) {
    for (let currentX = left; currentX < right; currentX++) {
      image.pixels[currentY * image.width + currentX] = 0;
    }
  }
}
