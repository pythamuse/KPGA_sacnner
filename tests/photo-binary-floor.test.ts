import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';

/**
 * The raised floor a two-candidate group answers to on a photo sheet, from
 * FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §9.1(b).
 *
 * Every automatic acceptance the binary questions (q02-q06) produced over the
 * 19 photo sheets was read, and there were six. Their winning scores
 * interleave -- CORRECT 0.029/0.035/0.067 against WRONG 0.025/0.027/0.032 --
 * so there is no cut that keeps the correct ones. 0.042 buys all three wrong
 * values at the price of two of the three correct ones. `WRONG = 0` outranking
 * correct count is the whole justification; n = 6 is the whole sample.
 *
 * What this file pins is not the number's rightness, which only the central
 * measurement can judge. It pins the two properties the number needs to be
 * worth measuring at all:
 *
 *   1. it applies to two-candidate groups on photo sheets and to nothing else;
 *   2. no route to an automatic value walks under it -- not the high
 *      conjunction, not the rescue, not the medium path.
 *
 * SUPERSEDED, NOT DELETED (2026-08-27, spec §14.1). Two-candidate groups on a
 * photo sheet are now refused outright, before the floor is ever consulted, so
 * on the default configuration this floor decides nothing. It is kept because
 * `PHOTO_BINARY_REFUSAL=0` puts it back in charge for a measurement run, and
 * because a later narrowing of the refusal drops those groups back onto it
 * rather than onto the base floor. This file therefore runs with the refusal
 * switched off -- it is the floor's specification, and the floor is only
 * observable there. The last block below runs on the default instead, so the
 * file also records that its subject is superseded.
 */

// The constant, restated so a retune has to change this file on purpose.
const PHOTO_BINARY_FLOOR = 0.042;
// What a score has to clear when the raised floor does not apply.
const BASE_FLOOR = 0.021;

/**
 * A row of boxes on a strip of paper, one box per candidate, sampled 1:1 by the
 * scorer (each cell is exactly the 36x28 sample grid, so a painted pixel is a
 * sample and every ink reading below is arithmetic rather than guesswork).
 */
const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const GUTTER = 4;
// The scorer drops a one-sample border per axis before averaging.
const USABLE_SAMPLES = (CELL_WIDTH - 2) * (CELL_HEIGHT - 2);
// Solid ink against blank paper, less the anti-aliasing band the scorer
// subtracts before it counts anything.
const RESIDUAL_PER_SAMPLE = 0.92;

function pageWidth(boxCount: number): number {
  return GUTTER + boxCount * (CELL_WIDTH + GUTTER);
}
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;

function boxRect(index: number): PixelRect {
  const left = GUTTER + index * (CELL_WIDTH + GUTTER);
  return { left, top: GUTTER, right: left + CELL_WIDTH, bottom: GUTTER + CELL_HEIGHT };
}

/**
 * `count` samples of solid ink, laid as a compact block inside the averaged
 * window so the residual is one connected component and reads as a mark.
 */
function paintSamples(
  pixels: Buffer,
  rect: PixelRect,
  count: number,
  width: number,
  blockWidth = 6,
): void {
  for (let index = 0; index < count; index++) {
    const y = rect.top + 5 + Math.floor(index / blockWidth);
    const x = rect.left + 5 + (index % blockWidth);
    pixels[y * width + x] = 0;
  }
}

/** Scattered single samples, spaced so no two touch: ink without a mark's shape. */
function paintScattered(pixels: Buffer, rect: PixelRect, count: number, width: number): void {
  for (let index = 0; index < count; index++) {
    const y = rect.top + 5 + 2 * Math.floor(index / 6);
    const x = rect.left + 5 + 2 * (index % 6);
    pixels[y * width + x] = 0;
  }
}

/** What `paintSamples` will score as, once the scorer has rounded it. */
function scoreOf(count: number): number {
  return Math.round((RESIDUAL_PER_SAMPLE * count / USABLE_SAMPLES) * 1000) / 1000;
}

/** What a painted box reads as on the `actualInk` the band check looks at. */
function inkOf(count: number): number {
  return count / USABLE_SAMPLES;
}

// The loser in every two-candidate fixture: the same ink on the page and on
// the blank form, so it scores zero while staying well clear of `void`. That
// keeps the band-structure refusal -- a different rule in the same gate -- out
// of these results, which is checked below rather than assumed.
const LOSER_SAMPLES = 20;

interface Fixture {
  result: ReturnType<typeof analyzeChoiceGroup>;
}

