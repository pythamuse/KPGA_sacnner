import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  analyzeChoiceGroup,
  ImageAnalysisData,
  normalizeTone,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { pinShippedScorer } from './helpers/scorerVariants';

/**
 * The tonal correction a photographed cell is measured through, from
 * FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §12.2.
 *
 * What was measured, on the twelve photo students who produced no automatic
 * value at all: the winner box's page ink has median 0.000 against a blank
 * template median of 0.096 -- the photographed box reads emptier than the
 * printed circle underneath it -- and 0 of 263 boxes clear the 0.08
 * differential margin. Their `brightnessOffset` reaches 185 where no
 * productive student exceeds 61, which puts those pages' 82nd percentile
 * around grey 70.
 *
 * Why a shift cannot fix that: `darkness()` returns 0 from grey 178 up, so
 * adding 185 carries paper at 70 and a mark at 50 over that edge together. A
 * shift moves two tones equally, so it can never separate them. Stretching the
 * range can, and that is the whole change: same paper anchor, different slope.
 *
 * These fixtures are synthetic and prove logic only. They say nothing about
 * accuracy on real sheets -- that is the central measurement's to decide, and
 * every constant here is PROVISIONAL.
 */

// The scorer resamples every cell onto a fixed 36x28 grid and drops a
// one-sample border per axis before averaging.
const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const CELL_SAMPLES = CELL_WIDTH * CELL_HEIGHT;
const USABLE_SAMPLES = (CELL_WIDTH - 2) * (CELL_HEIGHT - 2);

// The anti-aliasing band the scorer subtracts before it counts any residual.
// A differential smaller than this is not ink as far as the gate is concerned.
const DIFFERENTIAL_MARGIN = 0.08;
// `darkness()`: 0 at this grey level and above.
const WHITE_POINT = 178;

function darkness(value: number): number {
  return Math.max(0, Math.min(1, (WHITE_POINT - value) / WHITE_POINT));
}

/**
 * One cell's worth of samples: paper everywhere, with runs of darker levels
 * laid over it. Only the histogram matters to the correction, so the order
 * these are written in is irrelevant.
 */
function boxSamples(paper: number, runs: Array<{ level: number; count: number }>): number[] {
  const samples = new Array<number>(CELL_SAMPLES).fill(paper);
  let index = 0;
  for (const run of runs) {
    for (let n = 0; n < run.count; n++) {
      samples[index++] = run.level;
    }
  }
  return samples;
}

// A blank-form cell: paper at 240 with a printed glyph over about a tenth of
// it, which is what §12.2's blank ink median of 0.096 per box amounts to. That
// tenth is why the 5th percentile of a blank box lands inside printed ink.
const BLANK_PAPER = 240;
const BLANK_PRINT = 25;
const PRINT_SAMPLES = 120; // 11.9% of the cell
const BLANK = boxSamples(BLANK_PAPER, [{ level: BLANK_PRINT, count: PRINT_SAMPLES }]);

// The measured failure: the whole page compressed into a 25-level band near
// grey 70, printed glyph and pen mark included.
const DARK_PAPER = 70;
const DARK_PRINT = 50;
const DARK_MARK = 45;
const MARK_SAMPLES = 40;
const DARK_PHOTO = boxSamples(DARK_PAPER, [
  { level: DARK_MARK, count: MARK_SAMPLES },
  { level: DARK_PRINT, count: PRINT_SAMPLES },
]);

// Every number below is the shipped scorer's. See `pinShippedScorer`.
pinShippedScorer();

