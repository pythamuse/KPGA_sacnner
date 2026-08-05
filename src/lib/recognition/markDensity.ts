import sharp from 'sharp';
import { ChoiceGroup, NormalizedRect } from './roiTemplates';

export interface ImageAnalysisData {
  width: number;
  height: number;
  pixels: Buffer;
  contentBounds?: PixelBounds;
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

  const frameBounds = detectFrameBounds({ width, height, pixels });

  return {
    width,
    height,
    pixels,
    contentBounds: frameBounds || detectDarkPixelBounds({ width, height, pixels }),
    contentBoundsConfident: frameBounds !== null,
  };
}

export function calculateDarkPixelDensity(
  image: ImageAnalysisData,
  normalizedRect: NormalizedRect,
  darkThreshold = 150,
  yOverride?: { top: number; bottom: number },
  pixelOverride?: PixelRect,
): number {
  const bounds = image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
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
  const frameBounds = detectFrameBounds(image);
  if (frameBounds) {
    return frameBounds;
  }

  return detectDarkPixelBounds(image);
}

function detectDarkPixelBounds(image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>): PixelBounds {
  const darkThreshold = 220;
  const minX = Math.floor(image.width * 0.02);
  const maxX = Math.ceil(image.width * 0.98);
  const minY = Math.floor(image.height * 0.05);
  const maxY = Math.ceil(image.height * 0.98);

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
      left: 0,
      top: 0,
      right: image.width,
      bottom: image.height,
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

function detectFrameBounds(image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>): PixelBounds | null {
  const darkThreshold = 220;
  const minX = Math.floor(image.width * 0.05);
  const maxX = Math.ceil(image.width * 0.95);
  const minY = Math.floor(image.height * 0.07);
  const maxY = Math.ceil(image.height * 0.95);
  const horizontalRows: number[] = [];

  for (let y = minY; y < maxY; y++) {
    let darkCount = 0;
    for (let x = minX; x < maxX; x++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }

    if (darkCount >= image.width * 0.35) {
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

  if ((right - left) < image.width * 0.58 || (bottom - top) < image.height * 0.62) {
    return null;
  }

  const bounds = { left, top, right, bottom };
  if (!isPlausibleFrameBounds(image, bounds)) {
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

export function analyzeChoiceGroup(
  image: ImageAnalysisData,
  group: ChoiceGroup,
  yOverride?: { top: number; bottom: number },
  allowAutoValue = true,
  candidatePixelOverrides?: PixelRect[],
): ChoiceGroupResult {
  const usesGridCells = candidatePixelOverrides?.length === group.candidates.length;
  const candidates = group.candidates
    .map((candidate, index) => ({
      value: candidate.value,
      score: roundScore(
        calculateDarkPixelDensity(
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

  if (best.score >= 0.35 && gap >= 0.12) {
    return {
      field: group.field,
      value: best.value,
      confidence: 'high',
      candidates,
    };
  }

  if (best.score >= 0.22 && gap >= 0.06) {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isPlausibleFrameBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height'>,
  bounds: PixelBounds,
): boolean {
  const frameWidth = bounds.right - bounds.left;
  const frameHeight = bounds.bottom - bounds.top;
  const aspectRatio = frameHeight / frameWidth;

  // The templates are portrait forms. Reject small internal tables or a partial
  // page frame before normalized ROI coordinates are allowed to drive recognition.
  return (
    frameWidth >= image.width * 0.7 &&
    frameHeight >= image.height * 0.78 &&
    bounds.left <= image.width * 0.2 &&
    bounds.right >= image.width * 0.8 &&
    bounds.top <= image.height * 0.2 &&
    bounds.bottom >= image.height * 0.8 &&
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