function run(
  winnerSamples: number,
  boxCount: number,
  photoProvenance: boolean,
  options: { scattered?: boolean; withBaseline?: boolean } = {},
): Fixture['result'] {
  const { scattered = false, withBaseline = true } = options;
  const width = pageWidth(boxCount);
  const boxes = Array.from({ length: boxCount }, (_, index) => boxRect(index));
  const page = Buffer.alloc(width * PAGE_HEIGHT, 255);
  const blank = Buffer.alloc(width * PAGE_HEIGHT, 255);

  if (scattered) {
    paintScattered(page, boxes[0], winnerSamples, width);
  } else {
    paintSamples(page, boxes[0], winnerSamples, width);
  }
  for (let index = 1; index < boxCount; index++) {
    paintSamples(page, boxes[index], LOSER_SAMPLES, width);
    paintSamples(blank, boxes[index], LOSER_SAMPLES, width);
  }

  const group: ChoiceGroup = {
    field: 'satisfaction.q03',
    candidates: boxes.map((rect, index) => ({
      value: index + 1,
      rect: {
        x: rect.left / width,
        y: rect.top / PAGE_HEIGHT,
        width: CELL_WIDTH / width,
        height: CELL_HEIGHT / PAGE_HEIGHT,
      },
    })),
  };
  const image: ImageAnalysisData = {
    width,
    height: PAGE_HEIGHT,
    pixels: page,
    contentBoundsConfident: true,
  };
  const baseline: ImageAnalysisData = {
    width,
    height: PAGE_HEIGHT,
    pixels: blank,
    contentBoundsConfident: true,
  };

  return analyzeChoiceGroup(
    image,
    group,
    undefined,
    true,
    boxes,
    false,
    withBaseline ? { image: baseline, candidatePixelOverrides: boxes } : undefined,
    photoProvenance,
  );
}

// Everything below reads the floor, and the floor is only reachable with the
// outright refusal off. Set per test rather than once at module scope so a
// test that wants the default can take it back by deleting the variable.
beforeEach(() => {
  process.env.PHOTO_BINARY_REFUSAL = '0';
});
afterEach(() => {
  delete process.env.PHOTO_BINARY_REFUSAL;
});

// The three readings the tests below are built on, stated once so a change in
// the fixture cannot quietly move what is being asked.
const WRONG_HIGH = 31; // the highest wrong winner §9.1(b) measured
const SURVIVING_CORRECT = 64; // the one correct winner the floor keeps
const AT_FLOOR = 40; // the smallest block that still rounds to the floor itself
const UNDER_FLOOR = 39;

describe('the fixture reads as the measurement it stands in for', () => {
  it('produces the scores §9.1(b) named', () => {
    expect(scoreOf(WRONG_HIGH)).toBe(0.032);
    expect(scoreOf(SURVIVING_CORRECT)).toBe(0.067);
    expect(scoreOf(AT_FLOOR)).toBe(PHOTO_BINARY_FLOOR);
    expect(scoreOf(UNDER_FLOOR)).toBeLessThan(PHOTO_BINARY_FLOOR);
    // 0.032 is the case the floor exists for: above the base floor, under the
    // raised one. Without that ordering these tests would prove nothing.
    expect(scoreOf(WRONG_HIGH)).toBeGreaterThan(BASE_FLOOR);
    expect(scoreOf(WRONG_HIGH)).toBeLessThan(PHOTO_BINARY_FLOOR);
  });

  it('keeps the band-structure rule out of these results', () => {
    // The loser box carries ink on both copies: not void, and under the band
    // rule's 0.040, either of which is enough to keep that refusal away. If
    // this ever stopped holding, the tests below would pass for the wrong
    // reason.
    expect(inkOf(LOSER_SAMPLES)).toBeGreaterThan(0.005);
    expect(inkOf(LOSER_SAMPLES)).toBeLessThan(0.040);
    for (const samples of [WRONG_HIGH, SURVIVING_CORRECT, AT_FLOOR, UNDER_FLOOR]) {
      expect(run(samples, 2, true).decision).not.toContain('band-structure');
    }
  });
});

describe('PHOTO_BINARY_FLOOR -- what it refuses', () => {
  it('refuses the highest wrong binary reading on a photo sheet', () => {
    const result = run(WRONG_HIGH, 2, true);

    expect(result.confidence).toBe('low');
    expect(result.value).toBeUndefined();
    // Named on its own, so a trace run can count what this constant costs
    // rather than reading it out of `absolute-floor` with everything else.
    expect(result.decision).toContain('photo-binary-floor');
    expect(result.decision).toContain('floor=0.032/0.042(');
  });

  it('leaves the same reading on a scan exactly where it was', () => {
    const result = run(WRONG_HIGH, 2, false);

    // Today's behaviour, unchanged: the base floor admits 0.032 and the group
    // is confirmed. This is the half of the change that must not move -- the
    // scan baseline is measured against it centrally.
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
    expect(result.decision).toContain('floor=0.032/0.021(');
    expect(result.decision).not.toContain('photo-binary-floor');
  });

  it('keeps the one correct reading that clears the floor', () => {
    const result = run(SURVIVING_CORRECT, 2, true);

    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
    expect(result.decision).toContain('floor=0.067/0.042(');
    expect(result.decision).not.toContain('photo-binary-floor');
  });

  it('does not touch a group with more than two candidates', () => {
    // Same score, same photo provenance, four boxes: the floor is about a
    // binary question having no third option to be outscored, so a wider group
    // reads exactly as it did before.
    const result = run(WRONG_HIGH, 4, true);

    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
    expect(result.decision).toContain('n=4');
    expect(result.decision).toContain('floor=0.032/0.021(');
    expect(result.decision).not.toContain('photo-binary-floor');
  });

  it('is inclusive: a score exactly at the floor is admitted', () => {
    const atFloor = run(AT_FLOOR, 2, true);
    expect(atFloor.value).toBe(1);
    expect(atFloor.confidence).toBe('high');
    expect(atFloor.decision).toContain(`floor=${PHOTO_BINARY_FLOOR.toFixed(3)}/0.042(`);

    const underFloor = run(UNDER_FLOOR, 2, true);
    expect(underFloor.value).toBeUndefined();
    expect(underFloor.confidence).toBe('low');
    expect(underFloor.decision).toContain('photo-binary-floor');
  });
});