describe('the fixture reads as the measurement it stands in for', () => {
  it('puts the anchors where §12.2 measured them', () => {
    const tone = normalizeTone(DARK_PHOTO, BLANK, true);

    // The shift this replaces, and the reason it cannot work: 70 + 170 and
    // 45 + 170 are both past the white point, so paper and mark arrive at
    // darkness 0 together.
    expect(tone.shift).toBe(BLANK_PAPER - DARK_PAPER);
    expect(tone.shift).toBe(170);
    expect(DARK_PAPER + tone.shift).toBeGreaterThan(WHITE_POINT);
    expect(DARK_MARK + tone.shift).toBeGreaterThan(WHITE_POINT);

    // The dark anchor is the printed glyph, not the pen mark: at 40 samples
    // the mark is under the 5th percentile of a 1008-sample cell, so the mark
    // cannot set the anchor it is supposed to be measured against.
    expect(MARK_SAMPLES / CELL_SAMPLES).toBeLessThan(0.05);
    expect(PRINT_SAMPLES / CELL_SAMPLES).toBeGreaterThan(0.05);
    expect(tone.label).toContain(`affine(${DARK_PRINT},${DARK_PAPER}`);
    expect(tone.label).toContain(`->${BLANK_PRINT},${BLANK_PAPER}`);
  });
});

describe('a compressed dark range -- the case the change exists for', () => {
  const affine = normalizeTone(DARK_PHOTO, BLANK, true);
  const linear = normalizeTone(DARK_PHOTO, BLANK, false);

  it('stretches rather than shifts', () => {
    expect(affine.mode).toBe('affine');
    // (240 - 25) blank levels per (70 - 50) page levels.
    expect(affine.gain).toBeCloseTo(215 / 20, 6);
    expect(affine.label).toContain('g=10.75');
    // Not capped: the cap is a different case and has its own test.
    expect(affine.label).not.toContain('!');
  });

  it('lands the printed glyph exactly on the blank form\'s, so the print still cancels', () => {
    // The property that keeps this from inventing ink: the page's own dark
    // anchor maps onto the blank's, so a box with nothing but printed form in
    // it comes out at zero residual however dark the photograph was.
    expect(affine.apply(DARK_PRINT)).toBe(BLANK_PRINT);
    expect(affine.apply(DARK_PAPER)).toBe(BLANK_PAPER);
    expect(darkness(affine.apply(DARK_PRINT)) - darkness(BLANK_PRINT)).toBe(0);
  });

  it('keeps the mark measurably darker than paper, and the differential survives', () => {
    const mark = darkness(affine.apply(DARK_MARK));
    const paper = darkness(affine.apply(DARK_PAPER));

    expect(mark).toBeGreaterThan(paper);
    // What the scorer computes for a mark standing where the blank form has
    // paper. It has to clear the margin, not merely be positive.
    expect(mark - paper - DIFFERENTIAL_MARGIN).toBeGreaterThan(0);
    expect(mark - paper).toBeCloseTo(1, 6);
  });

  it('collapses under the shift it replaces -- both halves of the defect, on one input', () => {
    // The same samples, the same blank form, today's correction: paper and
    // mark arrive at the same darkness, which is 0.000 page ink and the
    // measured 0 of 263 boxes clearing the margin.
    const mark = darkness(linear.apply(DARK_MARK));
    const paper = darkness(linear.apply(DARK_PAPER));

    expect(linear.mode).toBe('linear');
    expect(mark).toBe(0);
    expect(paper).toBe(0);
    expect(mark - paper).toBe(0);
    expect(mark - paper - DIFFERENTIAL_MARGIN).toBeLessThan(0);
  });
});

