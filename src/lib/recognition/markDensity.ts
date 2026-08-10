import sharp from 'sharp';
import { ChoiceGroup, NormalizedRect } from './roiTemplates';

export type ContentBoundsSource = 'frame' | 'paper' | 'template' | 'dark';

export interface ImageAnalysisData {
  width: number;
  height: number;
  pixels: Buffer;
  contentBounds?: PixelBounds;
  contentBoundsSource?: ContentBoundsSource;
  pageBounds?: PixelBounds;
  contentBoundsConfident: boolean;
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

export interface ChoiceGroupResult {
  field: string;
  value?: number | string;
  confidence: 'high' | 'medium' | 'low';
  candidates: CandidateScore[];
}

export interface ChoiceGroupBaseline {
  image: ImageAnalysisData;
  candidatePixelOverrides: PixelRect[];
}

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

  return {
    width,
    height,
    pixels,
    contentBounds,
    contentBoundsSource,
    pageBounds: pageBounds || undefined,
    contentBoundsConfident: paperContentBounds !== null || frameBounds !== null,
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
  if (!registrationFrame || !image.pageBounds || !isPlausiblePaperBounds(image, image.pageBounds)) {
    return image;
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

  if (
    contentBounds.right <= contentBounds.left + 1
    || contentBounds.bottom <= contentBounds.top + 1
    || !isPlausibleTemplateContentBounds(page, contentBounds)
  ) {
    return image;
  }

  return {
    ...image,
    contentBounds,
    contentBoundsSource: 'template',
    contentBoundsConfident: true,
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
  if (image.contentBoundsSource === 'dark') {
    return false;
  }

  const bounds = image.contentBounds;
  if (!bounds) {
    return false;
  }

  const documentBounds = image.pageBounds || bounds;
  if (!isPlausiblePaperBounds(image, documentBounds)) {
    return false;
  }

  // For a detected page, the content frame is intentionally inset from all
  // four sheet edges. Judge registration confidence using the outer paper
  // bounds, then ensure the inner template frame remains plausibly large and
  // contained. Older callers without a page keep the legacy edge checks.
  if (image.pageBounds) {
    return isPlausibleTemplateContentBounds(image.pageBounds, bounds);
  }

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const aspectRatio = height / width;

  return (
    width >= image.width * 0.72 &&
    height >= image.height * 0.78 &&
    bounds.left <= image.width * 0.16 &&
    bounds.right >= image.width * 0.84 &&
    bounds.top <= image.height * 0.16 &&
    bounds.bottom >= image.height * 0.84 &&
    aspectRatio >= 1.05 &&
    aspectRatio <= 1.9
  );
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
  const candidates = group.candidates
    .map((candidate, index) => ({
      value: candidate.value,
      score: roundScore(
        usesBaseline
          ? calculateTemplateInkDifference(
            image,
            usesGridCells ? candidatePixelOverrides![index] : toPixelRect(image, candidate.rect, yOverride),
            baseline!.image,
            baseline!.candidatePixelOverrides[index],
          )
          : calculateDarkPixelDensity(
            image,
            candidate.rect,
            150,
            yOverride,
            usesGridCells ? candidatePixelOverrides[index] : undefined,
          ),
      ),
    }))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const second = candidates[1];

  if (!best) {
    return {
      field: group.field,
      confidence: 'low',
      candidates,
    };
  }

  // A fallback content bound may still produce plausible-looking candidate scores.
  // Never turn those scores into automatic data when the page frame was not trusted.
  if (!allowAutoValue) {
    return {
      field: group.field,
      confidence: 'low',
      candidates,
    };
  }

  const gap = best.score - (second?.score || 0);
  const highScoreThreshold = usesBaseline ? 0.018 : 0.35;
  const highGapThreshold = usesBaseline ? 0.009 : 0.12;
  const mediumScoreThreshold = usesBaseline ? 0.007 : 0.1;
  const mediumGapThreshold = usesBaseline ? 0.003 : 0.025;

  if (best.score >= highScoreThreshold && gap >= highGapThreshold) {
    return {
      field: group.field,
      value: best.value,
      confidence: 'high',
      candidates,
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
    };
  }

  return {
    field: group.field,
    confidence: 'low',
    candidates,
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
  const sampleWidth = 36;
  const sampleHeight = 28;
  const actual = sampleRect(image, actualRect, sampleWidth, sampleHeight);
  const blank = sampleRect(baseline, baselineRect, sampleWidth, sampleHeight);
  if (actual.length === 0 || blank.length === 0) {
    return 0;
  }

  // Different scanners change the paper's overall brightness. Normalize only
  // the light background before comparing dark ink, keeping local pen strokes.
  const brightnessOffset = percentile(blank, 0.82) - percentile(actual, 0.82);
  const alignment = findBestBaselineAlignment(actual, blank, sampleWidth, sampleHeight, brightnessOffset);
  let difference = 0;

  for (let y = 1; y < sampleHeight - 1; y++) {
    for (let x = 1; x < sampleWidth - 1; x++) {
      const index = y * sampleWidth + x;
      const baselineIndex = (y + alignment.y) * sampleWidth + (x + alignment.x);
      const actualInk = darkness(actual[index] + brightnessOffset);
      const baselineInk = darkness(blank[baselineIndex]);
      // Ignore the narrow anti-aliasing and scanner-noise band around the
      // printed form. A handwritten circle or check remains well above it.
      difference += Math.max(0, actualInk - baselineInk - 0.08);
    }
  }

  const usablePixels = Math.max((sampleWidth - 2) * (sampleHeight - 2), 1);
  return difference / usablePixels;
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

function findBestBaselineAlignment(
  actual: number[],
  baseline: number[],
  width: number,
  height: number,
  brightnessOffset: number,
): { x: number; y: number } {
  let best = { x: 0, y: 0, score: Number.POSITIVE_INFINITY };

  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      let score = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const actualInk = darkness(actual[y * width + x] + brightnessOffset);
          const baselineInk = darkness(baseline[(y + offsetY) * width + (x + offsetX)]);
          score += Math.abs(actualInk - baselineInk);
        }
      }
      if (score < best.score) {
        best = { x: offsetX, y: offsetY, score };
      }
    }
  }

  return best;
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
