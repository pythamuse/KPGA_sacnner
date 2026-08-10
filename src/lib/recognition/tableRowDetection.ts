import { ImageAnalysisData } from './markDensity';
import {
  cagiLateQuestionYs,
  cagiQuestionYs,
  satisfactionBinaryYs,
  satisfactionScaleYs,
  satisfactionTemplate,
} from './roiTemplates';
import { detectOcrTextLines, type OcrOptions } from './ocrTextLines';

export interface HorizontalLine {
  y: number;
}

export interface RowMatchResult {
  lineYs: number[];
  confident: boolean;
  diagnostic?: string;
}

export interface RowYOverride {
  top: number;
  bottom: number;
}

export interface RowDetectionResult {
  overrides: Record<string, RowYOverride>;
  diagnostics?: Record<string, string>;
}

// The printed form contains intentionally uneven rows (for example, two-line
// questions). Match the measured template gap pattern instead of assuming all
// table rules are evenly spaced.
export const ROW_PATTERN_TOLERANCE_RATIO = 0.35;

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
  toleranceRatio = ROW_PATTERN_TOLERANCE_RATIO,
): RowMatchResult | null {
  return evaluateRowPattern(
    detectedLines,
    expectedRelativeGaps,
    toleranceRatio,
  ).match;
}

function evaluateRowPattern(
  detectedLines: HorizontalLine[],
  expectedRelativeGaps: number[],
  toleranceRatio = ROW_PATTERN_TOLERANCE_RATIO,
): { match: RowMatchResult | null; failure?: RowPatternFailure } {
  const requiredLineCount = expectedRelativeGaps.length + 1;
  if (requiredLineCount < 2) {
    return {
      match: null,
      failure: { reason: 'lines_undetected', detail: `행 선 0/${requiredLineCount}개` },
    };
  }

  if (detectedLines.length === 0) {
    return {
      match: null,
      failure: { reason: 'lines_undetected', detail: `행 선 0/${requiredLineCount}개` },
    };
  }

  if (detectedLines.length < requiredLineCount) {
    return {
      match: null,
      failure: { reason: 'insufficient_lines', detail: `행 선 ${detectedLines.length}/${requiredLineCount}개` },
    };
  }

  const sortedLines = [...detectedLines].sort((a, b) => a.y - b.y);
  let bestDeviation: number | undefined;

  for (let start = 0; start <= sortedLines.length - requiredLineCount; start++) {
    const candidateLines = sortedLines.slice(start, start + requiredLineCount);
    const gaps = getPositiveGaps(candidateLines.map((line) => line.y));
    if (!gaps) {
      continue;
    }

    const firstGap = gaps[0];
    const actualRelativeGaps = gaps.map((gap) => gap / firstGap);
    const deviations = actualRelativeGaps.map((gap, index) => {
      const expected = expectedRelativeGaps[index];
      return Math.abs(gap - expected) / expected;
    });
    const candidateDeviation = Math.max(...deviations);
    if (bestDeviation === undefined || candidateDeviation < bestDeviation) {
      bestDeviation = candidateDeviation;
    }

    if (deviations.every((deviation) => deviation <= toleranceRatio)) {
      return {
        match: {
          lineYs: candidateLines.map((line) => line.y),
          confident: true,
        },
      };
    }
  }

  return {
    match: null,
    failure: {
      reason: 'gap_mismatch',
      detail: bestDeviation === undefined
        ? '행 선 간격 패턴 불일치'
        : `행 선 간격 패턴 불일치 (최대 편차 ${Math.round(bestDeviation * 100)}% (허용 ${Math.round(toleranceRatio * 100)}%))`,
    },
  };
}

export function buildCagiRowOverrides(image: ImageAnalysisData): Record<string, RowYOverride>;
export function buildCagiRowOverrides(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  ocrOptions?: OcrOptions,
): Promise<Record<string, RowYOverride>>;
export function buildCagiRowOverrides(
  image: ImageAnalysisData,
  imageBuffer?: Buffer,
  ocrOptions?: OcrOptions,
): Record<string, RowYOverride> | Promise<Record<string, RowYOverride>> {
  const detection = imageBuffer
    ? buildCagiRowDetection(image, imageBuffer, ocrOptions)
    : buildCagiRowDetection(image);
  return detection instanceof Promise ? detection.then((result) => result.overrides) : detection.overrides;
}