describe('a normal exposure -- the healthy photograph this must not disturb', () => {
  // A well-exposed photograph of the same form: the same tones, a couple of
  // levels off the blank form's.
  const HEALTHY_PAPER = 238;
  const HEALTHY_PRINT = 27;
  const HEALTHY_MARK = 18;
  const HEALTHY = boxSamples(HEALTHY_PAPER, [
    { level: HEALTHY_MARK, count: MARK_SAMPLES },
    { level: HEALTHY_PRINT, count: PRINT_SAMPLES },
  ]);

  const affine = normalizeTone(HEALTHY, BLANK, true);
  const linear = normalizeTone(HEALTHY, BLANK, false);

  it('barely moves: the two corrections agree across the whole grey range', () => {
    expect(affine.gain).toBeLessThan(1.05);
    for (let value = 0; value <= 255; value++) {
      expect(Math.abs(affine.apply(value) - linear.apply(value))).toBeLessThan(6);
      expect(Math.abs(darkness(affine.apply(value)) - darkness(linear.apply(value))))
        .toBeLessThan(0.04);
    }
  });

  it('reads the same mark, at the same strength, either way', () => {
    const affineResidual = darkness(affine.apply(HEALTHY_MARK))
      - darkness(BLANK_PAPER) - DIFFERENTIAL_MARGIN;
    const linearResidual = darkness(linear.apply(HEALTHY_MARK))
      - darkness(BLANK_PAPER) - DIFFERENTIAL_MARGIN;

    expect(affineResidual).toBeGreaterThan(0);
    expect(linearResidual).toBeGreaterThan(0);
    expect(Math.abs(affineResidual - linearResidual)).toBeLessThan(0.05);
  });

  it('takes the shift outright when there is nothing left to stretch', () => {
    // A photograph whose range is already as wide as the blank form's gets no
    // map at all -- `gain <= 1` is a fallback, not a compression -- so the
    // healthiest sheets keep exactly the arithmetic they had.
    const wide = boxSamples(245, [
      { level: 10, count: MARK_SAMPLES },
      { level: 20, count: PRINT_SAMPLES },
    ]);
    const tone = normalizeTone(wide, BLANK, true);

    expect(tone.mode).toBe('linear');
    expect(tone.label).toContain('flat');
    expect(tone.apply(10)).toBe(10 + tone.shift);
  });
});

describe('degenerate anchors fall back to the shift rather than divide by them', () => {
  it('refuses a page whose own anchors are too close together', () => {
    // A cell that is almost one flat tone: 4 levels between the anchors. The
    // gain that implies is noise, not exposure.
    const flat = boxSamples(70, [{ level: 66, count: PRINT_SAMPLES + MARK_SAMPLES }]);
    const tone = normalizeTone(flat, BLANK, true);

    expect(tone.mode).toBe('linear');
    expect(tone.gain).toBe(1);
    // The reason, with the two spans it was decided on: a fallback whose
    // numbers cannot be read back is the silent change this label prevents.
    expect(tone.label).toBe('linear(170,span=4/215)');
    for (const value of [0, 45, 66, 70, 128, 255]) {
      expect(tone.apply(value)).toBe(value + tone.shift);
    }
  });

  it('refuses a blank cell with no tonal range to map onto', () => {
    // A box whose printed content covers under 5% of it: the blank form's two
    // anchors are the same paper reading, and mapping onto that would squash
    // the page flat.
    const blankPaperOnly = boxSamples(BLANK_PAPER, [{ level: BLANK_PRINT, count: 30 }]);
    const tone = normalizeTone(DARK_PHOTO, blankPaperOnly, true);

    expect(tone.mode).toBe('linear');
    // The page had a usable 20-level span of its own; the blank form had none.
    expect(tone.label).toBe('linear(170,blank-span=20/0)');
    expect(tone.apply(DARK_MARK)).toBe(DARK_MARK + tone.shift);
  });

  it('refuses an empty sample set instead of producing a mapping from nothing', () => {
    const tone = normalizeTone([], [], true);

    expect(tone.mode).toBe('linear');
    expect(tone.shift).toBe(0);
    expect(tone.apply(45)).toBe(45);
  });

  it('caps the stretch, and says so in the label', () => {
    // 215 blank levels over 10 page levels is 21.5x. The cap holds the paper
    // anchor where it was and reduces the slope, so an almost-degenerate span
    // cannot license unbounded amplification of the paper's own grain.
    const veryDark = boxSamples(70, [
      { level: 55, count: MARK_SAMPLES },
      { level: 60, count: PRINT_SAMPLES },
    ]);
    const tone = normalizeTone(veryDark, BLANK, true);

    expect(tone.mode).toBe('affine');
    expect(tone.gain).toBe(12);
    expect(tone.label).toContain('g=12.00!');
    expect(tone.apply(70)).toBe(BLANK_PAPER);
    // Above the uncapped map's output for the dark anchor, i.e. less stretch.
    expect(tone.apply(60)).toBeGreaterThan(BLANK_PRINT);
  });
});

