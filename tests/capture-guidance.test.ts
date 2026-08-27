import { describe, expect, it } from 'vitest';
import {
  EDGE_CONSISTENCY_WARN,
  GUIDE_ASPECT_RATIO,
  GUIDE_SHORT_EDGE_FILL,
  READY_STREAK_FOR_SHUTTER,
  computeGuideRect,
  computeQuadGeometry,
  computeVideoBoxMapping,
  evaluateCaptureGuidance,
  mapDisplayToFrame,
  mapFrameToDisplay,
  mapQuadToDisplay,
  mapRectToDisplay,
  nextReadyStreak,
  rejectionHint,
  type LiveQuadQuality,
} from '../src/lib/documentScanner/captureGuidance';
import type { Point } from '../src/lib/documentScanner/perspectiveCorrect';

/**
 * Fixture frame: portrait, 1.384 -- the same shape the sheet is, so the
 * numbers below stay readable.
 */
const FRAME_W = 1000;
const FRAME_H = 1384;

/** Head-on, centred, filling 0.78 of both axes: what the guide asks for. */
const IDEAL_QUAD: Point[] = [
  { x: 110, y: 152 },
  { x: 890, y: 152 },
  { x: 890, y: 1232 },
  { x: 110, y: 1232 },
];

/** Same box, rolled 6 degrees clockwise (both horizontal edges tilt equally). */
const ROLLED_QUAD: Point[] = [
  { x: 110, y: 152 },
  { x: 890, y: 234 },
  { x: 890, y: 1314 },
  { x: 110, y: 1232 },
];

/** Top edge shorter than the bottom: the top of the sheet is farther away. */
const TOP_FAR_QUAD: Point[] = [
  { x: 180, y: 152 },
  { x: 820, y: 152 },
  { x: 890, y: 1232 },
  { x: 110, y: 1232 },
];

/** Bottom edge shorter: the bottom of the sheet is farther away. */
const BOTTOM_FAR_QUAD: Point[] = [
  { x: 110, y: 152 },
  { x: 890, y: 152 },
  { x: 820, y: 1232 },
  { x: 180, y: 1232 },
];

/** Left edge shorter than the right: the left of the sheet is farther away. */
const LEFT_FAR_QUAD: Point[] = [
  { x: 110, y: 250 },
  { x: 890, y: 152 },
  { x: 890, y: 1232 },
  { x: 110, y: 1130 },
];

/** Right edge shorter: the right of the sheet is farther away. */
const RIGHT_FAR_QUAD: Point[] = [
  { x: 110, y: 152 },
  { x: 890, y: 250 },
  { x: 890, y: 1130 },
  { x: 110, y: 1232 },
];

function quality(points: Point[], edgeConsistency = 1): LiveQuadQuality {
  return { points, confidence: 0.8, edgeConsistency, aspectRatio: GUIDE_ASPECT_RATIO };
}

function guidance(points: Point[] | null, edgeConsistency = 1) {
  return evaluateCaptureGuidance({
    quality: points ? quality(points, edgeConsistency) : null,
    rejection: null,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
  });
}