export function buildCagiRowDetection(image: ImageAnalysisData): RowDetectionResult;
export function buildCagiRowDetection(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  ocrOptions?: OcrOptions,
): Promise<RowDetectionResult>;
export function buildCagiRowDetection(
  image: ImageAnalysisData,
  imageBuffer?: Buffer,
  ocrOptions?: OcrOptions,
): RowDetectionResult | Promise<RowDetectionResult> {
  const primaryFields = cagiQuestionYs.map((_, index) => `cagi.q${String(index + 1).padStart(2, '0')}`);
  const lateFields = cagiLateQuestionYs.map((_, index) => `cagi.q${String(index + 8).padStart(2, '0')}`);

  if (imageBuffer) {
    return Promise.all([
      buildRowDetectionAsync(image, imageBuffer, cagiQuestionYs, primaryFields, ocrOptions),
      buildRowDetectionAsync(image, imageBuffer, cagiLateQuestionYs, lateFields, ocrOptions),
    ]).then(([primary, late]) => mergeRowDetectionResults(primary, late));
  }

  return mergeRowDetectionResults(
    buildRowDetectionSync(image, cagiQuestionYs, primaryFields),
    buildRowDetectionSync(image, cagiLateQuestionYs, lateFields),
  );
}

export function buildSatisfactionRowOverrides(image: ImageAnalysisData): Record<string, RowYOverride>;
export function buildSatisfactionRowOverrides(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  ocrOptions?: OcrOptions,
): Promise<Record<string, RowYOverride>>;
export function buildSatisfactionRowOverrides(
  image: ImageAnalysisData,
  imageBuffer?: Buffer,
  ocrOptions?: OcrOptions,
): Record<string, RowYOverride> | Promise<Record<string, RowYOverride>> {
  const detection = imageBuffer
    ? buildSatisfactionRowDetection(image, imageBuffer, ocrOptions)
    : buildSatisfactionRowDetection(image);
  return detection instanceof Promise ? detection.then((result) => result.overrides) : detection.overrides;
}

export function buildSatisfactionRowDetection(image: ImageAnalysisData): RowDetectionResult;
export function buildSatisfactionRowDetection(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  ocrOptions?: OcrOptions,
): Promise<RowDetectionResult>;
export function buildSatisfactionRowDetection(
  image: ImageAnalysisData,
  imageBuffer?: Buffer,
  ocrOptions?: OcrOptions,
): RowDetectionResult | Promise<RowDetectionResult> {
  if (imageBuffer) {
    return buildSatisfactionRowDetectionAsync(image, imageBuffer, ocrOptions);
  }

  return mergeRowDetectionResults(
    buildSatisfactionQuestionOneDetection(image),
    buildSatisfactionGroupDetection(image, satisfactionBinaryYs, 2),
    buildSatisfactionGroupDetection(image, satisfactionScaleYs, 7),
  );
}

async function buildSatisfactionRowDetectionAsync(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  ocrOptions?: OcrOptions,
): Promise<RowDetectionResult> {
  return mergeRowDetectionResults(
    buildSatisfactionQuestionOneDetection(image),
    await buildSatisfactionGroupDetectionAsync(image, imageBuffer, satisfactionBinaryYs, 2, ocrOptions),
    await buildSatisfactionGroupDetectionAsync(image, imageBuffer, satisfactionScaleYs, 7, ocrOptions),
  );
}

