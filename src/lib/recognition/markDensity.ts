import sharp from 'sharp';
import { ChoiceGroup, NormalizedRect } from './roiTemplates';

export type ContentBoundsSource = 'frame' | 'paper' | 'template' | 'dark';

export interface ImageAnalysisData {
  /**
   * Why the template registration frame was not applied, when it was not.
   *
   * The blank asset resolves its content bounds through the template path and
   * the uploads resolve theirs through the paper path, so the subtraction
   * normalises the two images through frames measured two different ways. Both
   * go through `applyTemplateRegistrationFrame`, so on the uploads it is
   * declining, and it used to decline silently. This names the guard that
   * refused and the numbers it refused on.
   */
  contentBoundsRejection?: string;
  width: number;
  height: number;
  pixels: Buffer;
  contentBounds?: PixelBounds;
  contentBoundsSource?: ContentBoundsSource;
  pageBounds?: PixelBounds;
  contentBoundsConfident: boolean;
  /** Whole-page quality measurements kept for the offline training export. */
  pageInkRatio?: number;
  pageIsBinarySource?: boolean;
}

export interface PixelBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CandidateScore {
  value: number | string;
  score: number;
}

/**
 * Candidate-level measurements used by the offline label exporter.
 *
 * These are observations made after the existing scoring calculation. They
 * are deliberately separate from CandidateScore so the review response keeps
 * its existing small candidate shape.
 */
export interface CandidateMeasurement {
  candidateIndex: number;
  score: number;
  actualInk: number | null;
  baselineInk: number | null;
  brightnessOffset: number | null;
  alignX: number | null;
  alignY: number | null;
  largestComponentSize: number | null;
  largestComponentRatio: number | null;
  diagonalRatio: number | null;
}

export interface ChoiceGroupResult {
  field: string;
  value?: number | string;
  confidence: 'high' | 'medium' | 'low';
  candidates: CandidateScore[];
  /** Internal measurement outlet; removed before the API response is built. */
  candidateMeasurements?: CandidateMeasurement[];
  /**
   * Why this group landed where it did, as numbers and fixed labels only. See
   * `describeDecision`. Nothing in this string comes from the scanned page
   * except scores, so a student's answers cannot travel through it.
   */
  decision: string;
}

export interface ChoiceGroupBaseline {
  image: ImageAnalysisData;
  candidatePixelOverrides: PixelRect[];
}

interface TemplateInkShape {
  largestComponentSize: number;
  largestComponentRatio: number;
  diagonalRatio: number;
}

interface TemplateInkFeatures extends TemplateInkShape {
  score: number;
  /** Mean darkness of the uploaded cell, after brightness normalisation. */
  actualInk: number;
  /** Mean darkness of the same cell on the blank form. */
  baselineInk: number;
  brightnessOffset: number;
  alignX: number;
  alignY: number;
  /**
   * Source pixels per sample, for the page and for the blank form. The
   * alignment search moves in whole samples, so these say how far it can
   * physically reach: a cell whose pitch is below 1 cannot have a
   * one-pixel registration error corrected at all.
   */
  pagePitchX: number;
  pagePitchY: number;
  blankPitchX: number;
  blankPitchY: number;
  /** The reach the search was actually given for this cell, per axis. */
  radiusX: number;
  radiusY: number;
  /** Steps per sample the offset was resolved to, per axis. */
  stepsX: number;
  stepsY: number;
  /** Mean disagreement per sample once the baseline was placed. */
  fit: number;
  /** Brightness-reference alternatives, measured only while tracing. */
  brightnessProbe?: BrightnessReferenceProbe;
  /** The inset 8x8 residual used by the direct checkbox gate, measured only while tracing. */
  insetSignal?: number;
  /** Where a much wider search would have gone. Only measured while tracing. */
  probe?: { x: number; y: number; fit: number; chosenFit: number; radius: number };
  /** What the leftover disagreement is made of. Only measured while tracing. */
  composition?: ResidualComposition;
  /**
   * Where the *printed* ink sits inside this cell on the blank form. Only
   * measured while tracing.
   *
   * This is the property that separates the two ways these forms are marked,
   * without naming a field. A basic-info checkbox is an empty printed square,
   * so its ink is all perimeter and a hand check lands in the middle. A CAGI
   * or satisfaction cell holds a printed glyph, so its ink is central and the
   * hand circle is drawn around the outside. Weighting the centre helps the
   * first and actively hurts the second, which is how a centre-weighted score
   * once turned CORRECT 108 into 101 with three wrong answers.
   */
  blankGeometry?: BlankInkGeometry;
}

interface BrightnessReferenceProbe {
  actualP82: number;
  blankP82: number;
  actualP95: number;
  blankP95: number;
  offset95: number;
  score95: number;
}

interface ScoredCandidate extends CandidateScore {
  shape?: TemplateInkFeatures;
  candidateIndex: number;
  /** Position in the group as the template lists it, 1-based, before sorting. */
  position: number;
  /**
   * Where the cell sits across the content envelope, 0 at the left edge and 1
   * at the right. A normalisation that disagrees about the page's width puts
   * the baseline further out of place the further from the anchored edge a
   * cell sits, so a fit that worsens with this is that error showing.
   */
  atX: number;
}

/**
 * How far the best option must outscore the runner-up, as a multiple, before a
 * baseline-backed group may be confirmed automatically. See `analyzeChoiceGroup`
 * for why an absolute gap cannot carry this decision.
 */
const HIGH_RELATIVE_CONTRAST = 1.25;

/**
 * Minimum residual ink a baseline-backed option must carry before it may be
 * confirmed at all. Chosen as the lowest value that removes the measured wrong
 * answer (its winning score was 0.0200) while costing the fewest correct ones:
 * 0.021 gives CORRECT 102 WRONG 0, where 0.023 drops to 99 and 0.026 to 97.
 */
const HIGH_ABSOLUTE_SIGNAL = 0.021;

/**
 * The shape a residual has to have before it counts as a pen mark rather than
 * leftover print. Hoisted from `hasStructuredTemplateMark` so the decision
 * trace can report each sub-test against the value it was actually compared
 * with; the values are unchanged.
 */
const STRUCTURED_MARK_MIN_COMPONENT = 7;
const STRUCTURED_MARK_MIN_COMPONENT_RATIO = 0.2;
const STRUCTURED_MARK_MIN_DIAGONAL_RATIO = 0.2;

export async function loadImageAnalysisData(filePath: string): Promise<ImageAnalysisData> {
  const { data: pixels, info } = await sharp(filePath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  if (width <= 0 || height <= 0) {
    throw new Error('이미지 크기를 읽을 수 없습니다.');
  }

  const image = { width, height, pixels };
  const pageBounds = detectPaperBounds(image);
  // A dark printed border can split an otherwise white scan into separate
  // bright components. In that case the largest bright component is the
  // *inside* of the form, and searching only inside it hides the actual outer
  // frame. Retry against the full bitmap before falling back to dark-pixel
  // bounds. The frame validator still rejects internal response tables.
  const frameBounds = detectFrameBounds(image, pageBounds || undefined)
    || (pageBounds ? detectFrameBounds(image) : null);
  const paperContentBounds = pageBounds
    ? detectPaperContentBounds(image, pageBounds)
    : null;
  const darkBounds = detectDarkPixelBounds(image);

  // A form can contain several large internal tables. The whole printed
  // envelope inside the detected sheet is the stable template coordinate
  // system; an internal table frame is only a fallback when that envelope
  // cannot be measured.
  const contentBounds = paperContentBounds || frameBounds || darkBounds;
  const contentBoundsSource: ContentBoundsSource = paperContentBounds
    ? 'paper'
    : frameBounds
      ? 'frame'
      : 'dark';
  const pageQuality = calculatePageQuality(pixels);

  return {
    width,
    height,
    pixels,
    contentBounds,
    contentBoundsSource,
    pageBounds: pageBounds || undefined,
    contentBoundsConfident: paperContentBounds !== null || frameBounds !== null,
    ...pageQuality,
  };
}

/**
 * Measures the submitted raster without changing any recognition input.
 * `sharp` has already flattened and grayscaled the source here, so the
 * intermediate-pixel ratio is the quality signal available to the server for
 * deciding whether the source was effectively bilevel.
 */
function calculatePageQuality(pixels: Buffer): {
  pageInkRatio: number;
  pageIsBinarySource: boolean;
} {
  if (pixels.length === 0) {
    return { pageInkRatio: 0, pageIsBinarySource: true };
  }

  let inkPixels = 0;
  let intermediatePixels = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels[index];
    if (pixel < 200) inkPixels += 1;
    if (pixel !== 0 && pixel !== 255) intermediatePixels += 1;
  }

  const intermediateRatio = intermediatePixels / pixels.length;
  return {
    pageInkRatio: inkPixels / pixels.length,
    // A small amount of anti-aliasing/compression residue is still compatible
    // with a scanned 1-bit source. The ratio, rather than a single pixel,
    // keeps the quality flag stable on real uploaded pages.
    pageIsBinarySource: intermediateRatio <= 0.01,
  };
}

/**
 * Registers a known form to the measured printed-content frame of its blank
 * template. The raw dark-pixel envelope remains useful for diagnostics, but
 * phone-photo shadows and objects on the sheet must not redefine the
 * coordinate system used by a known form.
 */