describe('computeVideoBoxMapping', () => {
  // 1200x1600 frame inside a 600x400 box: the two fits disagree by 2x, which
  // is exactly the mismatch CAPTURE_GUIDANCE §4.2 says must never be split
  // across two pieces of code.
  it('letterboxes under contain', () => {
    const mapping = computeVideoBoxMapping(1200, 1600, 600, 400, 'contain');

    expect(mapping).not.toBeNull();
    expect(mapping!.scale).toBeCloseTo(0.25, 10);
    expect(mapping!.offsetX).toBeCloseTo(150, 10);
    expect(mapping!.offsetY).toBeCloseTo(0, 10);
  });

  it('crops under cover', () => {
    const mapping = computeVideoBoxMapping(1200, 1600, 600, 400, 'cover');

    expect(mapping!.scale).toBeCloseTo(0.5, 10);
    expect(mapping!.offsetX).toBeCloseTo(0, 10);
    expect(mapping!.offsetY).toBeCloseTo(-200, 10);
  });

  it('places the frame corners where each fit puts them', () => {
    const contain = computeVideoBoxMapping(1200, 1600, 600, 400, 'contain')!;
    const cover = computeVideoBoxMapping(1200, 1600, 600, 400, 'cover')!;

    expect(mapFrameToDisplay(contain, { x: 0, y: 0 })).toEqual({ x: 150, y: 0 });
    expect(mapFrameToDisplay(contain, { x: 1200, y: 1600 })).toEqual({ x: 450, y: 400 });
    expect(mapFrameToDisplay(cover, { x: 0, y: 0 })).toEqual({ x: 0, y: -200 });
    expect(mapFrameToDisplay(cover, { x: 1200, y: 1600 })).toEqual({ x: 600, y: 600 });
  });

  it('round-trips display and frame coordinates', () => {
    for (const fit of ['cover', 'contain'] as const) {
      const mapping = computeVideoBoxMapping(1200, 1600, 640, 360, fit)!;
      const original = { x: 317, y: 941 };
      const back = mapDisplayToFrame(mapping, mapFrameToDisplay(mapping, original));

      expect(back.x).toBeCloseTo(original.x, 8);
      expect(back.y).toBeCloseTo(original.y, 8);
    }
  });

  it('refuses degenerate boxes instead of dividing by zero', () => {
    expect(computeVideoBoxMapping(0, 1600, 600, 400)).toBeNull();
    expect(computeVideoBoxMapping(1200, 1600, 600, 0)).toBeNull();
    expect(computeVideoBoxMapping(Number.NaN, 1600, 600, 400)).toBeNull();
  });

  it('maps a quad point by point', () => {
    const mapping = computeVideoBoxMapping(1200, 1600, 600, 400, 'contain')!;

    expect(mapQuadToDisplay(mapping, [
      { x: 0, y: 0 },
      { x: 1200, y: 0 },
      { x: 1200, y: 1600 },
      { x: 0, y: 1600 },
    ])).toEqual([
      { x: 150, y: 0 },
      { x: 450, y: 0 },
      { x: 450, y: 400 },
      { x: 150, y: 400 },
    ]);
  });
});

describe('computeGuideRect', () => {
  it('fills the short edge of a portrait frame and centres the box', () => {
    const rect = computeGuideRect(1200, 1600)!;

    expect(rect.width).toBeCloseTo(1200 * GUIDE_SHORT_EDGE_FILL, 8);
    expect(rect.height / rect.width).toBeCloseTo(GUIDE_ASPECT_RATIO, 8);
    expect(rect.left).toBeCloseTo((1200 - rect.width) / 2, 8);
    expect(rect.top).toBeCloseTo((1600 - rect.height) / 2, 8);
  });

  it('fills the short edge of a landscape frame -- which is its height', () => {
    const rect = computeGuideRect(1600, 1200)!;

    expect(rect.height).toBeCloseTo(1200 * GUIDE_SHORT_EDGE_FILL, 8);
    expect(rect.height / rect.width).toBeCloseTo(GUIDE_ASPECT_RATIO, 8);
  });

  it('shrinks rather than letting a near-square frame push the box off-picture', () => {
    const rect = computeGuideRect(1000, 1000)!;

    expect(rect.height).toBeLessThanOrEqual(1000);
    expect(rect.width).toBeLessThanOrEqual(1000);
    expect(rect.height).toBeCloseTo(1000, 8);
    expect(rect.height / rect.width).toBeCloseTo(GUIDE_ASPECT_RATIO, 8);
  });

  it('rejects degenerate input', () => {
    expect(computeGuideRect(0, 100)).toBeNull();
    expect(computeGuideRect(100, 100, 0)).toBeNull();
  });
});

