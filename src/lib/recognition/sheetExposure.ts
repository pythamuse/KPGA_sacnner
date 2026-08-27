import {
  applyTemplateRegistrationFrame,
  getRegistrationBounds,
  loadImageAnalysisData,
  percentile,
  sampleRect,
  type ImageAnalysisData,
} from './markDensity';
import { loadBlankFormBaseline } from './templateBaseline';
import { getTemplate, type FormType } from './roiTemplates';

/**
 * Sheet-level exposure, measured against the blank template (spec §12.3, unit
 * W-B).
 *
 * WHY THIS EXISTS
 * ---------------
 * §12.2 measured the zero-yield photo sheets and found the winning boxes
 * *emptier than the blank form* — the printed circle itself had vanished, not
 * only the student's mark. The one cell-level number that separated those
 * sheets was `brightnessOffset`: median 44 on the zero-yield side but reaching
 * 185, against at most 61 among the productive sheets.
 *
 * That number falls out of per-candidate scoring inside `markDensity`, which
 * means it only exists *after* recognition has run — far too late to ask the
 * person holding the paper to take the photo again. This module computes the
 * same comparison at sheet level, from the stored image plus the committed
 * blank asset, so it can be asked at upload time.
 *
 * WHAT IS THE SAME AS THE SCORER, AND WHAT IS NOT
 * -----------------------------------------------
 * Same: the two primitives. `sampleRect` and `percentile` are imported from
 * markDensity rather than re-implemented, so the resampling and the
 * percentile-index rule cannot drift from the scorer's. `offset82` is
 * `percentile(blank, 0.82) - percentile(actual, 0.82)` — character for
 * character the scorer's `brightnessOffset` — and `offset95` matches
 * `measureBrightnessReference`'s.
 *
 * Different: the SCOPE. The scorer takes its percentiles over ONE candidate
 * cell, resampled to a 36x28 grid. There is no cell here, so this takes them
 * over the REGISTERED CONTENT AREA — `getRegistrationBounds`, i.e. the
 * template registration frame that `applyTemplateRegistrationFrame` measured,
 * falling back to the whole bitmap when that frame was refused. The page is
 * resampled onto a fixed grid exactly the way a cell is (fixed sample counts,
 * aspect-agnostic, same `sampleRect`), so the two images are compared
 * position for position through their own registration frames.
 *
 * This is a MEASUREMENT MODULE. It reads; it never changes a recognized
 * value, a gate or a threshold, and nothing in it is on the recognition path.
 */

/**
 * The page's resample grid, the analogue of the scorer's 36x28 per cell.
 *
 * Fixed rather than aspect-derived, because `sampleRect` is aspect-agnostic
 * and the scorer's grid is fixed too: what the percentile needs is a uniform
 * spatial sample of the registered area, and 288x384 = 110,592 samples gives
 * the tail (p95) enough population to be stable while staying cheap to sort.
 */
export const SHEET_EXPOSURE_SAMPLE_WIDTH = 288;
export const SHEET_EXPOSURE_SAMPLE_HEIGHT = 384;

/**
 * The dark end of `dynamicRange`. The bright end is p95, which the scorer
 * already defines; this is the matching low percentile, far enough from 0 not
 * to be a single dust speck.
 */
export const SHEET_EXPOSURE_FLOOR_FRACTION = 0.05;

export interface SheetExposureMeasurement {
  /** 82nd percentile of the uploaded sheet over the registered content area. */
  actualP82: number;
  /** 82nd percentile of the blank template over its own registered content area. */
  blankP82: number;
  /**
   * `blankP82 - actualP82`. Identical in definition to the scorer's
   * `brightnessOffset`, at sheet scope: how far the linear brightness shift
   * would have to move this page to put its paper where the blank's paper is.
   * §12.2's candidate signal.
   */
  offset82: number;
  actualP95: number;
  blankP95: number;
  /** `blankP95 - actualP95`, the scorer's `offset95` at sheet scope. */
  offset95: number;
  /**
   * p95 - p5 of the uploaded sheet alone (no blank involved): the width of the
   * tonal range the linear shift has to work inside. §12.2's mechanism is that
   * a large offset applied to a COMPRESSED range carries the marks over the
   * ink threshold along with the paper, so the two numbers are only
   * interpretable together.
   */
  dynamicRange: number;
}

/**
 * The exposure comparison itself: two registered images in, seven numbers out.
 *
 * Exported for tests that need to hold the frame fixed while changing only
 * the pixels; production callers use the two wrappers below.
 */
export function compareSheetExposure(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels' | 'contentBounds'>,
  blank: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels' | 'contentBounds'>,
): SheetExposureMeasurement {
  const actual = sampleRect(
    image,
    getRegistrationBounds(image),
    SHEET_EXPOSURE_SAMPLE_WIDTH,
    SHEET_EXPOSURE_SAMPLE_HEIGHT,
  );
  const blankSamples = sampleRect(
    blank,
    getRegistrationBounds(blank),
    SHEET_EXPOSURE_SAMPLE_WIDTH,
    SHEET_EXPOSURE_SAMPLE_HEIGHT,
  );

  const actualP82 = percentile(actual, 0.82);
  const blankP82 = percentile(blankSamples, 0.82);
  const actualP95 = percentile(actual, 0.95);
  const blankP95 = percentile(blankSamples, 0.95);

  return {
    actualP82,
    blankP82,
    offset82: blankP82 - actualP82,
    actualP95,
    blankP95,
    offset95: blankP95 - actualP95,
    dynamicRange: actualP95 - percentile(actual, SHEET_EXPOSURE_FLOOR_FRACTION),
  };
}

/**
 * Measures a sheet that is already loaded and registered.
 *
 * `evaluateSheetQuality` uses this one: it has the registered image in hand
 * already, and re-loading it would double the sharp decode and the paper-bounds
 * search for nothing.
 *
 * Returns null when the blank asset cannot be read — `loadBlankFormBaseline`
 * swallows its own failures, and an exposure figure with no reference is not a
 * smaller measurement, it is a different one.
 */
export async function measureSheetExposureForImage(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels' | 'contentBounds'>,
  formType: FormType,
): Promise<SheetExposureMeasurement | null> {
  const baseline = await loadBlankFormBaseline(formType);
  if (!baseline) {
    return null;
  }
  return compareSheetExposure(image, baseline.image);
}

/**
 * Measures one stored sheet without running recognition.
 *
 * The load path is recognition's own (`loadImageAnalysisData` then
 * `applyTemplateRegistrationFrame`), so the frame this measures through is the
 * frame recognition would have measured through.
 */
export async function measureSheetExposure(
  imagePath: string,
  formType: FormType,
): Promise<SheetExposureMeasurement | null> {
  const template = getTemplate(formType);
  const image = applyTemplateRegistrationFrame(
    await loadImageAnalysisData(imagePath),
    template.registrationFrame,
  );
  return measureSheetExposureForImage(image, formType);
}
