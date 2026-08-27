import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import {
  cagiTemplate,
  ChoiceGroup,
  satisfactionTemplate,
} from '../src/lib/recognition/roiTemplates';
import { withAffineTone } from './helpers/affineTone';

/**
 * Two-candidate groups on a photo sheet reach no automatic value at all --
 * **while the affine tone map is armed.**
 *
 * FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27 §14.1. With the affine tone map
 * armed the binary questions produced 27 automatic values over the 19 photo
 * sheets, 21 correct and 6 wrong, and every wrong one was the other box winning
 * outright -- so no floor can reach them, because cutting the wrong six also
 * cuts the right twenty-one. Three features looked like discriminators at 26 of
 * 27 and all three turned out to be proxies for which *position* won: the key
 * holds 26 ones to a single zero and the blank form's ink is fully determined
 * by position. The rule they encode is "always answer 1".
 *
 * So there is no discriminator to build a better gate out of, and the answer is
 * refusal. What this file pins is not that refusing is right -- only central
 * measurement can judge the trade -- but the two properties the refusal needs:
 *
 *   1. it applies to two-candidate groups on photo sheets and to nothing else;
 *   2. no route to an automatic value survives it -- not the high conjunction,
 *      not the rescue, not the medium path.
 *
 * Plus the two properties that make it measurable: it is on by default, and
 * `PHOTO_BINARY_REFUSAL=0` takes it off without touching anything else.
 *
 * **The scope narrowed after this file was written, and the tests moved with
 * it.** The refusal was built unconditionally on photo sheets; measured on the
 * shipped linear path it cost 33 correct cells on the same 19 sheets (59 -> 23)
 * and removed no wrong value, because §14.1's six wrong reads all appear under
 * the map and not under the shift. `analyzeChoiceGroup` therefore also requires
 * `affineToneEnabled()`, so every case below arms `MARK_AFFINE_TONE` -- that is
 * the configuration the rule exists in. The shipped path is pinned separately
 * at the end of the file, and it is the half that protects the 59 correct
 * cells.
 */

// Restated so a change of polarity has to change this file on purpose.
const REFUSAL_LABEL = 'photo-binary-refused';
const PHOTO_BINARY_FLOOR = 0.042;
const BASE_FLOOR = 0.021;

/**
 * The same strip-of-paper fixture `photo-binary-floor.test.ts` uses: one box
 * per candidate, sampled 1:1 by the scorer, so every ink reading below is
 * arithmetic rather than guesswork.
 */
const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const GUTTER = 4;
// The scorer drops a one-sample border per axis before averaging.
const USABLE_SAMPLES = (CELL_WIDTH - 2) * (CELL_HEIGHT - 2);
// Solid ink against blank paper, less the anti-aliasing band the scorer
// subtracts before it counts anything.
const RESIDUAL_PER_SAMPLE = 0.92;
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;

function pageWidth(boxCount: number): number {
  return GUTTER + boxCount * (CELL_WIDTH + GUTTER);
}

function boxRect(index: number): PixelRect {
  const left = GUTTER + index * (CELL_WIDTH + GUTTER);
  return { left, top: GUTTER, right: left + CELL_WIDTH, bottom: GUTTER + CELL_HEIGHT };
}