export function applyTemplateRegistrationFrame(
  image: ImageAnalysisData,
  registrationFrame?: NormalizedRect,
): ImageAnalysisData {
  if (!registrationFrame) {
    return { ...image, contentBoundsRejection: 'no-registration-frame' };
  }
  if (!image.pageBounds) {
    return { ...image, contentBoundsRejection: 'no-page-bounds' };
  }
  if (!isPlausiblePaperBounds(image, image.pageBounds)) {
    const page = image.pageBounds;
    const pw = (page.right - page.left) / image.width;
    const ph = (page.bottom - page.top) / image.height;
    const ar = (page.bottom - page.top) / Math.max(page.right - page.left, 1);
    return {
      ...image,
      contentBoundsRejection: `implausible-page(w=${pw.toFixed(3)}/0.550`
        + ` h=${ph.toFixed(3)}/0.620 ar=${ar.toFixed(3)}/[1.05,1.90])`,
    };
  }

  const page = image.pageBounds;
  const pageWidth = page.right - page.left;
  const pageHeight = page.bottom - page.top;
  const contentBounds: PixelBounds = {
    left: clamp(Math.round(page.left + registrationFrame.x * pageWidth), 0, image.width - 1),
    top: clamp(Math.round(page.top + registrationFrame.y * pageHeight), 0, image.height - 1),
    right: clamp(Math.round(page.left + (registrationFrame.x + registrationFrame.width) * pageWidth), 1, image.width),
    bottom: clamp(Math.round(page.top + (registrationFrame.y + registrationFrame.height) * pageHeight), 1, image.height),
  };

  if (contentBounds.right <= contentBounds.left + 1 || contentBounds.bottom <= contentBounds.top + 1) {
    return { ...image, contentBoundsRejection: 'degenerate-frame' };
  }
  if (!isPlausibleTemplateContentBounds(page, contentBounds)) {
    const cw = (contentBounds.right - contentBounds.left) / Math.max(page.right - page.left, 1);
    const ch = (contentBounds.bottom - contentBounds.top) / Math.max(page.bottom - page.top, 1);
    const ar = (contentBounds.bottom - contentBounds.top)
      / Math.max(contentBounds.right - contentBounds.left, 1);
    const inside = contentBounds.left >= page.left && contentBounds.top >= page.top
      && contentBounds.right <= page.right && contentBounds.bottom <= page.bottom;
    return {
      ...image,
      contentBoundsRejection: `implausible-frame(inside=${inside ? 1 : 0}`
        + ` w=${cw.toFixed(3)}/0.550 h=${ch.toFixed(3)}/0.550`
        + ` ar=${ar.toFixed(3)}/[1.05,1.95])`,
    };
  }

  return {
    ...image,
    contentBounds,
    contentBoundsSource: 'template',
    contentBoundsConfident: true,
    contentBoundsRejection: undefined,
  };
}

export function calculateDarkPixelDensity(
  image: ImageAnalysisData,
  normalizedRect: NormalizedRect,
  darkThreshold = 150,
  yOverride?: { top: number; bottom: number },
  pixelOverride?: PixelRect,
): number {
  const bounds = getRegistrationBounds(image);
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const left = clamp(
    Math.floor(pixelOverride ? pixelOverride.left : bounds.left + normalizedRect.x * baseWidth),
    0,
    image.width - 1,
  );
  const top = clamp(
    Math.floor(pixelOverride ? pixelOverride.top : yOverride ? yOverride.top : bounds.top + normalizedRect.y * baseHeight),
    0,
    image.height - 1,
  );
  const right = clamp(
    Math.ceil(pixelOverride ? pixelOverride.right : bounds.left + (normalizedRect.x + normalizedRect.width) * baseWidth),
    left + 1,
    image.width,
  );
  const bottom = clamp(
    Math.ceil(pixelOverride ? pixelOverride.bottom : yOverride ? yOverride.bottom : bounds.top + (normalizedRect.y + normalizedRect.height) * baseHeight),
    top + 1,
    image.height,
  );

  let darkPixels = 0;
  let totalPixels = 0;

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const value = image.pixels[y * image.width + x];
      if (value < darkThreshold) {
        darkPixels++;
      }
      totalPixels++;
    }
  }

  return totalPixels === 0 ? 0 : darkPixels / totalPixels;
}

export function detectContentBounds(image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>): PixelBounds {
  const pageBounds = detectPaperBounds(image);
  const paperContentBounds = pageBounds
    ? detectPaperContentBounds(image, pageBounds)
    : null;
  if (paperContentBounds) {
    return paperContentBounds;
  }

  const frameBounds = detectFrameBounds(image, pageBounds || undefined);
  if (frameBounds) {
    return frameBounds;
  }

  return detectDarkPixelBounds(image);
}

/**
 * Finds the bright sheet before looking for printed ink. Phone photos often
 * include a dark desk, cable, or shadow that must never become part of the
 * normalized document coordinate system.
 */
export function detectPaperBounds(image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>): PixelBounds | null {
  const sampleWidth = Math.min(360, Math.max(1, Math.ceil(image.width / 8)));
  const sampleHeight = Math.min(520, Math.max(1, Math.ceil(image.height / 8)));
  const stepX = image.width / sampleWidth;
  const stepY = image.height / sampleHeight;

  let bestCandidate: { bounds: PixelBounds; area: number } | null = null;

  for (const threshold of [195, 170]) {
    const component = findLargestBrightComponent(
      image,
      sampleWidth,
      sampleHeight,
      stepX,
      stepY,
      threshold,
    );
    if (!component) {
      continue;
    }

    const bounds = {
      left: clamp(Math.floor(component.left * stepX), 0, image.width - 1),
      top: clamp(Math.floor(component.top * stepY), 0, image.height - 1),
      right: clamp(Math.ceil(component.right * stepX), 1, image.width),
      bottom: clamp(Math.ceil(component.bottom * stepY), 1, image.height),
    };

    if (isPlausiblePaperBounds(image, bounds) && (!bestCandidate || component.area > bestCandidate.area)) {
      bestCandidate = { bounds, area: component.area };
    }
  }

  return bestCandidate?.bounds || null;
}

function findLargestBrightComponent(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  sampleWidth: number,
  sampleHeight: number,
  stepX: number,
  stepY: number,
  threshold: number,
): { left: number; top: number; right: number; bottom: number; area: number } | null {
  const sampleCount = sampleWidth * sampleHeight;
  const bright = new Uint8Array(sampleCount);
  const visited = new Uint8Array(sampleCount);

  for (let sampleY = 0; sampleY < sampleHeight; sampleY++) {
    const pixelY = Math.min(image.height - 1, Math.floor((sampleY + 0.5) * stepY));
    for (let sampleX = 0; sampleX < sampleWidth; sampleX++) {
      const pixelX = Math.min(image.width - 1, Math.floor((sampleX + 0.5) * stepX));
      const index = sampleY * sampleWidth + sampleX;
      bright[index] = image.pixels[pixelY * image.width + pixelX] >= threshold ? 1 : 0;
    }
  }

  let largest: { left: number; top: number; right: number; bottom: number; area: number } | null = null;
  const queue: number[] = [];

  for (let start = 0; start < sampleCount; start++) {
    if (bright[start] === 0 || visited[start] !== 0) {
      continue;
    }

    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let area = 0;
    let left = sampleWidth;
    let right = 0;
    let top = sampleHeight;
    let bottom = 0;

    for (let cursor = 0; cursor < queue.length; cursor++) {
      const index = queue[cursor];
      const sampleX = index % sampleWidth;
      const sampleY = Math.floor(index / sampleWidth);
      area++;
      left = Math.min(left, sampleX);
      right = Math.max(right, sampleX + 1);
      top = Math.min(top, sampleY);
      bottom = Math.max(bottom, sampleY + 1);

      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = sampleX + offsetX;
          const nextY = sampleY + offsetY;
          if (nextX < 0 || nextY < 0 || nextX >= sampleWidth || nextY >= sampleHeight) continue;
          const next = nextY * sampleWidth + nextX;
          if (bright[next] === 0 || visited[next] !== 0) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
    }

    if (!largest || area > largest.area) {
      largest = { left, top, right, bottom, area };
    }
  }

  return largest;
}

function detectPaperContentBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  pageBounds: PixelBounds,
): PixelBounds | null {
  const bounds = detectDarkPixelBounds(image, pageBounds);
  const pageWidth = pageBounds.right - pageBounds.left;
  const pageHeight = pageBounds.bottom - pageBounds.top;
  const contentWidth = bounds.right - bounds.left;
  const contentHeight = bounds.bottom - bounds.top;
  const aspectRatio = contentHeight / contentWidth;

  if (
    contentWidth < pageWidth * 0.55
    || contentHeight < pageHeight * 0.6
    || aspectRatio < 1.05
    || aspectRatio > 1.9
  ) {
    return null;
  }

  return bounds;
}

function detectDarkPixelBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  searchBounds?: PixelBounds,
): PixelBounds {
  const darkThreshold = 220;
  const frame = searchBounds || { left: 0, top: 0, right: image.width, bottom: image.height };
  const frameWidth = frame.right - frame.left;
  const frameHeight = frame.bottom - frame.top;
  const minX = clamp(Math.floor(frame.left + frameWidth * 0.02), 0, image.width - 1);
  const maxX = clamp(Math.ceil(frame.right - frameWidth * 0.02), minX + 1, image.width);
  const minY = clamp(Math.floor(frame.top + frameHeight * 0.03), 0, image.height - 1);
  const maxY = clamp(Math.ceil(frame.bottom - frameHeight * 0.02), minY + 1, image.height);

  let left = maxX;
  let right = minX;
  let top = maxY;
  let bottom = minY;

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const value = image.pixels[y * image.width + x];
      if (value < darkThreshold) {
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + 1);
      }
    }
  }

  if (left >= right || top >= bottom) {
    return {
      left: frame.left,
      top: frame.top,
      right: frame.right,
      bottom: frame.bottom,
    };
  }

  const paddingX = Math.round((right - left) * 0.005);
  const paddingY = Math.round((bottom - top) * 0.005);

  return {
    left: clamp(left - paddingX, 0, image.width - 1),
    top: clamp(top - paddingY, 0, image.height - 1),
    right: clamp(right + paddingX, 1, image.width),
    bottom: clamp(bottom + paddingY, 1, image.height),
  };
}

function detectFrameBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  pageBounds?: PixelBounds,
): PixelBounds | null {
  const darkThreshold = 220;
  const reference = pageBounds || { left: 0, top: 0, right: image.width, bottom: image.height };
  const referenceWidth = reference.right - reference.left;
  const referenceHeight = reference.bottom - reference.top;
  const minX = clamp(Math.floor(reference.left + referenceWidth * 0.05), 0, image.width - 1);
  const maxX = clamp(Math.ceil(reference.right - referenceWidth * 0.05), minX + 1, image.width);
  const minY = clamp(Math.floor(reference.top + referenceHeight * 0.07), 0, image.height - 1);
  const maxY = clamp(Math.ceil(reference.bottom - referenceHeight * 0.05), minY + 1, image.height);
  const horizontalRows: number[] = [];

  for (let y = minY; y < maxY; y++) {
    let darkCount = 0;
    for (let x = minX; x < maxX; x++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }

    if (darkCount >= (maxX - minX) * 0.35) {
      horizontalRows.push(y);
    }
  }

  if (horizontalRows.length < 2) {
    return null;
  }

  const top = horizontalRows[0];
  const bottom = horizontalRows[horizontalRows.length - 1] + 1;
  const minVerticalDarkPixels = Math.max(80, (bottom - top) * 0.12);
  const verticalCols: number[] = [];

  for (let x = minX; x < maxX; x++) {
    let darkCount = 0;
    for (let y = top; y < bottom; y++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }

    if (darkCount >= minVerticalDarkPixels) {
      verticalCols.push(x);
    }
  }

  if (verticalCols.length < 2) {
    return null;
  }

  const left = verticalCols[0];
  const right = verticalCols[verticalCols.length - 1] + 1;

  if ((right - left) < referenceWidth * 0.58 || (bottom - top) < referenceHeight * 0.62) {
    return null;
  }

  const bounds = { left, top, right, bottom };
  if (!isPlausibleFrameBounds(image, bounds, reference)) {
    return null;
  }

  // Long table rules can satisfy the initial row/column density thresholds.
  // Require all four detected edges to remain sufficiently continuous so an
  // internal form table is not promoted to the page frame.
  if (!hasContinuousFrameEdges(image, bounds)) {
    return null;
  }

  return bounds;
}

/**
 * All coordinate consumers use this one registration frame. A raw dark-pixel
 * envelope may still be shown for manual review, but it is never trusted for
 * automatic answers unless page or frame registration succeeded.
 */
export function getRegistrationBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
): PixelBounds {
  return image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
}

export function hasUsableFormBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds' | 'contentBoundsSource' | 'pageBounds'>,
): boolean {
  return resolveFormBoundsStatus(image).usable;
}

/**
 * The safety precondition, with the clause that decided it.
 *
 * `hasUsableFormBounds` returns this verdict and nothing else, so the reason
 * reported can never drift from the reason applied -- there is one evaluation,
 * not an explanation written alongside it.
 *
 * This matters because the caller ands this together with grid verification
 * before handing the result to `analyzeChoiceGroup`, which sees only the
 * conjunction. A group refused on the combined precondition cannot say which
 * half refused it unless this one is re-checked, and the two halves live in
 * different files and want different fixes.
 */
function resolveFormBoundsStatus(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds' | 'contentBoundsSource' | 'pageBounds'>,
): { usable: boolean; reason: string } {
  if (image.contentBoundsSource === 'dark') {
    return { usable: false, reason: 'dark-bounds-only' };
  }

  const bounds = image.contentBounds;
  if (!bounds) {
    return { usable: false, reason: 'no-content-bounds' };
  }

  const documentBounds = image.pageBounds || bounds;
  if (!isPlausiblePaperBounds(image, documentBounds)) {
    const w = (documentBounds.right - documentBounds.left) / image.width;
    const h = (documentBounds.bottom - documentBounds.top) / image.height;
    const ar = (documentBounds.bottom - documentBounds.top)
      / Math.max(documentBounds.right - documentBounds.left, 1);
    return {
      usable: false,
      reason: `implausible-paper(w=${w.toFixed(3)}/0.550 h=${h.toFixed(3)}/0.620`
        + ` ar=${ar.toFixed(3)}/[1.05,1.90])`,
    };
  }

  // For a detected page, the content frame is intentionally inset from all
  // four sheet edges. Judge registration confidence using the outer paper
  // bounds, then ensure the inner template frame remains plausibly large and
  // contained. Older callers without a page keep the legacy edge checks.
  if (image.pageBounds) {
    const page = image.pageBounds;
    if (isPlausibleTemplateContentBounds(page, bounds)) {
      return { usable: true, reason: 'ok' };
    }
    const cw = (bounds.right - bounds.left) / Math.max(page.right - page.left, 1);
    const ch = (bounds.bottom - bounds.top) / Math.max(page.bottom - page.top, 1);
    const ar = (bounds.bottom - bounds.top) / Math.max(bounds.right - bounds.left, 1);
    const inside = bounds.left >= page.left && bounds.top >= page.top
      && bounds.right <= page.right && bounds.bottom <= page.bottom;
    return {
      usable: false,
      reason: `implausible-content(inside=${inside ? 1 : 0} w=${cw.toFixed(3)}/0.550`
        + ` h=${ch.toFixed(3)}/0.550 ar=${ar.toFixed(3)}/[1.05,1.95])`,
    };
  }

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const aspectRatio = height / width;

  const usable = width >= image.width * 0.72
    && height >= image.height * 0.78
    && bounds.left <= image.width * 0.16
    && bounds.right >= image.width * 0.84
    && bounds.top <= image.height * 0.16
    && bounds.bottom >= image.height * 0.84
    && aspectRatio >= 1.05
    && aspectRatio <= 1.9;

  return {
    usable,
    reason: usable
      ? 'ok-legacy'
      : `legacy-edges(w=${(width / image.width).toFixed(3)}/0.720`
        + ` h=${(height / image.height).toFixed(3)}/0.780`
        + ` l=${(bounds.left / image.width).toFixed(3)}/0.160`
        + ` r=${(bounds.right / image.width).toFixed(3)}/0.840`
        + ` t=${(bounds.top / image.height).toFixed(3)}/0.160`
        + ` b=${(bounds.bottom / image.height).toFixed(3)}/0.840`
        + ` ar=${aspectRatio.toFixed(3)}/[1.05,1.90])`,
  };
}

function isPlausibleTemplateContentBounds(pageBounds: PixelBounds, contentBounds: PixelBounds): boolean {
  const pageWidth = pageBounds.right - pageBounds.left;
  const pageHeight = pageBounds.bottom - pageBounds.top;
  const contentWidth = contentBounds.right - contentBounds.left;
  const contentHeight = contentBounds.bottom - contentBounds.top;

  return (
    contentBounds.left >= pageBounds.left
    && contentBounds.top >= pageBounds.top
    && contentBounds.right <= pageBounds.right
    && contentBounds.bottom <= pageBounds.bottom
    && contentWidth >= pageWidth * 0.55
    && contentHeight >= pageHeight * 0.55
    && contentHeight / contentWidth >= 1.05
    && contentHeight / contentWidth <= 1.95
  );
}

function isPlausiblePaperBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height'>,
  bounds: PixelBounds,
): boolean {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const aspectRatio = height / width;

  return (
    width >= image.width * 0.55
    && height >= image.height * 0.62
    && aspectRatio >= 1.05
    && aspectRatio <= 1.9
  );
}

interface DecisionEvidence {
  field: string;
  boundsSource: ContentBoundsSource | 'none';
  boundsWidth: number;
  boundsRejection?: string;
  usesBaseline: boolean;
  usesGridCells: boolean;
  scores: number[];
  ranked: ScoredCandidate[];
  best?: ScoredCandidate;
  gap: number;
  relativeContrast: number;
  highScoreThreshold: number;
  highGapThreshold: number;
  mediumScoreThreshold: number;
  mediumGapThreshold: number;
  requireHighVisualConfidence: boolean;
}

/**
 * Every test `analyzeChoiceGroup` applied, what it was given, and by how much
 * it missed.
 *
 * Seventeen cells sit at `src=grid conf=low` with verified coordinates and a
 * mark that is really on the page, and `conf=low` alone cannot say whether a
 * test missed by two percent or by tenfold. Those are different problems and
 * four attempts have already been spent tuning this file without knowing which
 * one was being tuned.
 *
 * Each failing test is named the way the age reader names its gates, and each
 * carries `have/need(ratio)` so the distance is readable at a glance. A ratio
 * just under 1 is a threshold problem; a ratio near zero is a signal problem.
 *
 * Only numbers and fixed labels are emitted. Candidate scores are listed in
 * rank order without their values, so the row shows the shape of the decision
 * without restating which option a student chose.
 */