describe('PHOTO_BINARY_FLOOR -- every route below the high conjunction', () => {
  /**
   * The high conjunction is not the only way a value reaches the page: the
   * rescue rule and the medium path both sit under it and neither reads a
   * floor of its own. A fixture whose residual has ink but no mark shape is
   * refused by the conjunction on `mark-shape` and picked up by the rescue,
   * whose weights read fit and edges rather than signal strength -- which is
   * exactly the route a weak binary reading would escape through.
   */
  it('refuses a group the routes under the conjunction would have taken', () => {
    const scan = run(WRONG_HIGH, 2, false, { scattered: true });

    // First: this fixture really is taken when the floor does not apply, and
    // not by the high conjunction, which refused it.
    expect(scan.decision).toContain('mark-shape');
    expect(scan.decision).toContain('rescued:');
    expect(scan.value).toBe(1);
    expect(scan.confidence).toBe('high');

    // Then: the same fixture on a photo sheet reaches no value at all.
    const photo = run(WRONG_HIGH, 2, true, { scattered: true });
    expect(photo.value).toBeUndefined();
    expect(photo.confidence).toBe('low');
    expect(photo.decision).toContain('photo-binary-floor');
    expect(photo.decision).not.toContain('rescued:');
  });

  it('raises the medium floor with the high one, so the gap between them is closed', () => {
    // The medium path's own floor is 0.007. Everything from there to 0.042 is
    // the room a binary photo group would have had under it.
    const photo = run(WRONG_HIGH, 2, true, { scattered: true });
    expect(photo.decision).toContain('med-floor=0.032/0.042(');

    const scan = run(WRONG_HIGH, 2, false, { scattered: true });
    expect(scan.decision).toContain('med-floor=0.032/0.007(');
  });
});

describe('PHOTO_BINARY_FLOOR -- where it cannot reach', () => {
  it('changes nothing on the raw-density path, whose floors are already above it', () => {
    // No blank form, so the scorer falls back to dark-pixel density, where the
    // thresholds are 0.35 and 0.1 -- both above 0.042, so applying the floor as
    // a maximum leaves them untouched. The two decisions are compared in full
    // rather than by outcome: a raised threshold would show up in the trace
    // even where it changed no answer.
    const photo = run(WRONG_HIGH, 2, true, { withBaseline: false });
    const scan = run(WRONG_HIGH, 2, false, { withBaseline: false });

    expect(photo.decision).toContain('base=0');
    expect(photo.decision).toBe(scan.decision);
    expect(photo.value).toBe(scan.value);
    expect(photo.confidence).toBe(scan.confidence);
  });
});

describe('PHOTO_BINARY_FLOOR -- what supersedes it', () => {
  /**
   * On the default configuration the floor never gets asked. Every reading it
   * would have admitted is refused first, which is the whole of §14.1: the six
   * wrong binary values were the *other box winning outright*, so no floor can
   * reach them without also cutting the correct ones.
   *
   * Detail covered in `photo-binary-refusal.test.ts`; what belongs here is the
   * one fact this file would otherwise assert falsely -- that the readings
   * below reach a value.
   */
  it('admits nothing the refusal has already declined', () => {
    delete process.env.PHOTO_BINARY_REFUSAL;

    for (const samples of [SURVIVING_CORRECT, AT_FLOOR]) {
      const result = run(samples, 2, true);
      expect(result.value).toBeUndefined();
      expect(result.confidence).toBe('low');
      expect(result.decision).toContain('photo-binary-refused');
    }
  });

  it('still refuses on its own where the refusal is switched off', () => {
    // The floor is not dead: with the refusal off it is what a photo-binary
    // group answers to, and it is what a narrowed refusal would fall back on.
    const admitted = run(SURVIVING_CORRECT, 2, true);
    expect(admitted.value).toBe(1);

    const refused = run(UNDER_FLOOR, 2, true);
    expect(refused.value).toBeUndefined();
    expect(refused.decision).toContain('photo-binary-floor');
  });
});