/** A compact block of solid ink: one connected component, reads as a mark. */
function paintSamples(pixels: Buffer, rect: PixelRect, count: number, width: number): void {
  for (let index = 0; index < count; index++) {
    const y = rect.top + 5 + Math.floor(index / 6);
    const x = rect.left + 5 + (index % 6);
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

/** What a painted box will score as, once the scorer has rounded it. */
function scoreOf(count: number): number {
  return Math.round((RESIDUAL_PER_SAMPLE * count / USABLE_SAMPLES) * 1000) / 1000;
}

/** What a painted box reads as on the `actualInk` the band check looks at. */
function inkOf(count: number): number {
  return count / USABLE_SAMPLES;
}

// The loser in every fixture that does not name its own: the same ink on the
// page and on the blank form, so it scores zero while staying clear of `void`.
// That keeps the band-structure refusal -- a different rule in the same gate --
// out of these results, which is checked below rather than assumed.
const LOSER_SAMPLES = 20;

interface RunOptions {
  /** Ink without a mark's shape, which is how the rescue route is reached. */
  scattered?: boolean;
  /** Page-only ink on the runner-up, so `relativeContrast` has something to cut. */
  runnerUpSamples?: number;
  withBaseline?: boolean;
  field?: string;
  requireHighVisualConfidence?: boolean;
}

function run(
  winnerSamples: number,
  boxCount: number,
  photoProvenance: boolean,
  options: RunOptions = {},
): ReturnType<typeof analyzeChoiceGroup> {
  const {
    scattered = false,
    runnerUpSamples,
    withBaseline = true,
    field = 'satisfaction.q03',
    requireHighVisualConfidence = false,
  } = options;
  const width = pageWidth(boxCount);
  const boxes = Array.from({ length: boxCount }, (_, index) => boxRect(index));
  const page = Buffer.alloc(width * PAGE_HEIGHT, 255);
  const blank = Buffer.alloc(width * PAGE_HEIGHT, 255);

  const paint = scattered ? paintScattered : paintSamples;
  paint(page, boxes[0], winnerSamples, width);
  for (let index = 1; index < boxCount; index++) {
    // Present on both copies, so it cancels to a zero residual.
    paintSamples(page, boxes[index], LOSER_SAMPLES, width);
    paintSamples(blank, boxes[index], LOSER_SAMPLES, width);
  }
  if (runnerUpSamples !== undefined) {
    // Page only, and only on box 1: a real residual on the runner-up, which is
    // what makes `relativeContrast` a finite number instead of infinity.
    paint(page, boxes[1], runnerUpSamples, width);
  }

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
    requireHighVisualConfidence,
    withBaseline ? { image: baseline, candidatePixelOverrides: boxes } : undefined,
    photoProvenance,
  );
}

/** One `key=value` token out of a decision trace. Values here carry no spaces. */
function segment(decision: string, key: string): string {
  return new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(decision)?.[1] ?? '';
}

// A winner well clear of both floors: the case §14.1 is about, where the signal
// is healthy and the value is still wrong half the time.
const STRONG = 64; // scores 0.067
// Above the base floor, under the raised one: what PHOTO_BINARY_FLOOR already
// stopped. Used to show the two rules agree rather than fight.
const UNDER_FLOOR = 31; // scores 0.032
// The pair that lands a binary photo group on the medium path, which is the
// only route left once the conjunction and the rescue have both declined.
// `paintSamples` lays the first 20 runner-up samples on top of the ones the
// blank form already carries, so the runner-up's residual is
// MEDIUM_RUNNER_UP - LOSER_SAMPLES = 103 samples.
//
//   winner 0.133, runner-up 0.107 -> contrast 1.243, just under the 1.25 the
//     high conjunction wants, so it refuses on `relative-contrast` alone;
//   the rescue reads the runner-up's fit at 103/884 = 0.117 against a weight
//     of -20.8, which drags its score under the 1.8 it needs;
//   both floors (0.042) and both gaps still clear by a wide margin, so the
//     medium path would take it.
const MEDIUM_WINNER = 128;
const MEDIUM_RUNNER_UP = 123;

// The rule under test exists only under the affine tone map, so it is armed for
// the file rather than repeated in every case. Set here rather than at module
// scope so the shipped-path cases at the end can take it back, and restored so
// the suite behaves the same whether or not `MARK_AFFINE_TONE` is already in the
// environment -- the pair of runs that measures the flag.
let ambientAffineTone: string | undefined;
beforeEach(() => {
  ambientAffineTone = process.env.MARK_AFFINE_TONE;
  process.env.MARK_AFFINE_TONE = '1';
});
afterEach(() => {
  delete process.env.PHOTO_BINARY_REFUSAL;
  if (ambientAffineTone === undefined) {
    delete process.env.MARK_AFFINE_TONE;
  } else {
    process.env.MARK_AFFINE_TONE = ambientAffineTone;
  }
});

describe('the fixture reads as the measurement it stands in for', () => {
  it('produces scores on the right side of both floors', () => {
    expect(scoreOf(STRONG)).toBe(0.067);
    expect(scoreOf(STRONG)).toBeGreaterThan(PHOTO_BINARY_FLOOR);
    expect(scoreOf(UNDER_FLOOR)).toBe(0.032);
    expect(scoreOf(UNDER_FLOOR)).toBeGreaterThan(BASE_FLOOR);
    expect(scoreOf(UNDER_FLOOR)).toBeLessThan(PHOTO_BINARY_FLOOR);
  });

  it('keeps the band-structure rule out of these results', () => {
    // The loser box carries ink on both copies: not void, and under the band
    // rule's 0.040, either of which is enough to keep that refusal away. If
    // this stopped holding, the tests below would pass for the wrong reason.
    expect(inkOf(LOSER_SAMPLES)).toBeGreaterThan(0.005);
    expect(inkOf(LOSER_SAMPLES)).toBeLessThan(0.040);
    for (const samples of [STRONG, UNDER_FLOOR]) {
      expect(run(samples, 2, true).decision).not.toContain('band-structure');
    }
  });
});

describe('the refusal -- what it covers', () => {
  it('refuses a strong two-candidate reading on a photo sheet', () => {
    const result = run(STRONG, 2, true);

    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.decision).toContain(REFUSAL_LABEL);
    // Nothing else declined this cell: it cleared the raised floor, the gap,
    // the mark shape and the contrast test. That is what makes it a cell this
    // rule really costs, rather than one that was never going to be filled --
    // and it is why the trace names the refusals separately.
    expect(result.decision).toContain('refused=photo-binary-refused');
    expect(result.decision).toContain('floor=0.067/0.042(');
  });

  it('leaves the same reading on a scan exactly where it was', () => {
    const result = run(STRONG, 2, false);

    // Today's behaviour, unchanged. The scan path is measured centrally
    // against a byte-exact baseline; this is the half that must not move.
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
    expect(result.decision).toContain('floor=0.067/0.021(');
    expect(result.decision).not.toContain(REFUSAL_LABEL);
    expect(result.decision).not.toContain('photo-binary-floor');
  });

  it('does not touch a group with more than two candidates', () => {
    // Same score, same photo provenance, four boxes. A wider group keeps a
    // third option to be outscored, which is the evidence §14.1 found missing
    // in the binary case, so it reads exactly as it did before.
    const four = run(STRONG, 4, true);
    expect(four.value).toBe(1);
    expect(four.confidence).toBe('high');
    expect(four.decision).toContain('n=4');
    expect(four.decision).not.toContain(REFUSAL_LABEL);

    // And the same group on a scan refused exactly the same things: no
    // photo-only rule reached a four-candidate group either way. Compared by
    // segment rather than by whole string, because the tone map is a separate
    // photo-only behaviour and prints its own label when `MARK_AFFINE_TONE`
    // arms it -- a difference this test is not about.
    const scan = run(STRONG, 4, false);
    expect(segment(four.decision, 'refused')).toBe(segment(scan.decision, 'refused'));
    expect(segment(four.decision, 'outcome')).toBe(segment(scan.decision, 'outcome'));
    expect(segment(four.decision, 'floor')).toBe(segment(scan.decision, 'floor'));

    // Five candidates too, which is what the satisfaction scale questions are.
    const five = run(STRONG, 5, true);
    expect(five.value).toBe(1);
    expect(five.confidence).toBe('high');
    expect(five.decision).not.toContain(REFUSAL_LABEL);
  });

  it('refuses on the CAGI sheet as well as the satisfaction one', () => {
    // `basic.gender` is the other two-candidate group in the templates, and it
    // is one the answer key marks blank on some sheets, so refusing there
    // cannot cost a correct value.
    const result = run(STRONG, 2, true, { field: 'basic.gender' });
    expect(result.value).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.decision).toContain(REFUSAL_LABEL);
  });
});

