import { orderQuadPoints, type Point, type QuadRejection } from './perspectiveCorrect';

/**
 * Live capture guidance -- the arithmetic only.
 *
 * Everything here is pure: no `cv`, no DOM, no worker. That is deliberate and
 * it is the reason this file exists separately from the panel. Three of the
 * four things this module computes (the frame <-> display transform, the
 * roll/keystone/coverage read of a quad, and the strided exposure read of a
 * frame) are exactly the kind of thing this project has already measured wrong
 * four times by instrumenting the wrong stage (CLAUDE.md §2), and a unit test
 * is the only cheap way to pin them down. `cv` cannot be imported into vitest
 * at all -- the 10MB transform hangs the runner -- so anything that needs it
 * lives in the worker or in a standalone Node script instead.
 *
 * Design: Task/CAPTURE_GUIDANCE_2026-08-27.md §3-§5, §7, and §11.3 for the
 * exposure half.
 *
 * EVERY THRESHOLD IN THIS FILE IS PROVISIONAL. CAPTURE_GUIDANCE §8 lists the
 * measurements that would settle them and none of them has been run. They are
 * drafts drawn from the 26 successful quads in §4/§5.2, not validated cuts.
 */

// --- coordinate mapping -----------------------------------------------------

export type ObjectFit = 'cover' | 'contain';

/**
 * The single transform between video-frame pixels and on-screen pixels.
 *
 * CAPTURE_GUIDANCE §4.2 is blunt about why this is one object and not two
 * pieces of arithmetic in two components: the guide rectangle and the detected
 * polygon must be drawn through the SAME mapping, or the user aims at a box
 * that does not correspond to what the gate measures. `object-fit` decides
 * whether the frame is cropped (`cover`, scale = max) or letterboxed
 * (`contain`, scale = min) inside the element's box.
 */
export interface VideoBoxMapping {
  frameWidth: number;
  frameHeight: number;
  displayWidth: number;
  displayHeight: number;
  /** frame px -> display px. */
  scale: number;
  /** Display-space position of frame origin. Negative under `cover`. */
  offsetX: number;
  offsetY: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeVideoBoxMapping(
  frameWidth: number,
  frameHeight: number,
  displayWidth: number,
  displayHeight: number,
  fit: ObjectFit = 'contain',
): VideoBoxMapping | null {
  if (
    !Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) ||
    !Number.isFinite(displayWidth) || !Number.isFinite(displayHeight) ||
    frameWidth <= 0 || frameHeight <= 0 || displayWidth <= 0 || displayHeight <= 0
  ) {
    return null;
  }

  const scaleX = displayWidth / frameWidth;
  const scaleY = displayHeight / frameHeight;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  return {
    frameWidth,
    frameHeight,
    displayWidth,
    displayHeight,
    scale,
    offsetX: (displayWidth - frameWidth * scale) / 2,
    offsetY: (displayHeight - frameHeight * scale) / 2,
  };
}

export function mapFrameToDisplay(mapping: VideoBoxMapping, point: Point): Point {
  return {
    x: mapping.offsetX + point.x * mapping.scale,
    y: mapping.offsetY + point.y * mapping.scale,
  };
}

export function mapDisplayToFrame(mapping: VideoBoxMapping, point: Point): Point {
  return {
    x: (point.x - mapping.offsetX) / mapping.scale,
    y: (point.y - mapping.offsetY) / mapping.scale,
  };
}

export function mapQuadToDisplay(mapping: VideoBoxMapping, points: Point[]): Point[] {
  return points.map((point) => mapFrameToDisplay(mapping, point));
}

export function mapRectToDisplay(mapping: VideoBoxMapping, rect: Rect): Rect {
  const topLeft = mapFrameToDisplay(mapping, { x: rect.left, y: rect.top });
  return {
    left: topLeft.x,
    top: topLeft.y,
    width: rect.width * mapping.scale,
    height: rect.height * mapping.scale,
  };
}

// --- guide rectangle --------------------------------------------------------

/**
 * height / width of the sheet. 656 / 474 = 1.3840 from
 * `cagiTemplate.baseSize`, which is also the `expectedAspectRatio` the gate is
 * given, so the guide and the gate describe the same shape.
 */
export const GUIDE_ASPECT_RATIO = 1.384;

