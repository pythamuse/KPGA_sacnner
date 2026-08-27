import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  SHEET_EXPOSURE_SAMPLE_HEIGHT,
  SHEET_EXPOSURE_SAMPLE_WIDTH,
  compareSheetExposure,
  measureSheetExposure,
  type SheetExposureMeasurement,
} from '../src/lib/recognition/sheetExposure';
import { loadBlankFormBaseline } from '../src/lib/recognition/templateBaseline';
import {
  evaluateSheetQuality,
  exposureRetakeReason,
  getExposureRetakeThreshold,
  type RegistrationMetaLike,
  type SheetQualityVerdict,
} from '../src/lib/recognition/sheetQuality';
import type { ImageAnalysisData } from '../src/lib/recognition/markDensity';

const assetDir = path.join(process.cwd(), 'src', 'lib', 'recognition', 'assets');
const cagiBlankPath = path.join(assetDir, 'cagi-blank.png');
const satisfactionBlankPath = path.join(assetDir, 'satisfaction-blank.png');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-exposure-'));

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

/**
 * Scales every pixel toward black while leaving the geometry — and therefore
 * the registration frame — untouched.
 *
 * Holding the frame fixed is the point: it makes the expected offset exactly
 * computable. `percentile` picks the value at a fixed rank of the sorted
 * samples, and `v => Math.round(k * v)` is non-decreasing, so it commutes with
 * that rank: percentile(scaled) === Math.round(k * percentile(original)).
 */
function darkenPixels(image: ImageAnalysisData, factor: number): ImageAnalysisData {
  const pixels = Buffer.allocUnsafe(image.pixels.length);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = Math.round(image.pixels[index] * factor);
  }
  return { ...image, pixels };
}

function makeRegistration(overrides: Partial<RegistrationMetaLike> = {}): RegistrationMetaLike {
  return {
    method: 'quad',
    confidence: 0.9,
    orbInliers: 200,
    orbInlierRatio: 0.8,
    quadResidualPx: 6,
    rejection: null,
    verified: true,
    ...overrides,
  };
}

/** The three fields that ARE the verdict. `signals` is reporting, not verdict. */
function verdictBytes(verdict: SheetQualityVerdict): string {
  return JSON.stringify({
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    hints: verdict.hints,
  });
}

describe('measureSheetExposure', () => {
  it('reads a blank measured against its own template as zero offset', async () => {
    for (const [formType, imagePath] of [
      ['cagi', cagiBlankPath],
      ['satisfaction', satisfactionBlankPath],
    ] as const) {
      const exposure = await measureSheetExposure(imagePath, formType);
      expect(exposure).not.toBeNull();
      const measured = exposure as SheetExposureMeasurement;

      // The sheet IS the blank, loaded and registered through the same path,
      // so the two sample sets are identical and the offsets are exactly 0 —
      // not merely small.
      expect(measured.offset82).toBe(0);
      expect(measured.offset95).toBe(0);
      expect(measured.actualP82).toBe(measured.blankP82);
      expect(measured.actualP95).toBe(measured.blankP95);

      // Sane figures: 8-bit grey, and a clean scan spans a real range.
      for (const value of [measured.actualP82, measured.blankP82, measured.actualP95, measured.blankP95]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(255);
      }
      expect(measured.actualP95).toBeGreaterThanOrEqual(measured.actualP82);
      expect(measured.dynamicRange).toBeGreaterThan(100);
      expect(measured.dynamicRange).toBeLessThanOrEqual(255);
    }
  }, 240000);

  it('samples the registered content area on a fixed grid', () => {
    // Documents the scope decision the report has to state: the scorer takes
    // its percentiles over one resampled cell, this takes them over the
    // registered content area on a grid of the same kind.
    expect(SHEET_EXPOSURE_SAMPLE_WIDTH).toBeGreaterThan(0);
    expect(SHEET_EXPOSURE_SAMPLE_HEIGHT).toBeGreaterThan(0);
  });

  it('turns darkening into a large positive offset82, proportional to the darkening', async () => {
    const baseline = await loadBlankFormBaseline('cagi');
    expect(baseline).toBeTruthy();
    const blank = baseline!.image;

    const reference = compareSheetExposure(blank, blank);
    expect(reference.offset82).toBe(0);

    let previousOffset = 0;
    for (const factor of [0.9, 0.7, 0.5, 0.3]) {
      const measured = compareSheetExposure(darkenPixels(blank, factor), blank);

      // Exact, not approximate: see darkenPixels. This is the proportionality
      // claim in its strongest form — the offset is the paper reference minus
      // the same reference scaled.
      expect(measured.offset82).toBe(reference.blankP82 - Math.round(factor * reference.blankP82));
      expect(measured.offset95).toBe(reference.blankP95 - Math.round(factor * reference.blankP95));
      // Darker sheet, larger offset, and the tonal range collapses with it —
      // the pair of numbers spec 12.2 says must be read together.
      expect(measured.offset82).toBeGreaterThan(previousOffset);
      expect(measured.dynamicRange).toBeLessThan(reference.dynamicRange);
      previousOffset = measured.offset82;
    }

    // The severest case reaches the scale 12.2 measured on the zero-yield
    // sheets (cell-level brightnessOffset up to 185).
    expect(previousOffset).toBeGreaterThan(150);
  }, 240000);

  it('measures the same darkening end to end, from a stored file', async () => {
    // The in-memory case above holds the frame fixed. This one goes through
    // the real load path — sharp decode, paper detection, registration frame —
    // to show the figure survives it.
    const factor = 0.7;
    const darkenedPath = path.join(scratchDir, 'cagi-dark.png');
    await sharp(cagiBlankPath).linear(factor, 0).png().toFile(darkenedPath);

    const measured = await measureSheetExposure(darkenedPath, 'cagi');
    expect(measured).not.toBeNull();

    // 255 - round(0.7 * 255) = 76. The tolerance is for sharp's own rounding
    // in the re-encode, not for the measurement.
    expect(measured!.offset82).toBeGreaterThan(0);
    expect(Math.abs(measured!.offset82 - 76)).toBeLessThanOrEqual(3);
  }, 240000);
});

