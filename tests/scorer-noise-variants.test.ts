import { describe, expect, it } from 'vitest';
import {
  calculateTemplateInkDifference,
  ImageAnalysisData,
  PixelRect,
} from '../src/lib/recognition/markDensity';
import { withScorerVariants } from './helpers/scorerVariants';

/**
 * The two noise-floor instruments, on synthetic cells.
 *
 * FIELD_TEST §34.7 measured the failure this round is aimed at: an UNMARKED
 * box keeps a residual of about 0.03 -- roughly the p10 of boxes that really
 * are marked -- and the leading hypothesis is that the residual is the printed
 * glyph, left behind because the baseline alignment moves in whole samples and
 * the misregistration is not a whole sample.
 *
 * Synthetic cells cannot say whether that hypothesis is true of real paper
 * (CLAUDE.md §2: nothing here judges accuracy, and no verdict is drawn here).
 * What they can say is what the two instruments arithmetically do, which is the
 * only thing a delegator measuring real rasters needs from this file:
 *
 *   1. A cell with a printed glyph and NO mark, whose blank copy is
 *      misregistered by a fraction of a sample, scores above zero today.
 *   2. `MARK_BASELINE_DILATE=1` removes that residual.
 *   3. It does NOT remove a real mark: a 3px stroke clear of the print keeps
 *      well over half its score.
 *   4. `MARK_ALIGN_RADIUS=2` reaches a two-sample misregistration that the
 *      default reach of one sample cannot, and the default still cannot.
 *   5. Both unset, every number is the one the shipped scorer produces.
 *
 * Every cell is exactly the 36x28 sample grid, so a painted pixel is a sample
 * and each figure below is arithmetic. Same fixture shape as
 * `ink-invariant.test.ts`.
 */

const CELL_WIDTH = 36;
const CELL_HEIGHT = 28;
const GUTTER = 4;
const PAGE_WIDTH = CELL_WIDTH + 2 * GUTTER;
const PAGE_HEIGHT = CELL_HEIGHT + 2 * GUTTER;
const RECT: PixelRect = {
  left: GUTTER,
  top: GUTTER,
  right: GUTTER + CELL_WIDTH,
  bottom: GUTTER + CELL_HEIGHT,
};

/** `darkness()` as the scorer defines it, for stating a grey level's ink. */
function inkOfGrey(value: number): number {
  return Math.max(0, Math.min(1, (178 - value) / 178));
}

/** Grey levels chosen so the ink each one carries is a round-ish number. */
const SOLID = 0; // ink 1.0000
const NEAR_SOLID = 10; // ink 0.9438 -- print the page reproduced a shade darker
const EDGE_HEAVY = 36; // ink 0.7978 -- the covered side of a fractional shift
const EDGE_LIGHT = 125; // ink 0.2978 -- the uncovered side of the same shift
const PAPER = 255; // ink 0

