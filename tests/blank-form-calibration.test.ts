import { describe, it, expect } from 'vitest';
import path from 'path';
import { loadImageAnalysisData } from '../src/lib/recognition/markDensity';

/**
 * The blank forms' content envelope is the coordinate system every ROI is
 * expressed in. If it moves, every template rectangle lands somewhere else on
 * every page at once, and nothing else in the suite would notice -- the unit
 * fixtures are synthetic and the real-scan measurement needs PDFs this repo
 * must never contain.
 *
 * Cycle 1 of the 2026-08-22 loop made content-bounds detection depend on the
 * image's tone distribution so that compressed scans reject edge speckle.
 * Binary assets deliberately keep the older path. That split is exactly what
 * this test pins: re-exporting either blank as greyscale would silently switch
 * it to the other branch and shift the calibration frame.
 */
const EXPECTED = {
  'cagi-blank.png': { left: 154, top: 190, width: 1465, height: 2029 },
  'satisfaction-blank.png': { left: 155, top: 207, width: 1358, height: 2012 },
} as const;

describe('blank form calibration frame', () => {
  it.each(Object.keys(EXPECTED))('%s keeps its content envelope', async (name) => {
    const file = path.join(process.cwd(), 'src/lib/recognition/assets', name);
    const img = await loadImageAnalysisData(file);
    const b = img.contentBounds;
    expect(b, `${name} produced no content bounds`).toBeTruthy();

    const want = EXPECTED[name as keyof typeof EXPECTED];
    expect({
      left: b!.left,
      top: b!.top,
      width: b!.right - b!.left,
      height: b!.bottom - b!.top,
    }).toEqual(want);

    // The templates are calibrated against the exact-pixel path; if an asset
    // ever arrives anti-aliased it would take the scan branch instead.
    expect(img.contentBoundsSource).toBe('paper');
  }, 120000);
});
