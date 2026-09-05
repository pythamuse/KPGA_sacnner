import { describe, expect, it, afterEach } from 'vitest';
import type { ImageAnalysisData, PixelRect } from '../src/lib/recognition/markDensity';
import type { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { __probe } from '../src/lib/recognition/detectCheckmarks';

/**
 * Cycle 4, Section B (CHECKBOX_RUNNERUP_CORE): synthetic tests for
 * `evaluateDirectCheckboxEvidence`, exercised directly via __probe -- no
 * rasterised page or student file needed. See cycle4-order.md and
 * Task/CYCLE4_BASIC_SIGNALS_AGENT_REPORT_2026-09-05.md.
 *
 * One choice group, two candidates: box 0 (the one the scorer names) and box
 * 1 (the runner-up). Both are 40x40-pixel windows on a shared page image, a
 * blank baseline of the same size (all white -- no printed content modeled,
 * so every dark actual pixel reads as +ink).
 *
 * Box 0's whole window is painted dark, giving it a strong, unambiguous
 * signal (named > 0, and comfortably past CHECKBOX_DOMINANCE_RATIO against
 * anything box 1 produces below) -- named is never the thing under test here,
 * only the runner-up figure is.
 *
 * Box 1 varies by scenario:
 *
 *   - "border bleed": dark only in a 5px ring around the window's rim,
 *     white in the inner 30x30 -- the border-bleed case the cycle 4 order's
 *     fact #2 measured on real pages (a window that only slightly overlaps
 *     the printed box's outline). The window's core -- inset 25% per side,
 *     the same definition `measureBasicCheckboxPlacement` uses -- excludes
 *     the entire 5px ring (core is [10,30)x[10,30) of a 40x40 window), so the
 *     core-windowed signal is 0 while the full-window signal is far past
 *     CHECKBOX_RUNNER_UP_SIGNAL (0.025).
 *   - "core inked": dark across the whole window, rim and interior alike --
 *     a real second mark. Both the full-window and the core-windowed signal
 *     are far past the threshold here, so both settings must refuse.
 */

const WIDTH = 90;
const HEIGHT = 40;
const NAMED_RECT: PixelRect = { left: 0, top: 0, right: 40, bottom: 40 };
const RUNNER_UP_RECT: PixelRect = { left: 50, top: 0, right: 90, bottom: 40 };
const BORDER_WIDTH = 5;

const GROUP: ChoiceGroup = {
  field: 'basic.group0',
  candidates: [
    { value: 0, rect: { x: 0, y: 0, width: 0.02, height: 0.02 } },
    { value: 1, rect: { x: 0, y: 0, width: 0.02, height: 0.02 } },
  ],
};

function blankImage(): ImageAnalysisData {
  return { width: WIDTH, height: HEIGHT, pixels: Buffer.alloc(WIDTH * HEIGHT, 255), contentBoundsConfident: true };
}

function paintRect(pixels: Buffer, rect: PixelRect, value: number): void {
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      pixels[y * WIDTH + x] = value;
    }
  }
}

/** `runnerUpVariant`: 'border' paints only a 5px ring at box 1's rim (the
 * interior stays clean); 'inked' paints the whole box (rim and interior). Box
 * 0 is always fully dark, and the baseline is always blank. */
function buildImage(runnerUpVariant: 'border' | 'inked'): ImageAnalysisData {
  const image = blankImage();
  paintRect(image.pixels, NAMED_RECT, 0);
  if (runnerUpVariant === 'inked') {
    paintRect(image.pixels, RUNNER_UP_RECT, 0);
  } else {
    const { left, top, right, bottom } = RUNNER_UP_RECT;
    paintRect(image.pixels, { left, top, right, bottom: top + BORDER_WIDTH }, 0); // top ring
    paintRect(image.pixels, { left, top: bottom - BORDER_WIDTH, right, bottom }, 0); // bottom ring
    paintRect(image.pixels, { left, top, right: left + BORDER_WIDTH, bottom }, 0); // left ring
    paintRect(image.pixels, { left: right - BORDER_WIDTH, top, right, bottom }, 0); // right ring
  }
  return image;
}

describe('coreWindow (measureBasicCheckboxPlacement\'s core, restated)', () => {
  it('insets a window by 25% per side', () => {
    expect(__probe.coreWindow({ left: 0, top: 0, right: 40, bottom: 40 })).toEqual({
      left: 10, right: 30, top: 10, bottom: 30,
    });
    expect(__probe.coreWindow({ left: 50, top: 100, right: 90, bottom: 140 })).toEqual({
      left: 60, right: 80, top: 110, bottom: 130,
    });
  });
});