/**
 * PROVISIONAL (CAPTURE_GUIDANCE §4.1). The 26 corrected quads covered 0.632 to
 * 0.922 of the frame, median 0.806-0.834, with the gate floor at 0.60 and the
 * margin floor at 0.02. 0.78 sits inside that band with ~0.11 margin per side
 * -- five times the floor -- so a user who fills the guide satisfies coverage,
 * margin and aspect at once rather than balancing on one of them.
 */
export const GUIDE_SHORT_EDGE_FILL = 0.78;

/**
 * The guide box, in whatever coordinate space `width`/`height` are given in.
 * Call it with FRAME dimensions and push the result through
 * `mapRectToDisplay`: coverage and margin are measured against the frame, so a
 * guide defined in display pixels would ask for the wrong thing wherever the
 * element crops or letterboxes the frame (CAPTURE_GUIDANCE §4.2).
 */
export function computeGuideRect(
  width: number,
  height: number,
  aspectRatio: number = GUIDE_ASPECT_RATIO,
  fill: number = GUIDE_SHORT_EDGE_FILL,
): Rect | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0 || !Number.isFinite(fill) || fill <= 0) {
    return null;
  }

  // The rectangle fills `fill` of the SHORT edge of the frame: on a portrait
  // frame that is its width, on a landscape frame its height.
  let rectWidth: number;
  let rectHeight: number;
  if (width <= height) {
    rectWidth = width * fill;
    rectHeight = rectWidth * aspectRatio;
  } else {
    rectHeight = height * fill;
    rectWidth = rectHeight / aspectRatio;
  }

  // A near-square frame can push the portrait box past the long edge; shrink
  // it rather than let the guide leave the picture.
  const overflow = Math.max(rectWidth / width, rectHeight / height);
  if (overflow > 1) {
    rectWidth /= overflow;
    rectHeight /= overflow;
  }

  return {
    left: (width - rectWidth) / 2,
    top: (height - rectHeight) / 2,
    width: rectWidth,
    height: rectHeight,
  };
}

// --- quad geometry ----------------------------------------------------------

export interface QuadGeometry {
  /** Degrees. 0 when the sheet's top and bottom edges are level on screen. */
  rollDeg: number;
  /** (bottom - top) / max. Positive means the TOP edge is farther from the camera. */
  keystoneV: number;
  /** (right - left) / max. Positive means the LEFT edge is farther from the camera. */
  keystoneH: number;
  coverageW: number;
  coverageH: number;
  /** Smallest of the four bounding-box margins, as a fraction of the frame. */
  marginMin: number;
  /** Mean height / mean width, same definition the gate uses. */
  aspectRatio: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * CAPTURE_GUIDANCE §5.2, verbatim: nothing new is estimated, the four ordered
 * corners already carry both tilts. The signs are the whole point -- they turn
 * "it is tilted" into "lower the top edge".
 */
export function computeQuadGeometry(
  points: Point[],
  frameWidth: number,
  frameHeight: number,
): QuadGeometry | null {
  if (!points || points.length !== 4 || frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }

  const [topLeft, topRight, bottomRight, bottomLeft] = orderQuadPoints(points);

  const rollDeg = ((Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x)
    + Math.atan2(bottomRight.y - bottomLeft.y, bottomRight.x - bottomLeft.x)) / 2) * (180 / Math.PI);

  const topWidth = distance(topLeft, topRight);
  const bottomWidth = distance(bottomLeft, bottomRight);
  const leftHeight = distance(topLeft, bottomLeft);
  const rightHeight = distance(topRight, bottomRight);

  const widthDenominator = Math.max(topWidth, bottomWidth);
  const heightDenominator = Math.max(leftHeight, rightHeight);
  const keystoneV = widthDenominator > 0 ? (bottomWidth - topWidth) / widthDenominator : 0;
  const keystoneH = heightDenominator > 0 ? (rightHeight - leftHeight) / heightDenominator : 0;

  const xs = [topLeft.x, topRight.x, bottomRight.x, bottomLeft.x];
  const ys = [topLeft.y, topRight.y, bottomRight.y, bottomLeft.y];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  const averageWidth = (topWidth + bottomWidth) / 2;
  const averageHeight = (leftHeight + rightHeight) / 2;

  return {
    rollDeg,
    keystoneV,
    keystoneH,
    coverageW: (right - left) / frameWidth,
    coverageH: (bottom - top) / frameHeight,
    marginMin: Math.min(
      left / frameWidth,
      1 - right / frameWidth,
      top / frameHeight,
      1 - bottom / frameHeight,
    ),
    aspectRatio: averageWidth > 0 ? averageHeight / averageWidth : 0,
  };
}