function describeDecision(evidence: DecisionEvidence, outcome: string, refused: string[]): string {
  const {
    field, usesBaseline, usesGridCells, scores, best, gap, relativeContrast,
    highScoreThreshold, highGapThreshold, mediumScoreThreshold, mediumGapThreshold,
  } = evidence;

  const parts = [
    `field=${field}`,
    `outcome=${outcome}`,
    `bounds=${evidence.boundsSource}`
      + `/${evidence.boundsWidth.toFixed(4)}`
      + `${evidence.boundsRejection ? `/${evidence.boundsRejection}` : ''}`,
    refused.length > 0 ? `refused=${refused.join(',')}` : 'refused=none',
    `base=${usesBaseline ? 1 : 0} cells=${usesGridCells ? 1 : 0} n=${scores.length}`,
    `scores=${scores.map((score) => score.toFixed(3)).join('/')}`,
  ];

  if (best) {
    parts.push(`floor=${ratioOf(best.score, highScoreThreshold)}`);
    parts.push(`gap=${ratioOf(gap, highGapThreshold)}`);
    if (usesBaseline) {
      parts.push(`contrast=${ratioOf(relativeContrast, HIGH_RELATIVE_CONTRAST)}`);
    }
    parts.push(`med-floor=${ratioOf(best.score, mediumScoreThreshold)}`);
    parts.push(`med-gap=${ratioOf(gap, mediumGapThreshold)}`);
  }

  const shape = best?.shape;
  if (usesBaseline && shape) {
    parts.push(
      `shape=[size=${ratioOf(shape.largestComponentSize, STRUCTURED_MARK_MIN_COMPONENT)}`
      + ` compact=${ratioOf(shape.largestComponentRatio, STRUCTURED_MARK_MIN_COMPONENT_RATIO)}`
      + ` diag=${ratioOf(shape.diagonalRatio, STRUCTURED_MARK_MIN_DIAGONAL_RATIO)}]`,
    );
  }

  // Every box, not just the winner. When the scorer names a box the checkbox
  // gate reports as empty, the question is what the named box has that the
  // inked one does not -- and that cannot be read from the winner alone. Each
  // entry is the box's position in the group as the template lists it, so a
  // row here lines up with the box the gate names.
  const ink = best?.shape as TemplateInkFeatures | undefined;
  if (usesBaseline && ink && ink.actualInk !== undefined) {
    const rows = evidence.ranked.slice(0, 6).map((candidate) => {
      const features = candidate.shape as TemplateInkFeatures | undefined;
      if (!features) return `${candidate.position}@${candidate.atX.toFixed(2)}:scr=${candidate.score.toFixed(3)}`;
      // An offset sitting on the edge of the search means the search ran out
      // of room rather than finding the best fit.
      const pinned = Math.abs(features.alignX) >= features.radiusX
        || Math.abs(features.alignY) >= features.radiusY;
      // Where a wider search wanted to go, and whether going there would have
      // fitted materially better. `want` pinned at its own radius, or a gain
      // near zero, both mean translation is not what is missing.
      const probe = features.probe;
      const wanted = probe
        ? ` want=${probe.x},${probe.y}`
          + `${Math.abs(probe.x) >= probe.radius || Math.abs(probe.y) >= probe.radius ? '!' : ''}`
          + `/${probe.radius} gain=${(probe.chosenFit - probe.fit).toFixed(4)}`
        : '';
      // What the leftover disagreement is made of, when it was measured.
      const c = features.composition;
      const made = c
        ? ` edge=${c.edgeShare.toFixed(2)}/${c.edgeFraction.toFixed(2)}`
          + ` bal=${c.edgeBalance.toFixed(2)}`
          + ` sharp=${c.pageSharpness.toFixed(3)},${c.blankSharpness.toFixed(3)}`
          + ` soft=${c.fitSoftBlank.toFixed(4)},${c.fitSoftBoth.toFixed(4)}`
          + ` mscore=${c.matchedScore.toFixed(4)}`
        : '';
      return `${candidate.position}@${candidate.atX.toFixed(2)}:scr=${candidate.score.toFixed(3)}`
        + ` page=${features.actualInk.toFixed(3)} blank=${features.baselineInk.toFixed(3)}`
        + ` shift=${features.brightnessOffset.toFixed(0)}`
        + (features.brightnessProbe
          ? ` ref82=${features.brightnessProbe.actualP82.toFixed(0)},${features.brightnessProbe.blankP82.toFixed(0)}`
            + ` ref95=${features.brightnessProbe.actualP95.toFixed(0)},${features.brightnessProbe.blankP95.toFixed(0)}`
            + ` alt95=${features.brightnessProbe.offset95.toFixed(0)},${features.brightnessProbe.score95.toFixed(4)}`
          : '')
        + (features.insetSignal !== undefined
          ? ` inner=${features.insetSignal.toFixed(3)}`
          : '')
        + (features.blankGeometry
          ? ` bcore=${features.blankGeometry.coreConcentration.toFixed(2)}`
            + `/${features.blankGeometry.fill.toFixed(3)}`
          : '')
        + ` align=${features.alignX.toFixed(2)},${features.alignY.toFixed(2)}${pinned ? '!' : ''}`
        + ` steps=${features.stepsX},${features.stepsY}`
        + ` fit=${features.fit.toFixed(4)}${wanted}${made}`;
    });
    parts.push(`boxes=[${rows.join(' | ')}]`);
    // How far the alignment search can physically reach. It moves in whole
    // samples, so a pitch below 1 means it cannot correct a one-pixel
    // registration error no matter what the offsets say.
    parts.push(
      `pitch=[page=${ink.pagePitchX.toFixed(2)},${ink.pagePitchY.toFixed(2)}`
      + ` blank=${ink.blankPitchX.toFixed(2)},${ink.blankPitchY.toFixed(2)}`
      + ` reach=${ink.radiusX},${ink.radiusY}]`,
    );
  }

  const trace = `[marks ${parts.join(' ')}]`;
  emitDecisionTrace(trace);
  return trace;
}

/**
 * The trace's second outlet.
 *
 * `analyzeChoiceGroup` returns the trace on its result, but the caller that
 * puts field text on the reviewer's screen lives in another file and does not
 * forward it yet. Until it does, this makes the same string readable from a
 * measurement run without any other file changing. It is off unless
 * `MARK_DECISION_TRACE` is set, so nothing is written in a normal request.
 */
function isTracing(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.MARK_DECISION_TRACE);
}

function emitDecisionTrace(trace: string): void {
  if (!isTracing()) {
    return;
  }
  // eslint-disable-next-line no-console
  console.info(trace);
}

/** `have/need(ratio)`, so a near miss and a rout read differently. */
function ratioOf(have: number, need: number): string {
  const ratio = need > 0 ? have / need : Number.POSITIVE_INFINITY;
  const shown = Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : 'inf';
  const value = Number.isFinite(have) ? have.toFixed(3) : 'inf';
  return `${value}/${need.toFixed(3)}(${shown})`;
}

