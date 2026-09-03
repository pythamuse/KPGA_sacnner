import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { refusalLabel } from '../src/lib/review/evidence';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { withAffineTone } from './helpers/affineTone';
import { withCancelVeto, type CancelVetoSettings } from './helpers/cancelVeto';
import { pinShippedScorer } from './helpers/scorerVariants';

/**
 * `MARK_CANCEL_VETO`, the cancelled-mark veto.
 *
 * FIELD_TEST §34.7: the remaining browser wrong answers are cells with ink in
 * two boxes, several of them a box the student marked and then STRUCK OUT with
 * an X before marking another. The veto refuses the automatic value when the
 * winning box's ink reads as a pair of crossing strokes -- `crossingScore` over
 * a floor AND `inkBboxFill` over one -- and leaves the row contested for a
 * person to answer.
 *
 * Three things only, because these are SYNTHETIC boxes (CLAUDE.md §2):
 *
 *   1. **OFF IS INVISIBLE.** With the variable unset nothing here changes, and
 *      with it SET the candidate measurements still do not: the trace the veto
 *      reads is computed but never copied onto the export.
 *   2. **THE RULE FIRES WHERE IT SAYS.** A struck-out X is refused and the row
 *      is contested; one selecting stroke is untouched; the runner-up is never
 *      promoted; the two thresholds are read from the environment.
 *   3. **IT ONLY TAKES.** A cell the veto refuses carries no value and no
 *      review suggestion, and the box it refused is not replaced.
 *
 * Nothing here says a real cancelling mark looks like this fixture, or that the
 * rule is worth its cost. The delegator measures that on four scan sets, four
 * photo sets and the browser.
 */

// Fixture geometry, same as `mark-shape-trace.test.ts`: one box per candidate,
// sampled 1:1, so a painted pixel is a sample and every figure below is
// arithmetic rather than guesswork.
const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const GUTTER = 4;
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;

type Stroke = Array<[number, number]>;

function pageWidth(boxCount: number): number {
  return GUTTER + boxCount * (CELL_WIDTH + GUTTER);
}

function boxRect(index: number): PixelRect {
  const left = GUTTER + index * (CELL_WIDTH + GUTTER);
  return { left, top: GUTTER, right: left + CELL_WIDTH, bottom: GUTTER + CELL_HEIGHT };
}

/** A straight run of samples from (x0,y0) to (x1,y1), one sample per step. */
function line(x0: number, y0: number, x1: number, y1: number): Stroke {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const points: Stroke = [];
  for (let i = 0; i <= steps; i += 1) {
    points.push([
      Math.round(x0 + ((x1 - x0) * i) / steps),
      Math.round(y0 + ((y1 - y0) * i) / steps),
    ]);
  }
  return points;
}

/** Widens a stroke to `width` samples, the way a pen is wider than a sample. */
function pen(stroke: Stroke, width: number): Stroke {
  const points: Stroke = [];
  for (const [x, y] of stroke) {
    for (let offset = 0; offset < width; offset += 1) points.push([x + offset, y]);
  }
  return points;
}

/**
 * The fixtures. Black ink on bare paper, so every painted sample survives the
 * subtraction as residual ~0.92 and clears the shape threshold of 0.08.
 *
 * Both marks are drawn with a THREE-sample pen. A one-sample X measures
 * `inkBboxFill` 0.09 and would sit under the fill floor however cleanly it
 * crosses -- which is the conjunction doing its job rather than a fixture
 * accident, and is why the strokes here have a width.
 */
const SHAPES = {
  /** A cancelling X: two crossing strokes. Measures crossing 1.00, fill 0.32. */
  cancelled: [...pen(line(9, 6, 24, 21), 3), ...pen(line(24, 6, 9, 21), 3)],
  /** One selecting stroke of the same pen. Measures crossing 0.00, fill 0.13. */
  selected: pen(line(5, 3, 26, 24), 3),
  /** Nothing at all. */
  empty: [] as Stroke,
};

type ShapeName = keyof typeof SHAPES;

function build(shapes: ShapeName[]) {
  const width = pageWidth(shapes.length);
  const boxes = shapes.map((_, index) => boxRect(index));
  const page = Buffer.alloc(width * PAGE_HEIGHT, 255);
  const blank = Buffer.alloc(width * PAGE_HEIGHT, 255);
  shapes.forEach((name, index) => {
    const rect = boxes[index];
    for (const [x, y] of SHAPES[name]) {
      page[(rect.top + y) * width + rect.left + x] = 0;
    }
  });
  return {
    image: {
      width, height: PAGE_HEIGHT, pixels: page, contentBoundsConfident: true,
    } as ImageAnalysisData,
    baseline: {
      width, height: PAGE_HEIGHT, pixels: blank, contentBoundsConfident: true,
    } as ImageAnalysisData,
    boxes,
    width,
  };
}

function run(shapes: ShapeName[]) {
  const { image, baseline, boxes, width } = build(shapes);
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
  return analyzeChoiceGroup(
    image,
    group,
    undefined,
    true,
    boxes,
    false,
    { image: baseline, candidatePixelOverrides: boxes },
    false,
  );
}

/**
 * `MARK_SHAPE_TRACE` is a different instrument that also adds the eight
 * columns, and the suite has to pass with it set. This file's subject is the
 * veto, so it states that flag's side rather than inheriting it -- the same
 * thing `mark-shape-trace.test.ts` does for its own.
 */
function withShapeTraceOff<T>(body: () => T): T {
  const previous = process.env.MARK_SHAPE_TRACE;
  delete process.env.MARK_SHAPE_TRACE;
  try {
    return body();
  } finally {
    if (previous !== undefined) process.env.MARK_SHAPE_TRACE = previous;
  }
}