// --- frame exposure ---------------------------------------------------------

/**
 * Live tone, the half of §3's table that was never built.
 *
 * CAPTURE_GUIDANCE §11.2: everything above this line is geometry, and geometry
 * is the solved problem (rectification is 38/38, FEATURE_SPEC §7). The open one
 * is exposure -- the zero-yield photo sheets are badly underexposed, their
 * printed circles gone along with the marks (FEATURE_SPEC §12.2) -- and the
 * overlay says nothing about it.
 *
 * `dynamicRange = p95 - p05` is the signal §11.3 picks, for one reason that
 * matters here: it is a property of the photograph ALONE. No template, no blank
 * asset, no registration frame -- so a single preview frame is enough to
 * compute it, which is not true of `offset82`/`offset95` next to it in
 * sheetExposure.ts.
 *
 * GUIDANCE, NEVER A VERDICT. Nothing below refuses, blocks or gates anything;
 * it changes one sentence beside the preview. Being wrong here costs one
 * retake, which is why it could ship on lighter evidence than the sheet-quality
 * verdict -- and that verdict deliberately does NOT use this signal
 * (FEATURE_SPEC §13.3: the cut is above its shuffled-label control but only by
 * two students out of nineteen, so it stays reporting-only until M6).
 *
 * AND THE SENTENCE IS CURRENTLY OFF. CAPTURE_GUIDANCE §13 measured this code on
 * preview-scale frames and found no signal there at all; the reading survives
 * as an instrument, the hint does not fire. `LIVE_EXPOSURE_HINT_ENABLED` below
 * carries the evidence. "Cheaper to be wrong" is a reason to accept a weaker
 * threshold, not a reason to accept one measured to be absent.
 */

/**
 * The low percentile of the pair.
 *
 * DELIBERATE DUPLICATE of `SHEET_EXPOSURE_FLOOR_FRACTION` in
 * src/lib/recognition/sheetExposure.ts, which is where the number was chosen.
 * It is not imported because that module reaches markDensity.ts, whose first
 * line is `import sharp from 'sharp'` -- a native, server-only binary. Pulling
 * it in here would drag it into the browser bundle AND into the OpenCV worker,
 * which is where this measurement actually runs. tests/frame-exposure.test.ts
 * imports both constants and asserts they are equal, so the duplicate cannot
 * drift silently.
 */
export const FRAME_EXPOSURE_FLOOR_FRACTION = 0.05;

/** The high percentile. Matches the p95 sheetExposure's `dynamicRange` uses. */
export const FRAME_EXPOSURE_CEILING_FRACTION = 0.95;

/**
 * Roughly how many frame positions the strided pass visits, before the region
 * test throws away the ones outside the sheet.
 *
 * Derived rather than fixed so the sample count does not move when
 * `LIVE_DETECT_LONG_SIDE` moves. At the current 480 budget a portrait frame is
 * 368x480 = 176,640 px, so the stride comes out at 3 and the pass visits
 * 123x160 = 19,680 positions; a quad covering the §4.1 median area keeps around
 * 12,000 of them, leaving ~600 above p95. That is a coarse read, which is all
 * this needs -- it decides one sentence, not a value.
 *
 * The stride is a subsample of the frame's pixels, NOT an average of them: an
 * average would pull the two tails toward the middle and `dynamicRange` is
 * nothing but the distance between those tails.
 */
export const FRAME_EXPOSURE_TARGET_SAMPLES = 20000;

/**
 * UNVALIDATED AT PREVIEW SCALE. Kept so the instrument keeps its units; NOT
 * currently used to say anything to anyone (see `LIVE_EXPOSURE_HINT_ENABLED`).
 *
 * CAPTURE_GUIDANCE §11.3 measured the split on the 19-student set: students who
 * yielded auto-filled cells came in at 155-182, students who yielded nothing at
 * 61-108, best single cut 17/19 against a shuffled-label p95 of 15. 130 is the
 * midpoint of that measured gap (108 -> 155), rounded to a round number.
 *
 * That split is from WARPED FINAL images. §13 has since measured the same
 * numbers on 480px preview-scale frames and 130 flags 19 students out of 19
 * there. Nothing about 130 survived; it is retained only because the device
 * session needs a named place to put the number it measures, and a constant
 * with a documented history is a better starting point than a bare 0.
 */
export const LIVE_DYNAMIC_RANGE_WARN = 130;