describe('the refusal -- every route to a value sits below it', () => {
  /**
   * The high conjunction is not the only way a value reaches the page. The
   * rescue rule and the medium path both sit under it, and the floor had to be
   * handed to each of them separately -- to the rescue as
   * `belowPhotoBinaryFloor`, to the medium path as `mediumScoreThreshold`. The
   * refusal replaces all three at once by returning before any of them, and
   * each fixture below proves the route it names is really taken when the
   * refusal is off.
   */
  it('precedes the rescue route', () => {
    // Ink with no mark shape: the conjunction refuses on `mark-shape` and the
    // rescue picks it up, reading fit and edges rather than signal strength.
    // Scored above PHOTO_BINARY_FLOOR on purpose, so the floor does *not*
    // cover this case and the refusal is demonstrably what stops it.
    process.env.PHOTO_BINARY_REFUSAL = '0';
    const withoutRefusal = run(STRONG, 2, true, { scattered: true });
    expect(withoutRefusal.decision).toContain('mark-shape');
    expect(withoutRefusal.decision).toContain('rescued:');
    expect(withoutRefusal.decision).not.toContain('photo-binary-floor');
    expect(withoutRefusal.value).toBe(1);
    expect(withoutRefusal.confidence).toBe('high');

    delete process.env.PHOTO_BINARY_REFUSAL;
    const refused = run(STRONG, 2, true, { scattered: true });
    expect(refused.value).toBeUndefined();
    expect(refused.confidence).toBe('low');
    expect(refused.decision).toContain(REFUSAL_LABEL);
    expect(refused.decision).not.toContain('rescued:');
  });

  it('precedes the medium path', () => {
    // A runner-up with a real residual pulls `relativeContrast` under 1.25, so
    // the high conjunction refuses while the winner still clears both floors
    // and the medium gap -- the one combination that reaches a medium value on
    // a binary photo group today.
    process.env.PHOTO_BINARY_REFUSAL = '0';
    const withoutRefusal = run(MEDIUM_WINNER, 2, true, { runnerUpSamples: MEDIUM_RUNNER_UP });
    expect(withoutRefusal.decision).toContain('relative-contrast');
    expect(withoutRefusal.decision).not.toContain('photo-binary-floor');
    expect(withoutRefusal.decision).not.toContain('rescued:');
    expect(withoutRefusal.value).toBe(1);
    expect(withoutRefusal.confidence).toBe('medium');

    delete process.env.PHOTO_BINARY_REFUSAL;
    const refused = run(MEDIUM_WINNER, 2, true, { runnerUpSamples: MEDIUM_RUNNER_UP });
    expect(refused.value).toBeUndefined();
    expect(refused.confidence).toBe('low');
    expect(refused.decision).toContain(REFUSAL_LABEL);
  });

  it('precedes the high conjunction', () => {
    // Already covered by the strong-reading case above; restated against the
    // conjunction's own trace so a future reordering that let the conjunction
    // run first would fail here rather than only on the outcome.
    const refused = run(STRONG, 2, true);
    expect(refused.decision).toContain('outcome=low');
    expect(refused.decision).not.toContain('outcome=high');
  });

  it('reaches the raw-density path too, where no floor ever applied', () => {
    // No blank form, so the scorer falls back to dark-pixel density and the
    // floors are 0.35 / 0.1 -- both above PHOTO_BINARY_FLOOR, which is why the
    // floor could never change anything here. The refusal does not read a
    // score at all, so it covers this path as well.
    const photo = run(STRONG, 2, true, { withBaseline: false });
    expect(photo.decision).toContain('base=0');
    expect(photo.value).toBeUndefined();
    expect(photo.confidence).toBe('low');
    expect(photo.decision).toContain(REFUSAL_LABEL);

    const scan = run(STRONG, 2, false, { withBaseline: false });
    expect(scan.decision).not.toContain(REFUSAL_LABEL);
  });

  it('leaves an earlier refusal reporting its own reason', () => {
    // `allowAutoValue = false` returns before any of this. A cell the grid
    // already refused keeps saying so, rather than being relabelled.
    const width = pageWidth(2);
    const boxes = [boxRect(0), boxRect(1)];
    const page = Buffer.alloc(width * PAGE_HEIGHT, 255);
    paintSamples(page, boxes[0], STRONG, width);
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
    const result = analyzeChoiceGroup(
      { width, height: PAGE_HEIGHT, pixels: page, contentBoundsConfident: true },
      group,
      undefined,
      false,
      boxes,
      false,
      undefined,
      true,
    );
    expect(result.value).toBeUndefined();
    // The strip is too small to read as paper, so the half of that early
    // return that fires here is the form-bounds one. Either way the point is
    // the same: the cell keeps its own reason and is not relabelled.
    expect(result.decision).toContain('refused=form-bounds:no-content-bounds');
    expect(result.decision).not.toContain(REFUSAL_LABEL);
  });
});