describe('isRunnerUpCoreEnabled (CHECKBOX_RUNNERUP_CORE)', () => {
  const ORIGINAL = process.env.CHECKBOX_RUNNERUP_CORE;
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.CHECKBOX_RUNNERUP_CORE;
    } else {
      process.env.CHECKBOX_RUNNERUP_CORE = ORIGINAL;
    }
  });

  it('defaults on, and only "0" turns it off', () => {
    delete process.env.CHECKBOX_RUNNERUP_CORE;
    expect(__probe.isRunnerUpCoreEnabled()).toBe(true);
    process.env.CHECKBOX_RUNNERUP_CORE = '0';
    expect(__probe.isRunnerUpCoreEnabled()).toBe(false);
    process.env.CHECKBOX_RUNNERUP_CORE = '1';
    expect(__probe.isRunnerUpCoreEnabled()).toBe(true);
  });
});

describe('evaluateDirectCheckboxEvidence runner-up core windowing', () => {
  const ORIGINAL = process.env.CHECKBOX_RUNNERUP_CORE;
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.CHECKBOX_RUNNERUP_CORE;
    } else {
      process.env.CHECKBOX_RUNNERUP_CORE = ORIGINAL;
    }
  });

  it('border-bleed runner-up: CHECKBOX_RUNNERUP_CORE on (default) accepts', () => {
    delete process.env.CHECKBOX_RUNNERUP_CORE;
    const image = buildImage('border');
    const baseline = blankImage();
    const evidence = __probe.evaluateDirectCheckboxEvidence(
      image, baseline, GROUP, [NAMED_RECT, RUNNER_UP_RECT], [NAMED_RECT, RUNNER_UP_RECT], 0,
    );
    expect(evidence.accepted).toBe(true);
    expect(evidence.reason).toBe('ok');
    expect(evidence.runnerUpCore).toBeDefined();
    expect(evidence.runnerUpCore!).toBeLessThanOrEqual(0.025);
    // The full-window signal the pre-cycle-4 check used is still reported in
    // `signals`, and it is well past the threshold -- the border ring alone
    // would have refused this field.
    expect(evidence.signals[1]).toBeGreaterThan(0.025);
  });

  it('border-bleed runner-up: CHECKBOX_RUNNERUP_CORE=0 refuses (today\'s behaviour)', () => {
    process.env.CHECKBOX_RUNNERUP_CORE = '0';
    const image = buildImage('border');
    const baseline = blankImage();
    const evidence = __probe.evaluateDirectCheckboxEvidence(
      image, baseline, GROUP, [NAMED_RECT, RUNNER_UP_RECT], [NAMED_RECT, RUNNER_UP_RECT], 0,
    );
    expect(evidence.accepted).toBe(false);
    expect(evidence.reason).toBe('runner-up-inked');
    expect(evidence.runnerUpCore).toBeUndefined();
  });

  it('core genuinely inked: both settings refuse', () => {
    const image = buildImage('inked');
    const baseline = blankImage();

    delete process.env.CHECKBOX_RUNNERUP_CORE;
    const withCore = __probe.evaluateDirectCheckboxEvidence(
      image, baseline, GROUP, [NAMED_RECT, RUNNER_UP_RECT], [NAMED_RECT, RUNNER_UP_RECT], 0,
    );
    expect(withCore.accepted).toBe(false);
    expect(withCore.reason).toBe('runner-up-inked');
    expect(withCore.runnerUpCore!).toBeGreaterThan(0.025);

    process.env.CHECKBOX_RUNNERUP_CORE = '0';
    const withoutCore = __probe.evaluateDirectCheckboxEvidence(
      image, baseline, GROUP, [NAMED_RECT, RUNNER_UP_RECT], [NAMED_RECT, RUNNER_UP_RECT], 0,
    );
    expect(withoutCore.accepted).toBe(false);
    expect(withoutCore.reason).toBe('runner-up-inked');
  });

  it('named box is always measured on the full window, regardless of the switch', () => {
    const image = buildImage('border');
    const baseline = blankImage();
    delete process.env.CHECKBOX_RUNNERUP_CORE;
    const withCore = __probe.evaluateDirectCheckboxEvidence(
      image, baseline, GROUP, [NAMED_RECT, RUNNER_UP_RECT], [NAMED_RECT, RUNNER_UP_RECT], 0,
    );
    process.env.CHECKBOX_RUNNERUP_CORE = '0';
    const withoutCore = __probe.evaluateDirectCheckboxEvidence(
      image, baseline, GROUP, [NAMED_RECT, RUNNER_UP_RECT], [NAMED_RECT, RUNNER_UP_RECT], 0,
    );
    // `signals` (the full-window figures, index 0 = named) is unaffected by
    // the switch either way.
    expect(withCore.signals[0]).toBeCloseTo(withoutCore.signals[0], 9);
    expect(withCore.signals[0]).toBeGreaterThan(0.5);
  });
});