function paintColumns(
  pixels: Buffer,
  columns: number[],
  value: number,
  rows: { from: number; to: number } = { from: 0, to: CELL_HEIGHT },
): void {
  for (let row = rows.from; row < rows.to; row += 1) {
    for (const column of columns) {
      pixels[(RECT.top + row) * PAGE_WIDTH + RECT.left + column] = value;
    }
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

function newPage(): Buffer {
  return Buffer.alloc(PAGE_WIDTH * PAGE_HEIGHT, PAPER);
}

function asImage(pixels: Buffer): ImageAnalysisData {
  return { width: PAGE_WIDTH, height: PAGE_HEIGHT, pixels, contentBoundsConfident: true };
}

function score(page: Buffer, blank: Buffer): number {
  return calculateTemplateInkDifference(asImage(page), RECT, asImage(blank), RECT);
}

/**
 * A printed glyph the page reproduced a quarter of a sample to the right.
 *
 * The blank carries a solid bar on columns 10..17. The page carries the same
 * bar shifted right by about a quarter sample, so its leading column is only
 * partly covered (EDGE_HEAVY) and one column past the bar's end is faintly
 * covered (EDGE_LIGHT). No whole-sample offset can undo a fractional shift, and
 * at a pitch of one source pixel the search has no fractional offsets to try,
 * so the leftover ink at column 18 is exactly the residual §34.7 describes.
 *
 * The shift is a quarter rather than a half on purpose: a half-sample shift is
 * equidistant from offset 0 and offset -1, and the search would be choosing
 * between ties. At a quarter, offset 0 wins outright (0.500 against 1.500 and
 * 2.500 of symmetric difference per row), so the residual under test is the one
 * left by the alignment the scorer actually picks.
 */
function glyphPair(): { page: Buffer; blank: Buffer } {
  const page = newPage();
  const blank = newPage();
  paintColumns(blank, range(10, 18), SOLID);
  paintColumns(page, [10], EDGE_HEAVY);
  paintColumns(page, range(11, 18), SOLID);
  paintColumns(page, [18], EDGE_LIGHT);
  return { page, blank };
}

describe('scorer noise-floor instruments', () => {
  describe('MARK_BASELINE_DILATE', () => {
    it('leaves the glyph residual in place when it is not set', () => {
      const { page, blank } = glyphPair();
      const plain = withScorerVariants({}, () => score(page, blank));
      // Column 18 carries EDGE_LIGHT against paper, less the 0.08 band:
      // (0.2978 - 0.08) * 26 rows / (34 * 26 usable) = 0.00641.
      expect(plain).toBeCloseTo((inkOfGrey(EDGE_LIGHT) - 0.08) / 34, 5);
      expect(plain).toBeGreaterThan(0);
    });

    it('removes the glyph residual from an unmarked cell', () => {
      const { page, blank } = glyphPair();
      const plain = withScorerVariants({}, () => score(page, blank));
      const dilated = withScorerVariants({ MARK_BASELINE_DILATE: '1' }, () => score(page, blank));
      // The blank's bar grown by one sample now covers column 18, so the page
      // is lighter there than the subtrahend and nothing survives the clip.
      expect(dilated).toBe(0);
      expect(dilated).toBeLessThan(plain);
    });

    it('does not cut a 3px stroke to half its score', () => {
      const { page, blank } = glyphPair();
      // Clear of the print by seven columns, so growing the blank's bar by one
      // sample cannot reach it.
      paintColumns(page, range(25, 28), SOLID, { from: 5, to: 25 });
      const plain = withScorerVariants({}, () => score(page, blank));
      const dilated = withScorerVariants({ MARK_BASELINE_DILATE: '1' }, () => score(page, blank));
      // 3 columns x 20 rows of (1.0 - 0.08) over 34 * 26 usable samples.
      const strokeAlone = (3 * 20 * (inkOfGrey(SOLID) - 0.08)) / (34 * 26);
      expect(dilated).toBeCloseTo(strokeAlone, 5);
      expect(dilated).toBeGreaterThan(plain * 0.5);
      // What it did remove is the glyph residual, and only that.
      expect(plain - dilated).toBeCloseTo((inkOfGrey(EDGE_LIGHT) - 0.08) / 34, 5);
    });
  });

  describe('MARK_ALIGN_RADIUS', () => {
    /**
     * The same printed bar, misregistered by two whole samples. The page's copy
     * is a shade darker than the blank's so the total-ink invariant does not
     * zero either reading before the offsets can be compared.
     */
    function shiftedPair(): { page: Buffer; blank: Buffer } {
      const page = newPage();
      const blank = newPage();
      paintColumns(blank, range(10, 18), NEAR_SOLID);
      paintColumns(page, range(12, 20), SOLID);
      return { page, blank };
    }

    it('cannot reach a two-sample misregistration at the default reach', () => {
      const { page, blank } = shiftedPair();
      const plain = withScorerVariants({}, () => score(page, blank));
      // Best offset within +/-1 is -1: one page-only column (19) survives at
      // (1.0 - 0.08) over 34 * 26 usable samples.
      expect(plain).toBeCloseTo((inkOfGrey(SOLID) - 0.08) / 34, 5);
      expect(plain).toBeGreaterThan(0);
    });

    it('reaches it at radius 2', () => {
      const { page, blank } = shiftedPair();
      const widened = withScorerVariants({ MARK_ALIGN_RADIUS: '2' }, () => score(page, blank));
      // Offset -2 lands the bars on each other; the 0.056 the page is darker by
      // is under the 0.08 band, so nothing survives.
      expect(widened).toBe(0);
    });

    it('is independent of the dilation and composes with it', () => {
      const { page, blank } = shiftedPair();
      const both = withScorerVariants(
        { MARK_BASELINE_DILATE: '1', MARK_ALIGN_RADIUS: '2' },
        () => score(page, blank),
      );
      expect(both).toBe(0);

      const glyph = glyphPair();
      const dilateOnly = withScorerVariants(
        { MARK_BASELINE_DILATE: '1' },
        () => score(glyph.page, glyph.blank),
      );
      const widenOnly = withScorerVariants(
        { MARK_ALIGN_RADIUS: '2' },
        () => score(glyph.page, glyph.blank),
      );
      // A fractional shift is not reachable by any whole-sample offset, so more
      // reach alone leaves the residual where it is -- the two instruments are
      // aimed at different things and neither stands in for the other.
      expect(dilateOnly).toBe(0);
      expect(widenOnly).toBeGreaterThan(0);
    });
  });

  it('reads the shipped scorer when neither variable is set', () => {
    const { page, blank } = glyphPair();
    const before = process.env.MARK_BASELINE_DILATE;
    const armed = withScorerVariants({ MARK_BASELINE_DILATE: '1' }, () => score(page, blank));
    const after = withScorerVariants({}, () => score(page, blank));
    expect(armed).toBe(0);
    expect(after).toBeGreaterThan(0);
    // The helper restored "not set at all" rather than the empty string.
    expect(process.env.MARK_BASELINE_DILATE).toBe(before);
  });
});