export function analyzeChoiceGroup(
  image: ImageAnalysisData,
  group: ChoiceGroup,
  yOverride?: { top: number; bottom: number },
  allowAutoValue = true,
  candidatePixelOverrides?: PixelRect[],
  requireHighVisualConfidence = false,
  baseline?: ChoiceGroupBaseline,
): ChoiceGroupResult {
  const usesGridCells = candidatePixelOverrides?.length === group.candidates.length;
  const usesBaseline = baseline?.candidatePixelOverrides.length === group.candidates.length;
  const scoredCandidates: ScoredCandidate[] = group.candidates
    .map((candidate, index) => {
      const templateEvidence = usesBaseline
        ? calculateTemplateInkFeatures(
          image,
          usesGridCells ? candidatePixelOverrides![index] : toPixelRect(image, candidate.rect, yOverride),
          baseline!.image,
          baseline!.candidatePixelOverrides[index],
        )
        : undefined;

      const rect = usesGridCells
        ? candidatePixelOverrides![index]
        : toPixelRect(image, candidate.rect, yOverride);
      // Falls back to the whole bitmap when no envelope was resolved, which is
      // the same frame the rest of this file uses in that case.
      const contentLeft = image.contentBounds?.left ?? 0;
      const contentWidth = Math.max((image.contentBounds?.right ?? image.width) - contentLeft, 1);

      return {
        position: index + 1,
        candidateIndex: index,
        atX: ((rect.left + rect.right) / 2 - contentLeft) / contentWidth,
        value: candidate.value,
        score: roundScore(
          templateEvidence?.score ?? calculateDarkPixelDensity(
            image,
            candidate.rect,
            150,
            yOverride,
            usesGridCells ? candidatePixelOverrides[index] : undefined,
          ),
        ),
        shape: templateEvidence,
      };
    })
    .sort((a, b) => b.score - a.score);
  const candidates: CandidateScore[] = scoredCandidates.map(({ value, score }) => ({ value, score }));
  const candidateMeasurements: CandidateMeasurement[] = scoredCandidates.map((candidate) => ({
    candidateIndex: candidate.candidateIndex,
    score: candidate.score,
    actualInk: candidate.shape?.actualInk ?? null,
    baselineInk: candidate.shape?.baselineInk ?? null,
    brightnessOffset: candidate.shape?.brightnessOffset ?? null,
    alignX: candidate.shape?.alignX ?? null,
    alignY: candidate.shape?.alignY ?? null,
    largestComponentSize: candidate.shape?.largestComponentSize ?? null,
    largestComponentRatio: candidate.shape?.largestComponentRatio ?? null,
    diagonalRatio: candidate.shape?.diagonalRatio ?? null,
  }));

  const best = scoredCandidates[0];
  const second = scoredCandidates[1];
  const evidence: DecisionEvidence = {
    field: group.field,
    boundsSource: image.contentBoundsSource ?? 'none',
    boundsWidth: ((image.contentBounds?.right ?? image.width)
      - (image.contentBounds?.left ?? 0)) / image.width,
    boundsRejection: image.contentBoundsRejection,
    usesBaseline,
    usesGridCells,
    scores: candidates.map((candidate) => candidate.score),
    ranked: scoredCandidates,
    best,
    gap: 0,
    relativeContrast: 0,
    highScoreThreshold: 0,
    highGapThreshold: 0,
    mediumScoreThreshold: 0,
    mediumGapThreshold: 0,
    requireHighVisualConfidence,
  };

  if (!best) {
    return {
      field: group.field,
      confidence: 'low',
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'low', ['no-candidates']),
    };
  }

  // A fallback content bound may still produce plausible-looking candidate scores.
  // Never turn those scores into automatic data when the page frame was not trusted.
  const gap = best.score - (second?.score || 0);
  // Printed circles and rules do not cancel perfectly: the blank form is a
  // 200dpi scan while an uploaded page is rendered at roughly half that, so
  // every option keeps a similar floor of leftover ink. That floor makes the
  // absolute gap meaningless -- on a real scan `satisfaction.q01` scored
  // 0.0500 / 0.0439 / 0.0423 / 0.0225 and the unmarked option 1 won by 0.0077,
  // well past the 0.004 gap rule. A real mark instead multiplies the runner-up
  // (1.9x on the same field's correct pages) because the leftover floor is
  // common to every option while pen ink is not.
  //
  // 1.25 is the largest threshold that costs no correct answer on the six-page
  // answer key (1.15-1.25 both give CORRECT 92 WRONG 0; 1.35 drops to 87), so
  // it maximizes the margin against unseen pages without trading accuracy. The
  // one measured wrong answer sat at 1.14.
  const relativeContrast = second && second.score > 0
    ? best.score / second.score
    : Number.POSITIVE_INFINITY;
  // The baseline score now acts only as a minimum signal floor. For a real
  // mark, the residual must also form a compact, stroke-like shape. This is
  // deliberately shared by every baseline-backed candidate; it does not know
  // the field name or the candidate index.
  // The relative-contrast rule below compares the best option with the runner
  // up, which is meaningless when both are noise. On one real page the
  // satisfaction marks were six times fainter than normal (0.011 against 0.067
  // elsewhere), the printed residue at 0.020 outscored the real mark, and the
  // 1.8x ratio confirmed it as a wrong answer. A floor keeps that comparison
  // from running at all until there is a real signal to compare.
  const highScoreThreshold = usesBaseline ? HIGH_ABSOLUTE_SIGNAL : 0.35;
  const highGapThreshold = usesBaseline ? 0.004 : 0.12;
  const mediumScoreThreshold = usesBaseline ? 0.007 : 0.1;
  const mediumGapThreshold = usesBaseline ? 0.003 : 0.025;

  evidence.gap = gap;
  evidence.relativeContrast = relativeContrast;
  evidence.highScoreThreshold = highScoreThreshold;
  evidence.highGapThreshold = highGapThreshold;
  evidence.mediumScoreThreshold = mediumScoreThreshold;
  evidence.mediumGapThreshold = mediumGapThreshold;

  if (!allowAutoValue) {
    // The caller ands two independent preconditions together and passes only
    // the conjunction, so this branch used to report `form-boundary-unverified`
    // for either of them. Re-checking the half that lives in this file
    // separates them: if the form bounds are usable, the grid is what refused,
    // and that is a different file and a different fix.
    const formBounds = resolveFormBoundsStatus(image);
    return {
      field: group.field,
      confidence: 'low',
      candidates,
      candidateMeasurements,
      decision: describeDecision(
        evidence,
        'low',
        [formBounds.usable ? 'grid-unverified' : `form-bounds:${formBounds.reason}`],
      ),
    };
  }

  const hasStructuredMark = !usesBaseline || hasStructuredTemplateMark(best.shape);

  // Which of the four high-confidence tests refused, recorded as they are
  // evaluated. This reads the same values the condition below reads and
  // decides nothing.
  const refused: string[] = [];
  if (!(best.score >= highScoreThreshold)) refused.push('absolute-floor');
  if (!(gap >= highGapThreshold)) refused.push('gap');
  if (!hasStructuredMark) refused.push('mark-shape');
  if (usesBaseline && !(relativeContrast >= HIGH_RELATIVE_CONTRAST)) refused.push('relative-contrast');

  if (
    best.score >= highScoreThreshold
    && gap >= highGapThreshold
    && hasStructuredMark
    && (!usesBaseline || relativeContrast >= HIGH_RELATIVE_CONTRAST)
  ) {
    return {
      field: group.field,
      value: best.value,
      confidence: 'high',
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'high', refused),
    };
  }

  // A verified table cell lets us use a lower medium threshold for a clear
  // hand-drawn ring. Sensitive fields can opt out and remain manual unless
  // the stricter high-confidence rule above is met.
  if (!requireHighVisualConfidence && best.score >= mediumScoreThreshold && gap >= mediumGapThreshold) {
    return {
      field: group.field,
      value: best.value,
      confidence: 'medium',
      candidates,
      candidateMeasurements,
      decision: describeDecision(evidence, 'medium', refused),
    };
  }

  if (requireHighVisualConfidence) refused.push('medium-path-not-offered');
  if (!(best.score >= mediumScoreThreshold)) refused.push('medium-floor');
  if (!(gap >= mediumGapThreshold)) refused.push('medium-gap');

  return {
    field: group.field,
    confidence: 'low',
    candidates,
    candidateMeasurements,
    decision: describeDecision(evidence, 'low', refused),
  };
}

/**
 * Scores only ink that is present in the submitted form but not in the
 * measured blank template. This removes the printed answer glyph and table
 * rules from the decision, which otherwise dominate small hand-drawn circles.
 */
export function calculateTemplateInkDifference(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
): number {
  return calculateTemplateInkFeatures(image, actualRect, baseline, baselineRect).score;
}

function calculateTemplateInkFeatures(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
): TemplateInkFeatures {
  const sampleWidth = 36;
  const sampleHeight = 28;
  const actual = sampleRect(image, actualRect, sampleWidth, sampleHeight);
  const blank = sampleRect(baseline, baselineRect, sampleWidth, sampleHeight);
  if (actual.length === 0 || blank.length === 0) {
    return {
      score: 0,
      largestComponentSize: 0,
      largestComponentRatio: 0,
      diagonalRatio: 0,
      actualInk: 0,
      baselineInk: 0,
      brightnessOffset: 0,
      alignX: 0,
      alignY: 0,
      pagePitchX: 0,
      pagePitchY: 0,
      blankPitchX: 0,
      blankPitchY: 0,
      radiusX: BASELINE_ALIGNMENT_RADIUS,
      radiusY: BASELINE_ALIGNMENT_RADIUS,
      stepsX: 1,
      stepsY: 1,
      fit: 0,
    };
  }

  // Different scanners change the paper's overall brightness. Normalize only
  // the light background before comparing dark ink, keeping local pen strokes.
  const brightnessOffset = percentile(blank, 0.82) - percentile(actual, 0.82);
  const pagePitchX = (actualRect.right - actualRect.left) / sampleWidth;
  const pagePitchY = (actualRect.bottom - actualRect.top) / sampleHeight;
  // The reach is set from the page's own pitch, because the registration error
  // to be absorbed is measured in the page's pixels.
  const radiusX = alignmentRadius(pagePitchX);
  const radiusY = alignmentRadius(pagePitchY);
  // The offset is resolved to a fraction of a sample wherever the grid
  // oversamples the page, because that is where a fractional misregistration
  // can exist at all.
  const stepsX = alignmentSteps(pagePitchX);
  const stepsY = alignmentSteps(pagePitchY);
  const alignment = findBestBaselineAlignment(
    actual,
    blank,
    sampleWidth,
    sampleHeight,
    brightnessOffset,
    radiusX,
    radiusY,
    stepsX,
    stepsY,
  );
  const residual = new Float32Array(sampleWidth * sampleHeight);
  let difference = 0;
  // Totals either side of the subtraction. They change nothing; they are what
  // makes "the baseline removed almost all of it" distinguishable from "there
  // was almost nothing there" once a group is refused.
  let actualTotal = 0;
  let baselineTotal = 0;

  for (let y = radiusY; y < sampleHeight - radiusY; y++) {
    for (let x = radiusX; x < sampleWidth - radiusX; x++) {
      const index = y * sampleWidth + x;
      const actualInk = darkness(actual[index] + brightnessOffset);
      const baselineInk = darkness(
        sampleGridAt(blank, sampleWidth, sampleHeight, x + alignment.x, y + alignment.y),
      );
      actualTotal += actualInk;
      baselineTotal += baselineInk;
      // Ignore the narrow anti-aliasing and scanner-noise band around the
      // printed form. A handwritten circle or check remains well above it.
      const residualInk = Math.max(0, actualInk - baselineInk - 0.08);
      residual[index] = residualInk;
      difference += residualInk;
    }
  }

  // Counted, not assumed: a cell inset further contributes fewer samples and
  // must be divided by fewer, or its score would shrink for no reason.
  const usablePixels = Math.max((sampleWidth - 2 * radiusX) * (sampleHeight - 2 * radiusY), 1);
  const shape = analyzeResidualShape(residual, sampleWidth, sampleHeight);
  return {
    score: difference / usablePixels,
    ...shape,
    actualInk: actualTotal / usablePixels,
    baselineInk: baselineTotal / usablePixels,
    brightnessOffset,
    alignX: alignment.x,
    alignY: alignment.y,
    pagePitchX,
    pagePitchY,
    blankPitchX: (baselineRect.right - baselineRect.left) / sampleWidth,
    blankPitchY: (baselineRect.bottom - baselineRect.top) / sampleHeight,
    radiusX,
    radiusY,
    stepsX,
    stepsY,
    fit: alignment.fit,
    brightnessProbe: isTracing()
      ? measureBrightnessReference(
        actual,
        blank,
        sampleWidth,
        sampleHeight,
        radiusX,
        radiusY,
        stepsX,
        stepsY,
      )
      : undefined,
    insetSignal: isTracing()
      ? calculateInsetResidualSignal(image, actualRect, baseline, baselineRect)
      : undefined,
    blankGeometry: isTracing()
      ? measureBlankInkGeometry(
        blank,
        sampleWidth,
        sampleHeight,
        radiusX,
        radiusY,
        alignment.x,
        alignment.y,
      )
      : undefined,
    probe: isTracing()
      ? probeAlignment(actual, blank, sampleWidth, sampleHeight, brightnessOffset, alignment.x, alignment.y)
      : undefined,
    composition: isTracing()
      ? analyzeResidualComposition(
        actual,
        blank,
        sampleWidth,
        sampleHeight,
        brightnessOffset,
        alignment.x,
        alignment.y,
        radiusX,
        radiusY,
      )
      : undefined,
  };
}

