import { describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  calculateTemplateInkDifference,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { withAffineTone } from './helpers/affineTone';
import { pinShippedScorer } from './helpers/scorerVariants';

/**
 * The total-ink guard, as it is actually scoped after central measurement.
 *
 * FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §14.2 read the winning box of
 * `p3 basic.gender` -- a cell the answer key marks blank, and filling it is the
 * failure CLAUDE.md §3 ranks above every other number -- as
 *
 *     page=0.099  blank=0.112  scr=0.056  tone=affine(53,209->0,255,g=1.63)
 *
 * Less total ink than the blank form carries, and a positive residual anyway,
 * because the aggregates are two-sided while the residual is
 * `max(0, actual - baseline - 0.08)` per sample: clipping throws away every
 * sample where the page is lighter, so a box darker in a few places and lighter
 * everywhere else still accumulates a score.
 *
 * §14.3 proposed forcing that box's score to 0 as a pure invariant, valid
 * "whether or not the affine map ran". **That reading was retracted on
 * measurement.** Enforced everywhere the guard cost
 *
 *     scans          node 355/7 -> 334/5   (-21 correct, -2 wrong)
 *     linear photos       59/0  ->  26/0   (-33 correct, no wrong to remove)
 *
 * The scan number is the informative one: `actualInk <= baselineInk` does NOT
 * mean "nothing was added" there. A thin tick adds ink in a handful of samples
 * while the box as a whole still reads lighter than the blank asset's printed
 * circle, because the two rasters render that circle at different weights. The
 * comparison is confounded by the printed content, not by the scanner -- the
 * linear-photo number says the same thing on the other raster pair.
 *
 * What the measurement does support is narrower: the AFFINE TONE MAP's stretch
 * manufactures per-sample residual in a box nothing was added to. So the guard
 * now requires `affineToneEnabled() && photoProvenance`, and `MARK_AFFINE_TONE`
 * is off by default.
 *
 * What this file pins, in the order the measurement ranks it:
 *
 *   1. **NON-REGRESSION.** With the flag off, or on a scan, a box below its
 *      blank keeps the score it has always had and its group still auto-fills.
 *      These are the cases that protect the 355-correct scan baseline and the
 *      59-correct linear photo baseline, and they are the larger half of this
 *      file on purpose.
 *   2. Under `MARK_AFFINE_TONE` on a photo sheet, that same box scores 0 and
 *      its group is refused -- including through the rescue route.
 *   3. Equality scores 0: the premise is "more than", not "at least".
 *   4. A box above its blank is untouched, to the digit, armed or not.
 *   5. The raw-density path, which has no baseline to compare against, is
 *      untouched.
 *   6. **The guard can only remove.** Zeroing one box must not widen another
 *      box's margin -- the naive form sends `relativeContrast` to infinity
 *      whenever the runner-up is zeroed, turning a refusal into an automatic
 *      value.
 *
 * Nothing here judges accuracy. These are synthetic boxes (CLAUDE.md §2), so
 * they can show the arithmetic does what it claims and nothing more. Every
 * expected number below is derived from `createGroupToneCorrection` /
 * `normalizeTone` and shown as arithmetic, so a reader can check it without
 * running anything.
 */

// The gate constants this file reasons against, restated so a retune has to
// change this file on purpose.
const HIGH_ABSOLUTE_SIGNAL = 0.021;
const HIGH_RELATIVE_CONTRAST = 1.25;

// The guard's two arming conditions are read at call time -- `photoProvenance`
// from the caller, `MARK_AFFINE_TONE` from `process.env` -- so every case here
// states the one it is about rather than inheriting it. `withAffineTone` is
// what keeps this suite passing on both sides of the flag.

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
const USABLE_SAMPLES = (CELL_WIDTH - 2) * (CELL_HEIGHT - 2); // 34 * 26 = 884
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
 * `anchor` is the printed content that sets the group's tonal anchors: it is
 * the darkest thing on both copies after the pen marks, so the 5th percentile
 * of the pooled samples lands inside it on each side. That is what gives
 * `createGroupToneCorrection` a gain to compute (see THE MAP below).
 *
 * `glyph` is further printed content -- the answer glyph or table rule the
 * subtraction exists to remove -- lying between the anchor and paper.
 * `pageGlyphGrey` is what the page's copy came out at; lighter than the blank's
 * is the §14.2 arrangement.
 *
 * `mark` is ink the page has and the blank does not, placed clear of everything
 * else so its residual survives the subtraction whole.
 */
interface Cell {
  anchorCount?: number;
  anchorBlankGrey?: number;
  anchorPageGrey?: number;
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
const ANCHOR_AT = { originX: 16, originY: 15, blockWidth: 12 };
const SHARED_AT = { originX: 3, originY: 15, blockWidth: 6 };
const BLANK_ONLY_AT = { originX: 20, originY: 3, blockWidth: 9 };

function paintCell(page: Buffer, blank: Buffer, rect: PixelRect, cell: Cell, width: number): void {
  if (cell.anchorCount) {
    paintBlock(blank, rect, {
      count: cell.anchorCount,
      value: cell.anchorBlankGrey ?? 45,
      ...ANCHOR_AT,
    }, width);
    paintBlock(page, rect, {
      count: cell.anchorCount,
      value: cell.anchorPageGrey ?? 105,
      ...ANCHOR_AT,
    }, width);
  }
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
// THE MAP.
//
// Every armed fixture below is a three-cell group -- one box under test and two
// quiet losers. Three rather than two because a two-candidate photo group under
// `MARK_AFFINE_TONE` is refused outright by `photo-binary-refused` (spec §14.1)
// before the conjunction runs, which would mask what this file is measuring.
// `photo-binary-floor.test.ts` and `photo-binary-refusal.test.ts` own that rule.
//
// `createGroupToneCorrection` pools all three cells' samples, so the anchors are
// read over 3 * 36 * 28 = 3024 samples a side. `percentile` takes index
// `round((n - 1) * fraction)`:
//
//     p05 -> round(3023 * 0.05) = 151
//     p82 -> round(3023 * 0.82) = 2479
//
// PAGE, darkest first, for the deficit fixture below:
//     grey 0    x  94   54-sample mark + 20 shared ink in each of the 2 losers
//     grey 105  x 120   the anchor block          <- covers index 94..213, so p05
//     grey 178  x 149   the faded glyph
//     grey 255  x 2661                            <- index 2479 lands here, so p82
//   => actualLo = 105, actualHi = 255
//
// BLANK, darkest first:
//     grey 0    x  40   the two losers' shared ink; the blank carries no mark
//     grey 45   x 120   the anchor block          <- covers index 40..159, so p05
//     grey 60   x 149   the glyph as the form prints it
//     grey 255  x 2715                            <- p82
//   => blankLo = 45, blankHi = 255
//
// `createToneCorrection` then takes the affine branch: actualSpan = 255 - 105 =
// 150 and blankSpan = 255 - 45 = 210 both clear TONE_MIN_SPAN = 8, and
// rawGain = 210 / 150 = 1.4 is above 1 and under TONE_MAX_GAIN = 12. The shift
// is blankHi - actualHi = 0, and `applyTone` is
//
//     v -> clamp(255 + (v - 255) * 1.4, 0, 255)
//
//     255 -> 255           ink 0
//     178 -> 147.2         ink 30.8/178 = 0.17303
//     105 ->  45           ink 133/178  = 0.74719   <- lands exactly on the blank's
//       0 -> -102 -> 0     ink 1
//
// The anchor block is why the guard can be exercised at all: it pins the page's
// dark end onto the blank's, so the glyph -- which sits *above* the anchor on
// both copies -- keeps a deficit after the stretch instead of being mapped onto
// its own counterpart. Without it the map sends the faded glyph straight onto
// the blank's glyph and the box comes out heavier than its baseline, which is
// what happened to the old fixtures here and why they had to be rebuilt.
// ---------------------------------------------------------------------------
const ANCHOR_COUNT = 120;
const ANCHOR_BLANK_GREY = 45; // ink 0.74719
const ANCHOR_PAGE_GREY = 105; // ink 0.41011 unmapped, 0.74719 through the map
const GLYPH_COUNT = 149;
const BLANK_GLYPH_GREY = 60; // ink 0.66292
const FADED_GLYPH_GREY = 178; // ink 0 unmapped, 0.17303 through the map
const MARK_COUNT = 54;

/** The anchor pair on its own, plus a mark: the page reads above its blank. */
const ANCHORED_MARK: Cell = {
  anchorCount: ANCHOR_COUNT,
  anchorBlankGrey: ANCHOR_BLANK_GREY,
  anchorPageGrey: ANCHOR_PAGE_GREY,
  mark: MARK_COUNT,
};
/**
 * The §14.2 arrangement, rebuilt to survive the map: the same cell with a glyph
 * the page reproduced far lighter than the blank holds it. Every sample of that
 * glyph is lighter on the page even after the stretch, so it contributes
 * nothing to the residual and a great deal to the totals; the mark alone carries
 * the score.
 */
const ANCHORED_DEFICIT: Cell = {
  ...ANCHORED_MARK,
  glyphCount: GLYPH_COUNT,
  blankGlyphGrey: BLANK_GLYPH_GREY,
  pageGlyphGrey: FADED_GLYPH_GREY,
};
/** A box that scores nothing and stays well clear of `void`: the loser. */
const QUIET_LOSER: Cell = { shared: 20 };
/** The group every armed case is run as. */
const DEFICIT_GROUP: Cell[] = [ANCHORED_DEFICIT, QUIET_LOSER, QUIET_LOSER];
const ABOVE_GROUP: Cell[] = [ANCHORED_MARK, QUIET_LOSER, QUIET_LOSER];

// Totals over the 884 averaged samples, from the mapped levels above.
//
//   page  = 54 x 1 + 120 x 0.74719 + 149 x 0.17303 = 169.445 -> 0.19168
//   blank =          120 x 0.74719 + 149 x 0.66292 = 188.438 -> 0.21317
const MAPPED_PAGE_INK = (MARK_COUNT
  + ANCHOR_COUNT * inkOfGrey(ANCHOR_BLANK_GREY)
  + GLYPH_COUNT * inkOfGrey(255 + (FADED_GLYPH_GREY - 255) * 1.4)) / USABLE_SAMPLES;
const MAPPED_BLANK_INK = (ANCHOR_COUNT * inkOfGrey(ANCHOR_BLANK_GREY)
  + GLYPH_COUNT * inkOfGrey(BLANK_GLYPH_GREY)) / USABLE_SAMPLES;
// The same box on the linear path, where nothing is stretched: the page's glyph
// at grey 178 is exactly where `darkness()` saturates to 0, and its anchor reads
// 0.41011 rather than the blank's 0.74719.
//
//   page  = 54 x 1 + 120 x 0.41011 + 149 x 0 = 103.213 -> 0.11675
const LINEAR_PAGE_INK = (MARK_COUNT + ANCHOR_COUNT * inkOfGrey(ANCHOR_PAGE_GREY)) / USABLE_SAMPLES;
// Only the mark clears the 0.08 anti-aliasing band, on either path:
//   mark    1       - 0       - 0.08 = 0.92, x54 = 49.68
//   anchor  0.74719 - 0.74719 - 0.08 < 0 -> 0   (mapped; unmapped it is lighter still)
//   glyph   0.17303 - 0.66292 - 0.08 < 0 -> 0   (mapped; unmapped the page reads 0)
const EXPECTED_RESIDUAL = (MARK_COUNT * RESIDUAL_PER_SAMPLE) / USABLE_SAMPLES;

// Every number below is the shipped scorer's. See `pinShippedScorer`.
pinShippedScorer();

describe('the fixture reads as the map the product would apply', () => {
  it('takes the affine branch, at the gain the two anchor pairs imply', () => {
    const result = withAffineTone(true, () => run(DEFICIT_GROUP, { photoProvenance: true }));
    // `createToneCorrection`'s own label, so the anchors and the gain are read
    // back from the implementation rather than assumed.
    expect(result.decision).toContain('tone=affine(105,255->45,255,g=1.40)');
  });

  it('puts the box below its blank after the stretch, with a residual anyway', () => {
    const result = withAffineTone(true, () => run(DEFICIT_GROUP, { photoProvenance: true }));
    const winner = measurementOf(result, 0);

    expect(winner.actualInk).toBeCloseTo(MAPPED_PAGE_INK, 6);
    expect(winner.baselineInk).toBeCloseTo(MAPPED_BLANK_INK, 6);
    expect(winner.actualInk).toBeCloseTo(0.192, 3);
    expect(winner.baselineInk).toBeCloseTo(0.213, 3);
    expect(winner.actualInk!).toBeLessThan(winner.baselineInk!);
    // The §14.2 arrangement: less total ink than the blank, positive residual.
    expect(EXPECTED_RESIDUAL).toBeCloseTo(0.056, 3);
  });

  it('is a residual the gate would otherwise have confirmed', () => {
    // Not a near miss some other threshold would have caught anyway: this box
    // clears the absolute floor two and a half times over.
    expect(EXPECTED_RESIDUAL).toBeGreaterThan(HIGH_ABSOLUTE_SIGNAL);
    // And the same cell without the faded glyph -- the only difference between
    // the two -- is confirmed at high confidence under the very same map.
    const control = withAffineTone(true, () => run(ABOVE_GROUP, { photoProvenance: true }));
    expect(control.value).toBe(1);
    expect(control.confidence).toBe('high');
  });

  it('keeps the band-structure rule out of these results', () => {
    // The losers carry 20/884 = 0.023 on both copies: over BAND_INK_EMPTY
    // (0.005) so nothing is void, and under BAND_INK_ALL_MIN (0.040) so the
    // minimum fails too. Either alone keeps that refusal away. If this stopped
    // holding, the cases below would pass for the wrong reason.
    expect(20 / USABLE_SAMPLES).toBeGreaterThan(0.005);
    expect(20 / USABLE_SAMPLES).toBeLessThan(0.040);
    const result = withAffineTone(true, () => run(DEFICIT_GROUP, { photoProvenance: true }));
    expect(result.decision).not.toContain('band-structure');
  });
});

// ---------------------------------------------------------------------------
// NON-REGRESSION. The half of this file that protects the measured baselines.
// ---------------------------------------------------------------------------

describe('NON-REGRESSION -- a scan is untouched, which is worth 21 correct cells', () => {
  // Enforcing the guard on scans measured node 355/7 -> 334/5. `photoProvenance`
  // is false here, so the box takes the linear shift every scan takes and the
  // guard must not reach it -- with `MARK_AFFINE_TONE` armed or not, because the
  // map is declined for a scan before any anchor is computed and arming it is
  // how the next cycle measures.
  for (const armed of [false, true]) {
    it(`scores 0.056 and auto-fills with MARK_AFFINE_TONE ${armed ? 'armed' : 'off'}`, () => {
      const result = withAffineTone(armed, () => run(DEFICIT_GROUP));

      const winner = measurementOf(result, 0);
      // The box is below its blank on the linear path too, so the aggregate
      // comparison is true here and the guard still has to stay out of it.
      expect(winner.actualInk).toBeCloseTo(LINEAR_PAGE_INK, 6);
      expect(winner.actualInk).toBeCloseTo(0.117, 3);
      expect(winner.baselineInk).toBeCloseTo(0.213, 3);
      expect(winner.actualInk!).toBeLessThan(winner.baselineInk!);

      expect(result.decision).toContain('tone=linear(0)');
      expect(result.candidates[0].score).toBe(0.056);
      expect(result.value).toBe(1);
      expect(result.confidence).toBe('high');
      expect(fieldOf(result.decision, 'refused')).toBe('none');
    });
  }
});

describe('NON-REGRESSION -- the linear photo path is untouched, worth 33 correct cells', () => {
  it('scores 0.056 and auto-fills on a photo sheet while the flag is off', () => {
    // The shipped configuration. Enforcing the guard here measured 59/0 -> 26/0
    // on the 19-student photo set: 33 correct cells given up and no wrong value
    // to remove, because on the linear path the same aggregate comparison is
    // confounded by the printed glyph rather than manufactured by a stretch.
    const result = withAffineTone(false, () => run(DEFICIT_GROUP, { photoProvenance: true }));

    expect(result.decision).toContain('tone=linear(0)');
    expect(result.candidates[0].score).toBe(0.056);
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
    expect(result.decision).not.toContain('refused=ink-invariant');
  });

  it('still reports the aggregate on the box, because measuring is not refusing', () => {
    // `inkInvariant=zeroed(...)` is written by `calculateTemplateInkFeatures`,
    // which computes the comparison unconditionally; only `analyzeChoiceGroup`
    // is scoped. The marker therefore appears on a box the guard did not touch,
    // and that is deliberate -- it is how a measurement run counts what arming
    // the flag would cost before arming it.
    const result = withAffineTone(false, () => run(DEFICIT_GROUP, { photoProvenance: true }));
    expect(result.decision).toContain(
      `inkInvariant=zeroed(page<=blank,scr0=${EXPECTED_RESIDUAL.toFixed(4)})`,
    );
    // Reported, and not acted on: the score is the residual, whole.
    expect(result.candidates[0].score).toBe(0.056);
  });
});

// ---------------------------------------------------------------------------
// The guard, under the conditions the product applies it.
// ---------------------------------------------------------------------------

describe('under MARK_AFFINE_TONE on a photo sheet, a box below its blank scores 0', () => {
  const armed = () => withAffineTone(true, () => run(DEFICIT_GROUP, { photoProvenance: true }));

  it('zeroes the box and refuses its group', () => {
    const result = armed();
    const winner = measurementOf(result, 0);

    expect(winner.actualInk!).toBeLessThan(winner.baselineInk!);
    expect(winner.score).toBe(0);
    expect(result.candidates[0].score).toBe(0);
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.decision).toContain('refused=ink-invariant,');
  });

  it('says so on the box, with the residual it removed', () => {
    expect(armed().decision).toContain(
      `inkInvariant=zeroed(page<=blank,scr0=${EXPECTED_RESIDUAL.toFixed(4)})`,
    );
  });

  it('refuses the rescue route too', () => {
    // The rescue reads shape and fit and never reads signal strength, so it is
    // the one route that could still confirm a box the guard emptied.
    const result = armed();
    expect(result.decision).not.toContain('rescued:');
    expect(result.value).toBeUndefined();
  });

  it('applies to the smallest exported unit, which is not scoped at all', () => {
    // `calculateTemplateInkDifference` returns the feature-level `score`, where
    // the comparison is unconditional. Scoping lives in `analyzeChoiceGroup`,
    // which is the only place that decides anything, so this unit reads the
    // same in both environments and is asserted in both.
    const { image, baseline, boxes } = build(DEFICIT_GROUP);
    for (const flag of [false, true]) {
      expect(withAffineTone(flag,
        () => calculateTemplateInkDifference(image, boxes[0], baseline, boxes[0]))).toBe(0);
    }
  });
});

describe('equality scores 0', () => {
  // The anchor pair and a mark, balanced by the same count of ink on the blank
  // only. Through the map the mark reads 1 and the blank-only ink reads 1, and
  // the anchor lands on its own counterpart, so the two totals match to the
  // sample:
  //
  //   page  = 54 x 1 + 120 x 0.74719 = 143.663 -> 0.16251
  //   blank = 54 x 1 + 120 x 0.74719 = 143.663 -> 0.16251
  //
  // The one-sided residual sees only the page's half: 54 x 0.92 / 884 = 0.056.
  const EQUAL_COUNT = MARK_COUNT;
  const EQUAL: Cell = { ...ANCHORED_MARK, blankOnly: EQUAL_COUNT };
  const EQUAL_GROUP: Cell[] = [EQUAL, QUIET_LOSER, QUIET_LOSER];
  const armed = () => withAffineTone(true, () => run(EQUAL_GROUP, { photoProvenance: true }));

  it('is a genuine tie carrying a residual, not a box with nothing in it', () => {
    const winner = measurementOf(armed(), 0);
    expect(winner.actualInk).toBe(winner.baselineInk);
    expect(winner.actualInk).toBeCloseTo(
      (EQUAL_COUNT + ANCHOR_COUNT * inkOfGrey(ANCHOR_BLANK_GREY)) / USABLE_SAMPLES, 6,
    );
    expect(winner.actualInk!).toBeGreaterThan(0);
    // What the residual would have been: the premise is "more than", so a tie
    // is on the wrong side of it.
    expect((EQUAL_COUNT * RESIDUAL_PER_SAMPLE) / USABLE_SAMPLES)
      .toBeGreaterThan(HIGH_ABSOLUTE_SIGNAL);
  });

  it('scores 0 and does not auto-fill', () => {
    const result = armed();
    expect(result.candidates[0].score).toBe(0);
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.decision).toContain('refused=ink-invariant,');
  });

  it('NON-REGRESSION: the same tie auto-fills with the flag off', () => {
    // Off the map the page's anchor reads 0.41011 against the blank's 0.74719,
    // so the box is merely below its blank rather than level with it -- and,
    // like every other reading on the linear path, it keeps its residual.
    const result = withAffineTone(false, () => run(EQUAL_GROUP, { photoProvenance: true }));
    expect(result.candidates[0].score).toBe(0.056);
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
  });
});

describe('a box above its blank is untouched', () => {
  it('scores what it scored before, to the digit, armed and not', () => {
    // 54 x 1 + 120 x 0.74719 = 0.16251 of page ink against the blank's
    // 120 x 0.74719 = 0.10143: the mark is the whole difference, and it is the
    // whole residual.
    const { image, baseline, boxes } = build(ABOVE_GROUP);
    const direct = calculateTemplateInkDifference(image, boxes[0], baseline, boxes[0]);
    expect(direct).toBeCloseTo(EXPECTED_RESIDUAL, 12);

    for (const armed of [false, true]) {
      const result = withAffineTone(armed, () => run(ABOVE_GROUP, { photoProvenance: true }));
      const winner = measurementOf(result, 0);
      expect(winner.actualInk!).toBeGreaterThan(winner.baselineInk!);
      expect(result.candidates[0].score).toBe(0.056);
      expect(result.value).toBe(1);
      expect(result.confidence).toBe('high');
      expect(result.decision).not.toContain('ink-invariant');
    }
  });

  it('reaches every gate with the numbers it always reached them with', () => {
    // The five ratios every automatic value is decided on. Read on a scan,
    // where the guard is out of scope by provenance alone, so a change in the
    // arming conditions cannot quietly move them.
    const { decision } = withAffineTone(false, () => run(ABOVE_GROUP));
    expect(fieldOf(decision, 'scores')).toBe('0.056/0.000/0.000');
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
  // measurement, so the guard must not reach it -- armed or not.
  it('leaves the page scoring exactly what density scores it', () => {
    const withoutBaseline = withAffineTone(true,
      () => run(DEFICIT_GROUP, { photoProvenance: true, withBaseline: false }));

    expect(fieldOf(withoutBaseline.decision, 'base')).toBe('0');
    expect(measurementOf(withoutBaseline, 0).actualInk).toBeNull();
    expect(measurementOf(withoutBaseline, 0).baselineInk).toBeNull();
    expect(withoutBaseline.decision).not.toContain('ink-invariant');
    // Nonzero, where the template path scores the same page 0 under the map.
    expect(withoutBaseline.candidates[0].score).toBeGreaterThan(0);
  });
});

describe('the guard can only remove, never widen a margin', () => {
  // A weak but genuine mark, against a runner-up the guard zeroes. Before this
  // unit the group was refused on relative contrast, 1.24 against the 1.25 it
  // needs. Zeroing the runner-up's score naively would divide by zero --
  // `relativeContrast` goes to infinity -- and hand this group an automatic
  // value it never earned. That is the failure mode this unit exists to avoid,
  // so it is pinned rather than assumed.
  //
  // The winner is bare paper plus a mark, which the map leaves alone: grey 255
  // maps to 255 and grey 0 clamps to 0 at any gain above 1, so its score is
  // 25 x 0.92 / 884 = 0.026 on either path.
  const WEAK_WINNER: Cell = { mark: 25 };
  const RUNNER_UP_MARK = 20;
  const ZEROED_RUNNER_UP: Cell = { ...ANCHORED_DEFICIT, mark: RUNNER_UP_MARK };
  const cells = [WEAK_WINNER, ZEROED_RUNNER_UP, QUIET_LOSER];
  // The pooled anchors move with the cells, so this group's map is its own.
  // PAGE: grey 0 x 65 (25 + 20 + 20 shared), grey 105 x 120 -> index 151 is 105.
  // BLANK: grey 0 x 20 (the loser's shared ink), grey 45 x 120 -> index 20..139,
  // grey 60 x 149 -> index 140..288, so index 151 falls in the glyph and
  // blankLo = 60, not 45. gain = (255-60)/(255-105) = 195/150 = 1.30.
  //
  //   page  = 20 x 1 + 120 x ink(60)=0.66292 + 149 x ink(154.9)=0.12978 = 118.89 -> 0.13449
  //   blank =          120 x 0.74719         + 149 x 0.66292            = 188.44 -> 0.21317
  //
  // and only the runner-up's 20-sample mark clears the 0.08 band, so its
  // pre-guard residual is 20 x 0.92 / 884 = 0.021 on this path and on the
  // linear one alike.
  const armed = (options: RunOptions = {}) => withAffineTone(true,
    () => run(cells, { photoProvenance: true, ...options }));

  it('zeroes the runner-up and leaves the winner ranked where it was', () => {
    const result = armed();
    const runnerUp = measurementOf(result, 1);
    expect(runnerUp.actualInk!).toBeLessThan(runnerUp.baselineInk!);
    expect(runnerUp.score).toBe(0);
    expect(measurementOf(result, 0).score).toBe(0.026);
    // The winner is still the winner: ranking reads the pre-guard score, so the
    // guard cannot promote a box either.
    expect(fieldOf(result.decision, 'scores')).toBe('0.026/0.000/0.000');
  });

  it('keeps both margin tests at the values they had before', () => {
    // `gap` and `contrast` both read the runner-up at its pre-guard 0.021, so
    // neither can widen: 0.026 - 0.021 = 0.005 and 0.026 / 0.021 = 1.238.
    const { decision } = armed();
    expect(fieldOf(decision, 'gap')).toBe('0.005/0.004(1.25x)');
    expect(fieldOf(decision, 'contrast')).toBe('1.238/1.250(0.99x)');
    expect((25 * RESIDUAL_PER_SAMPLE) / USABLE_SAMPLES - (RUNNER_UP_MARK * RESIDUAL_PER_SAMPLE)
      / USABLE_SAMPLES).toBeCloseTo(0.005, 3);
  });

  it('still refuses the group on relative contrast', () => {
    const result = armed({ requireHighVisualConfidence: true });
    expect(result.decision).toContain('relative-contrast');
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    // The refusal is the contrast test, not the guard: the winner is not the
    // zeroed box.
    expect(result.decision).not.toContain('refused=ink-invariant');
    expect(1.238).toBeLessThan(HIGH_RELATIVE_CONTRAST);
  });

  it('NON-REGRESSION: with the flag off both boxes keep their scores', () => {
    // The same three cells on the shipped path. The runner-up is still below
    // its blank -- 0.078 against 0.213 -- and still keeps its 0.021, which is
    // the reading the scan and linear-photo measurements say must not be taken
    // away. The two margin tests are unmoved either way, which is the point:
    // scoping the guard changed which box gets a score, never which box wins.
    const result = withAffineTone(false, () => run(cells, { photoProvenance: true }));
    const runnerUp = measurementOf(result, 1);
    expect(runnerUp.actualInk!).toBeLessThan(runnerUp.baselineInk!);
    expect(runnerUp.score).toBe(0.021);
    expect(fieldOf(result.decision, 'scores')).toBe('0.026/0.021/0.000');
    expect(fieldOf(result.decision, 'gap')).toBe('0.005/0.004(1.25x)');
    expect(fieldOf(result.decision, 'contrast')).toBe('1.238/1.250(0.99x)');
  });
});
