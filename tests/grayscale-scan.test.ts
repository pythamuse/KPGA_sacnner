import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeChoiceGroup,
  R_BILEVEL,
  type ImageAnalysisData,
  type PixelRect,
} from '../src/lib/recognition/markDensity';
import type { ChoiceGroup } from '../src/lib/recognition/roiTemplates';

const PAGE_WIDTH = 480;
const PAGE_HEIGHT = 110;
const BOX_WIDTH = 60;
const BOX_HEIGHT = 80;
const BOX_TOP = 15;
const BOX_LEFT = 10;
const BOX_PITCH = 90;
const BOX_COUNT = 5;
const PRINTED_GREY = 89; // darkness 0.5 under the scorer's 178-level scale.

const originalGrayClass = process.env.GRAY_CLASS;
const originalGridTrace = process.env.GRID_TRACE;
const originalDecisionTrace = process.env.MARK_DECISION_TRACE;

afterEach(() => {
  if (originalGrayClass === undefined) delete process.env.GRAY_CLASS;
  else process.env.GRAY_CLASS = originalGrayClass;
  if (originalGridTrace === undefined) delete process.env.GRID_TRACE;
  else process.env.GRID_TRACE = originalGridTrace;
  if (originalDecisionTrace === undefined) delete process.env.MARK_DECISION_TRACE;
  else process.env.MARK_DECISION_TRACE = originalDecisionTrace;
  vi.restoreAllMocks();
});

function buildScene(pageIsBinarySource: boolean): {
  image: ImageAnalysisData;
  baseline: ImageAnalysisData;
  boxes: PixelRect[];
  group: ChoiceGroup;
} {
  const page = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
  const blank = Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, 255);
  const boxes = Array.from({ length: BOX_COUNT }, (_, index) => ({
    left: BOX_LEFT + index * BOX_PITCH,
    top: BOX_TOP,
    right: BOX_LEFT + index * BOX_PITCH + BOX_WIDTH,
    bottom: BOX_TOP + BOX_HEIGHT,
  }));

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    // The blank form's printed structure fills a common inner block. Every
    // page reproduces that structure at half its darkness.
    for (let y = box.top + 22; y < box.top + 58; y += 1) {
      for (let x = box.left + 12; x < box.left + 48; x += 1) {
        blank[y * PAGE_WIDTH + x] = 0;
        page[y * PAGE_WIDTH + x] = PRINTED_GREY;
      }
    }
    if (index === 0) {
      // The mark is laid over printed structure. The old baseline subtraction
      // therefore removes it; the calibrated baseline leaves it visible.
      for (let y = box.top + 30; y < box.top + 50; y += 1) {
        for (let x = box.left + 20; x < box.left + 40; x += 1) {
          page[y * PAGE_WIDTH + x] = 0;
        }
      }
    }
  }

  const group: ChoiceGroup = {
    field: 'satisfaction.q01',
    candidates: boxes.map((box, index) => ({
      value: index + 1,
      rect: {
        x: box.left / PAGE_WIDTH,
        y: box.top / PAGE_HEIGHT,
        width: BOX_WIDTH / PAGE_WIDTH,
        height: BOX_HEIGHT / PAGE_HEIGHT,
      },
    })),
  };
  const common = {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    contentBounds: { left: 0, top: 0, right: PAGE_WIDTH, bottom: PAGE_HEIGHT },
    contentBoundsConfident: true,
  };
  return {
    image: { ...common, pixels: page, pageIsBinarySource },
    baseline: { ...common, pixels: blank, pageIsBinarySource: true },
    boxes,
    group,
  };
}

function runScene(pageIsBinarySource: boolean, photoProvenance = false) {
  const scene = buildScene(pageIsBinarySource);
  return analyzeChoiceGroup(
    scene.image,
    scene.group,
    undefined,
    true,
    scene.boxes,
    false,
    { image: scene.baseline, candidatePixelOverrides: scene.boxes },
    photoProvenance,
  );
}

function measurementFor(result: ReturnType<typeof runScene>, candidateIndex: number) {
  const measurement = result.candidateMeasurements?.find((entry) => entry.candidateIndex === candidateIndex);
  expect(measurement).toBeDefined();
  return measurement!;
}

describe('opt-in grayscale scan class', () => {
  it('keeps the old baseline subtraction when GRAY_CLASS is off', () => {
    process.env.GRAY_CLASS = '0';

    const result = runScene(false);

    expect(result.value).toBeUndefined();
    expect(result.candidates[0].score).toBe(0);
    expect(result.evidence?.inputClass).toBeUndefined();
    expect(result.decision).not.toContain('class=grayscale-scan');
  });

  it('scales only the baseline side and derives a page margin from box noise', () => {
    process.env.GRAY_CLASS = '1';

    const result = runScene(false);
    const winner = measurementFor(result, 0);
    const quiet = measurementFor(result, 1);

    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
    expect(winner.score).toBeGreaterThan(0.021);
    expect(quiet.score).toBe(0);
    expect(result.decision).toContain('class=grayscale-scan');
    expect(result.decision).toContain(`gain=${(0.5 / R_BILEVEL).toFixed(2)}`);
    expect(result.evidence?.inputClass).toBe('grayscale-scan');
    expect(result.evidence?.ratio).toBeCloseTo(0.5, 3);
    expect(result.evidence?.gain).toBeCloseTo(0.5 / R_BILEVEL, 3);
    expect(result.evidence?.margin).toBeGreaterThanOrEqual(0.03);
    expect(result.evidence?.margin).toBeLessThanOrEqual(0.08);
  });

  it('does not change a bilevel or photo-class result when the flag is on', () => {
    process.env.GRAY_CLASS = '1';

    const bilevelWithFlag = runScene(true);
    process.env.GRAY_CLASS = '0';
    const bilevelWithoutFlag = runScene(true);
    expect(bilevelWithFlag).toEqual(bilevelWithoutFlag);

    process.env.GRAY_CLASS = '1';
    const photoWithFlag = runScene(false, true);
    process.env.GRAY_CLASS = '0';
    const photoWithoutFlag = runScene(false, true);
    expect(photoWithFlag).toEqual(photoWithoutFlag);
  });
});

describe('baseline pairing trace', () => {
  it('reports normalized i-to-i center deviation without changing the result', () => {
    process.env.GRID_TRACE = '1';
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });

    const traced = runScene(true);
    const pairLine = lines.find((line) => line.startsWith('[baseline-pair]'));

    expect(pairLine).toMatch(
      /^\[baseline-pair\] field=satisfaction\.q01 maxDev=0\.0000 pitchMin=0\.\d{3} ok=1$/,
    );

    delete process.env.GRID_TRACE;
    const untraced = runScene(true);
    expect(traced).toEqual(untraced);
  });
});