interface BlankInkGeometry {
  /**
   * Share of the blank form's ink in this cell that falls inside the middle
   * half of each axis, divided by that region's share of the area. Above 1
   * means the printed ink is concentrated in the centre; below 1 means it is
   * pushed to the perimeter. Scale-free, so a 13px checkbox and a 58px
   * satisfaction cell are directly comparable.
   */
  coreConcentration: number;
  /** Mean printed darkness across the cell, so an empty cell is recognisable. */
  fill: number;
}

/**
 * Where the printed ink sits in a cell, measured on the blank form alone.
 *
 * Reads the same resampled grid the score is computed from, over the same
 * usable region, so it describes the cell the scorer actually sees rather than
 * an idealised rectangle.
 */
function measureBlankInkGeometry(
  blank: number[],
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  alignX: number,
  alignY: number,
): BlankInkGeometry {
  const coreLeft = width * 0.25;
  const coreRight = width * 0.75;
  const coreTop = height * 0.25;
  const coreBottom = height * 0.75;
  let total = 0;
  let core = 0;
  let samples = 0;
  let coreSamples = 0;

  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const ink = darkness(sampleGridAt(blank, width, height, x + alignX, y + alignY));
      total += ink;
      samples += 1;
      if (x >= coreLeft && x < coreRight && y >= coreTop && y < coreBottom) {
        core += ink;
        coreSamples += 1;
      }
    }
  }

  if (samples === 0 || total <= 0 || coreSamples === 0) {
    return { coreConcentration: 0, fill: 0 };
  }
  // Ink share of the core against its area share. A cell whose print is spread
  // evenly reads 1 whatever its size.
  const areaShare = coreSamples / samples;
  return { coreConcentration: core / total / areaShare, fill: total / samples };
}

/**
 * Measures whether the local 82nd-percentile paper reference is being moved by
 * a dark mark. The 95th-percentile offset is a diagnostic comparison only; it
 * never changes the score or any gate.
 */
function measureBrightnessReference(
  actual: number[],
  blank: number[],
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  stepsX: number,
  stepsY: number,
): BrightnessReferenceProbe {
  const actualP82 = percentile(actual, 0.82);
  const blankP82 = percentile(blank, 0.82);
  const actualP95 = percentile(actual, 0.95);
  const blankP95 = percentile(blank, 0.95);
  const offset95 = blankP95 - actualP95;
  const alignment95 = findBestBaselineAlignment(
    actual,
    blank,
    width,
    height,
    offset95,
    radiusX,
    radiusY,
    stepsX,
    stepsY,
  );
  let difference = 0;
  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const actualInk = darkness(actual[y * width + x] + offset95);
      const baselineInk = darkness(
        sampleGridAt(blank, width, height, x + alignment95.x, y + alignment95.y),
      );
      difference += Math.max(0, actualInk - baselineInk - 0.08);
    }
  }
  const usablePixels = Math.max((width - 2 * radiusX) * (height - 2 * radiusY), 1);
  return {
    actualP82,
    blankP82,
    actualP95,
    blankP95,
    offset95,
    score95: difference / usablePixels,
  };
}

/**
 * Mirrors the direct checkbox gate's 3px/4px inset and 8x8 sampling as
 * measurement. It is intentionally separate from the full-box scorer and is
 * never used to alter a candidate score or decision.
 */
function calculateInsetResidualSignal(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
): number {
  const actual = insetPixelRect(actualRect, 3);
  const blank = insetPixelRect(baselineRect, 4);
  let difference = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const actualX = clamp(
        Math.round(actual.left + (x + 0.5) * (actual.right - actual.left) / 8),
        0,
        image.width - 1,
      );
      const actualY = clamp(
        Math.round(actual.top + (y + 0.5) * (actual.bottom - actual.top) / 8),
        0,
        image.height - 1,
      );
      const blankX = clamp(
        Math.round(blank.left + (x + 0.5) * (blank.right - blank.left) / 8),
        0,
        baseline.width - 1,
      );
      const blankY = clamp(
        Math.round(blank.top + (y + 0.5) * (blank.bottom - blank.top) / 8),
        0,
        baseline.height - 1,
      );
      const actualInk = darkness(image.pixels[actualY * image.width + actualX]);
      const blankInk = darkness(baseline.pixels[blankY * baseline.width + blankX]);
      difference += Math.max(0, actualInk - blankInk - 0.08);
    }
  }
  return difference / 64;
}

function insetPixelRect(rect: PixelRect, inset: number): PixelRect {
  const left = Math.min(rect.left + inset, rect.right - 1);
  const top = Math.min(rect.top + inset, rect.bottom - 1);
  const right = Math.max(left + 1, rect.right - inset);
  const bottom = Math.max(top + 1, rect.bottom - inset);
  return { left, top, right, bottom };
}

function hasStructuredTemplateMark(shape?: TemplateInkShape): boolean {
  return Boolean(
    shape
    && shape.largestComponentSize >= STRUCTURED_MARK_MIN_COMPONENT
    && shape.largestComponentRatio >= STRUCTURED_MARK_MIN_COMPONENT_RATIO
    && shape.diagonalRatio >= STRUCTURED_MARK_MIN_DIAGONAL_RATIO,
  );
}

function analyzeResidualShape(
  residual: Float32Array,
  width: number,
  height: number,
): TemplateInkShape {
  const shapeThreshold = 0.08;
  const visited = new Uint8Array(residual.length);
  let activePixels = 0;
  let largestComponentSize = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const start = y * width + x;
      if (visited[start] || residual[start] <= shapeThreshold) continue;

      const queue = [start];
      visited[start] = 1;
      let componentSize = 0;
      while (queue.length > 0) {
        const current = queue.pop()!;
        const currentX = current % width;
        const currentY = Math.floor(current / width);
        componentSize += 1;
        activePixels += 1;

        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          for (let offsetX = -1; offsetX <= 1; offsetX++) {
            if (offsetX === 0 && offsetY === 0) continue;
            const neighborX = currentX + offsetX;
            const neighborY = currentY + offsetY;
            if (
              neighborX < 1
              || neighborX >= width - 1
              || neighborY < 1
              || neighborY >= height - 1
            ) continue;
            const neighbor = neighborY * width + neighborX;
            if (visited[neighbor] || residual[neighbor] <= shapeThreshold) continue;
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }
      }
      largestComponentSize = Math.max(largestComponentSize, componentSize);
    }
  }

  let diagonalEdges = 0;
  let orthogonalEdges = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (residual[index] <= shapeThreshold) continue;
      for (const [offsetX, offsetY] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const neighbor = (y + offsetY) * width + x + offsetX;
        if (residual[neighbor] <= shapeThreshold) continue;
        if (offsetX === 0 || offsetY === 0) orthogonalEdges += 1;
        else diagonalEdges += 1;
      }
    }
  }

  return {
    largestComponentSize,
    largestComponentRatio: activePixels > 0 ? largestComponentSize / activePixels : 0,
    diagonalRatio: diagonalEdges / Math.max(diagonalEdges + orthogonalEdges, 1),
  };
}

function toPixelRect(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  rect: NormalizedRect,
  yOverride?: { top: number; bottom: number },
): PixelRect {
  const bounds = getRegistrationBounds(image);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const left = clamp(Math.floor(bounds.left + rect.x * width), 0, image.width - 1);
  const right = clamp(Math.ceil(bounds.left + (rect.x + rect.width) * width), left + 1, image.width);
  const top = clamp(Math.floor(yOverride ? yOverride.top : bounds.top + rect.y * height), 0, image.height - 1);
  const bottom = clamp(Math.ceil(yOverride ? yOverride.bottom : bounds.top + (rect.y + rect.height) * height), top + 1, image.height);
  return { left, top, right, bottom };
}

function sampleRect(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  rect: PixelRect,
  sampleWidth: number,
  sampleHeight: number,
): number[] {
  const left = clamp(Math.floor(rect.left), 0, image.width - 1);
  const top = clamp(Math.floor(rect.top), 0, image.height - 1);
  const right = clamp(Math.ceil(rect.right), left + 1, image.width);
  const bottom = clamp(Math.ceil(rect.bottom), top + 1, image.height);
  const width = right - left;
  const height = bottom - top;
  const samples: number[] = [];

  for (let y = 0; y < sampleHeight; y++) {
    const sourceY = Math.min(bottom - 1, Math.max(top, Math.round(top + ((y + 0.5) / sampleHeight) * height - 0.5)));
    for (let x = 0; x < sampleWidth; x++) {
      const sourceX = Math.min(right - 1, Math.max(left, Math.round(left + ((x + 0.5) / sampleWidth) * width - 0.5)));
      samples.push(image.pixels[sourceY * image.width + sourceX]);
    }
  }

  return samples;
}