/**
 * The hint is OFF. This is the whole safety story of this module, so it is one
 * boolean and not a build flag, an env read or a prop.
 *
 * CAPTURE_GUIDANCE §13 took the 19 original photos, downscaled them to the live
 * 480px long side, ran THE SHIPPED detector and THE SHIPPED exposure code over
 * them (scripts/check-preview-exposure.cjs), and found:
 *
 *   - 130 flags 19 of 19 students, including all five whose photos actually
 *     yield auto-filled cells. A hint that fires on everyone is not guidance,
 *     it is noise, and it spends the credibility of the geometry hints next to
 *     it.
 *   - Moving the number does not rescue it. Under the project's permutation
 *     discipline preview `dynamicRange` scores 15/19 against a shuffled-label
 *     p95 of 15: chance. The signal §11.3 found on warped finals DOES NOT
 *     EXIST at this scale.
 *   - Mechanism, visible in the residuals: downscaling averages, and
 *     `dynamicRange` is nothing but the distance between two tails, so a
 *     well-exposed sheet with real ink detail loses 34-58 points while a dark
 *     one, having no detail to lose, barely moves. The downscale drags the good
 *     photos toward the bad ones.
 *   - A p05 cut scored 17/19 but selects exactly the students whose quad was
 *     detected -- it reads detection success, not exposure. Same leakage shape
 *     as FEATURE_SPEC §14.1. Rejected.
 *
 * The measurement below it all stays and keeps flowing into
 * `CaptureGuidanceStatus.exposure`: it is the instrument the device session
 * reads. What is switched off is the SENTENCE, because no threshold is
 * justified by this evidence.
 *
 * A device session flips this one boolean, once it has a threshold measured on
 * a real preview raster rather than on a downscaled still (§13.6: the downscale
 * isolates the raster term alone; a phone's preview has its own gain and white
 * balance on top).
 */
export const LIVE_EXPOSURE_HINT_ENABLED = false;

/**
 * Below this many samples the two tails are not a measurement.
 *
 * Derived, not fitted: p95 is read off the top 5% of the population, so 2000
 * samples put 100 of them above the cut. Fewer than that and the reading is
 * noise dressed as a number.
 *
 * IT IS NOT A REGION DISCRIMINATOR and must not be read as one. §13's
 * quad-locked frames gave 7,600-12,500 samples and its guide-region frames gave
 * 6,392 -- close enough that any count drawn between them would be fitted to
 * two runs. The `region === 'quad'` test is what keeps desk and floor out; this
 * floor only rejects a degenerate population (a sliver of a quad, a stride
 * larger than the region), and at 2000 it sits far below every real quad frame
 * measured so far, so it should never fire in practice.
 */
export const LIVE_EXPOSURE_MIN_SAMPLES = 2000;

/** Which area the samples came from. The two are NOT the same measurement. */
export type FrameExposureRegion = 'quad' | 'guide';

export interface FrameExposure {
  p05: number;
  p95: number;
  /** `p95 - p05`. §11.3's signal. */
  dynamicRange: number;
}

export interface FrameExposureSample extends FrameExposure {
  /**
   * `quad` means the samples are the sheet's own pixels. `guide` means no quad
   * had been found yet and the guide rectangle's interior stood in for it, so
   * the samples include whatever desk or floor the sheet does not cover --
   * a darker or lighter surround moves both tails. Callers that care about the
   * page's exposure specifically must check this.
   */
  region: FrameExposureRegion;
  sampleCount: number;
  stride: number;
}

/**
 * Percentile by histogram: an O(n) counting pass instead of an O(n log n) sort.
 *
 * The live loop runs every ~200ms and shares a thread with quad detection, so
 * it must not stall; sorting ~12,000 samples per frame to read two of them is
 * the wrong shape of work. `values` here are 8-bit, so 256 bins are exact.
 *
 * INDEX RULE COPIED FROM `percentile` IN markDensity.ts, deliberately: this
 * number is compared against measurements sheetExposure.ts took through that
 * function, and a half-open-interval disagreement would show up as a constant
 * offset nobody could trace. That rule is
 *
 *     sorted[min(n - 1, max(0, round((n - 1) * fraction)))]
 *
 * i.e. nearest-rank on a 0-based index, JS `Math.round` (halves up). The
 * equivalent statement over a histogram is: the smallest bin whose cumulative
 * count exceeds that index. Empty input returns 0, as it does there.
 */