function buildSatisfactionQuestionOneDetection(image: ImageAnalysisData): RowDetectionResult {
  const group = satisfactionTemplate.choiceGroups.find((item) => item.field === 'satisfaction.q01');
  if (!group) {
    return { overrides: {} };
  }

  const bounds = image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const templateY = group.candidates[0]
    ? group.candidates[0].rect.y + group.candidates[0].rect.height / 2
    : 0.43;
  const centerY = bounds.top + templateY * baseHeight;
  const searchPadding = Math.max(24, Math.round(baseHeight * 0.04));
  const answerLeft = Math.min(...group.candidates.map((candidate) => candidate.rect.x));
  const answerRight = Math.max(...group.candidates.map((candidate) => candidate.rect.x + candidate.rect.width));
  const xPadding = Math.max(12, Math.round(baseWidth * 0.03));
  const lines = detectHorizontalLines(
    image,
    centerY - searchPadding,
    centerY + searchPadding,
    bounds.left + answerLeft * baseWidth - xPadding,
    bounds.left + answerRight * baseWidth + xPadding,
    0.3,
  );

  let bestPair: [number, number] | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  const sortedLines = [...lines].sort((a, b) => a.y - b.y);
  for (let first = 0; first < sortedLines.length - 1; first++) {
    for (let second = first + 1; second < sortedLines.length; second++) {
      const top = sortedLines[first].y;
      const bottom = sortedLines[second].y;
      if (top >= centerY || bottom <= centerY) {
        continue;
      }

      const distance = Math.abs((top + bottom) / 2 - centerY);
      if (distance < bestDistance) {
        bestPair = [top, bottom];
        bestDistance = distance;
      }
    }
  }

  if (!bestPair) {
    return {
      overrides: {},
      diagnostics: {
        'satisfaction.q01': `행: 픽셀 insufficient_lines (문항1 행 경계 ${lines.length}/2개)`,
      },
    };
  }

  const center = (bestPair[0] + bestPair[1]) / 2;
  const interval = bestPair[1] - bestPair[0];
  return {
    overrides: {
      'satisfaction.q01': {
        top: clamp(Math.floor(center - interval * 0.45), 0, image.height - 1),
        bottom: clamp(Math.ceil(center + interval * 0.45), 1, image.height),
      },
    },
  };
}

function buildSatisfactionGroupDetection(
  image: ImageAnalysisData,
  rowYs: number[],
  firstQuestionNumber: number,
): RowDetectionResult {
  return buildRowDetectionSync(
    image,
    rowYs,
    rowYs.map((_, index) => `satisfaction.q${String(firstQuestionNumber + index).padStart(2, '0')}`),
  );
}

async function buildSatisfactionGroupDetectionAsync(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  rowYs: number[],
  firstQuestionNumber: number,
  ocrOptions?: OcrOptions,
): Promise<RowDetectionResult> {
  return buildRowDetectionAsync(
    image,
    imageBuffer,
    rowYs,
    rowYs.map((_, index) => `satisfaction.q${String(firstQuestionNumber + index).padStart(2, '0')}`),
    ocrOptions,
  );
}

function buildRowDetectionSync(
  image: ImageAnalysisData,
  templateYs: number[],
  fields: string[],
): RowDetectionResult {
  const match = findRowMatch(image, templateYs);
  if (!match?.confident) {
    return match?.diagnostic
      ? { overrides: {}, diagnostics: diagnosticsForFields(fields, match.diagnostic) }
      : { overrides: {} };
  }

  return { overrides: buildOverridesFromRowCenters(match.lineYs, fields, image.height) };
}

async function buildRowDetectionAsync(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  templateYs: number[],
  fields: string[],
  ocrOptions?: OcrOptions,
): Promise<RowDetectionResult> {
  const match = await findRowMatch(image, templateYs, imageBuffer, ocrOptions);
  if (!match?.confident) {
    return match?.diagnostic
      ? { overrides: {}, diagnostics: diagnosticsForFields(fields, match.diagnostic) }
      : { overrides: {} };
  }

  return { overrides: buildOverridesFromRowCenters(match.lineYs, fields, image.height) };
}

function mergeRowDetectionResults(...results: RowDetectionResult[]): RowDetectionResult {
  const diagnostics = results.reduce<Record<string, string>>(
    (merged, result) => ({ ...merged, ...(result.diagnostics || {}) }),
    {},
  );

  return {
    overrides: results.reduce<Record<string, RowYOverride>>(
      (merged, result) => ({ ...merged, ...result.overrides }),
      {},
    ),
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
  };
}

function diagnosticsForFields(fields: string[], diagnostic: string): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, diagnostic]));
}