describe('guide rectangle through the video mapping (CAPTURE_GUIDANCE §4.2)', () => {
  // The guide is computed in FRAME coordinates and pushed through the same
  // mapping as the detected polygon. That is what makes "fill the guide" mean
  // "satisfy the coverage the gate measures".
  it('keeps the frame-relative size the gate measures, under contain', () => {
    const mapping = computeVideoBoxMapping(1200, 1600, 600, 400, 'contain')!;
    const guide = mapRectToDisplay(mapping, computeGuideRect(1200, 1600)!);
    const videoWidthOnScreen = 1200 * mapping.scale;
    const videoHeightOnScreen = 1600 * mapping.scale;

    expect(guide.width / videoWidthOnScreen).toBeCloseTo(GUIDE_SHORT_EDGE_FILL, 8);
    expect(guide.left).toBeGreaterThanOrEqual(mapping.offsetX);
    expect(guide.top).toBeGreaterThanOrEqual(mapping.offsetY);
    expect(guide.top + guide.height).toBeLessThanOrEqual(mapping.offsetY + videoHeightOnScreen + 1e-9);
  });

  // Why the element was moved off `object-fit: cover`: the box the gate wants
  // does not fit on screen at all, so a user aiming at the visible guide would
  // be aiming at something the detector is not measuring.
  it('would run off the top of the element under cover', () => {
    const mapping = computeVideoBoxMapping(1200, 1600, 600, 400, 'cover')!;
    const guide = mapRectToDisplay(mapping, computeGuideRect(1200, 1600)!);

    expect(guide.top).toBeLessThan(0);
    expect(guide.top + guide.height).toBeGreaterThan(mapping.displayHeight);
  });
});

describe('computeQuadGeometry', () => {
  it('reads a head-on, centred sheet as square-on', () => {
    const geometry = computeQuadGeometry(IDEAL_QUAD, FRAME_W, FRAME_H)!;

    expect(geometry.rollDeg).toBeCloseTo(0, 10);
    expect(geometry.keystoneV).toBeCloseTo(0, 10);
    expect(geometry.keystoneH).toBeCloseTo(0, 10);
    expect(geometry.coverageW).toBeCloseTo(0.78, 8);
    expect(geometry.coverageH).toBeCloseTo(1080 / FRAME_H, 8);
    expect(geometry.marginMin).toBeCloseTo(152 / FRAME_H, 8);
    expect(geometry.aspectRatio).toBeCloseTo(1080 / 780, 8);
  });

  it('recovers the roll angle from the top and bottom edges', () => {
    const geometry = computeQuadGeometry(ROLLED_QUAD, FRAME_W, FRAME_H)!;

    expect(geometry.rollDeg).toBeCloseTo((Math.atan2(82, 780) * 180) / Math.PI, 6);
    expect(geometry.rollDeg).toBeGreaterThan(4);
    expect(geometry.keystoneV).toBeCloseTo(0, 10);
    expect(geometry.keystoneH).toBeCloseTo(0, 10);
  });

  it('signs the vertical keystone by which horizontal edge is farther', () => {
    expect(computeQuadGeometry(TOP_FAR_QUAD, FRAME_W, FRAME_H)!.keystoneV)
      .toBeCloseTo((780 - 640) / 780, 8);
    expect(computeQuadGeometry(BOTTOM_FAR_QUAD, FRAME_W, FRAME_H)!.keystoneV)
      .toBeCloseTo((640 - 780) / 780, 8);
  });

  it('signs the horizontal keystone by which vertical edge is farther', () => {
    expect(computeQuadGeometry(LEFT_FAR_QUAD, FRAME_W, FRAME_H)!.keystoneH)
      .toBeCloseTo((1080 - 880) / 1080, 8);
    expect(computeQuadGeometry(RIGHT_FAR_QUAD, FRAME_W, FRAME_H)!.keystoneH)
      .toBeCloseTo((880 - 1080) / 1080, 8);
  });

  it('accepts the four corners in any order', () => {
    const scrambled = [IDEAL_QUAD[2], IDEAL_QUAD[0], IDEAL_QUAD[3], IDEAL_QUAD[1]];

    expect(computeQuadGeometry(scrambled, FRAME_W, FRAME_H))
      .toEqual(computeQuadGeometry(IDEAL_QUAD, FRAME_W, FRAME_H));
  });

  it('rejects anything that is not four points in a real frame', () => {
    expect(computeQuadGeometry(IDEAL_QUAD.slice(0, 3), FRAME_W, FRAME_H)).toBeNull();
    expect(computeQuadGeometry(IDEAL_QUAD, 0, FRAME_H)).toBeNull();
  });
});

