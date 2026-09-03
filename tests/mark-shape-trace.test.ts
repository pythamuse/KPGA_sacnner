import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  analyzeChoiceGroup,
  CandidateMeasurement,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { withAffineTone } from './helpers/affineTone';
import { pinShippedScorer } from './helpers/scorerVariants';

/**
 * `MARK_SHAPE_TRACE`, the contested-cell shape instrument.
 *
 * FIELD_TEST §34.7: every remaining browser wrong answer is a cell with ink in
 * two boxes, and several are a box the student marked and then CANCELLED with
 * an X before marking another. The scorer measures `largestComponentSize` and
 * `diagonalRatio`, neither of which can tell a crossing pair of strokes from a
 * single selecting mark. This file pins what the new trace measures.
 *
 * Two things only, because these are SYNTHETIC boxes (CLAUDE.md §2):
 *
 *   1. **OFF IS INVISIBLE.** With the variable unset the measurements are the
 *      same objects, key for key and digit for digit, that the scorer produced
 *      before the trace existed -- pinned as an md5 over the serialized
 *      `candidateMeasurements` of a fixed fixture, so a stray key or a moved
 *      key fails here rather than in a diff of a real export.
 *   2. **THE ARITHMETIC DOES WHAT IT CLAIMS.** A crossed pair of strokes reads
 *      as crossing, one stroke does not, and a loop reads as a loop. Nothing
 *      here says a real cancelling mark looks like these; the delegator
 *      measures that on real rasters.
 *
 * Both bodies state their side of the flag rather than inherit it, because the
 * suite has to pass with `MARK_SHAPE_TRACE=1` in the environment and without.
 */

// Fixture geometry, same shape as `ink-invariant.test.ts`: one box per
// candidate, sampled 1:1, so a painted pixel is a sample and every figure below
// is arithmetic rather than guesswork.
const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const GUTTER = 4;
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;
/** The scorer drops a one-sample border per axis, and the trace reads the same window. */
const WINDOW_WIDTH = CELL_WIDTH - 2;
const WINDOW_HEIGHT = CELL_HEIGHT - 2;

/** Cell-local sample coordinates of the ink a fixture box carries. */
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

/** A one-sample-thick ellipse outline inscribed in the given cell-local box. */
function ellipse(left: number, top: number, right: number, bottom: number): Stroke {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = (right - left) / 2;
  const radiusY = (bottom - top) / 2;
  const seen = new Set<string>();
  const points: Stroke = [];
  for (let i = 0; i < 720; i += 1) {
    const angle = (i * Math.PI) / 360;
    const x = Math.round(centerX + radiusX * Math.cos(angle));
    const y = Math.round(centerY + radiusY * Math.sin(angle));
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push([x, y]);
  }
  return points;
}

/** Every sample inside the given cell-local box: a filled blob. */
function block(left: number, top: number, right: number, bottom: number): Stroke {
  const points: Stroke = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) points.push([x, y]);
  }
  return points;
}

/**
 * The fixture shapes. All ink is black on a blank form that is bare paper, so
 * every painted sample survives the subtraction as residual ~0.92 and lands
 * well over the trace's 0.08 threshold. All of it sits inside
 * `x in [1, 34], y in [1, 26]`, the window the scorer averages and the trace
 * reads.
 */
const SHAPES: Record<string, Stroke> = {
  /** A cancelling X: two strokes crossing over the whole box. */
  cross: [...line(4, 3, 25, 24), ...line(25, 3, 4, 24)],
  /** One selecting stroke, the same length and thickness as an arm of the X. */
  singleStroke: line(4, 3, 25, 24),
  /** A drawn ring, filling the same fraction of the box on both axes. */
  loop: ellipse(5, 4, 30, 23),
  /** A filled-in box: both diagonal tests answer yes at every interior sample. */
  blob: block(12, 8, 23, 19),
  /** Two separate ticks, so `componentCount` and `component2Size` have work. */
  twoTicks: [...line(3, 4, 10, 11), ...line(24, 4, 31, 11)],
  /** Nothing at all. */
  empty: [],
};

