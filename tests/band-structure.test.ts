import { describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  detectOffRowBand,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';

/**
 * The band-structure refusal, from FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §8
 * (re-measured version) row A'.
 *
 * Two photo sheets read `satisfaction.q10` as 2 instead of 4. The ranked boxes
 * carried the same arrangement on both: the box the student marked read
 * `actualInk 0.000` while the other four sat at 0.10-0.17, and the gate then
 * confirmed the wrong column on margins that looked healthy. That is a band
 * displaced onto the printed text line below the table's last row, not an
 * answer row, and this file pins down when the recogniser says so.
 *
 * Both routes are exercised. `detectOffRowBand` is the pure rule and carries
 * the threshold arithmetic, including the boundaries, which cannot be hit
 * exactly through a rasterised fixture. `analyzeChoiceGroup` is driven with a
 * synthetic five-box baseline group to prove the rule actually sits ahead of
 * the paths that auto-fill -- the pure function alone cannot show that.
 */

// The drafted constants, restated here so a retune has to change the test on
// purpose rather than have it follow along silently.
const HIGH = 0.10;
const EMPTY = 0.005;
const MIN_INKED = 3;

describe('detectOffRowBand -- the rule', () => {
  it('refuses the measured off-row signature: four boxes inked, one void', () => {
    // §8's reading of p4/p5 satisfaction.q10, winner first as the decision
    // ranks them.
    expect(detectOffRowBand([0.16, 0.14, 0.13, 0.12, 0.000], 0)).toEqual({ inked: 4, empty: 1 });
  });

  it('leaves a normal marked row alone: one box inked over a shared baseline', () => {
    expect(detectOffRowBand([0.15, 0.05, 0.04, 0.03, 0.03], 0)).toBeNull();
  });

  it('leaves an all-blank row alone -- the other gates own that case', () => {
    expect(detectOffRowBand([0, 0, 0, 0, 0], 0)).toBeNull();
    expect(detectOffRowBand([0.002, 0.001, 0.000, 0.003, 0.000], 0)).toBeNull();
  });

  it('leaves a heavily inked row with no void box alone', () => {
    // Ink everywhere is a dark or over-exposed cell, not the displacement this
    // refusal names. Without a void box there is no missing column to explain.
    expect(detectOffRowBand([0.16, 0.14, 0.13, 0.12, 0.11], 0)).toBeNull();
  });

  it('leaves the band alone when the would-be winner is the void box', () => {
    // The winner scoring on an empty box is a different situation, and one the
    // existing floor already refuses. This rule must not claim it.
    expect(detectOffRowBand([0.000, 0.16, 0.14, 0.13, 0.12], 0)).toBeNull();
  });

  it('reads the winner at the index it is given, not always the first', () => {
    const inks = [0.000, 0.16, 0.14, 0.13, 0.12];
    expect(detectOffRowBand(inks, 1)).toEqual({ inked: 4, empty: 1 });
    expect(detectOffRowBand(inks, 0)).toBeNull();
  });

  it('counts every void box, not just the first', () => {
    expect(detectOffRowBand([0.16, 0.14, 0.13, 0.000, 0.000], 0)).toEqual({ inked: 3, empty: 2 });
  });

  describe('boundaries -- each constant is a >= or a <=, and the test says which', () => {
    it('BAND_INK_HIGH is inclusive: a box exactly at the threshold counts as inked', () => {
      // Exactly MIN_INKED boxes, the last of them sitting on HIGH itself.
      expect(detectOffRowBand([0.16, 0.14, HIGH, 0.000, 0.000], 0)).toEqual({ inked: 3, empty: 2 });
      // One hair below and the same row no longer has enough inked boxes.
      expect(detectOffRowBand([0.16, 0.14, HIGH - 0.0001, 0.000, 0.000], 0)).toBeNull();
    });

    it('BAND_INK_HIGH is inclusive for the winner too', () => {
      expect(detectOffRowBand([HIGH, 0.14, 0.13, 0.000], 0)).toEqual({ inked: 3, empty: 1 });
      expect(detectOffRowBand([HIGH - 0.0001, 0.14, 0.13, 0.12, 0.000], 0)).toBeNull();
    });

    it('BAND_INK_EMPTY is inclusive: a box exactly at the threshold counts as void', () => {
      expect(detectOffRowBand([0.16, 0.14, 0.13, EMPTY], 0)).toEqual({ inked: 3, empty: 1 });
      // Just above it, the box is faint rather than void and the rule declines.
      expect(detectOffRowBand([0.16, 0.14, 0.13, EMPTY + 0.0001], 0)).toBeNull();
    });

    it('MIN_INKED_BOXES is a minimum: one fewer inked box and the rule declines', () => {
      const atMinimum = [0.16, 0.14, 0.13, 0.000];
      expect(atMinimum.filter((ink) => ink >= HIGH)).toHaveLength(MIN_INKED);
      expect(detectOffRowBand(atMinimum, 0)).toEqual({ inked: MIN_INKED, empty: 1 });
      expect(detectOffRowBand([0.16, 0.14, 0.09, 0.000], 0)).toBeNull();
    });

    it('declines on a group too short to carry the arrangement, and on a bad index', () => {
      expect(detectOffRowBand([0.16, 0.14, 0.000], 0)).toBeNull();
      expect(detectOffRowBand([], 0)).toBeNull();
      expect(detectOffRowBand([0.16, 0.14, 0.13, 0.000], 9)).toBeNull();
      expect(detectOffRowBand([0.16, 0.14, 0.13, 0.000], -1)).toBeNull();
    });

    it('ignores a reading that is not a number rather than counting it either way', () => {
      expect(detectOffRowBand([0.16, 0.14, 0.13, Number.NaN, 0.000], 0))
        .toEqual({ inked: 3, empty: 1 });
      expect(detectOffRowBand([Number.NaN, 0.16, 0.14, 0.13, 0.000], 0)).toBeNull();
    });
  });
});

/**
 * A five-box row on a strip of paper, one box per candidate, sampled 1:1 by the
 * scorer (the cells are exactly the 36x28 sample grid, so a painted pixel is a
 * sample and the ink readings below are arithmetic rather than guesswork).
 */
const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const GUTTER = 4;
const BOX_COUNT = 5;
const PAGE_WIDTH = GUTTER + BOX_COUNT * (CELL_WIDTH + GUTTER);
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;
// The scorer drops a one-sample border per axis before averaging.
const USABLE_SAMPLES = (CELL_WIDTH - 2) * (CELL_HEIGHT - 2);

function boxRect(index: number): PixelRect {
  const left = GUTTER + index * (CELL_WIDTH + GUTTER);
  return { left, top: GUTTER, right: left + CELL_WIDTH, bottom: GUTTER + CELL_HEIGHT };
}

/** Solid ink of a chosen area, laid inside the averaged window. */
function paintInk(pixels: Buffer, rect: PixelRect, rows: number, columns: number): void {
  for (let y = rect.top + 11; y < rect.top + 11 + rows; y++) {
    for (let x = rect.left + 5; x < rect.left + 5 + columns; x++) {
      pixels[y * PAGE_WIDTH + x] = 0;
    }
  }
}

/** What `paintInk` will read as, so a test can name the ink it is asking for. */
function inkOf(rows: number, columns: number): number {
  return (rows * columns) / USABLE_SAMPLES;
}

const boxes = Array.from({ length: BOX_COUNT }, (_, index) => boxRect(index));

const group: ChoiceGroup = {
  field: 'satisfaction.q10',
  candidates: boxes.map((rect, index) => ({
    value: index + 1,
    rect: {
      x: rect.left / PAGE_WIDTH,
      y: rect.top / PAGE_HEIGHT,
      width: CELL_WIDTH / PAGE_WIDTH,
      height: CELL_HEIGHT / PAGE_HEIGHT,
    },
  })),
};

function analyze(page: Buffer, blank: Buffer) {
  const image: ImageAnalysisData = {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pixels: page,
    contentBoundsConfident: true,
  };
  const baseline: ImageAnalysisData = {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pixels: blank,
    contentBoundsConfident: true,
  };
  return analyzeChoiceGroup(image, group, undefined, true, boxes, false, {
    image: baseline,
    candidatePixelOverrides: boxes,
  });
}

describe('analyzeChoiceGroup -- where the refusal sits', () => {
  it('refuses the off-row band before any path that would auto-fill it', () => {
    const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
    const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);

    // Box 0 carries ink the blank form does not, so it wins on every existing
    // test: it clears the floor, the gap, the contrast and the mark shape.
    paintInk(page, boxes[0], 5, 23);
    // Boxes 1-3 carry the same ink on the page AND on the blank form, so they
    // score near zero and cannot be what refuses this group -- but their
    // template ink is the printed-text ink the band is lying on.
    for (const index of [1, 2, 3]) {
      paintInk(page, boxes[index], 5, 23);
      paintInk(blank, boxes[index], 5, 23);
    }
    // Box 4 is past the table's right edge: void on both.

    expect(inkOf(5, 23)).toBeGreaterThanOrEqual(HIGH);

    const result = analyze(page, blank);

    // The whole point: nothing else objected. The refusal list holds this check
    // and nothing more, so without it the group would have been confirmed.
    expect(result.decision).toContain('refused=band-structure');
    expect(result.decision).toContain('band=refused(inked=4,empty=1');
    expect(result.confidence).toBe('low');
    expect(result.value).toBeUndefined();
  });

  it('refuses the same band when only the medium path would have taken it', () => {
    const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
    const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);

    // The winner's ink is nearly all printed form, so what is left over lands
    // between the medium floor and the high one: the high conjunction refuses
    // and the medium path is what would confirm it.
    paintInk(page, boxes[0], 5, 23);
    paintInk(blank, boxes[0], 5, 21);
    for (const index of [1, 2, 3]) {
      paintInk(page, boxes[index], 5, 23);
      paintInk(blank, boxes[index], 5, 23);
    }

    const result = analyze(page, blank);

    // High refused on its own terms, and the band check still had to be the
    // thing that stopped the medium path from filling the field.
    expect(result.decision).toContain('absolute-floor');
    expect(result.decision).toContain('band-structure');
    expect(result.decision).toContain('band=refused(inked=4,empty=1');
    expect(result.confidence).toBe('low');
    expect(result.value).toBeUndefined();
  });

  it('leaves a normal marked row confirmed', () => {
    const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
    const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);

    // One box marked, the rest sharing the faint printed baseline every option
    // carries. This is the arrangement a real answer makes.
    paintInk(page, boxes[2], 5, 27);
    for (const index of [0, 1, 3, 4]) {
      paintInk(page, boxes[index], 5, 6);
      paintInk(blank, boxes[index], 5, 6);
    }

    expect(inkOf(5, 6)).toBeLessThan(HIGH);

    const result = analyze(page, blank);

    expect(result.decision).not.toContain('band-structure');
    expect(result.decision).not.toContain('band=refused');
    expect(result.value).toBe(group.candidates[2].value);
    expect(result.confidence).toBe('high');
  });

  it('leaves an all-blank row to the gates that own it', () => {
    const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
    const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);

    const result = analyze(page, blank);

    expect(result.decision).not.toContain('band-structure');
    expect(result.decision).not.toContain('band=refused');
    // The four thresholds all refuse it, which is the gate that owns an empty
    // reading. What follows is not this check's business: two blank buffers
    // give the rescue rule an all-zero feature vector, where its bias alone
    // clears the threshold, so this synthetic pair comes out confirmed. That
    // is a property of a fixture with no printed form on it at all -- recorded
    // here so the next reader does not mistake it for the band rule leaking.
    expect(result.decision).toContain('absolute-floor');
    expect(result.decision).toContain('rescued:');
  });

  it('does not run on the raw-density path, which has no template ink to read', () => {
    // Same displaced-band arrangement, no blank form: the scorer falls back to
    // dark-pixel density, where `actualInk` does not exist. A density reading
    // is a different measurement and this rule says nothing about it.
    const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
    paintInk(page, boxes[0], 5, 23);
    for (const index of [1, 2, 3]) {
      paintInk(page, boxes[index], 5, 23);
    }
    const image: ImageAnalysisData = {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      pixels: page,
      contentBoundsConfident: true,
    };

    const result = analyzeChoiceGroup(image, group, undefined, true, boxes);

    expect(result.decision).toContain('base=0');
    expect(result.decision).not.toContain('band-structure');
  });
});