describe('the refusal -- how it is switched off for measurement', () => {
  it('is on when the variable is unset', () => {
    delete process.env.PHOTO_BINARY_REFUSAL;
    expect(run(STRONG, 2, true).decision).toContain(REFUSAL_LABEL);
  });

  it('is on for every value that is not an explicit off', () => {
    for (const value of ['1', 'true', 'on', '', 'yes']) {
      process.env.PHOTO_BINARY_REFUSAL = value;
      expect(run(STRONG, 2, true).decision).toContain(REFUSAL_LABEL);
    }
  });

  it('is off for 0, false and off, in any casing', () => {
    for (const value of ['0', 'false', 'FALSE', 'off', ' Off ']) {
      process.env.PHOTO_BINARY_REFUSAL = value;
      const result = run(STRONG, 2, true);
      expect(result.decision).not.toContain(REFUSAL_LABEL);
      expect(result.value).toBe(1);
    }
  });

  it('hands the group back to PHOTO_BINARY_FLOOR when switched off', () => {
    // The floor is not dead code: it is superseded while the refusal is on,
    // and it is what a measurement run with the refusal off answers to. A
    // reading under the floor is still refused there.
    process.env.PHOTO_BINARY_REFUSAL = '0';
    const underFloor = run(UNDER_FLOOR, 2, true);
    expect(underFloor.value).toBeUndefined();
    expect(underFloor.decision).toContain('photo-binary-floor');
    expect(underFloor.decision).toContain('floor=0.032/0.042(');
  });

  it('does not change the scan path in either position', () => {
    const on = run(STRONG, 2, false).decision;
    process.env.PHOTO_BINARY_REFUSAL = '0';
    const off = run(STRONG, 2, false).decision;
    expect(on).toBe(off);
  });
});

