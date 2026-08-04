import { ImageAnalysisData } from './markDensity';
import {
  cagiLateQuestionYs,
  cagiQuestionYs,
  satisfactionBinaryYs,
  satisfactionScaleYs,
} from './roiTemplates';
import { detectOcrTextLines } from './ocrTextLines';

export interface HorizontalLine {
  y: number;
}

export interface RowMatchResult {
  lineYs: number[];
  confident: boolean;
}

export interface RowYOverride {
  top: number;
  bottom: number;
}

export function detectHorizontalLines(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  searchTop: number,
  searchBottom: number,
  xLeft: number,
  xRight: number,
  minDarkRatio = 0.5,
  darkThreshold = 200,
): HorizontalLine[] {
  const top = clamp(Math.floor(searchTop), 0, image.height - 1);
  const bottom = clamp(Math.ceil(searchBottom), top + 1, image.height);
  const left = clamp(Math.floor(xLeft), 0, image.width - 1);
  const right = clamp(Math.ceil(xRight), left + 1, image.width);
  const width = right - left;
  const darkRows: number[] = [];

  for (let y = top; y < bottom; y++) {
    let darkCount = 0;
    for (let x = left; x < right; x++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }

    if (darkCount / width >= minDarkRatio) {
      darkRows.push(y);
    }
  }

  const lines: HorizontalLine[] = [];
  let groupStart: number | null = null;
  let previous = -1;

  for (const y of darkRows) {
    if (groupStart === null) {
      groupStart = y;
      previous = y;
      continue;
    }

    if (y === previous + 1) {
      previous = y;
      continue;
    }

    lines.push({ y: (groupStart + previous) / 2 });
    groupStart = y;
    previous = y;
  }

  if (groupStart !== null) {
    lines.push({ y: (groupStart + previous) / 2 });
  }

  return lines;
}

export function matchRowPattern(
  detectedLines: HorizontalLine[],
  expectedRelativeGaps: number[],
  toleranceRatio = 0.35,
): RowMatchResult | null {
  const requiredLineCount = expectedRelativeGaps.length + 1;
  if (requiredLineCount < 2 || detectedLines.length < requiredLineCount) {
    return null;
  }

  const sortedLines = [...detectedLines].sort((a, b) => a.y - b.y);

  for (let start = 0; start <= sortedLines.length - requiredLineCount; start++) {
    const candidateLines = sortedLines.slice(start, start + requiredLineCount);
    const gaps = getPositiveGaps(candidateLines.map((line) => line.y));
    if (!gaps) {
      continue;
    }

    const firstGap = gaps[0];
    const actualRelativeGaps = gaps.map((gap) => gap / firstGap);
    const matched = actualRelativeGaps.every((gap, index) => {
      const expected = expectedRelativeGaps[index];
      return Math.abs(gap - expected) / expected <= toleranceRatio;
    });

    if (matched) {
      return {
        lineYs: candidateLines.map((line) => line.y),
        confident: true,
      };
    }
  }

  return null;
}

export function buildCagiRowOverrides(image: ImageAnalysisData): Record<string, RowYOverride>;
export function buildCagiRowOverrides(image: ImageAnalysisData, imageBuffer: Buffer): Promise<Record<string, RowYOverride>>;
export function buildCagiRowOverrides(
  image: ImageAnalysisData,
  imageBuffer?: Buffer,
): Record<string, RowYOverride> | Promise<Record<string, RowYOverride>> {
  const questionYs = [...cagiQuestionYs, ...cagiLateQuestionYs];
  const fields = questionYs.map((_, index) => `cagi.q${String(index + 1).padStart(2, '0')}`);

  if (imageBuffer) {
    return buildRowOverridesAsync(image, imageBuffer, questionYs, fields);
  }

  return buildRowOverridesSync(image, questionYs, fields);
}

export function buildSatisfactionRowOverrides(image: ImageAnalysisData): Record<string, RowYOverride>;
export function buildSatisfactionRowOverrides(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
): Promise<Record<string, RowYOverride>>;
export function buildSatisfactionRowOverrides(
  image: ImageAnalysisData,
  imageBuffer?: Buffer,
): Record<string, RowYOverride> | Promise<Record<string, RowYOverride>> {
  if (imageBuffer) {
    return buildSatisfactionRowOverridesAsync(image, imageBuffer);
  }

  return {
    ...buildSatisfactionGroupOverrides(image, satisfactionBinaryYs, 2),
    ...buildSatisfactionGroupOverrides(image, satisfactionScaleYs, 7),
  };
}

async function buildSatisfactionRowOverridesAsync(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
): Promise<Record<string, RowYOverride>> {
  return {
    ...(await buildSatisfactionGroupOverridesAsync(image, imageBuffer, satisfactionBinaryYs, 2)),
    ...(await buildSatisfactionGroupOverridesAsync(image, imageBuffer, satisfactionScaleYs, 7)),
  };
}

function buildSatisfactionGroupOverrides(
  image: ImageAnalysisData,
  rowYs: number[],
  firstQuestionNumber: number,
): Record<string, RowYOverride> {
  return buildRowOverridesSync(
    image,
    rowYs,
    rowYs.map((_, index) => `satisfaction.q${String(firstQuestionNumber + index).padStart(2, '0')}`),
  );
}