export function percentileFromHistogram(
  histogram: Uint32Array | number[],
  count: number,
  fraction: number,
): number {
  if (count <= 0) {
    return 0;
  }

  const index = Math.min(count - 1, Math.max(0, Math.round((count - 1) * fraction)));
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    cumulative += histogram[bin];
    if (cumulative > index) {
      return bin;
    }
  }
  return histogram.length - 1;
}

/**
 * 256 bins over 8-bit values.
 *
 * Non-finite entries are dropped rather than binned, and the returned count
 * reflects that -- a NaN in the array would otherwise land in bin 0 and drag
 * p05 to black. Non-integer entries are rounded into a bin, which is the one
 * place this and markDensity's `percentile` can disagree; every caller here
 * feeds it 8-bit pixel values, where they cannot.
 */
export function buildGrayHistogram(gray: Uint8ClampedArray | number[]): {
  histogram: Uint32Array;
  count: number;
} {
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < gray.length; i++) {
    const value = gray[i];
    if (!Number.isFinite(value)) continue;
    histogram[Math.min(255, Math.max(0, Math.round(value)))] += 1;
    count += 1;
  }
  return { histogram, count };
}

/**
 * The measurement itself, over an already-extracted set of grey samples.
 *
 * Pure and shape-free on purpose: the region logic below and the tests both go
 * through this, so what the live loop reports and what a test hand-computes are
 * produced by the same arithmetic.
 */
export function measureFrameExposure(gray: Uint8ClampedArray | number[]): FrameExposure {
  const { histogram, count } = buildGrayHistogram(gray);
  const p05 = percentileFromHistogram(histogram, count, FRAME_EXPOSURE_FLOOR_FRACTION);
  const p95 = percentileFromHistogram(histogram, count, FRAME_EXPOSURE_CEILING_FRACTION);
  return { p05, p95, dynamicRange: p95 - p05 };
}

/** Stride that lands the whole-frame pass near `FRAME_EXPOSURE_TARGET_SAMPLES`. */
export function computeExposureStride(
  width: number,
  height: number,
  targetSamples: number = FRAME_EXPOSURE_TARGET_SAMPLES,
): number {
  if (!(width > 0) || !(height > 0) || !(targetSamples > 0)) {
    return 1;
  }
  return Math.max(1, Math.round(Math.sqrt((width * height) / targetSamples)));
}

/**
 * Rec.601 luma, the same weights `cv.cvtColor(..., COLOR_RGBA2GRAY)` uses two
 * functions away in the same worker.
 *
 * Worth being explicit that this is NOT bit-identical to the grey
 * sheetExposure.ts measures through: `sharp.grayscale()` is libvips, which
 * converts in linear light with Rec.709 weights. For a sheet of white paper and
 * black ink the difference is nil -- every neutral pixel has R = G = B and every
 * luma formula returns that same value -- but a coloured desk in the guide-rect
 * fallback would read slightly differently. It is a second-order term next to
 * the preview-versus-final gap `LIVE_DYNAMIC_RANGE_WARN` already carries.
 */
function lumaFromRgba(pixels: Uint8ClampedArray, offset: number): number {
  return Math.round(
    0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2],
  );
}