/**
 * How far the baseline may be nudged when it is compared with the page.
 *
 * The radius is in resampled samples, but every cell is resampled to the same
 * fixed grid, so one sample is a different physical distance in a small cell
 * than in a large one. At a fixed radius of 1 the search reached two source
 * pixels on a satisfaction cell and under one on a basic-info checkbox, and the
 * winner sat against the boundary on 69% of all decisions -- 100% of basic
 * info. The radius is therefore derived per cell from its own sampling pitch,
 * so every cell gets the same physical reach of about one source pixel: the
 * reach a search expressed in samples had was an accident of cell size.
 *
 * The minimum is 1, which reproduces the previous behaviour exactly for any
 * cell already sampled at a pitch of one source pixel or coarser. The maximum
 * bounds both the cost and the freedom: past about a pixel, a mismatch is a
 * registration failure rather than jitter, and the cell should not be scored on
 * a guess.
 */
const BASELINE_ALIGNMENT_RADIUS = 1;
const BASELINE_ALIGNMENT_MAX_RADIUS = 4;

/**
 * Reach given to the diagnostic probe only. Wide enough that a table-sized
 * registration error lands inside it, so an optimum that still sits on this
 * boundary means something other than translation is separating the two images.
 */
const PROBE_ALIGNMENT_RADIUS = 4;

/**
 * How finely the baseline offset is resolved, in steps per sample.
 *
 * The residual decomposition said the leftover disagreement sits on printed
 * edges, is antisymmetric about them, and goes only when both images are
 * matched rather than either one alone. Geometry makes the blank the
 * higher-resolution image everywhere -- a 200dpi scan against a half-resolution
 * render -- so a sharpness mismatch would have gone with softening the blank
 * alone, and softening the blank alone changed nothing. What both-sided
 * softening removes is sub-sample misregistration: the search moved in whole
 * samples, so a fractional offset was invisible to it at any radius, and 23
 * pinned cells gaining nothing from four times the reach is that showing.
 *
 * The operation that removes a fractional offset is a fractional shift, not a
 * softer comparison. Softening the comparison was built, measured and rejected
 * before shipping: on a blank-form checkbox where a whole-sample offset already
 * fitted to 0.0012, the flattened objective could no longer see that minimum,
 * took its neighbour at 0.0264, and turned an empty cell into a
 * medium-confidence read. Choosing an offset on a softened objective and
 * applying it to unsoftened images drifts the choice.
 *
 * Interpolating leaves the objective alone. The whole-sample offsets are still
 * candidates, so the search minimises over a superset and the fit it finds can
 * only match or beat the previous one -- and nothing that is scored is
 * softened, so a faint mark keeps every bit of its ink and the shape test still
 * sees it at full resolution.
 *
 * Steps come from the page's own pitch, the same quantity that sets the reach.
 * Where the grid is at or coarser than the source pixels there is nothing
 * between samples to find, the count is 1, and the search is exactly the one
 * that ran before.
 */
const BASELINE_ALIGNMENT_MAX_STEPS = 4;

function alignmentSteps(pitch: number): number {
  if (!Number.isFinite(pitch) || pitch <= 0) {
    return 1;
  }
  return clamp(Math.round(1 / pitch), 1, BASELINE_ALIGNMENT_MAX_STEPS);
}

/**
 * Bilinear read of a sample grid at a fractional position. At a whole-number
 * position it returns that sample exactly, which is what keeps a single-step
 * search identical to the one that ran before.
 */
function sampleGridAt(grid: number[], width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const left = clamp(x0, 0, width - 1);
  const top = clamp(y0, 0, height - 1);
  const right = clamp(x0 + 1, 0, width - 1);
  const bottom = clamp(y0 + 1, 0, height - 1);
  const topLeft = grid[top * width + left];
  const topRight = grid[top * width + right];
  const bottomLeft = grid[bottom * width + left];
  const bottomRight = grid[bottom * width + right];
  return topLeft
    + (topRight - topLeft) * fx
    + (bottomLeft - topLeft) * fy
    + (topLeft - topRight - bottomLeft + bottomRight) * fx * fy;
}

/**
 * Gradient above which a sample counts as sitting on a printed edge. Darkness
 * runs 0 to 1, and the edge of a printed rule crosses most of that range, so
 * this separates structure from paper texture without being near either.
 */
const RESIDUAL_EDGE_GRADIENT = 0.15;

/**
 * Samples needed to cover one source pixel, so a cell resampled far above its
 * own resolution can still be shifted a whole pixel.
 */
function alignmentRadius(pitch: number): number {
  if (!Number.isFinite(pitch) || pitch <= 0) {
    return BASELINE_ALIGNMENT_RADIUS;
  }
  return clamp(Math.round(1 / pitch), BASELINE_ALIGNMENT_RADIUS, BASELINE_ALIGNMENT_MAX_RADIUS);
}

/**
 * Finds where the blank form sits against the page.
 *
 * The objective is the symmetric absolute difference between the two images,
 * not the one-sided residual that becomes the score. That is what keeps a wider
 * search from eating a mark: sliding the blank's ink onto a pen stroke lowers
 * the difference under the stroke, but it also strips that ink from where it
 * belongs and plants it where it does not, so mis-registering the print costs
 * twice over the printed structure -- which carries far more ink than any pen
 * mark (mean 0.251 against 0.079 on a measured checkbox). The minimum therefore
 * sits at true print-to-print registration, and widening the window does not
 * move that minimum, it only lets the search reach it.
 *
 * This is the opposite of dilating the blank form, which took this project from
 * CORRECT 92 to 64: dilation adds ink to the subtrahend, permanently enlarging
 * what is removed from every cell. A translation adds no ink at all. It only
 * chooses where the same ink sits.
 *
 * The compared region is inset by the radius so that every offset reads real
 * in-bounds samples and compares exactly the same count. Without that the
 * offsets near the edge would read past the array, and scoring fewer samples
 * would look better than scoring more -- driving the search straight to its
 * own boundary.
 */
function findBestBaselineAlignment(
  actual: number[],
  baseline: number[],
  width: number,
  height: number,
  brightnessOffset: number,
  radiusX: number,
  radiusY: number,
  stepsX: number,
  stepsY: number,
): { x: number; y: number; fit: number } {
  let best = { x: 0, y: 0, score: Number.POSITIVE_INFINITY };
  const compared = Math.max((width - 2 * radiusX) * (height - 2 * radiusY), 1);

  const scoreAt = (offsetX: number, offsetY: number): number => {
    let score = 0;
    for (let y = radiusY; y < height - radiusY; y++) {
      for (let x = radiusX; x < width - radiusX; x++) {
        const actualInk = darkness(actual[y * width + x] + brightnessOffset);
        const baselineInk = darkness(sampleGridAt(baseline, width, height, x + offsetX, y + offsetY));
        score += Math.abs(actualInk - baselineInk);
      }
    }
    return score;
  };

  // Whole samples first, over exactly the grid the previous search used, then
  // fractions within one sample of the winner. Searching every fraction across
  // the whole reach costs the fourth power of the radius; this costs its square
  // and still evaluates the old grid in full, so the offset returned is at
  // least as good as the one that grid would have given.
  for (let offsetY = -radiusY; offsetY <= radiusY; offsetY++) {
    for (let offsetX = -radiusX; offsetX <= radiusX; offsetX++) {
      const score = scoreAt(offsetX, offsetY);
      if (score < best.score) {
        best = { x: offsetX, y: offsetY, score };
      }
    }
  }

  if (stepsX > 1 || stepsY > 1) {
    const coarse = { x: best.x, y: best.y };
    for (let stepY = -stepsY; stepY <= stepsY; stepY++) {
      for (let stepX = -stepsX; stepX <= stepsX; stepX++) {
        if (stepX % stepsX === 0 && stepY % stepsY === 0) {
          continue;
        }
        const offsetX = clamp(coarse.x + stepX / stepsX, -radiusX, radiusX);
        const offsetY = clamp(coarse.y + stepY / stepsY, -radiusY, radiusY);
        const score = scoreAt(offsetX, offsetY);
        if (score < best.score) {
          best = { x: offsetX, y: offsetY, score };
        }
      }
    }
  }

  // Mean disagreement per sample at the offset chosen. A cell that is merely
  // shifted comes to near-agreement once it is shifted back; a cell that cannot
  // be made to agree by any shift keeps a floor here, and no amount of reach
  // will help it.
  return { x: best.x, y: best.y, fit: best.score / compared };
}

interface ResidualComposition {
  /** Share of the disagreement carried by samples on a printed edge. */
  edgeShare: number;
  /** Share of samples that are on a printed edge. */
  edgeFraction: number;
  /** 0 when the edge disagreement cancels out, 1 when it is all one way. */
  edgeBalance: number;
  /** Mean gradient of each image: which one is sharper, and by how much. */
  pageSharpness: number;
  blankSharpness: number;
  /** Fit after softening the blank, and after softening both. */
  fitSoftBlank: number;
  fitSoftBoth: number;
  /**
   * What the score would be if the subtraction itself were taken at the common
   * band. Measured, never applied: softening what is scored spreads a mark's
   * ink and the residual's clip then eats proportionally more of a faint mark
   * than a strong one. This is the number that says whether touching the
   * subtraction is ever worth it, without touching it.
   */
  matchedScore: number;
}

/**
 * What the leftover disagreement is made of, once the baseline is placed as
 * well as it can be.
 *
 * Half the pinned satisfaction cells gain nothing from a search four times
 * wider: the offset a wide search picks is the one it already had. So whatever
 * separates those two images there, sliding one over the other does not close
 * it. Three readings separate the remaining candidates, and they are readings
 * rather than an argument because this axis has now produced four wrong
 * diagnoses, two of them mine.
 *
 * `edgeShare` against `edgeFraction` says whether the disagreement sits on the
 * edges of printed rules and glyphs or is spread across the cell. A resampling
 * difference lives on edges; a genuine ink difference need not.
 *
 * `edgeBalance` is the sharper test. Two images at different effective
 * resolutions disagree *antisymmetrically* about an edge -- the softer one is
 * lighter on one side and darker on the other -- so the signed difference
 * cancels while the absolute difference stays large. Ink that is present in one
 * image and absent from the other is one-signed. Near 0 means sharpness, near 1
 * means substance.
 *
 * `fitSoftBlank` answers the question that decides the axis: if the residual is
 * the blank being sharper, softening the blank removes it, and the fix is to
 * compare the two at a common effective resolution. If softening changes
 * nothing, no operation on the baseline reaches this residual.
 *
 * Measured only while tracing.
 */