describe('sheetQuality exposure wiring is inert', () => {
  // Every registration case the verdict rules distinguish, with the verdict
  // each one has to keep producing. Written out rather than derived, so a
  // change to the rules fails here instead of being mirrored by the test.
  const cases: Array<{
    name: string;
    registration: RegistrationMetaLike | null;
    expected: { verdict: string; reasons: string[]; hints: string[] };
  }> = [
    {
      name: 'no registration meta (scan path)',
      registration: null,
      expected: { verdict: 'good', reasons: ['no-registration-meta'], hints: [] },
    },
    {
      name: 'verified registration',
      registration: makeRegistration(),
      expected: { verdict: 'good', reasons: ['registration-verified'], hints: [] },
    },
    {
      name: 'unverified warp',
      registration: makeRegistration({ method: 'orb', verified: false }),
      expected: {
        verdict: 'retake-suggested',
        reasons: ['unverified-warp'],
        hints: ['촬영 상태가 좋지 않아 인식 정확도가 낮을 수 있습니다. 다시 찍는 것을 권장합니다'],
      },
    },
    {
      name: "method 'none' with a cropped rejection",
      registration: makeRegistration({ method: 'none', confidence: 0, verified: false, rejection: 'cropped' }),
      expected: {
        verdict: 'unusable',
        reasons: ['registration-none'],
        hints: ['종이의 네 모서리가 모두 화면 안에 들어오게 찍어주세요'],
      },
    },
    {
      name: "method 'none' with no rejection",
      registration: makeRegistration({ method: 'none', confidence: 0, verified: false, rejection: null }),
      expected: {
        verdict: 'unusable',
        reasons: ['registration-none'],
        hints: ['종이가 배경과 구분되도록 어두운 바닥을 피해 다시 찍어주세요'],
      },
    },
  ];

  const verdicts = new Map<string, SheetQualityVerdict>();

  beforeAll(async () => {
    for (const testCase of cases) {
      verdicts.set(testCase.name, await evaluateSheetQuality({
        imagePath: cagiBlankPath,
        formType: 'cagi',
        registration: testCase.registration,
      }));
    }
  }, 600000);

  it('ships the exposure threshold disabled', () => {
    // The safety pin. Enabling this constant is the central checkout's call,
    // made on labelled data against a shuffled-label control (spec F3.4); if
    // it is set here, this fails and says so.
    expect(getExposureRetakeThreshold()).toBeNull();
  });

  it('keeps the exposure rule silent at the shipped threshold, however dark the sheet', () => {
    const extreme: SheetExposureMeasurement = {
      actualP82: 0,
      blankP82: 255,
      offset82: 255,
      actualP95: 0,
      blankP95: 255,
      offset95: 255,
      dynamicRange: 0,
    };

    expect(exposureRetakeReason(extreme)).toBeNull();
    expect(exposureRetakeReason(extreme, null)).toBeNull();
    expect(exposureRetakeReason(null, 10)).toBeNull();
    // ...and the path is real, not a comment: give it a threshold and it fires.
    expect(exposureRetakeReason(extreme, 10)).toBe('exposure-underexposed');
  });

  it('reports the exposure signal on every verdict', () => {
    // Without this the inertness test below would pass vacuously — a signal
    // that is never measured cannot change a verdict either.
    for (const testCase of cases) {
      const verdict = verdicts.get(testCase.name)!;
      expect(verdict.signals.exposure).not.toBeNull();
      expect(typeof verdict.signals.exposure!.offset82).toBe('number');
      expect(typeof verdict.signals.exposure!.dynamicRange).toBe('number');
    }
  });

  it('returns the registration-only verdict for every input, exposure present or stripped', () => {
    for (const testCase of cases) {
      const verdict = verdicts.get(testCase.name)!;

      // 1. The verdict is today's registration-only verdict, byte for byte.
      expect(verdictBytes(verdict)).toBe(JSON.stringify(testCase.expected));

      // 2. And removing the new signal changes none of those bytes: the
      //    exposure figures travel in `signals` and nothing reads them.
      const stripped: SheetQualityVerdict = {
        ...verdict,
        signals: { ...verdict.signals, exposure: null },
      };
      expect(verdictBytes(stripped)).toBe(verdictBytes(verdict));
    }
  });
});