/** Crossing-number test. Four edges, no convexity assumed. */
function isInsidePolygon(polygon: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Exposure of the SHEET, not of the picture.
 *
 * CAPTURE_GUIDANCE §6.2 is the reason for the region test: outside the quad is
 * desk and floor, and the 19-student set was shot on a dark floor
 * (FEATURE_SPEC §12.2). Including it would let a dark background swamp a
 * correctly exposed page -- or, worse, a bright desk rescue an underexposed one.
 *
 * With no quad yet the guide rectangle's interior stands in. The user is being
 * asked to fill exactly that box, so it is the best available proxy, but it is
 * a DIFFERENT measurement and the returned `region` says which one ran.
 *
 * Returns null when the frame is unusable or no sample landed inside the
 * region; a missing measurement is reported as missing, not as zero.
 */
export function measureFrameExposureInRegion(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  quadPoints: Point[] | null,
): FrameExposureSample | null {
  if (!(width > 0) || !(height > 0) || pixels.length < width * height * 4) {
    return null;
  }

  const polygon = quadPoints && quadPoints.length === 4 ? orderQuadPoints(quadPoints) : null;
  const region: FrameExposureRegion = polygon ? 'quad' : 'guide';

  let left: number;
  let top: number;
  let right: number;
  let bottom: number;

  if (polygon) {
    const xs = polygon.map((point) => point.x);
    const ys = polygon.map((point) => point.y);
    left = Math.floor(Math.min(...xs));
    right = Math.ceil(Math.max(...xs));
    top = Math.floor(Math.min(...ys));
    bottom = Math.ceil(Math.max(...ys));
  } else {
    const guide = computeGuideRect(width, height);
    if (!guide) return null;
    left = Math.floor(guide.left);
    top = Math.floor(guide.top);
    right = Math.ceil(guide.left + guide.width);
    bottom = Math.ceil(guide.top + guide.height);
  }

  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(width, right);
  bottom = Math.min(height, bottom);
  if (right <= left || bottom <= top) {
    return null;
  }

  // One counting pass, straight into the bins: no intermediate sample array,
  // so the per-frame allocation is the fixed 256-entry histogram.
  const stride = computeExposureStride(width, height);
  const histogram = new Uint32Array(256);
  let count = 0;

  for (let y = top; y < bottom; y += stride) {
    const rowOffset = y * width;
    for (let x = left; x < right; x += stride) {
      if (polygon && !isInsidePolygon(polygon, x, y)) continue;
      histogram[lumaFromRgba(pixels, (rowOffset + x) * 4)] += 1;
      count += 1;
    }
  }

  if (count === 0) {
    return null;
  }

  const p05 = percentileFromHistogram(histogram, count, FRAME_EXPOSURE_FLOOR_FRACTION);
  const p95 = percentileFromHistogram(histogram, count, FRAME_EXPOSURE_CEILING_FRACTION);

  return { p05, p95, dynamicRange: p95 - p05, region, sampleCount: count, stride };
}

// --- thresholds -------------------------------------------------------------

/**
 * PROVISIONAL (CAPTURE_GUIDANCE §5.2, unvalidated -- §8-4 is the measurement
 * that would confirm it). The 26 corrected quads had `edgeConsistency` from
 * 0.814 with a median of 0.978, i.e. successes are almost head-on. 0.93 is
 * roughly 7% keystone.
 */
export const EDGE_CONSISTENCY_WARN = 0.93;

/** PROVISIONAL (CAPTURE_GUIDANCE §5.2, unvalidated -- see §8-4). */
export const ROLL_WARN_DEG = 4;

/**
 * Mirrors `MIN_PAGE_COVERAGE` / `MIN_FRAME_MARGIN` in perspectiveCorrect.ts.
 *
 * Note what this means in practice: `evaluateQuadDetailed` already refuses
 * anything below these, so a NON-NULL quality can never fail them. They are a
 * guard that keeps this reducer honest if the gate is ever loosened or if a
 * future detect path returns rejected quads with their points -- not the check
 * that drives the live "step closer" hint. That hint reaches the user through
 * `rejection === 'too-small'` instead.
 */
export const MIN_LIVE_COVERAGE = 0.6;
export const MIN_LIVE_MARGIN = 0.02;

// --- status reducer ---------------------------------------------------------

export interface LiveQuadQuality {
  points: Point[];
  confidence: number;
  edgeConsistency: number;
  aspectRatio: number;
}

export interface CaptureGuidanceInput {
  quality: LiveQuadQuality | null;
  rejection: QuadRejection | null;
  frameWidth: number;
  frameHeight: number;
  /**
   * Optional. Absent or null whenever the frame could not be measured -- the
   * worker was unavailable, the request timed out, no sample landed inside the
   * region. Guidance then degrades to what it said before this existed rather
   * than inventing a tone reading.
   */
  exposure?: FrameExposureSample | null;
  /**
   * Overrides `LIVE_EXPOSURE_HINT_ENABLED` for this call. Production never
   * passes it -- the panel calls the reducer without it, so the shipped
   * behaviour is the constant. It exists so the ON path stays under test while
   * it is switched off, which is the only way the device session's first flip
   * is not also the first time that branch has ever run.
   */
  exposureHintEnabled?: boolean;
}

export type CaptureGuidanceLevel = 'searching' | 'adjust' | 'ready';

export type CaptureGuidanceCode =
  | 'no-frame'
  | 'landscape'
  | 'searching'
  | 'cropped'
  | 'too-small'
  | 'wrong-shape'
  | 'not-a-quad'
  | 'margin'
  | 'coverage'
  | 'roll'
  | 'keystone-top'
  | 'keystone-bottom'
  | 'keystone-left'
  | 'keystone-right'
  | 'exposure'
  | 'ready';

export interface CaptureGuidanceStatus {
  level: CaptureGuidanceLevel;
  code: CaptureGuidanceCode;
  /** The one line shown beside the frame. Never the only signal -- see §4.2. */
  message: string;
  /** Secondary line, or null. */
  detail: string | null;
  geometry: QuadGeometry | null;
  /** Whatever was measured for this frame, whether or not it drove the status. */
  exposure: FrameExposureSample | null;
}

/**
 * F2.2's rejection -> instruction table. The panel's `retakeHintFor` and the
 * server verdict in sheetQuality.ts use the same strings; live guidance and
 * the post-capture prompt must not word the same fault two ways.
 */
export function rejectionHint(rejection: QuadRejection | null): string {
  if (rejection === 'cropped') return '종이의 네 모서리가 모두 화면 안에 들어오게 찍어주세요';
  if (rejection === 'too-small') return '종이가 화면을 더 채우도록 가까이서 찍어주세요';
  if (rejection === 'wrong-shape') return '종이 정면에서, 세로 방향으로 찍어주세요';
  return '종이가 배경과 구분되도록 어두운 바닥을 피해 다시 찍어주세요';
}

function rejectionCode(rejection: QuadRejection): CaptureGuidanceCode {
  return rejection;
}

/**
 * An axis-aligned sheet of aspect 1.384 cannot satisfy `MIN_PAGE_COVERAGE` on
 * BOTH axes inside a landscape frame -- 0.6 of the width already implies more
 * than the full height. So a landscape frame is not "hard to detect", it is
 * un-detectable, and saying so first is more useful than "looking for paper"
 * (CAPTURE_GUIDANCE §4.1). This also fires on a landscape desktop webcam,
 * where the same arithmetic holds.
 */
export function isLandscapeFrame(frameWidth: number, frameHeight: number): boolean {
  return frameWidth > frameHeight;
}

/**
 * Every condition the tone hint has to clear, in one place a test can call.
 *
 * Exported separately from the reducer so the ON state is exercisable without
 * an env read -- this code runs inside a browser worker, where `process.env`
 * does not exist and a build-time flag would not be inspectable from a unit
 * test either.
 *
 * The three guards, and why each is not redundant:
 *
 *   `enabled` -- §13. No threshold is justified by the evidence.
 *   `region === 'quad'` -- §13.3, and this is the one that was previously left
 *      to an ordering ARGUMENT rather than a check. The old comment said the
 *      region is always 'quad' by the time control reaches here, and today it
 *      is; FEATURE_SPEC §14.2 is what an over-read invariant costs when the
 *      call order later changes underneath it. The stakes are measured, not
 *      hypothetical: §13.3 found 14 of 19 frames fell to the guide region, and
 *      there the reading is not the paper's exposure at all -- one guide frame
 *      read 143 against 81 for a quad frame that actually yielded cells. It
 *      reads BACKWARDS, so this is a correctness guard, not belt-and-braces.
 *   `sampleCount` -- a population too thin for its own tails; see
 *      LIVE_EXPOSURE_MIN_SAMPLES, which is explicitly NOT a region proxy.
 */
export function shouldWarnOnExposure(
  exposure: FrameExposureSample | null | undefined,
  enabled: boolean = LIVE_EXPOSURE_HINT_ENABLED,
): boolean {
  if (!enabled || !exposure) return false;
  if (exposure.region !== 'quad') return false;
  if (exposure.sampleCount < LIVE_EXPOSURE_MIN_SAMPLES) return false;
  return exposure.dynamicRange < LIVE_DYNAMIC_RANGE_WARN;
}

export function evaluateCaptureGuidance(input: CaptureGuidanceInput): CaptureGuidanceStatus {
  const { quality, rejection, frameWidth, frameHeight } = input;
  const exposure = input.exposure ?? null;

  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    return {
      level: 'searching',
      code: 'no-frame',
      message: '카메라 화면을 준비하는 중',
      detail: null,
      geometry: null,
      exposure,
    };
  }

  if (isLandscapeFrame(frameWidth, frameHeight)) {
    return {
      level: 'adjust',
      code: 'landscape',
      message: '휴대폰을 세로로 들어주세요',
      detail: '가로 화면에서는 종이 전체가 인식 범위에 들어오지 않습니다',
      geometry: null,
      exposure,
    };
  }

  if (!quality) {
    if (rejection) {
      // A sheet-shaped candidate WAS seen and refused: name what to change.
      return {
        level: 'adjust',
        code: rejectionCode(rejection),
        message: rejectionHint(rejection),
        detail: null,
        geometry: null,
        exposure,
      };
    }

    return {
      level: 'searching',
      code: 'searching',
      message: '종이를 찾는 중',
      detail: '종이가 배경과 구분되게 놓아주세요',
      geometry: null,
      exposure,
    };
  }

  const geometry = computeQuadGeometry(quality.points, frameWidth, frameHeight);
  if (!geometry) {
    return {
      level: 'searching',
      code: 'searching',
      message: '종이를 찾는 중',
      detail: '종이가 배경과 구분되게 놓아주세요',
      geometry: null,
      exposure,
    };
  }

  // Order follows the gate's own precedence in `evaluateQuadDetailed`: running
  // off the frame is checked before distance, because it is the one fault a
  // person can act on without ambiguity.
  if (geometry.marginMin < MIN_LIVE_MARGIN) {
    return {
      level: 'adjust',
      code: 'margin',
      message: '종이 전체가 화면 안에 들어오게 해주세요',
      detail: null,
      geometry,
      exposure,
    };
  }

  if (geometry.coverageW < MIN_LIVE_COVERAGE || geometry.coverageH < MIN_LIVE_COVERAGE) {
    return {
      level: 'adjust',
      code: 'coverage',
      message: '조금 더 가까이',
      detail: '종이가 안내선을 채우도록 맞춰주세요',
      geometry,
      exposure,
    };
  }

  if (Math.abs(geometry.rollDeg) > ROLL_WARN_DEG) {
    return {
      level: 'adjust',
      code: 'roll',
      message: '화면과 나란히 돌려주세요',
      detail: null,
      geometry,
      exposure,
    };
  }

  if (quality.edgeConsistency < EDGE_CONSISTENCY_WARN) {
    // `edgeConsistency` says HOW MUCH; the individual keystone signs say WHICH
    // WAY. The larger of the two decides the sentence (§5.2).
    const vertical = Math.abs(geometry.keystoneV) >= Math.abs(geometry.keystoneH);
    if (vertical) {
      return geometry.keystoneV >= 0
        ? { level: 'adjust', code: 'keystone-top', message: '위쪽을 조금 낮춰주세요', detail: null, geometry, exposure }
        : { level: 'adjust', code: 'keystone-bottom', message: '아래쪽을 조금 낮춰주세요', detail: null, geometry, exposure };
    }

    return geometry.keystoneH >= 0
      ? { level: 'adjust', code: 'keystone-left', message: '카메라를 왼쪽으로 조금 옮겨주세요', detail: null, geometry, exposure }
      : { level: 'adjust', code: 'keystone-right', message: '카메라를 오른쪽으로 조금 옮겨주세요', detail: null, geometry, exposure };
  }

  // LAST, and only once the geometry is otherwise green (CAPTURE_GUIDANCE
  // §11.2 asks for the tone hint, not for it to elbow ahead of the framing
  // hints). A frame that is dark AND badly framed reports the framing: the
  // person can see the edges of their own paper in the preview and cannot see
  // that it is underexposed, but re-aiming is still the nearer fix, and two
  // instructions at once is one instruction too many.
  //
  // OFF by default (§13). Note where this sits: `nextReadyStreak` resets on any
  // level that is not 'ready', so a branch taken here does not merely add a
  // sentence -- it makes 지금 촬영하세요 and the shutter emphasis unreachable on
  // that frame. With §13's numbers (19/19 flagged) an ungated branch would have
  // removed the shutter affordance on every sheet, permanently.
  if (shouldWarnOnExposure(exposure, input.exposureHintEnabled)) {
    return {
      level: 'adjust',
      code: 'exposure',
      message: '밝은 곳에서 다시 찍어주세요',
      detail: '화면이 어둡습니다 — 그림자를 피해주세요',
      geometry,
      exposure,
    };
  }

  return {
    level: 'ready',
    code: 'ready',
    message: '지금 촬영하세요',
    detail: null,
    geometry,
    exposure,
  };
}

/**
 * PROVISIONAL. Three consecutive green detections (~0.6s at the §7 target
 * rate) before the shutter is emphasised, so a single lucky frame does not
 * flash the button. This only CHANGES EMPHASIS -- capture is never blocked,
 * because the detector can be wrong and a hard block strands the user with a
 * sheet it refuses to see.
 */
export const READY_STREAK_FOR_SHUTTER = 3;

export function nextReadyStreak(previous: number, status: CaptureGuidanceStatus): number {
  return status.level === 'ready' ? previous + 1 : 0;
}