type ShapeName = keyof typeof SHAPES;

function build(shapes: ShapeName[]): {
  image: ImageAnalysisData;
  baseline: ImageAnalysisData;
  boxes: PixelRect[];
  width: number;
} {
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
    image: { width, height: PAGE_HEIGHT, pixels: page, contentBoundsConfident: true },
    baseline: { width, height: PAGE_HEIGHT, pixels: blank, contentBoundsConfident: true },
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

/** Arms or disarms `MARK_SHAPE_TRACE` around one body, restoring what it found. */
function withShapeTrace<T>(armed: boolean, body: () => T): T {
  const previous = process.env.MARK_SHAPE_TRACE;
  if (armed) {
    process.env.MARK_SHAPE_TRACE = '1';
  } else {
    delete process.env.MARK_SHAPE_TRACE;
  }
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.MARK_SHAPE_TRACE;
    } else {
      process.env.MARK_SHAPE_TRACE = previous;
    }
  }
}

/** The trace of one shape, measured on its own three-box group. */
function traceOf(name: ShapeName): CandidateMeasurement {
  // Two quiet losers beside it: `analyzeChoiceGroup` is a group calculation and
  // the tone anchor is the group's, so a shape is never measured alone.
  const result = withAffineTone(false, () => withShapeTrace(true, () => run([name, 'empty', 'empty'])));
  const found = (result.candidateMeasurements ?? []).find((entry) => entry.candidateIndex === 0);
  expect(found, `no measurement for ${name}`).toBeDefined();
  return found!;
}

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

