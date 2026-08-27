import { describe, expect, it } from 'vitest';
import {
  FRAME_EXPOSURE_CEILING_FRACTION,
  FRAME_EXPOSURE_FLOOR_FRACTION,
  GUIDE_SHORT_EDGE_FILL,
  LIVE_DYNAMIC_RANGE_WARN,
  LIVE_EXPOSURE_HINT_ENABLED,
  LIVE_EXPOSURE_MIN_SAMPLES,
  READY_STREAK_FOR_SHUTTER,
  buildGrayHistogram,
  computeExposureStride,
  computeGuideRect,
  evaluateCaptureGuidance,
  measureFrameExposure,
  measureFrameExposureInRegion,
  nextReadyStreak,
  percentileFromHistogram,
  shouldWarnOnExposure,
  type FrameExposureSample,
} from '../src/lib/documentScanner/captureGuidance';
import { SHEET_EXPOSURE_FLOOR_FRACTION } from '../src/lib/recognition/sheetExposure';
import { percentile } from '../src/lib/recognition/markDensity';
import type { Point } from '../src/lib/documentScanner/perspectiveCorrect';

/**
 * Live exposure guidance (CAPTURE_GUIDANCE §11.3).
 *
 * Two things are being pinned here and they are not the same thing:
 *
 * 1. That the histogram percentile is the SAME number markDensity's `percentile`
 *    would produce. The §11.3 split (155-182 productive, 61-108 not) was
 *    measured through that function; if this one rounds its index differently
 *    the live reading is offset from the evidence by a constant nobody would
 *    trace.
 * 2. That the reducer says the framing thing first. A dark, badly framed frame
 *    has two faults and the person can only act on one at a time.
 *
 * What is NOT pinned, because it cannot be from here: whether
 * `LIVE_DYNAMIC_RANGE_WARN` is in the right place. That number came from warped
 * finals, not preview frames, and only a device session can move it.
 */

// --- fixtures ---------------------------------------------------------------

/** Portrait, ~1.384: the same shape the sheet is. */
const FRAME_W = 400;
const FRAME_H = 554;

/** Head-on, centred, filling 0.78 of both axes: what the guide asks for. */
const IDEAL_QUAD: Point[] = [
  { x: 44, y: 61 },
  { x: 356, y: 61 },
  { x: 356, y: 493 },
  { x: 44, y: 493 },
];

/**
 * Rolled ~8 degrees, well past `ROLL_WARN_DEG`, and otherwise clean: both
 * horizontal edges tilt equally so the keystones stay at 0, and it keeps a
 * 0.097 margin so it does not trip the margin check on the way past.
 */
const ROLLED_QUAD: Point[] = [
  { x: 60, y: 80 },
  { x: 340, y: 120 },
  { x: 340, y: 500 },
  { x: 60, y: 460 },
];

/** Runs off the bottom of the frame: fails the margin check. */
const CROPPED_QUAD: Point[] = [
  { x: 44, y: 61 },
  { x: 356, y: 61 },
  { x: 356, y: 553 },
  { x: 44, y: 553 },
];

function quality(points: Point[], edgeConsistency = 0.99) {
  return { points, confidence: 0.9, edgeConsistency, aspectRatio: 1.384 };
}

function sample(
  dynamicRange: number,
  region: 'quad' | 'guide' = 'quad',
  sampleCount = 12000,
): FrameExposureSample {
  return {
    p05: 240 - dynamicRange,
    p95: 240,
    dynamicRange,
    region,
    sampleCount,
    stride: 3,
  };
}

/**
 * A neutral RGBA frame. Every pixel has R = G = B, so its Rec.601 luma is that
 * value exactly and nothing in the assertions below depends on the weights.
 */
