import { describe, expect, it } from 'vitest';
import { getPixelCropBox } from '../src/lib/recognition/fieldCrop';

describe('pixel cell crop boxes', () => {
  it('uses response-cell-relative padding instead of page-relative padding', () => {
    const crop = getPixelCropBox(
      { width: 3000, height: 4000, contentBounds: { left: 150, top: 280, right: 2850, bottom: 3800 } },
      { left: 1900, top: 1500, right: 2400, bottom: 1550 },
      0.022,
    );

    expect(crop.width).toBeLessThan(700);
    expect(crop.height).toBeLessThan(100);
    expect(crop.roi.top).toBeGreaterThan(0);
  });
});
