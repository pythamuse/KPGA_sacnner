import { describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  detectOffRowBand,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';

/**
 * The band-structure refusal, from FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27
 * §9.1(a), which re-measured the draft §8 row A' had proposed and replaced it.
 *
 * Two photo sheets read `satisfaction.q10` as 2 instead of 4. The ranked boxes
 * carried the same arrangement on both: the box the student marked read
 * `actualInk 0.000` while every other box carried ink, and the gate then
 * confirmed the wrong column on margins that looked healthy. That is a band
 * displaced onto the printed text line below the table's last row, not an
 * answer row, and this file pins down when the recogniser says so.
 *
 * The draft rule (>=3 boxes at >=0.10, plus >=1 void) covered the first sheet
 * and missed the second, whose inks are `0.103/0.077/0.070/0.046/0.000` -- the
 * same arrangement at a lower level. §9.1(a) re-measured over all fifteen
 * accepted multi-choice photo rows: `>=1 void AND every non-void box >= 0.040`
 * fires on both off-row bands and on none of the legitimate rows, whose highest
 * minNonVoid is 0.017 (p1 q07). 0.040 / 0.017 is the whole margin, on fifteen
 * rows.
 *
 * Both routes are exercised. `detectOffRowBand` is the pure rule and carries
 * the threshold arithmetic, including the boundaries, which cannot be hit
 * exactly through a rasterised fixture. `analyzeChoiceGroup` is driven with a
 * synthetic five-box baseline group to prove the rule actually sits ahead of
 * the paths that auto-fill -- the pure function alone cannot show that.
 */

// The measured constants, restated here so a retune has to change the test on
// purpose rather than have it follow along silently.
const EMPTY = 0.005;
const ALL_MIN = 0.040;
// The highest minNonVoid any of the fifteen legitimate rows reached. Every
// "leaves it alone" case below is built at or under this.
const LEGITIMATE_MAX = 0.017;

describe('detectOffRowBand -- the rule', () => {
  it('refuses the measured off-row signature: every box inked but one, which is void', () => {
    // The p4-shaped case: the level the draft rule was cut for.
    expect(detectOffRowBand([0.16, 0.14, 0.13, 0.12, 0.000], 0))
      .toEqual({ nonVoid: 4, empty: 1, minNonVoid: 0.12 });
  });

  it('refuses the lower band the inked-count rule missed', () => {
    // §9.1(a)'s p5 `satisfaction.q10`, verbatim, winner first as the decision
    // ranks them. Not one box reaches the old 0.10, so the old rule counted
    // zero inked boxes and let this through; the new one reads the 0.046 and
    // refuses.
    expect(detectOffRowBand([0.103, 0.077, 0.070, 0.046, 0.000], 0))
      .toEqual({ nonVoid: 4, empty: 1, minNonVoid: 0.046 });
  });

  it('leaves a normal marked row alone: one box inked over a shared baseline', () => {
    // A void box is present, so the void half of the signature is satisfied and
    // the 0.040 minimum is the only thing refusing this. That is the case the
    // fifteen rows measure: their faint boxes sit at or under 0.017.
    expect(detectOffRowBand([0.15, LEGITIMATE_MAX, 0.012, 0.010, 0.000], 0)).toBeNull();
    // The worst of them, on every faint box at once.
    expect(detectOffRowBand([0.15, LEGITIMATE_MAX, LEGITIMATE_MAX, LEGITIMATE_MAX, 0.000], 0))
      .toBeNull();
    // ...and that is the entire margin this rule has: 2.3x.
    expect(ALL_MIN / LEGITIMATE_MAX).toBeGreaterThan(2.3);
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
    expect(detectOffRowBand(inks, 1)).toEqual({ nonVoid: 4, empty: 1, minNonVoid: 0.12 });
    expect(detectOffRowBand(inks, 0)).toBeNull();
  });

  it('counts every void box, not just the first', () => {
    expect(detectOffRowBand([0.16, 0.14, 0.13, 0.000, 0.000], 0))
      .toEqual({ nonVoid: 3, empty: 2, minNonVoid: 0.13 });
  });

  it('reports the smallest inked reading, which is what the rule turned on', () => {
    // Not the winner and not the last box: the refusal is diagnosable only if
    // the number compared against 0.040 is the one reported.
    expect(detectOffRowBand([0.16, 0.041, 0.13, 0.12, 0.000], 0))
      .toEqual({ nonVoid: 4, empty: 1, minNonVoid: 0.041 });
  });

  describe('boundaries -- each constant is a >= or a <=, and the test says which', () => {
    it('BAND_INK_ALL_MIN is inclusive: a box exactly at it still reads as band ink', () => {
      expect(detectOffRowBand([0.16, 0.14, ALL_MIN, 0.000, 0.000], 0))
        .toEqual({ nonVoid: 3, empty: 2, minNonVoid: ALL_MIN });
      // One hair below and the row has an inked box too faint for a band.
      expect(detectOffRowBand([0.16, 0.14, ALL_MIN - 0.0001, 0.000, 0.000], 0)).toBeNull();
    });

    it('BAND_INK_ALL_MIN applies to the winner like any other box', () => {
      expect(detectOffRowBand([ALL_MIN, 0.14, 0.13, 0.000], 0))
        .toEqual({ nonVoid: 3, empty: 1, minNonVoid: ALL_MIN });
      expect(detectOffRowBand([ALL_MIN - 0.0001, 0.14, 0.13, 0.12, 0.000], 0)).toBeNull();
    });

    it('BAND_INK_EMPTY is inclusive: a box exactly at it counts as void', () => {
      expect(detectOffRowBand([0.16, 0.14, 0.13, EMPTY], 0))
        .toEqual({ nonVoid: 3, empty: 1, minNonVoid: 0.13 });
      // Just above it the box is faint rather than void, so it joins the inked
      // set -- and being under 0.040 it is what refuses the rule. The void that
      // remains beside it is there so this reads as the one difference.
      expect(detectOffRowBand([0.16, 0.14, 0.13, EMPTY + 0.0001, 0.000], 0)).toBeNull();
      expect(detectOffRowBand([0.16, 0.14, 0.13, EMPTY, 0.000], 0))
        .toEqual({ nonVoid: 3, empty: 2, minNonVoid: 0.13 });
    });

    it('BAND_INK_EMPTY is inclusive for the winner too: a void winner is not this case', () => {
      expect(detectOffRowBand([EMPTY, 0.16, 0.14, 0.13, 0.000], 0)).toBeNull();
      // Above it the winner is inked, and then the 0.040 minimum reads it.
      expect(detectOffRowBand([EMPTY + 0.0001, 0.16, 0.14, 0.13, 0.000], 0)).toBeNull();
    });

    it('declines on an empty group and on a bad index', () => {
      expect(detectOffRowBand([], 0)).toBeNull();
      expect(detectOffRowBand([0.16, 0.14, 0.13, 0.000], 9)).toBeNull();
      expect(detectOffRowBand([0.16, 0.14, 0.13, 0.000], -1)).toBeNull();
    });

    it('has no minimum group size any more, which the measured sample cannot speak to', () => {
      // The old rule needed three inked boxes, so it could not fire below four
      // boxes at all. The new one has no count in it, so a two- or three-box
      // group carrying the same arrangement is refused. The fifteen rows
      // §9.1(a) measured are all multi-choice, so this is out of sample --
      // recorded here as a consequence of the rule, not as a measured result.
      // It only ever removes a value, so it cannot make a wrong answer.
      expect(detectOffRowBand([0.16, 0.14, 0.000], 0))
        .toEqual({ nonVoid: 2, empty: 1, minNonVoid: 0.14 });
      expect(detectOffRowBand([0.10, 0.000], 0))
        .toEqual({ nonVoid: 1, empty: 1, minNonVoid: 0.10 });
      // A binary question's boxes both carry printed ink, which is the reading
      // that keeps this off them: p16 q03 measured 0.053 and 0.027, no void.
      expect(detectOffRowBand([0.053, 0.027], 0)).toBeNull();
    });

    it('ignores a reading that is not a number rather than counting it either way', () => {
      expect(detectOffRowBand([0.16, 0.14, 0.13, Number.NaN, 0.000], 0))
        .toEqual({ nonVoid: 3, empty: 1, minNonVoid: 0.13 });
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
  // photoProvenance: true — the band refusal is photo-only. Running it on
  // scans measurably cost 4 correct cells for zero WRONG change (2026-08-27).
  return analyzeChoiceGroup(image, group, undefined, true, boxes, false, {
    image: baseline,
    candidatePixelOverrides: boxes,
  }, true);
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

    expect(inkOf(5, 23)).toBeGreaterThanOrEqual(ALL_MIN);

    const result = analyze(page, blank);

    // The whole point: nothing else objected. The refusal list holds this check
    // and nothing more, so without it the group would have been confirmed.
    expect(result.decision).toContain('refused=band-structure');
    expect(result.decision).toContain('band=refused(nonvoid=4,empty=1,min=0.130/0.040(');
    expect(result.confidence).toBe('low');
    expect(result.value).toBeUndefined();
  });

  it('refuses the lower band the inked-count rule let through', () => {
    const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
    const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);

    // The p5 arrangement: same shape as above, but no box reaches 0.10. The
    // old rule counted zero inked boxes here and confirmed the winner.
    paintInk(page, boxes[0], 5, 9);
    for (const index of [1, 2, 3]) {
      paintInk(page, boxes[index], 5, 9);
      paintInk(blank, boxes[index], 5, 9);
    }

    expect(inkOf(5, 9)).toBeLessThan(0.10);
    expect(inkOf(5, 9)).toBeGreaterThanOrEqual(ALL_MIN);

    const result = analyze(page, blank);

    expect(result.decision).toContain('refused=band-structure');
    expect(result.decision).toContain('band=refused(nonvoid=4,empty=1,min=0.051/0.040(');
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
    expect(result.decision).toContain('band=refused(nonvoid=4,empty=1,min=0.130/0.040(');
    expect(result.confidence).toBe('low');
    expect(result.value).toBeUndefined();
  });

  it('leaves a normal marked row confirmed, void box and all', () => {
    const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
    const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);

    // One box marked, the rest sharing the faint printed baseline every option
    // carries, and one box void. This is the arrangement a real answer makes,
    // and the void means only the 0.040 minimum stands between it and a
    // refusal -- the faint boxes are built at 0.017 and 0.010, which is the top
    // of what the fifteen measured legitimate rows reached.
    paintInk(page, boxes[2], 5, 27);
    for (const index of [0, 1]) {
      paintInk(page, boxes[index], 3, 5);
      paintInk(blank, boxes[index], 3, 5);
    }
    paintInk(page, boxes[3], 3, 3);
    paintInk(blank, boxes[3], 3, 3);
    // Box 4 stays void, so `empty >= 1` holds and the minimum is the only test
    // left.

    expect(inkOf(3, 5)).toBeCloseTo(LEGITIMATE_MAX, 3);
    expect(inkOf(3, 5)).toBeLessThan(ALL_MIN);
    expect(inkOf(3, 3)).toBeLessThan(inkOf(3, 5));

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
    // reading. What follows is not this check's business, and is recorded here
    // so the next reader does not mistake it for the band rule leaking.
    //
    // Two blank buffers give the rescue rule an all-zero feature vector, where
    // its bias alone clears the threshold, and this pair used to come out
    // confirmed on that alone. The total-ink invariant now closes that route
    // (FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §14.2, `tests/ink-invariant`):
    // both boxes carry 0.000 page ink against 0.000 blank ink, so nothing was
    // added to either and the rescue -- which reads shape and fit but never a
    // score -- is not allowed to confirm one.
    expect(result.decision).toContain('absolute-floor');
    expect(result.decision).toContain('ink-invariant');
    expect(result.decision).not.toContain('rescued:');
    expect(result.value).toBeUndefined();
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

    const result = analyzeChoiceGroup(image, group, undefined, true, boxes, false, undefined, true);

    expect(result.decision).toContain('base=0');
    expect(result.decision).not.toContain('band-structure');
  });
});