describe('NON-REGRESSION -- the shipped path, where the refusal does not apply', () => {
  /**
   * `MARK_AFFINE_TONE` is off by default, so this is what actually runs today.
   * Every case here takes the flag back off, over the `beforeEach` above.
   *
   * The measurement these pin: refusing binary groups on the linear photo path
   * cost 33 correct cells on the 19-student set, 59 -> 23, and removed no wrong
   * value -- §14.1's six wrong reads are all under the map. A refusal is still a
   * cost, and it is only worth paying where the failure it prevents occurs.
   */
  it('auto-fills a strong two-candidate photo reading, which is worth 33 cells', () => {
    const result = withAffineTone(false, () => run(STRONG, 2, true));

    expect(result.decision).not.toContain(REFUSAL_LABEL);
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
  });

  it('leaves PHOTO_BINARY_FLOOR as the rule a binary photo group answers to', () => {
    // Not superseded on this path: the raised floor is still cut against the
    // reading, and it is still what refuses one below it. That is why the
    // constant is live code rather than a leftover.
    const admitted = withAffineTone(false, () => run(STRONG, 2, true));
    expect(admitted.decision).toContain('floor=0.067/0.042(');

    const refused = withAffineTone(false, () => run(UNDER_FLOOR, 2, true));
    expect(refused.value).toBeUndefined();
    expect(refused.decision).toContain('photo-binary-floor');
  });

  it('does not read PHOTO_BINARY_REFUSAL at all while the map is off', () => {
    // The two flags are a conjunction, not alternatives. With the map off the
    // refusal's own switch changes nothing in either position, so a measurement
    // run that moves only `PHOTO_BINARY_REFUSAL` is measuring nothing.
    const on = withAffineTone(false, () => {
      delete process.env.PHOTO_BINARY_REFUSAL;
      return run(STRONG, 2, true).decision;
    });
    const off = withAffineTone(false, () => {
      process.env.PHOTO_BINARY_REFUSAL = '0';
      return run(STRONG, 2, true).decision;
    });
    expect(on).toBe(off);
  });
});

describe('scope -- which fields have two candidates', () => {
  /**
   * The whole cost of this refusal, enumerated. Pinned so that a template edit
   * which makes some other group binary cannot silently enrol it, and so the
   * central checkout can read the list without re-deriving it.
   */
  it('is exactly basic.gender and the five binary satisfaction questions', () => {
    const binaryFields = [...cagiTemplate.choiceGroups, ...satisfactionTemplate.choiceGroups]
      .filter((group) => group.candidates.length === 2)
      .map((group) => group.field);

    expect(binaryFields).toEqual([
      'basic.gender',
      'satisfaction.q02',
      'satisfaction.q03',
      'satisfaction.q04',
      'satisfaction.q05',
      'satisfaction.q06',
    ]);
  });

  it('leaves every other group untouched, including the widest', () => {
    const others = [...cagiTemplate.choiceGroups, ...satisfactionTemplate.choiceGroups]
      .filter((group) => group.candidates.length !== 2);

    // Nothing else is binary, and nothing is unary either -- a one-candidate
    // group would slip past a `length === 2` test, so it is worth knowing that
    // none exists.
    expect(others.every((group) => group.candidates.length >= 4)).toBe(true);
    expect(others.length).toBeGreaterThan(0);
  });
});
