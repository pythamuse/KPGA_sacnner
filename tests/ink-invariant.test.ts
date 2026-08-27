import { describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  calculateTemplateInkDifference,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';

/**
 * The total-ink invariant, from FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §14.2.
 *
 * Differential scoring rests on one premise: count only what the student
 * ADDED. §14.2 measured that premise broken. The winning box of
 * `p3 basic.gender` -- a cell the answer key marks blank, and filling it is the
 * failure CLAUDE.md §3 ranks above every other number -- read
 *
 *     page=0.099  blank=0.112  scr=0.056
 *
 * Less total ink than the blank form carries, and a positive residual anyway.
 * The two are summed over the same samples in the same loop, so what lets them
 * disagree in sign is that the aggregates are two-sided while the residual is
 * `max(0, actual - baseline - 0.08)` per sample: clipping throws away every
 * sample where the page is lighter, so a box that is darker in a few places and
 * lighter everywhere else still accumulates a score.
 *
 * What this file pins:
 *
 *   1. a box whose page ink is below its blank ink scores 0, and its group
 *      does not auto-fill -- including the arrangement §14.2 measured, at the
 *      numbers §14.2 measured;
 *   2. equality scores 0, because the premise is "more than", not "at least";
 *   3. a box above its blank is untouched, to the digit;
 *   4. the raw-density path, which has no baseline to compare against, is
 *      untouched;
 *   5. **the invariant can only remove.** Zeroing one box must not widen
 *      another box's margin -- the naive form sends `relativeContrast` to
 *      infinity whenever the runner-up is zeroed, which would turn a refusal
 *      into an automatic value. That is the opposite of what this unit is.
 *
 * Nothing here judges accuracy. These are synthetic boxes (CLAUDE.md §2), so
 * they can show the arithmetic does what it claims and nothing more.
 */

// The gate constants this file reasons against, restated so a retune has to
// change this file on purpose.
const HIGH_ABSOLUTE_SIGNAL = 0.021;
const HIGH_RELATIVE_CONTRAST = 1.25;

/**
 * One box per candidate on a strip of paper, sampled 1:1 by the scorer: each
 * cell is exactly the 36x28 sample grid, so a painted pixel is a sample and
 * every ink figure below is arithmetic rather than guesswork. Same fixture
 * shape as `photo-binary-floor.test.ts`.
 */
const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const GUTTER = 4;
/** The scorer drops a one-sample border per axis before averaging. */
const USABLE_SAMPLES = (CELL_WIDTH - 2) * (CELL_HEIGHT - 2);
/** Solid ink on blank paper, less the anti-aliasing band subtracted per sample. */
const RESIDUAL_PER_SAMPLE = 0.92;
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;

/** `darkness()` as the scorer defines it, for stating a grey level's ink. */
function inkOfGrey(value: number): number {
  return Math.max(0, Math.min(1, (178 - value) / 178));
}

function pageWidth(boxCount: number): number {
  return GUTTER + boxCount * (CELL_WIDTH + GUTTER);
}

function boxRect(index: number): PixelRect {
  const left = GUTTER + index * (CELL_WIDTH + GUTTER);
  return { left, top: GUTTER, right: left + CELL_WIDTH, bottom: GUTTER + CELL_HEIGHT };
}

/**
 * `count` samples of one grey level, laid as a compact block so a residual made
 * of them is a single connected component and reads as a mark.
 */
function paintBlock(
  pixels: Buffer,
  rect: PixelRect,
  options: {
    count: number;
    value: number;
    originX: number;
    originY: number;
    blockWidth: number;
  },
  width: number,
): void {
  const { count, value, originX, originY, blockWidth } = options;
  for (let index = 0; index < count; index++) {
    const y = rect.top + originY + Math.floor(index / blockWidth);
    const x = rect.left + originX + (index % blockWidth);
    pixels[y * width + x] = value;
  }
}

/**
 * The printed content of one cell, and how the page reproduced it.
 *
 * `glyph` is the form's own printing -- the answer glyph or table rule that the
 * subtraction exists to remove. `pageGlyphGrey` is what the page's copy of it
 * came out at: lighter than the blank's is the §14.2 arrangement, and equal to
 * it is an ordinary scan. `mark` is ink the page has and the blank does not,
 * placed clear of the glyph so its residual survives the subtraction whole.
 */
interface Cell {
  glyphCount?: number;
  blankGlyphGrey?: number;
  pageGlyphGrey?: number;
  mark?: number;
  /** Ink on both page and blank, at the same place: a box that scores nothing. */
  shared?: number;
  /** Ink on the blank only, placed clear of everything the page carries. */
  blankOnly?: number;
}

/** Where each kind of ink goes inside a cell, all well inside the averaged window. */
const MARK_AT = { originX: 3, originY: 3, blockWidth: 6 };
const GLYPH_AT = { originX: 16, originY: 3, blockWidth: 15 };
const SHARED_AT = { originX: 3, originY: 15, blockWidth: 6 };
const BLANK_ONLY_AT = { originX: 20, originY: 3, blockWidth: 9 };

function paintCell(page: Buffer, blank: Buffer, rect: PixelRect, cell: Cell, width: number): void {
  if (cell.glyphCount) {
    paintBlock(blank, rect, {
      count: cell.glyphCount,
      value: cell.blankGlyphGrey ?? 60,
      ...GLYPH_AT,
    }, width);
    paintBlock(page, rect, {
      count: cell.glyphCount,
      value: cell.pageGlyphGrey ?? 60,
      ...GLYPH_AT,
    }, width);
  }
  if (cell.mark) {
    paintBlock(page, rect, { count: cell.mark, value: 0, ...MARK_AT }, width);
  }
  if (cell.shared) {
    for (const target of [page, blank]) {
      paintBlock(target, rect, { count: cell.shared, value: 0, ...SHARED_AT }, width);
    }
  }
  if (cell.blankOnly) {
    paintBlock(blank, rect, { count: cell.blankOnly, value: 0, ...BLANK_ONLY_AT }, width);
  }
}

interface RunOptions {
  photoProvenance?: boolean;
  withBaseline?: boolean;
  requireHighVisualConfidence?: boolean;
  field?: string;
}

function build(cells: Cell[]): {
  image: ImageAnalysisData;
  baseline: ImageAnalysisData;
  boxes: PixelRect[];
  width: number;
} {
  const width = pageWidth(cells.length);
  const boxes = cells.map((_, index) => boxRect(index));
  const page = Buffer.alloc(width * PAGE_HEIGHT, 255);
  const blank = Buffer.alloc(width * PAGE_HEIGHT, 255);
  cells.forEach((cell, index) => paintCell(page, blank, boxes[index], cell, width));
  return {
    image: { width, height: PAGE_HEIGHT, pixels: page, contentBoundsConfident: true },
    baseline: { width, height: PAGE_HEIGHT, pixels: blank, contentBoundsConfident: true },
    boxes,
    width,
  };
}

function run(cells: Cell[], options: RunOptions = {}) {
  const {
    photoProvenance = false,
    withBaseline = true,
    requireHighVisualConfidence = false,
    field = 'satisfaction.q03',
  } = options;
  const { image, baseline, boxes, width } = build(cells);
  const group: ChoiceGroup = {
    field,
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
  return analyzeChoiceGroup(
    image,
    group,
    undefined,
    true,
    boxes,
    requireHighVisualConfidence,
    withBaseline ? { image: baseline, candidatePixelOverrides: boxes } : undefined,
    photoProvenance,
  );
}

/** The one box's measurements, by the index the template lists it at. */
function measurementOf(result: ReturnType<typeof analyzeChoiceGroup>, candidateIndex: number) {
  const found = (result.candidateMeasurements ?? [])
    .find((entry) => entry.candidateIndex === candidateIndex);
  expect(found).toBeDefined();
  return found!;
}

/** One `key=` field out of the decision string. */
function fieldOf(decision: string, key: string): string {
  const match = new RegExp(`(?:^|[ \\[])${key}=([^ \\]]+)`).exec(decision);
  expect(match, `${key}= missing from ${decision}`).not.toBeNull();
  return match![1];
}

// ---------------------------------------------------------------------------
// The §14.2 cell, rebuilt at the numbers §14.2 measured.
//
// A form glyph the page reproduced lighter than the blank scan holds it, plus a
// patch of ink the blank does not have. Every sample of the glyph is lighter on
// the page than on the blank, so the glyph contributes nothing to the residual
// and a great deal to the totals; the patch alone carries the score.
// ---------------------------------------------------------------------------
const GLYPH_COUNT = 149;
const BLANK_GLYPH_GREY = 60; // ink 0.663
const FADED_GLYPH_GREY = 138; // ink 0.225 -- 0.438 lighter, far past the 0.08 band
const SECTION_14_2_MARK = 54;

const SECTION_14_2: Cell = {
  glyphCount: GLYPH_COUNT,
  blankGlyphGrey: BLANK_GLYPH_GREY,
  pageGlyphGrey: FADED_GLYPH_GREY,
  mark: SECTION_14_2_MARK,
};
/** The same cell with the glyph printed as darkly as the blank holds it. */
const ABOVE_BLANK: Cell = {
  glyphCount: GLYPH_COUNT,
  blankGlyphGrey: BLANK_GLYPH_GREY,
  pageGlyphGrey: BLANK_GLYPH_GREY,
  mark: SECTION_14_2_MARK,
};
/** A box that scores nothing and stays well clear of `void`: the loser. */
const QUIET_LOSER: Cell = { shared: 20 };

const EXPECTED_PAGE_INK = (SECTION_14_2_MARK + GLYPH_COUNT * inkOfGrey(FADED_GLYPH_GREY))
  / USABLE_SAMPLES;
const EXPECTED_BLANK_INK = (GLYPH_COUNT * inkOfGrey(BLANK_GLYPH_GREY)) / USABLE_SAMPLES;
const EXPECTED_RESIDUAL = (SECTION_14_2_MARK * RESIDUAL_PER_SAMPLE) / USABLE_SAMPLES;

describe('the fixture reads as the measurement it stands in for', () => {
  it('reproduces §14.2: page 0.099, blank 0.112, residual 0.056', () => {
    const result = run([SECTION_14_2, QUIET_LOSER]);
    const winner = measurementOf(result, 0);

    expect(winner.actualInk).toBeCloseTo(0.099, 3);
    expect(winner.baselineInk).toBeCloseTo(0.112, 3);
    // Arithmetic, not a coincidence of the tuning.
    expect(winner.actualInk).toBeCloseTo(EXPECTED_PAGE_INK, 6);
    expect(winner.baselineInk).toBeCloseTo(EXPECTED_BLANK_INK, 6);
    expect(EXPECTED_RESIDUAL).toBeCloseTo(0.056, 3);
  });

  it('is a residual the gate would otherwise have confirmed', () => {
    // Without the invariant this box clears the absolute floor two and a half
    // times over. Nothing here is a near miss that some other threshold would
    // have caught anyway.
    expect(EXPECTED_RESIDUAL).toBeGreaterThan(HIGH_ABSOLUTE_SIGNAL);
    // And the same box with the glyph printed at full strength -- the only
    // difference between the two cells -- is confirmed at high confidence.
    const control = run([ABOVE_BLANK, QUIET_LOSER]);
    expect(control.value).toBe(1);
    expect(control.confidence).toBe('high');
  });
});

describe('a box carrying no more ink than the blank scores 0', () => {
  it('zeroes the §14.2 box and refuses its group', () => {
    const result = run([SECTION_14_2, QUIET_LOSER]);
    const winner = measurementOf(result, 0);

    expect(winner.actualInk!).toBeLessThan(winner.baselineInk!);
    expect(winner.score).toBe(0);
    expect(result.candidates[0].score).toBe(0);
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.decision).toContain('refused=ink-invariant,');
  });

  it('says so on the box, with the residual it removed', () => {
    const result = run([SECTION_14_2, QUIET_LOSER]);
    expect(result.decision).toContain(
      `inkInvariant=zeroed(page<=blank,scr0=${EXPECTED_RESIDUAL.toFixed(4)})`,
    );
  });

  it('applies to the smallest exported unit as well as to the group', () => {
    const { image, baseline, boxes } = build([SECTION_14_2, QUIET_LOSER]);
    expect(calculateTemplateInkDifference(image, boxes[0], baseline, boxes[0])).toBe(0);
  });

  it('holds on a scan, where no tonal map ran at all', () => {
    // `photoProvenance` is false throughout this file, so the boxes were
    // measured through the linear shift every scan takes -- the invariant is a
    // property of the subtraction, not of the affine map that exposed it.
    const result = run([SECTION_14_2, QUIET_LOSER]);
    expect(result.decision).toContain('tone=linear(0)');
    expect(result.candidates[0].score).toBe(0);
  });

  it('refuses the rescue route too', () => {
    // The rescue reads shape and fit and never reads signal strength, so it is
    // the one route that could still confirm a box the invariant emptied.
    const result = run([SECTION_14_2, QUIET_LOSER]);
    expect(result.decision).not.toContain('rescued:');
    expect(result.value).toBeUndefined();
  });
});

describe('equality scores 0', () => {
  // Ink on the blank the page does not have, and ink on the page the blank does
  // not have, in equal amounts and different places. The totals match to the
  // sample; the one-sided residual sees only the page's half.
  const EQUAL_COUNT = 54;
  const EQUAL: Cell = { mark: EQUAL_COUNT, blankOnly: EQUAL_COUNT };

  it('is a genuine tie carrying a residual, not a box with nothing in it', () => {
    const result = run([EQUAL, QUIET_LOSER]);
    const winner = measurementOf(result, 0);
    expect(winner.actualInk).toBe(winner.baselineInk);
    expect(winner.actualInk!).toBeGreaterThan(0);
    // What the residual would have been: the premise is "more than", so a tie
    // is on the wrong side of it.
    expect((EQUAL_COUNT * RESIDUAL_PER_SAMPLE) / USABLE_SAMPLES)
      .toBeGreaterThan(HIGH_ABSOLUTE_SIGNAL);
  });

  it('scores 0 and does not auto-fill', () => {
    const result = run([EQUAL, QUIET_LOSER]);
    expect(result.candidates[0].score).toBe(0);
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
  });
});

describe('a box above its blank is untouched', () => {
  it('scores what it scored before, to the digit', () => {
    const { image, baseline, boxes } = build([ABOVE_BLANK, QUIET_LOSER]);
    const direct = calculateTemplateInkDifference(image, boxes[0], baseline, boxes[0]);
    expect(direct).toBeCloseTo(EXPECTED_RESIDUAL, 12);

    const result = run([ABOVE_BLANK, QUIET_LOSER]);
    const winner = measurementOf(result, 0);
    expect(winner.actualInk!).toBeGreaterThan(winner.baselineInk!);
    expect(result.candidates[0].score).toBe(0.056);
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
    expect(result.decision).not.toContain('ink-invariant');
  });

  it('reaches every gate with the numbers it always reached them with', () => {
    // Captured from the implementation this unit changed, by running this
    // fixture against it. These are the five ratios every automatic value is
    // decided on; if the invariant had disturbed an untouched box, they move.
    const { decision } = run([ABOVE_BLANK, QUIET_LOSER]);
    expect(fieldOf(decision, 'scores')).toBe('0.056/0.000');
    expect(fieldOf(decision, 'floor')).toBe('0.056/0.021(2.67x)');
    expect(fieldOf(decision, 'gap')).toBe('0.056/0.004(14.00x)');
    expect(fieldOf(decision, 'contrast')).toBe('inf/1.250(inf)');
    expect(fieldOf(decision, 'med-floor')).toBe('0.056/0.007(8.00x)');
    expect(fieldOf(decision, 'med-gap')).toBe('0.056/0.003(18.67x)');
  });
});

describe('the raw-density path has no baseline and no invariant', () => {
  // The same page, scored with no blank form supplied. There is no `baselineInk`
  // for anything to be compared against, and a density reading is not the same
  // measurement, so the invariant must not reach it.
  it('leaves the §14.2 page scoring exactly what density scores it', () => {
    const withoutBaseline = run([SECTION_14_2, QUIET_LOSER], { withBaseline: false });

    expect(fieldOf(withoutBaseline.decision, 'base')).toBe('0');
    expect(measurementOf(withoutBaseline, 0).actualInk).toBeNull();
    expect(measurementOf(withoutBaseline, 0).baselineInk).toBeNull();
    expect(withoutBaseline.decision).not.toContain('ink-invariant');
    // Nonzero, where the template path scores the same page 0.
    expect(withoutBaseline.candidates[0].score).toBeGreaterThan(0);
    // Captured from the implementation this unit changed.
    expect(fieldOf(withoutBaseline.decision, 'scores')).toBe('0.201/0.020');
  });
});

describe('the invariant can only remove, never widen a margin', () => {
  // A weak but genuine mark, against a runner-up the invariant zeroes. Before
  // this unit the group was refused on relative contrast, 1.24 against the 1.25
  // it needs. Zeroing the runner-up's score naively would divide by zero --
  // `relativeContrast` goes to infinity -- and hand this group an automatic
  // value it never earned. That is the failure mode this unit exists to avoid,
  // so it is pinned rather than assumed.
  const WEAK_WINNER: Cell = { mark: 25 };
  const ZEROED_RUNNER_UP: Cell = {
    // A larger faded glyph than §14.2's, so the runner-up disagrees with the
    // blank form too much for the rescue route to reach this group. The rescue
    // reads shape and fit and never reads a score, so it neither helps nor
    // hinders the invariant -- it just answers first, and it would answer the
    // same way before this unit as after. Keeping it out is what leaves the
    // contrast test as the gate this fixture is actually about.
    glyphCount: 220,
    blankGlyphGrey: BLANK_GLYPH_GREY,
    pageGlyphGrey: FADED_GLYPH_GREY,
    mark: 20,
  };
  const cells = [WEAK_WINNER, ZEROED_RUNNER_UP];

  it('zeroes the runner-up and leaves the winner ranked where it was', () => {
    const result = run(cells);
    const runnerUp = measurementOf(result, 1);
    expect(runnerUp.actualInk!).toBeLessThan(runnerUp.baselineInk!);
    expect(runnerUp.score).toBe(0);
    expect(measurementOf(result, 0).score).toBe(0.026);
    // The winner is still the winner: ranking reads the pre-invariant score, so
    // the invariant cannot promote a box either.
    expect(fieldOf(result.decision, 'scores')).toBe('0.026/0.000');
  });

  it('keeps both margin tests at the values they had before', () => {
    // Captured from the implementation this unit changed. `gap` and `contrast`
    // both read the runner-up at its pre-invariant 0.021, so neither can widen.
    const { decision } = run(cells);
    expect(fieldOf(decision, 'gap')).toBe('0.005/0.004(1.25x)');
    expect(fieldOf(decision, 'contrast')).toBe('1.238/1.250(0.99x)');
  });

  it('still refuses the group on relative contrast', () => {
    const result = run(cells, { requireHighVisualConfidence: true });
    expect(result.decision).toContain('relative-contrast');
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    // The refusal is the contrast test, not the invariant: the winner is not
    // the zeroed box.
    expect(result.decision).not.toContain('refused=ink-invariant');
    expect(1.238).toBeLessThan(HIGH_RELATIVE_CONTRAST);
  });
});