describe('a scan takes the shift, unchanged', () => {
  it('is `value + shift` and nothing else, on every grey level', () => {
    const tone = normalizeTone(DARK_PHOTO, BLANK, false);

    expect(tone.mode).toBe('linear');
    expect(tone.gain).toBe(1);
    expect(tone.label).toBe('linear(170)');
    for (let value = 0; value <= 255; value++) {
      // Strict equality: this is the arithmetic the byte-exact scan baseline
      // was measured on, so "close enough" is not the assertion.
      expect(tone.apply(value)).toBe(value + tone.shift);
    }
  });

  it('never reaches the map, however dark the samples are', () => {
    // Same input that produces a 10.75x stretch on a photo sheet.
    expect(normalizeTone(DARK_PHOTO, BLANK, true).mode).toBe('affine');
    expect(normalizeTone(DARK_PHOTO, BLANK, false).mode).toBe('linear');
  });
});

/**
 * The same tones through the real scorer, because the pure function cannot
 * show where the correction sits: it is computed per candidate box, and every
 * reading in `calculateTemplateInkFeatures` -- the score, the alignment
 * search, the residual edges -- has to go through the same one.
 */
const GUTTER = 4;
const BOX_COUNT = 4;
const PAGE_WIDTH = GUTTER + BOX_COUNT * (CELL_WIDTH + GUTTER);
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;

function boxRect(index: number): PixelRect {
  const left = GUTTER + index * (CELL_WIDTH + GUTTER);
  return { left, top: GUTTER, right: left + CELL_WIDTH, bottom: GUTTER + CELL_HEIGHT };
}

const boxes = Array.from({ length: BOX_COUNT }, (_, index) => boxRect(index));

function paint(
  pixels: Buffer,
  rect: PixelRect,
  level: number,
  row: number,
  rows: number,
  columns: number,
): void {
  for (let y = rect.top + row; y < rect.top + row + rows; y++) {
    for (let x = rect.left + 5; x < rect.left + 5 + columns; x++) {
      pixels[y * PAGE_WIDTH + x] = level;
    }
  }
}

/** The printed glyph, in the same place on the page and on the blank form. */
function paintPrint(pixels: Buffer, rect: PixelRect, level: number, columns = 24): void {
  paint(pixels, rect, level, 11, 5, columns); // 5 x 24 = 120 samples
}

/** The pen mark, on the page only, clear of the printed glyph. */
function paintMark(pixels: Buffer, rect: PixelRect, level: number): void {
  paint(pixels, rect, level, 3, 4, 10); // 40 samples
}

const group: ChoiceGroup = {
  field: 'satisfaction.q03',
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

function analyzeUnderexposedSheet(photoProvenance: boolean, printColumns = boxes.map(() => 24)) {
  const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, DARK_PAPER);
  const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, BLANK_PAPER);
  boxes.forEach((rect, index) => {
    // The same printed form on both copies, so what differs between them is
    // only what the student did.
    paintPrint(page, rect, DARK_PRINT, printColumns[index]);
    paintPrint(blank, rect, BLANK_PRINT, printColumns[index]);
  });
  paintMark(page, boxes[0], DARK_MARK);

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
  }, photoProvenance);
}