async function buildSatisfactionGroupOverridesAsync(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  rowYs: number[],
  firstQuestionNumber: number,
): Promise<Record<string, RowYOverride>> {
  return buildRowOverridesAsync(
    image,
    imageBuffer,
    rowYs,
    rowYs.map((_, index) => `satisfaction.q${String(firstQuestionNumber + index).padStart(2, '0')}`),
  );
}

function buildRowOverridesSync(
  image: ImageAnalysisData,
  templateYs: number[],
  fields: string[],
): Record<string, RowYOverride> {
  const match = findRowMatch(image, templateYs);
  if (!match?.confident) {
    return {};
  }

  return buildOverridesFromRowCenters(match.lineYs, fields, image.height);
}

async function buildRowOverridesAsync(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  templateYs: number[],
  fields: string[],
): Promise<Record<string, RowYOverride>> {
  const match = await findRowMatch(image, templateYs, imageBuffer);
  if (!match?.confident) {
    return {};
  }

  return buildOverridesFromRowCenters(match.lineYs, fields, image.height);
}

function findRowMatch(image: ImageAnalysisData, templateYs: number[]): RowMatchResult | null;
function findRowMatch(
  image: ImageAnalysisData,
  templateYs: number[],
  imageBuffer: Buffer,
): Promise<RowMatchResult | null>;
function findRowMatch(
  image: ImageAnalysisData,
  templateYs: number[],
  imageBuffer?: Buffer,
): RowMatchResult | null | Promise<RowMatchResult | null> {
  const expectedRelativeGaps = buildExpectedRelativeGaps(templateYs);
  if (expectedRelativeGaps.length === 0) {
    return null;
  }

  const bounds = image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
  const baseWidth = bounds.right - bounds.left;
  const searchTop = image.height * 0.15;
  const searchBottom = image.height * 0.9;
  const xLeft = bounds.left + baseWidth * 0.08;
  const xRight = bounds.right - baseWidth * 0.02;

  if (imageBuffer) {
    return findRowMatchWithOcrFallback(image, imageBuffer, expectedRelativeGaps, searchTop, searchBottom, xLeft, xRight);
  }

  const detectedLines = detectHorizontalLines(image, searchTop, searchBottom, xLeft, xRight);

  return matchRowPattern(detectedLines, expectedRelativeGaps);
}

async function findRowMatchWithOcrFallback(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  expectedRelativeGaps: number[],
  searchTop: number,
  searchBottom: number,
  xLeft: number,
  xRight: number,
): Promise<RowMatchResult | null> {
  const ocrLines = await detectOcrTextLines(
    imageBuffer,
    image.width,
    image.height,
    searchTop,
    searchBottom,
    xLeft,
    xRight,
  );
  const ocrMatch = matchRowPattern(ocrLines, expectedRelativeGaps);
  if (ocrMatch?.confident) {
    return ocrMatch;
  }

  const detectedLines = detectHorizontalLines(image, searchTop, searchBottom, xLeft, xRight);
  return matchRowPattern(detectedLines, expectedRelativeGaps);
}

function buildExpectedRelativeGaps(ys: number[]): number[] {
  const gaps = getPositiveGaps(ys);
  if (!gaps) {
    return [];
  }

  const firstGap = gaps[0];
  return gaps.map((gap) => gap / firstGap);
}

function buildOverridesFromRowCenters(
  rowCenters: number[],
  fields: string[],
  imageHeight: number,
): Record<string, RowYOverride> {
  if (rowCenters.length !== fields.length) {
    return {};
  }

  const overrides: Record<string, RowYOverride> = {};
  for (let index = 0; index < rowCenters.length; index++) {
    const previousGap = index > 0 ? rowCenters[index] - rowCenters[index - 1] : null;
    const nextGap = index < rowCenters.length - 1 ? rowCenters[index + 1] - rowCenters[index] : null;
    const interval = previousGap && nextGap ? Math.min(previousGap, nextGap) : previousGap || nextGap;

    if (!interval || interval <= 0) {
      return {};
    }

    // Margin is wider than it looks strictly necessary for: matched lines are assumed to sit
    // at the same relative spacing as roiTemplates.ts's row-center Ys, but on a real form the
    // most reliably detectable lines are likely row *separators*, not row *centers* -- if that
    // shifts every matched line by up to ~half a row, a narrow window would miss the mark
    // entirely. 0.45 keeps neighboring rows' windows from touching while tolerating that offset.
    overrides[fields[index]] = {
      top: clamp(Math.floor(rowCenters[index] - interval * 0.45), 0, imageHeight - 1),
      bottom: clamp(Math.ceil(rowCenters[index] + interval * 0.45), 1, imageHeight),
    };
  }

  return overrides;
}

function getPositiveGaps(values: number[]): number[] | null {
  if (values.length < 2) {
    return null;
  }

  const gaps: number[] = [];
  for (let index = 1; index < values.length; index++) {
    const gap = values[index] - values[index - 1];
    if (gap <= 0) {
      return null;
    }
    gaps.push(gap);
  }

  return gaps;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