/** One run, with every flag it depends on stated rather than inherited. */
function measure(shapes: ShapeName[], veto: CancelVetoSettings) {
  return withAffineTone(false, () => withShapeTraceOff(
    () => withCancelVeto(veto, () => run(shapes)),
  ));
}

const OFF: CancelVetoSettings = { MARK_CANCEL_VETO: '0' };
const ON: CancelVetoSettings = { MARK_CANCEL_VETO: '1' };

/** The eight columns the trace flag, and only the trace flag, may add. */
const TRACE_KEYS = [
  'componentCount',
  'component2Size',
  'inkBboxFill',
  'diagonalPos',
  'diagonalNeg',
  'crossingScore',
  'spanX',
  'spanY',
] as const;

const FIXTURE: ShapeName[] = ['cancelled', 'selected', 'empty'];

describe('MARK_CANCEL_VETO', () => {
  pinShippedScorer();

  describe('the measurement record', () => {
    const digest = (veto: CancelVetoSettings) => createHash('md5')
      .update(JSON.stringify(measure(FIXTURE, veto).candidateMeasurements))
      .digest('hex');

    /**
     * Armed (the default), the veto needs `crossingScore` and `inkBboxFill`, so
     * the shape trace IS computed with `MARK_SHAPE_TRACE` unset -- and nothing copies it
     * onto a `CandidateMeasurement`. If these two ever differ, arming a veto
     * started changing an export and the flag is no longer free to measure.
     */
    it('is byte-identical whether or not the veto is armed', () => {
      expect(digest(ON)).toBe(digest(OFF));
    });

    it('gains no trace column from the veto', () => {
      const result = measure(FIXTURE, ON);
      for (const measurement of result.candidateMeasurements ?? []) {
        for (const key of TRACE_KEYS) {
          expect(Object.prototype.hasOwnProperty.call(measurement, key), key).toBe(false);
        }
      }
    });
  });

  describe('with the flag disabled', () => {
    it('fills a struck-out box exactly as it did before', () => {
      const result = measure(FIXTURE, OFF);
      expect(result.value).toBe(1);
      expect(result.confidence).toBe('high');
      expect(result.evidence?.refused).not.toContain('cancel-crossing');
    });
  });

  describe('with the flag at its default', () => {
    it('refuses the automatic value on a struck-out box', () => {
      const result = measure(FIXTURE, ON);
      expect(result.value).toBeUndefined();
      expect(result.confidence).not.toBe('high');
    });

    it('marks the row contested and names the reason', () => {
      const result = measure(FIXTURE, ON);
      expect(result.contested).toBe(true);
      expect(result.evidence?.contested).toBe(true);
      expect(result.evidence?.outcome).toBe('contested');
      expect(result.evidence?.refused).toContain('cancel-crossing');
      expect(result.decision).toContain('cancel-crossing');
      expect(result.decision).toContain('contested=1');
    });

    it('never promotes the runner-up, and offers no default', () => {
      // The box below the X carries a clean selecting stroke, which is the
      // most tempting replacement there is. The veto's finding is about the
      // box it refused and says nothing about this one.
      const result = measure(FIXTURE, ON);
      expect(result.value).toBeUndefined();
      expect(result.suggestion).toBeUndefined();
      // Ranking is untouched: the X still won, it just did not get to answer.
      expect(result.evidence?.winner?.index).toBe(0);
      expect(result.candidates).toEqual(measure(FIXTURE, OFF).candidates);
    });

    it('leaves one selecting stroke alone', () => {
      const off = measure(['selected', 'empty', 'empty'], OFF);
      const on = measure(['selected', 'empty', 'empty'], ON);
      expect(off.value).toBe(1);
      expect(off.confidence).toBe('high');
      expect(on.value).toBe(off.value);
      expect(on.confidence).toBe(off.confidence);
      expect(on.contested).toBe(off.contested);
      expect(on.decision).toBe(off.decision);
    });
  });

  describe('the thresholds', () => {
    it('spares the X when the fill floor is raised past it', () => {
      // The X measures inkBboxFill 0.32. Raised over that, the conjunction
      // cannot complete however cleanly the strokes cross.
      const result = measure(FIXTURE, { MARK_CANCEL_VETO: '1', MARK_CANCEL_FILL: '0.4' });
      expect(result.value).toBe(1);
      expect(result.confidence).toBe('high');
    });

    it('catches one stroke when both floors are dropped under it', () => {
      // crossing 0.00 and fill 0.13, so this can only happen because BOTH
      // variables were read. It is not a rule anybody should ship -- it is the
      // proof that the numbers come from the environment.
      const result = measure(['selected', 'empty', 'empty'], {
        MARK_CANCEL_VETO: '1',
        MARK_CANCEL_CROSSING: '0',
        MARK_CANCEL_FILL: '0.1',
      });
      expect(result.value).toBeUndefined();
      expect(result.evidence?.refused).toContain('cancel-crossing');
    });

    it('falls back on the defaults when a variable is not a number', () => {
      const result = measure(FIXTURE, {
        MARK_CANCEL_VETO: '1',
        MARK_CANCEL_CROSSING: 'nonsense',
        MARK_CANCEL_FILL: '',
      });
      expect(result.value).toBeUndefined();
      expect(result.evidence?.refused).toContain('cancel-crossing');
    });
  });

  it('has a reviewer phrase for the refusal', () => {
    expect(refusalLabel('cancel-crossing')).toBe('취소 표시로 보이는 교차 획');
  });
});