describe('MARK_SHAPE_TRACE', () => {
  pinShippedScorer();

  describe('with the variable unset', () => {
    /**
     * The fixture the md5 is taken over: one group carrying every shape this
     * file draws, so the digest covers a scored box, a refused box and an empty
     * box at once. Serialized with `JSON.stringify`, which is what the label
     * sidecar and the review payload both go through -- an added key, a removed
     * key or a key in a different position all change the digest.
     */
    const digest = () => withAffineTone(false, () => withShapeTrace(false, () => {
      const result = run(['cross', 'singleStroke', 'loop', 'blob', 'twoTicks', 'empty']);
      return createHash('md5')
        .update(JSON.stringify(result.candidateMeasurements))
        .digest('hex');
    }));

    /**
     * Measured on the base commit (4fef6ec) with this same fixture, BEFORE the
     * trace existed, and re-measured after. If this digit ever moves, the
     * instrument stopped being free and the change is not a measurement round
     * any more.
     */
    it('produces byte-identical candidate measurements', () => {
      expect(digest()).toBe('fb4157cbae4deb97b37d75a7c10ace0c');
    });

    it('adds no trace key to any measurement', () => {
      const result = withAffineTone(false, () => withShapeTrace(false, () => run(['cross', 'loop', 'empty'])));
      for (const measurement of result.candidateMeasurements ?? []) {
        for (const key of TRACE_KEYS) {
          expect(Object.prototype.hasOwnProperty.call(measurement, key), key).toBe(false);
        }
      }
    });
  });

  describe('with the variable set', () => {
    it('gives every candidate the full set of trace fields', () => {
      const result = withAffineTone(false, () => withShapeTrace(true, () => run(['cross', 'loop', 'empty'])));
      const measurements = result.candidateMeasurements ?? [];
      expect(measurements).toHaveLength(3);
      for (const measurement of measurements) {
        for (const key of TRACE_KEYS) {
          expect(typeof measurement[key], key).toBe('number');
        }
      }
    });

    it('reads a crossed pair of strokes as crossing', () => {
      const cross = traceOf('cross');
      // Two arms over the same box, in comparable amounts: iou ~1, balance ~1.
      expect(cross.crossingScore!).toBeGreaterThan(0.6);
      expect(cross.componentCount!).toBeGreaterThanOrEqual(1);
      // Both diagonal directions carry real weight, which is what "crossed"
      // means before any region test is applied.
      expect(cross.diagonalPos!).toBeGreaterThan(0.3);
      expect(cross.diagonalNeg!).toBeGreaterThan(0.3);
    });

    it('does not read one stroke as crossing', () => {
      const single = traceOf('singleStroke');
      const cross = traceOf('cross');
      // One direction only, so the balance term is 0 and so is the score.
      expect(single.crossingScore!).toBe(0);
      expect(single.crossingScore!).toBeLessThan(cross.crossingScore!);
      expect(single.diagonalNeg!).toBe(0);
      expect(single.diagonalPos!).toBeGreaterThan(0.3);
    });

    it('reads a loop as thin and square in the box', () => {
      const loop = traceOf('loop');
      const blob = traceOf('blob');
      // A ring is mostly the hole it encloses.
      expect(loop.inkBboxFill!).toBeLessThan(0.3);
      expect(blob.inkBboxFill!).toBeGreaterThan(0.9);
      // Drawn to the same fraction of the window on both axes, and read back
      // that way. `spanX`/`spanY` are normalized per axis, so this is the
      // shape's aspect relative to the cell, not to the sample grid.
      expect(loop.spanX!).toBeCloseTo(loop.spanY!, 1);
      expect(loop.spanX!).toBeCloseTo(26 / WINDOW_WIDTH, 5);
      expect(loop.spanY!).toBeCloseTo(20 / WINDOW_HEIGHT, 5);
    });

    it('does not read a straight-edged fill as crossing', () => {
      // Every interior sample answers yes to both diagonal tests and every edge
      // sample answers no to both, so the exclusive sets are empty and the
      // score is 0. This is the case the exclusive definition exists for -- and
      // its limit: the fill has to be a clean axis-aligned rectangle for it to
      // hold. A filled circle's ragged boundary reads like the loop below
      // (0.98 measured end-to-end on a synthetic marked form), which is why
      // `crossingScore` is only ever read next to `inkBboxFill`.
      const blob = traceOf('blob');
      expect(blob.diagonalPos!).toBeGreaterThan(0.6);
      expect(blob.diagonalNeg!).toBeGreaterThan(0.6);
      expect(blob.crossingScore!).toBe(0);
    });

    it('counts separate marks, and sizes the second', () => {
      const ticks = traceOf('twoTicks');
      expect(ticks.componentCount!).toBe(2);
      expect(ticks.component2Size!).toBe(8);
      const single = traceOf('singleStroke');
      expect(single.componentCount!).toBe(1);
      expect(single.component2Size!).toBe(0);
    });

    it('zeroes every field on a box with no ink', () => {
      const empty = traceOf('empty');
      for (const key of TRACE_KEYS) expect(empty[key], key).toBe(0);
    });

    it('leaves the score, the ranking and the existing shape numbers alone', () => {
      const shapes: ShapeName[] = ['cross', 'singleStroke', 'loop', 'blob', 'twoTicks', 'empty'];
      const off = withAffineTone(false, () => withShapeTrace(false, () => run(shapes)));
      const on = withAffineTone(false, () => withShapeTrace(true, () => run(shapes)));
      expect(on.value).toEqual(off.value);
      expect(on.confidence).toBe(off.confidence);
      expect(on.contested).toBe(off.contested);
      expect(on.candidates).toEqual(off.candidates);
      expect(on.decision).toEqual(off.decision);
      const strip = (measurements: CandidateMeasurement[] | undefined) => (measurements ?? [])
        .map((measurement) => {
          const copy = { ...measurement } as Record<string, unknown>;
          for (const key of TRACE_KEYS) delete copy[key];
          return copy;
        });
      expect(strip(on.candidateMeasurements)).toEqual(strip(off.candidateMeasurements));
    });
  });
});