function makeFrame(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = valueAt(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Sheet occupying the guide box, split into an ink band and paper.
 *
 * The band is 30% of the sheet's height, so whatever the stride does the ink is
 * far more than 5% and far less than 95% of the samples: p05 lands in `ink` and
 * p95 in `paper` by construction, not by fitting. Everything outside the sheet
 * is `surround`.
 */
function makeSheetFrame(ink: number, paper: number, surround: number) {
  const bandBottom = 61 + Math.round((493 - 61) * 0.3);
  return makeFrame(FRAME_W, FRAME_H, (x, y) => {
    if (x < 44 || x >= 356 || y < 61 || y >= 493) return surround;
    return y < bandBottom ? ink : paper;
  });
}

// --- the percentile convention ----------------------------------------------

describe('percentileFromHistogram', () => {
  it('matches markDensity.percentile, which is where the §11.3 numbers came from', () => {
    // Random-but-deterministic integer populations of assorted shapes. The
    // point is not any one value; it is that no input separates the two.
    let seed = 20260827;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (const length of [1, 2, 3, 7, 11, 20, 41, 100, 999]) {
      for (const spread of [1, 8, 256]) {
        const values: number[] = [];
        for (let i = 0; i < length; i++) {
          values.push(Math.min(255, Math.floor(random() * spread)));
        }
        const { histogram, count } = buildGrayHistogram(values);
        for (const fraction of [0, 0.05, 0.25, 0.5, 0.82, 0.95, 1]) {
          expect(percentileFromHistogram(histogram, count, fraction)).toBe(
            percentile(values, fraction),
          );
        }
      }
    }
  });

  it('reads the nearest rank on a 0-based index, rounding halves up', () => {
    // n = 11 -> (n - 1) * 0.05 = 0.5 exactly. Nearest-rank-with-halves-up puts
    // p05 at index 1; truncation or banker's rounding would put it at index 0.
    // This is the one case where the three rules visibly disagree.
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110];
    const { histogram, count } = buildGrayHistogram(values);

    expect(percentileFromHistogram(histogram, count, 0.05)).toBe(20);
    expect(percentileFromHistogram(histogram, count, 0.95)).toBe(110);
    expect(percentile(values, 0.05)).toBe(20);
  });

  it('returns 0 for an empty population, as markDensity does', () => {
    expect(percentileFromHistogram(new Uint32Array(256), 0, 0.5)).toBe(0);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('drops non-finite entries instead of binning them at black', () => {
    const { histogram, count } = buildGrayHistogram([10, Number.NaN, 20, Number.POSITIVE_INFINITY]);

    expect(count).toBe(2);
    expect(percentileFromHistogram(histogram, count, 0)).toBe(10);
    expect(percentileFromHistogram(histogram, count, 1)).toBe(20);
  });

  it('uses the same floor fraction sheetExposure chose', () => {
    // sheetExposure.ts cannot be imported by captureGuidance.ts -- it reaches
    // markDensity.ts, whose first line is `import sharp from 'sharp'`, and that
    // would land a native server-only binary in the browser bundle and in the
    // OpenCV worker. So the constant is duplicated, and this is the pin that
    // keeps the duplicate honest.
    expect(FRAME_EXPOSURE_FLOOR_FRACTION).toBe(SHEET_EXPOSURE_FLOOR_FRACTION);
    expect(FRAME_EXPOSURE_CEILING_FRACTION).toBe(0.95);
  });
});

describe('measureFrameExposure', () => {
  it('reports zero range for a single-valued population', () => {
    expect(measureFrameExposure([7, 7, 7, 7, 7])).toEqual({ p05: 7, p95: 7, dynamicRange: 0 });
  });

  it('puts each tail in its own value for a two-valued population', () => {
    // 90 dark, 10 bright. n = 100 so p05 is index round(99 * 0.05) = 5, inside
    // the 90-wide dark block; p95 is index round(99 * 0.95) = 94, inside the
    // bright one.
    const values = [...Array(90).fill(10), ...Array(10).fill(200)];

    expect(measureFrameExposure(values)).toEqual({ p05: 10, p95: 200, dynamicRange: 190 });
  });

  it('reads a full 256-level ramp at the two nearest ranks', () => {
    // n = 256: p05 is index round(255 * 0.05) = 13, p95 is round(255 * 0.95) =
    // 242, and value equals index in a ramp.
    const ramp = Array.from({ length: 256 }, (_, index) => index);

    expect(measureFrameExposure(ramp)).toEqual({ p05: 13, p95: 242, dynamicRange: 229 });
  });

  it('accepts a Uint8ClampedArray as readily as an array', () => {
    const ramp = Uint8ClampedArray.from(Array.from({ length: 256 }, (_, index) => index));

    expect(measureFrameExposure(ramp).dynamicRange).toBe(229);
  });
});

// --- the strided region pass ------------------------------------------------

describe('computeExposureStride', () => {
  it('lands the whole-frame pass near the target sample count', () => {
    // 368x480 is the live budget's portrait frame (LIVE_DETECT_LONG_SIDE 480).
    expect(computeExposureStride(368, 480)).toBe(3);
    // Half the linear size, so a smaller stride keeps the count comparable.
    expect(computeExposureStride(184, 240)).toBe(1);
    expect(computeExposureStride(0, 480)).toBe(1);
  });
});

describe('measureFrameExposureInRegion', () => {
  it('separates a compressed-dark frame from a well-exposed one', () => {
    // Both frames are the same geometry and the same ink fraction. The only
    // difference is the tone the paper was recorded at: FEATURE_SPEC §12.2's
    // mechanism, where paper and mark end up in the same narrow band.
    const dark = measureFrameExposureInRegion(
      makeSheetFrame(40, 95, 70),
      FRAME_W,
      FRAME_H,
      IDEAL_QUAD,
    );
    const bright = measureFrameExposureInRegion(
      makeSheetFrame(30, 240, 70),
      FRAME_W,
      FRAME_H,
      IDEAL_QUAD,
    );

    expect(dark).not.toBeNull();
    expect(bright).not.toBeNull();

    // Derived, not fitted: the ink band is 30% of the sheet, so p05 is an ink
    // pixel and p95 a paper pixel whatever the stride happens to sample.
    expect(dark!.p05).toBe(40);
    expect(dark!.p95).toBe(95);
    expect(dark!.dynamicRange).toBe(55);

    expect(bright!.p05).toBe(30);
    expect(bright!.p95).toBe(240);
    expect(bright!.dynamicRange).toBe(210);

    // And they fall on opposite sides of the provisional line.
    expect(dark!.dynamicRange).toBeLessThan(LIVE_DYNAMIC_RANGE_WARN);
    expect(bright!.dynamicRange).toBeGreaterThanOrEqual(LIVE_DYNAMIC_RANGE_WARN);
  });

  it('ignores everything outside the quad', () => {
    // A pitch-black desk around a perfectly exposed sheet. If the surround
    // leaked in, p05 would be 0 and the range would read as enormous.
    const measurement = measureFrameExposureInRegion(
      makeSheetFrame(30, 240, 0),
      FRAME_W,
      FRAME_H,
      IDEAL_QUAD,
    );

    expect(measurement!.p05).toBe(30);
    expect(measurement!.region).toBe('quad');
  });

  it('falls back to the guide rectangle, and says that is what it measured', () => {
    // A uniform sheet at 250 on a uniform 100 surround. The sheet is a small
    // centred box, well inside the guide rectangle.
    const SHEET: Point[] = [
      { x: 150, y: 200 },
      { x: 250, y: 200 },
      { x: 250, y: 350 },
      { x: 150, y: 350 },
    ];
    const pixels = makeFrame(FRAME_W, FRAME_H, (x, y) =>
      x >= 150 && x < 250 && y >= 200 && y < 350 ? 250 : 100,
    );

    const insideQuad = measureFrameExposureInRegion(pixels, FRAME_W, FRAME_H, SHEET);
    const guideFallback = measureFrameExposureInRegion(pixels, FRAME_W, FRAME_H, null);

    expect(insideQuad!.region).toBe('quad');
    expect(guideFallback!.region).toBe('guide');

    // The quad sees only paper: one value, so no range at all.
    expect(insideQuad!.p05).toBe(250);
    expect(insideQuad!.p95).toBe(250);
    expect(insideQuad!.dynamicRange).toBe(0);

    // The guide box is 0.78 of the short edge, so the 100x150 sheet covers
    // ~11% of it. 11% is comfortably above 5% and below 95%, which puts p05 on
    // the surround and p95 on the sheet -- a DIFFERENT measurement of the same
    // frame, which is the reason the flag exists.
    const guide = computeGuideRect(FRAME_W, FRAME_H)!;
    const sheetShare = (100 * 150) / (guide.width * guide.height);
    expect(sheetShare).toBeGreaterThan(FRAME_EXPOSURE_FLOOR_FRACTION);
    expect(sheetShare).toBeLessThan(1 - FRAME_EXPOSURE_FLOOR_FRACTION);

    expect(guideFallback!.p05).toBe(100);
    expect(guideFallback!.p95).toBe(250);
    expect(guideFallback!.dynamicRange).toBe(150);
    expect(guideFallback!.sampleCount).toBeGreaterThan(insideQuad!.sampleCount);
    expect(GUIDE_SHORT_EDGE_FILL).toBe(0.78);
  });

  it('reports a missing measurement as missing, not as zero', () => {
    const pixels = makeFrame(8, 8, () => 128);

    expect(measureFrameExposureInRegion(pixels, 0, 8, null)).toBeNull();
    expect(measureFrameExposureInRegion(pixels, 8, 8, null)).not.toBeNull();
    // Fewer pixels than the dimensions claim: refuse rather than read garbage.
    expect(measureFrameExposureInRegion(pixels, 64, 64, null)).toBeNull();
  });

  it('takes the four corners in any order', () => {
    const pixels = makeSheetFrame(30, 240, 0);
    const shuffled = [IDEAL_QUAD[2], IDEAL_QUAD[0], IDEAL_QUAD[3], IDEAL_QUAD[1]];

    expect(measureFrameExposureInRegion(pixels, FRAME_W, FRAME_H, shuffled)).toEqual(
      measureFrameExposureInRegion(pixels, FRAME_W, FRAME_H, IDEAL_QUAD),
    );
  });
});

// --- where exposure sits in the order --------------------------------------

describe('the hint is off (CAPTURE_GUIDANCE §13)', () => {
  const base = { rejection: null, frameWidth: FRAME_W, frameHeight: FRAME_H };

  it('ships off', () => {
    expect(LIVE_EXPOSURE_HINT_ENABLED).toBe(false);
  });

  it('leaves a dark, well-framed sheet green -- AND lets it build the streak', () => {
    // The streak is the part that regressed and the part worth pinning.
    // `nextReadyStreak` resets on any level that is not 'ready', so an
    // ungated exposure branch sitting where this one sits does not add a
    // sentence -- it makes 지금 촬영하세요 and the shutter emphasis unreachable.
    // §13 measured 130 firing on 19 of 19 students, so that would have been
    // every sheet, permanently.
    const status = evaluateCaptureGuidance({
      ...base,
      quality: quality(IDEAL_QUAD),
      exposure: sample(LIVE_DYNAMIC_RANGE_WARN - 60),
    });

    expect(status.level).toBe('ready');
    expect(status.code).toBe('ready');
    expect(status.message).toBe('지금 촬영하세요');

    let streak = 0;
    for (let frame = 0; frame < READY_STREAK_FOR_SHUTTER; frame++) {
      streak = nextReadyStreak(streak, status);
    }
    expect(streak).toBe(READY_STREAK_FOR_SHUTTER);
    expect(streak >= READY_STREAK_FOR_SHUTTER).toBe(true);
  });

  it('still reports the reading, which is the whole point of keeping it', () => {
    const dark = sample(LIVE_DYNAMIC_RANGE_WARN - 60);
    const status = evaluateCaptureGuidance({ ...base, quality: quality(IDEAL_QUAD), exposure: dark });

    expect(status.exposure).toBe(dark);
  });

  it('replays §13: none of the nine quad-locked preview frames is warned about', () => {
    // The measured preview dynamicRange of every frame where the shipped
    // detector actually found a quad. All below 130, including the students
    // whose photos yield auto-filled cells -- which is why the threshold was
    // switched off rather than moved.
    for (const dynamicRange of [81, 84, 86, 88, 90, 92, 94, 96, 97]) {
      const status = evaluateCaptureGuidance({
        ...base,
        quality: quality(IDEAL_QUAD),
        exposure: sample(dynamicRange),
      });

      expect(status.code).toBe('ready');
      expect(nextReadyStreak(2, status)).toBe(3);
    }
  });
});

describe('shouldWarnOnExposure', () => {
  it('needs the flag, the quad region, the sample floor and the range together', () => {
    const dark = sample(LIVE_DYNAMIC_RANGE_WARN - 60);

    // The flag alone decides the shipped answer.
    expect(shouldWarnOnExposure(dark)).toBe(false);
    expect(shouldWarnOnExposure(dark, false)).toBe(false);
    expect(shouldWarnOnExposure(dark, true)).toBe(true);

    // No reading at all.
    expect(shouldWarnOnExposure(null, true)).toBe(false);
    expect(shouldWarnOnExposure(undefined, true)).toBe(false);

    // §13.3: the guide region is not the paper's exposure, and it read
    // BACKWARDS on the real set -- a guide frame at 143 against a quad frame
    // at 81 that actually yielded cells. Never warn from it, however dark.
    expect(shouldWarnOnExposure(sample(1, 'guide'), true)).toBe(false);
    expect(shouldWarnOnExposure(sample(0, 'guide'), true)).toBe(false);

    // Too thin a population for its own tails.
    expect(shouldWarnOnExposure(sample(10, 'quad', LIVE_EXPOSURE_MIN_SAMPLES - 1), true)).toBe(false);
    expect(shouldWarnOnExposure(sample(10, 'quad', LIVE_EXPOSURE_MIN_SAMPLES), true)).toBe(true);

    // And the threshold itself is good enough.
    expect(shouldWarnOnExposure(sample(LIVE_DYNAMIC_RANGE_WARN), true)).toBe(false);
    expect(shouldWarnOnExposure(sample(LIVE_DYNAMIC_RANGE_WARN - 1), true)).toBe(true);
  });
});

describe('evaluateCaptureGuidance with exposure', () => {
  const base = {
    rejection: null,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    // Exercises the branch that §13 switched off, so the device session's
    // first flip of LIVE_EXPOSURE_HINT_ENABLED is not the first time this path
    // has ever run. Production never passes this.
    exposureHintEnabled: true,
  };

  it('asks for light once the framing is otherwise green', () => {
    const status = evaluateCaptureGuidance({
      ...base,
      quality: quality(IDEAL_QUAD),
      exposure: sample(LIVE_DYNAMIC_RANGE_WARN - 1),
    });

    expect(status.level).toBe('adjust');
    expect(status.code).toBe('exposure');
    expect(status.message).toBe('밝은 곳에서 다시 찍어주세요');
    expect(status.detail).toBe('화면이 어둡습니다 — 그림자를 피해주세요');
    expect(status.geometry).not.toBeNull();
    // And this is what makes the flag necessary rather than tidy.
    expect(nextReadyStreak(2, status)).toBe(0);
  });

  it('stays green for a well-exposed, well-framed sheet', () => {
    const status = evaluateCaptureGuidance({
      ...base,
      quality: quality(IDEAL_QUAD),
      exposure: sample(LIVE_DYNAMIC_RANGE_WARN + 40),
    });

    expect(status.level).toBe('ready');
    expect(status.code).toBe('ready');
  });

  it('treats the threshold itself as good enough', () => {
    const status = evaluateCaptureGuidance({
      ...base,
      quality: quality(IDEAL_QUAD),
      exposure: sample(LIVE_DYNAMIC_RANGE_WARN),
    });

    expect(status.code).toBe('ready');
  });

  it('never warns from a guide-region reading, however dark', () => {
    const status = evaluateCaptureGuidance({
      ...base,
      quality: quality(IDEAL_QUAD),
      exposure: sample(1, 'guide'),
    });

    expect(status.code).toBe('ready');
    expect(status.exposure!.region).toBe('guide');
  });

  it('never warns from a population too thin for its own tails', () => {
    const status = evaluateCaptureGuidance({
      ...base,
      quality: quality(IDEAL_QUAD),
      exposure: sample(1, 'quad', LIVE_EXPOSURE_MIN_SAMPLES - 1),
    });

    expect(status.code).toBe('ready');
  });

  it('says nothing about tone when the frame could not be measured', () => {
    // The worker was unavailable, or the request timed out. Guidance degrades
    // to what it said before this existed; it does not invent a reading.
    expect(evaluateCaptureGuidance({ ...base, quality: quality(IDEAL_QUAD) }).code).toBe('ready');
    expect(
      evaluateCaptureGuidance({ ...base, quality: quality(IDEAL_QUAD), exposure: null }).code,
    ).toBe('ready');
  });

  it('reports the framing problem, not the darkness, when a frame has both', () => {
    const dark = sample(LIVE_DYNAMIC_RANGE_WARN - 80);

    // Rolled: the fix is to turn the phone, and hearing "find more light"
    // instead would send the person the wrong way.
    expect(evaluateCaptureGuidance({ ...base, quality: quality(ROLLED_QUAD), exposure: dark }).code)
      .toBe('roll');

    // Running off the frame.
    expect(evaluateCaptureGuidance({ ...base, quality: quality(CROPPED_QUAD), exposure: dark }).code)
      .toBe('margin');

    // Keystoned.
    expect(
      evaluateCaptureGuidance({
        ...base,
        quality: quality(
          [
            { x: 100, y: 61 },
            { x: 300, y: 61 },
            { x: 356, y: 493 },
            { x: 44, y: 493 },
          ],
          0.8,
        ),
        exposure: dark,
      }).code,
    ).toBe('keystone-top');

    // No quad at all: the detector saw a candidate and refused it.
    expect(
      evaluateCaptureGuidance({
        ...base,
        quality: null,
        rejection: 'too-small',
        exposure: dark,
      }).code,
    ).toBe('too-small');

    // No candidate at all.
    expect(evaluateCaptureGuidance({ ...base, quality: null, exposure: dark }).code)
      .toBe('searching');

    // Landscape, which is checked before everything.
    expect(
      evaluateCaptureGuidance({
        quality: null,
        rejection: null,
        frameWidth: FRAME_H,
        frameHeight: FRAME_W,
        exposure: dark,
      }).code,
    ).toBe('landscape');
  });

  it('carries the reading on every branch, whether or not it drove the status', () => {
    const dark = sample(LIVE_DYNAMIC_RANGE_WARN - 80);

    for (const input of [
      { ...base, quality: quality(IDEAL_QUAD), exposure: dark },
      { ...base, quality: quality(ROLLED_QUAD), exposure: dark },
      { ...base, quality: null, rejection: 'cropped' as const, exposure: dark },
      { ...base, quality: null, exposure: dark },
      { quality: null, rejection: null, frameWidth: 0, frameHeight: 0, exposure: dark },
    ]) {
      expect(evaluateCaptureGuidance(input).exposure).toBe(dark);
    }
  });

  it('drives the reducer from a real frame, end to end', () => {
    const darkFrame = measureFrameExposureInRegion(
      makeSheetFrame(40, 95, 70),
      FRAME_W,
      FRAME_H,
      IDEAL_QUAD,
    );
    const brightFrame = measureFrameExposureInRegion(
      makeSheetFrame(30, 240, 70),
      FRAME_W,
      FRAME_H,
      IDEAL_QUAD,
    );

    expect(
      evaluateCaptureGuidance({ ...base, quality: quality(IDEAL_QUAD), exposure: darkFrame }).code,
    ).toBe('exposure');
    expect(
      evaluateCaptureGuidance({ ...base, quality: quality(IDEAL_QUAD), exposure: brightFrame }).code,
    ).toBe('ready');
  });
});