describe('evaluateCaptureGuidance', () => {
  it('asks for a portrait frame first, because the gate cannot pass in landscape', () => {
    const status = evaluateCaptureGuidance({
      quality: null,
      rejection: null,
      frameWidth: 1600,
      frameHeight: 1200,
    });

    expect(status.code).toBe('landscape');
    expect(status.level).toBe('adjust');
  });

  it('is grey and searching when no candidate was seen at all', () => {
    const status = guidance(null);

    expect(status.level).toBe('searching');
    expect(status.code).toBe('searching');
    expect(status.message).toBe('종이를 찾는 중');
    expect(status.detail).not.toBeNull();
  });

  it('is amber with the rejection wording when a candidate was seen and refused', () => {
    for (const rejection of ['cropped', 'too-small', 'wrong-shape', 'not-a-quad'] as const) {
      const status = evaluateCaptureGuidance({
        quality: null,
        rejection,
        frameWidth: FRAME_W,
        frameHeight: FRAME_H,
      });

      expect(status.level).toBe('adjust');
      expect(status.code).toBe(rejection);
      // Same table the post-capture retake prompt reads.
      expect(status.message).toBe(rejectionHint(rejection));
    }
  });

  it('is green for a head-on sheet that fills the guide', () => {
    const status = guidance(IDEAL_QUAD);

    expect(status.level).toBe('ready');
    expect(status.code).toBe('ready');
    expect(status.message).toBe('지금 촬영하세요');
  });

  it('calls out roll before perspective, because the fix is different', () => {
    const status = guidance(ROLLED_QUAD, 0.8);

    expect(status.code).toBe('roll');
    expect(status.message).toBe('화면과 나란히 돌려주세요');
  });

  it('turns the keystone sign into a direction', () => {
    const belowWarn = EDGE_CONSISTENCY_WARN - 0.03;

    expect(guidance(TOP_FAR_QUAD, belowWarn).code).toBe('keystone-top');
    expect(guidance(TOP_FAR_QUAD, belowWarn).message).toBe('위쪽을 조금 낮춰주세요');
    expect(guidance(BOTTOM_FAR_QUAD, belowWarn).code).toBe('keystone-bottom');
    expect(guidance(BOTTOM_FAR_QUAD, belowWarn).message).toBe('아래쪽을 조금 낮춰주세요');
    expect(guidance(LEFT_FAR_QUAD, belowWarn).code).toBe('keystone-left');
    expect(guidance(RIGHT_FAR_QUAD, belowWarn).code).toBe('keystone-right');
  });

  it('stays green when edgeConsistency is above the warning threshold', () => {
    // The keystone geometry is unchanged; only the summary value decides.
    expect(guidance(TOP_FAR_QUAD, EDGE_CONSISTENCY_WARN + 0.01).level).toBe('ready');
  });

  // The margin and coverage branches cannot fire on a quality the SHIPPED gate
  // produced -- `evaluateQuadDetailed` refuses those first. They are a guard,
  // and these two cases pin down what the guard says if it ever is reached.
  it('names a sheet running off the frame', () => {
    const status = guidance([
      { x: 5, y: 152 },
      { x: 890, y: 152 },
      { x: 890, y: 1232 },
      { x: 5, y: 1232 },
    ]);

    expect(status.code).toBe('margin');
  });

  it('names a sheet that is too far away', () => {
    const status = guidance([
      { x: 350, y: 484 },
      { x: 650, y: 484 },
      { x: 650, y: 900 },
      { x: 350, y: 900 },
    ]);

    expect(status.code).toBe('coverage');
    expect(status.message).toBe('조금 더 가까이');
  });

  it('waits for the camera before saying anything', () => {
    const status = evaluateCaptureGuidance({
      quality: null,
      rejection: null,
      frameWidth: 0,
      frameHeight: 0,
    });

    expect(status.code).toBe('no-frame');
    expect(status.level).toBe('searching');
  });
});

describe('nextReadyStreak', () => {
  it('counts consecutive green readings and resets on anything else', () => {
    const green = guidance(IDEAL_QUAD);
    const amber = guidance(ROLLED_QUAD, 0.8);

    let streak = 0;
    streak = nextReadyStreak(streak, green);
    streak = nextReadyStreak(streak, green);
    expect(streak).toBeLessThan(READY_STREAK_FOR_SHUTTER);

    streak = nextReadyStreak(streak, green);
    expect(streak).toBe(READY_STREAK_FOR_SHUTTER);

    streak = nextReadyStreak(streak, amber);
    expect(streak).toBe(0);
  });
});