function findRowMatch(image: ImageAnalysisData, templateYs: number[]): RowMatchResult;
function findRowMatch(
  image: ImageAnalysisData,
  templateYs: number[],
  imageBuffer: Buffer,
  ocrOptions?: OcrOptions,
): Promise<RowMatchResult>;
function findRowMatch(
  image: ImageAnalysisData,
  templateYs: number[],
  imageBuffer?: Buffer,
  ocrOptions?: OcrOptions,
): RowMatchResult | Promise<RowMatchResult> {
  const expectedRelativeGaps = buildExpectedRelativeGaps(templateYs);
  if (expectedRelativeGaps.length === 0) {
    return createFailureResult({ reason: 'lines_undetected', detail: '행 선 패턴 없음' }, '픽셀');
  }

  const bounds = image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
  const baseWidth = bounds.right - bounds.left;
  // A non-confident content bound can be just the dark answer lines rather
  // than the page frame. In that case template Ys still refer to full-page
  // coordinates, so use the image itself as the broad search anchor.
  const yReference = image.contentBoundsConfident ? bounds : {
    top: 0,
    bottom: image.height,
  };
  const templateTop = yReference.top + Math.min(...templateYs) * (yReference.bottom - yReference.top);
  const templateBottom = yReference.top + Math.max(...templateYs) * (yReference.bottom - yReference.top);
  const searchPadding = Math.max(24, Math.round((yReference.bottom - yReference.top) * 0.04));
  const searchTop = clamp(templateTop - searchPadding, 0, image.height - 1);
  const searchBottom = clamp(templateBottom + searchPadding, searchTop + 1, image.height);
  const xLeft = bounds.left + baseWidth * 0.08;
  const xRight = bounds.right - baseWidth * 0.02;

  if (imageBuffer) {
    return findRowMatchWithOcrFallback(
      image,
      imageBuffer,
      expectedRelativeGaps,
      searchTop,
      searchBottom,
      xLeft,
      xRight,
      ocrOptions,
    );
  }

  const detectedLines = detectHorizontalLines(image, searchTop, searchBottom, xLeft, xRight, 0.3);
  const pixelEvaluation = evaluateRowPattern(detectedLines, expectedRelativeGaps);
  return pixelEvaluation.match || createFailureResult(
    pixelEvaluation.failure || classifyRowPatternFailure(detectedLines.length, expectedRelativeGaps.length + 1),
    '픽셀',
  );
}

async function findRowMatchWithOcrFallback(
  image: ImageAnalysisData,
  imageBuffer: Buffer,
  expectedRelativeGaps: number[],
  searchTop: number,
  searchBottom: number,
  xLeft: number,
  xRight: number,
  ocrOptions?: OcrOptions,
): Promise<RowMatchResult> {
  const detectedLines = detectHorizontalLines(image, searchTop, searchBottom, xLeft, xRight, 0.3);
  const pixelEvaluation = evaluateRowPattern(detectedLines, expectedRelativeGaps);
  if (pixelEvaluation.match?.confident) {
    return pixelEvaluation.match;
  }
  const pixelFailure = pixelEvaluation.failure
    || classifyRowPatternFailure(detectedLines.length, expectedRelativeGaps.length + 1);

  const ocrLines = await detectOcrTextLines(
    imageBuffer,
    image.width,
    image.height,
    searchTop,
    searchBottom,
    xLeft,
    xRight,
    ocrOptions,
  );
  const ocrEvaluation = evaluateRowPattern(ocrLines, expectedRelativeGaps);
  if (ocrEvaluation.match?.confident) {
    return ocrEvaluation.match;
  }
  const ocrFailure = ocrEvaluation.failure
    || classifyRowPatternFailure(ocrLines.length, expectedRelativeGaps.length + 1);

  return {
    lineYs: [],
    confident: false,
    diagnostic: [
      formatFailure('픽셀', pixelFailure),
      formatFailure('OCR', ocrFailure),
    ].join('; '),
  };
}

type RowFailureReason = 'lines_undetected' | 'insufficient_lines' | 'gap_mismatch';

interface RowPatternFailure {
  reason: RowFailureReason;
  detail: string;
}

function createFailureResult(failure: RowPatternFailure, source: string): RowMatchResult {
  return {
    lineYs: [],
    confident: false,
    diagnostic: formatFailure(source, failure),
  };
}

function formatFailure(source: string, failure: RowPatternFailure): string {
  return `행: ${source} ${failure.reason} (${failure.detail})`;
}

function classifyRowPatternFailure(found: number, required: number): RowPatternFailure {
  if (found === 0) {
    return { reason: 'lines_undetected', detail: `행 선 0/${required}개` };
  }

  if (found < required) {
    return { reason: 'insufficient_lines', detail: `행 선 ${found}/${required}개` };
  }

  return { reason: 'gap_mismatch', detail: '행 선 간격 패턴 불일치' };
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

function buildExpectedRelativeGaps(ys: number[]): number[] {
  const gaps = getPositiveGaps(ys);
  if (!gaps) {
    return [];
  }

  const firstGap = gaps[0];
  return gaps.map((gap) => gap / firstGap);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