function analyzeResidualComposition(
  actual: number[],
  blank: number[],
  width: number,
  height: number,
  brightnessOffset: number,
  offsetX: number,
  offsetY: number,
  radiusX: number,
  radiusY: number,
): ResidualComposition {
  const page = new Float32Array(width * height);
  const base = new Float32Array(width * height);
  for (let index = 0; index < page.length; index++) {
    page[index] = darkness(actual[index] + brightnessOffset);
    base[index] = darkness(blank[index]);
  }
  const softPage = softenSamples(page, width, height);
  const softBase = softenSamples(base, width, height);

  const at = (grid: Float32Array, x: number, y: number): number =>
    grid[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  const gradient = (grid: Float32Array, x: number, y: number): number => Math.max(
    Math.abs(at(grid, x + 1, y) - at(grid, x - 1, y)),
    Math.abs(at(grid, x, y + 1) - at(grid, x, y - 1)),
  );

  let total = 0;
  let edgeMass = 0;
  let edgeSigned = 0;
  let edgeCount = 0;
  let count = 0;
  let pageGradient = 0;
  let blankGradient = 0;
  let softBlankTotal = 0;
  let softBothTotal = 0;
  let matchedScoreTotal = 0;

  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      const bx = x + offsetX;
      const by = y + offsetY;
      const difference = at(page, x, y) - at(base, bx, by);
      total += Math.abs(difference);
      softBlankTotal += Math.abs(at(page, x, y) - at(softBase, bx, by));
      softBothTotal += Math.abs(at(softPage, x, y) - at(softBase, bx, by));
      matchedScoreTotal += Math.max(0, at(softPage, x, y) - at(softBase, bx, by) - 0.08);
      pageGradient += gradient(page, x, y);
      blankGradient += gradient(base, bx, by);
      count++;
      if (gradient(base, bx, by) >= RESIDUAL_EDGE_GRADIENT) {
        edgeMass += Math.abs(difference);
        edgeSigned += difference;
        edgeCount++;
      }
    }
  }

  const samples = Math.max(count, 1);
  return {
    edgeShare: total > 0 ? edgeMass / total : 0,
    edgeFraction: edgeCount / samples,
    edgeBalance: edgeMass > 0 ? Math.abs(edgeSigned) / edgeMass : 0,
    pageSharpness: pageGradient / samples,
    blankSharpness: blankGradient / samples,
    fitSoftBlank: softBlankTotal / samples,
    fitSoftBoth: softBothTotal / samples,
    matchedScore: matchedScoreTotal / samples,
  };
}

/** Three-by-three mean, the mildest way to take resolution out of an image. */
function softenSamples(grid: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(grid.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let seen = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const row = clamp(y + dy, 0, height - 1);
          const column = clamp(x + dx, 0, width - 1);
          sum += grid[row * width + column];
          seen++;
        }
      }
      output[y * width + x] = sum / seen;
    }
  }
  return output;
}

/**
 * Where the alignment would have gone with far more room, and how much better
 * it would have fitted.
 *
 * This decides the shape of the next fix and nothing else, so it is measured
 * rather than reasoned about: a consistent direction across a table means the
 * two images disagree about where the table is, and belongs upstream of this
 * file; scattered directions mean per-cell jitter and want more reach; an
 * optimum that is itself pinned, or one that barely improves the fit, means
 * translation is not the missing operation at all.
 *
 * It runs only while tracing, so it costs a measurement run and nothing else.
 * Both fits are computed over the same probe-inset region so the two are
 * comparable.
 */
function probeAlignment(
  actual: number[],
  baseline: number[],
  width: number,
  height: number,
  brightnessOffset: number,
  chosenX: number,
  chosenY: number,
): { x: number; y: number; fit: number; chosenFit: number; radius: number } {
  const radius = PROBE_ALIGNMENT_RADIUS;
  const fitAt = (offsetX: number, offsetY: number): number => {
    let score = 0;
    let compared = 0;
    for (let y = radius; y < height - radius; y++) {
      for (let x = radius; x < width - radius; x++) {
        const actualInk = darkness(actual[y * width + x] + brightnessOffset);
        const baselineInk = darkness(baseline[(y + offsetY) * width + (x + offsetX)]);
        score += Math.abs(actualInk - baselineInk);
        compared++;
      }
    }
    return score / Math.max(compared, 1);
  };

  let best = { x: 0, y: 0, fit: Number.POSITIVE_INFINITY };
  for (let offsetY = -radius; offsetY <= radius; offsetY++) {
    for (let offsetX = -radius; offsetX <= radius; offsetX++) {
      const fit = fitAt(offsetX, offsetY);
      if (fit < best.fit) {
        best = { x: offsetX, y: offsetY, fit };
      }
    }
  }

  return { ...best, chosenFit: fitAt(chosenX, chosenY), radius };
}

function darkness(value: number): number {
  return Math.max(0, Math.min(1, (178 - value) / 178));
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isPlausibleFrameBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height'>,
  bounds: PixelBounds,
  reference: PixelBounds = { left: 0, top: 0, right: image.width, bottom: image.height },
): boolean {
  const frameWidth = bounds.right - bounds.left;
  const frameHeight = bounds.bottom - bounds.top;
  const aspectRatio = frameHeight / frameWidth;
  const referenceWidth = reference.right - reference.left;
  const referenceHeight = reference.bottom - reference.top;

  // The templates are portrait forms. Reject small internal tables or a partial
  // page frame before normalized ROI coordinates are allowed to drive recognition.
  return (
    frameWidth >= referenceWidth * 0.7 &&
    frameHeight >= referenceHeight * 0.78 &&
    bounds.left <= reference.left + referenceWidth * 0.2 &&
    bounds.right >= reference.right - referenceWidth * 0.2 &&
    bounds.top <= reference.top + referenceHeight * 0.2 &&
    bounds.bottom >= reference.bottom - referenceHeight * 0.2 &&
    aspectRatio >= 1.05 &&
    aspectRatio <= 1.9
  );
}

function hasContinuousFrameEdges(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  bounds: PixelBounds,
): boolean {
  const frameWidth = bounds.right - bounds.left;
  const frameHeight = bounds.bottom - bounds.top;
  const horizontalInset = Math.max(1, Math.round(frameWidth * 0.04));
  const verticalInset = Math.max(1, Math.round(frameHeight * 0.02));
  const horizontalLeft = bounds.left + horizontalInset;
  const horizontalRight = bounds.right - horizontalInset;
  const verticalTop = bounds.top + verticalInset;
  const verticalBottom = bounds.bottom - verticalInset;

  const topRatio = darkRatioInRows(
    image,
    bounds.top,
    Math.min(bounds.top + Math.max(2, Math.round(frameHeight * 0.01)), bounds.bottom),
    horizontalLeft,
    horizontalRight,
  );
  const bottomRatio = darkRatioInRows(
    image,
    Math.max(bounds.top, bounds.bottom - Math.max(2, Math.round(frameHeight * 0.01))),
    bounds.bottom,
    horizontalLeft,
    horizontalRight,
  );
  const leftRatio = darkRatioInColumns(
    image,
    bounds.left,
    Math.min(bounds.left + Math.max(2, Math.round(frameWidth * 0.01)), bounds.right),
    verticalTop,
    verticalBottom,
  );
  const rightRatio = darkRatioInColumns(
    image,
    Math.max(bounds.left, bounds.right - Math.max(2, Math.round(frameWidth * 0.01))),
    bounds.right,
    verticalTop,
    verticalBottom,
  );

  return (
    topRatio >= 0.38 &&
    bottomRatio >= 0.38 &&
    leftRatio >= 0.45 &&
    rightRatio >= 0.45
  );
}

function darkRatioInRows(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  top: number,
  bottom: number,
  left: number,
  right: number,
): number {
  const safeTop = clamp(Math.floor(top), 0, image.height - 1);
  const safeBottom = clamp(Math.ceil(bottom), safeTop + 1, image.height);
  const safeLeft = clamp(Math.floor(left), 0, image.width - 1);
  const safeRight = clamp(Math.ceil(right), safeLeft + 1, image.width);
  let bestRatio = 0;

  for (let y = safeTop; y < safeBottom; y++) {
    let dark = 0;
    for (let x = safeLeft; x < safeRight; x++) {
      if (image.pixels[y * image.width + x] < 220) {
        dark++;
      }
    }

    bestRatio = Math.max(bestRatio, dark / (safeRight - safeLeft));
  }

  return bestRatio;
}

function darkRatioInColumns(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  left: number,
  right: number,
  top: number,
  bottom: number,
): number {
  const safeLeft = clamp(Math.floor(left), 0, image.width - 1);
  const safeRight = clamp(Math.ceil(right), safeLeft + 1, image.width);
  const safeTop = clamp(Math.floor(top), 0, image.height - 1);
  const safeBottom = clamp(Math.ceil(bottom), safeTop + 1, image.height);
  let bestRatio = 0;

  for (let x = safeLeft; x < safeRight; x++) {
    let dark = 0;
    for (let y = safeTop; y < safeBottom; y++) {
      if (image.pixels[y * image.width + x] < 220) {
        dark++;
      }
    }

    bestRatio = Math.max(bestRatio, dark / (safeBottom - safeTop));
  }

  return bestRatio;
}