describe('analyzeChoiceGroup -- the correction where it is actually applied', () => {
  // The affine map is measured but not shipped: it recovered 59 -> 122 correct
  // cells on the 19-student photo set and produced eight wrong values where
  // there had been none, so §5.4 keeps it off the shipped path (see the flag's
  // comment in markDensity.ts). These cases exercise the instrument, so they
  // arm it explicitly rather than depending on a default that must stay off.
  beforeEach(() => { process.env.MARK_AFFINE_TONE = '1'; });
  afterEach(() => { delete process.env.MARK_AFFINE_TONE; });

  it('recovers the mark on a photo sheet the shift reads as empty', () => {
    const result = analyzeUnderexposedSheet(true);

    // 40 samples of residual at 0.92 each over the 884 the scorer averages.
    expect(result.candidates[0].score)
      .toBe(Math.round((MARK_SAMPLES * (1 - DIFFERENTIAL_MARGIN) / USABLE_SAMPLES) * 1000) / 1000);
    expect(result.candidates[0].score).toBeGreaterThan(0);
    // The other three boxes hold printed glyph only, and it cancels: the map
    // does not turn a dark photograph into ink everywhere.
    expect(result.candidates.slice(1).map((candidate) => candidate.score)).toEqual([0, 0, 0]);
  });

  it('reads zero on the same pixels when the sheet is a scan', () => {
    const result = analyzeUnderexposedSheet(false);

    expect(result.candidates.map((candidate) => candidate.score)).toEqual([0, 0, 0, 0]);
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    // The measured defect, in one line: the winner box's page ink is 0.000
    // while the blank form's is not.
    expect(result.decision).toContain('page=0.000');
    expect(result.decision).not.toContain('blank=0.000');
  });

  it('measures every box of a group through one correction, never two', () => {
    // The reason this is a group decision and not a per-box one, measured over
    // 120 synthetic groups before it was: with the choice made per box, a box
    // whose blank cell held too little printed ink to have a dark anchor fell
    // back to the shift while its neighbours were mapped at 1.4x, and the
    // winner then changed on 6 of 240 decisions. `gap`, `relativeContrast` and
    // the band check all compare boxes with each other, so two boxes on
    // different scales is a wrong value waiting to happen.
    //
    // Box 1's glyph covers 20 samples of 1008 -- under the 5th percentile, so
    // on its own that cell has no dark anchor at all.
    //
    // First, that the fixture really does contain the disagreement: box 1's
    // cell, taken by itself, gets no map.
    const loneCell = normalizeTone(
      boxSamples(DARK_PAPER, [{ level: DARK_PRINT, count: 20 }]),
      boxSamples(BLANK_PAPER, [{ level: BLANK_PRINT, count: 20 }]),
      true,
    );
    expect(loneCell.mode).toBe('linear');

    const mixed = analyzeUnderexposedSheet(true, [24, 4, 24, 24]);
    const tones = mixed.decision.match(/tone=[^ \]]*/g) || [];

    expect(tones).toHaveLength(BOX_COUNT);
    expect(new Set(tones).size).toBe(1);
    // Pooling the group's cells restores the anchor the lone cell lacked.
    expect(tones[0]).toContain('affine(');
  });

  it('falls back for the whole group when the pooled anchors are degenerate', () => {
    // Every cell short of printed ink: no box gets a map, and no box is left
    // on a different scale from the others either.
    const narrow = analyzeUnderexposedSheet(true, boxes.map(() => 4));
    const tones = narrow.decision.match(/tone=[^ \]]*/g) || [];

    expect(new Set(tones).size).toBe(1);
    expect(tones[0]).toContain('linear(');
    expect(tones[0]).toContain('span=');
    expect(narrow.value).toBeUndefined();
  });

  it('says in the trace which correction each box was measured through', () => {
    // A silent change here is undiagnosable, and the correction is per box, so
    // the label has to travel with the box rather than with the group.
    const photo = analyzeUnderexposedSheet(true);
    expect(photo.decision).toContain(`tone=affine(${DARK_PRINT},${DARK_PAPER}`);
    expect(photo.decision).toContain('g=10.75)');
    expect(photo.decision).toContain('shift=170');

    const scan = analyzeUnderexposedSheet(false);
    expect(scan.decision).toContain('tone=linear(170)');
    expect(scan.decision).not.toContain('affine');
  });
});
