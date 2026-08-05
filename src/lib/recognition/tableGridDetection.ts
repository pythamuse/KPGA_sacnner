import { type ImageAnalysisData, type PixelBounds, type PixelRect } from './markDensity';
import { cagiTemplate, satisfactionTemplate, type ChoiceGroup } from './roiTemplates';
import { detectHorizontalLines } from './tableRowDetection';

export interface VerticalLine {
  x: number;
}

export type FieldCellOverrides = Record<string, PixelRect[]>;

interface TableGridSpec {
  groups: ChoiceGroup[];
  enableTemplateAlignment?: boolean;
}

export interface GridDetectionResult {
  overrides: FieldCellOverrides;
  registeredFields: Set<string>;
}

/**
 * Finds long vertical table rules in a bounded table region. The horizontal
 * counterpart lives in tableRowDetection so row-only fallback remains shared.
 */
export function detectVerticalLines(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  searchTop: number,
  searchBottom: number,
  xLeft: number,
  xRight: number,
  minDarkRatio = 0.32,
  darkThreshold = 200,
): VerticalLine[] {
  const top = clamp(Math.floor(searchTop), 0, image.height - 1);
  const bottom = clamp(Math.ceil(searchBottom), top + 1, image.height);
  const left = clamp(Math.floor(xLeft), 0, image.width - 1);
  const right = clamp(Math.ceil(xRight), left + 1, image.width);
  const height = bottom - top;
  const darkColumns: number[] = [];

  for (let x = left; x < right; x++) {
    let darkCount = 0;
    for (let y = top; y < bottom; y++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }

    if (darkCount / height >= minDarkRatio) {
      darkColumns.push(x);
    }
  }

  return groupLinePositions(darkColumns).map((x) => ({ x }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildCagiGridOverrides(image: ImageAnalysisData): FieldCellOverrides {
  return buildCagiGridDetection(image).overrides;
}

export function buildCagiGridDetection(image: ImageAnalysisData): GridDetectionResult {
  return mergeGridDetection(image, [
    { groups: getGroups(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
    ]), enableTemplateAlignment: true },
    { groups: getGroups(cagiTemplate.choiceGroups, ['cagi.q08', 'cagi.q09']), enableTemplateAlignment: true },
  ]);
}

export function buildSatisfactionGridOverrides(image: ImageAnalysisData): FieldCellOverrides {
  return mergeGridDetection(image, [
    { groups: getGroups(satisfactionTemplate.choiceGroups, ['satisfaction.q01']) },
    { groups: getGroups(satisfactionTemplate.choiceGroups, [
      'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06',
    ]) },
    { groups: getGroups(satisfactionTemplate.choiceGroups, [
      'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
    ]) },
  ]).overrides;
}

function mergeGridDetection(image: ImageAnalysisData, specs: TableGridSpec[]): GridDetectionResult {
  if (!image.contentBoundsConfident) {
    return { overrides: {}, registeredFields: new Set() };
  }

  return specs.reduce<GridDetectionResult>((result, spec) => {
    const registered = spec.enableTemplateAlignment
      ? buildTemplateAlignedOverrides(image, spec)
      : {};
    const exact = buildGridOverrides(image, spec);
    const registeredFields = new Set(result.registeredFields);

    for (const field of Object.keys(registered)) {
      if (!exact[field]) {
        registeredFields.add(field);
      }
    }
    for (const field of Object.keys(exact)) {
      registeredFields.delete(field);
    }

    return {
      overrides: { ...result.overrides, ...registered, ...exact },
      registeredFields,
    };
  }, { overrides: {}, registeredFields: new Set() });
}

function buildGridOverrides(image: ImageAnalysisData, spec: TableGridSpec): FieldCellOverrides {
  const { groups } = spec;
  const firstGroup = groups[0];
  if (!firstGroup || groups.some((group) => group.candidates.length !== firstGroup.candidates.length)) {
    return {};
  }

  const bounds = getBounds(image);
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const columnCenters = firstGroup.candidates.map((candidate) => candidate.rect.x + candidate.rect.width / 2);
  const rowCenters = groups.map((group) => average(
    group.candidates.map((candidate) => candidate.rect.y + candidate.rect.height / 2),
  ));
  const averageColumnSize = average(firstGroup.candidates.map((candidate) => candidate.rect.width));
  const averageRowSize = average(groups.flatMap((group) => group.candidates.map((candidate) => candidate.rect.height)));
  const expectedColumnLines = deriveCellBoundaries(columnCenters, averageColumnSize);
  const expectedRowLines = deriveCellBoundaries(rowCenters, averageRowSize);

  const expectedX = expectedColumnLines.map((value) => bounds.left + value * baseWidth);
  const expectedY = expectedRowLines.map((value) => bounds.top + value * baseHeight);
  const xTolerance = Math.max(8, Math.round(baseWidth * 0.035));
  const yTolerance = Math.max(8, Math.round(baseHeight * 0.03));

  const horizontalLines = detectHorizontalLines(
    image,
    expectedY[0] - yTolerance,
    expectedY[expectedY.length - 1] + yTolerance,
    expectedX[0] - xTolerance,
    expectedX[expectedX.length - 1] + xTolerance,
    0.3,
  ).map((line) => line.y);
  const verticalLines = detectVerticalLines(
    image,
    expectedY[0] - yTolerance,
    expectedY[expectedY.length - 1] + yTolerance,
    expectedX[0] - xTolerance,
    expectedX[expectedX.length - 1] + xTolerance,
  ).map((line) => line.x);

  const matchedRows = matchExpectedLines(horizontalLines, expectedY, yTolerance);
  const matchedColumns = matchExpectedLines(verticalLines, expectedX, xTolerance);
  if (!matchedRows || !matchedColumns || !hasConsistentGaps(matchedRows, expectedY) || !hasConsistentGaps(matchedColumns, expectedX)) {
    return {};
  }

  const overrides: FieldCellOverrides = {};
  for (let rowIndex = 0; rowIndex < groups.length; rowIndex++) {
    const group = groups[rowIndex];
    const top = matchedRows[rowIndex];
    const bottom = matchedRows[rowIndex + 1];
    const candidates = group.candidates.map((_, columnIndex) => buildCellCenterRect(
      matchedColumns[columnIndex],
      matchedColumns[columnIndex + 1],
      top,
      bottom,
    ));

    if (candidates.some((rect) => rect.right - rect.left < 4 || rect.bottom - rect.top < 4)) {
      return {};
    }

    overrides[group.field] = candidates;
  }

  return overrides;
}

/**
 * When perspective makes one table rule drift across rows, a single global
 * x/y line cannot describe every cell. Align the repeated printed response
 * circles before falling back to the static template positions.
 */
function buildTemplateAlignedOverrides(image: ImageAnalysisData, spec: TableGridSpec): FieldCellOverrides {
  const { groups } = spec;
  if (groups.length < 2 || !image.contentBoundsConfident) {
    return {};
  }

  const bounds = getBounds(image);
  const baseline: GridTransform = { xScale: 1, xOffset: 0, yScale: 1, yOffset: 0 };
  let transform = baseline;
  transform = findBestAxisTransform(image, groups, bounds, transform, 'x');
  transform = findBestAxisTransform(image, groups, bounds, transform, 'y');
  transform = findBestAxisTransform(image, groups, bounds, transform, 'x');

  const baselineScore = scoreTransform(image, groups, bounds, baseline);
  const score = scoreTransform(image, groups, bounds, transform);
  if (!isRegistrationConfident(score, baselineScore, transform)) {
    return {};
  }

  return Object.fromEntries(groups.map((group) => [
    group.field,
    group.candidates.map((candidate) => toPixelRect(candidate.rect, bounds, transform)),
  ]));
}

interface GridTransform {
  xScale: number;
  xOffset: number;
  yScale: number;
  yOffset: number;
}

function findBestAxisTransform(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
  bounds: PixelBounds,
  current: GridTransform,
  axis: 'x' | 'y',
): GridTransform {
  let best = current;
  let bestScore = scoreTransform(image, groups, bounds, current);
  const scaleValues = axis === 'x'
    ? [0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2]
    : [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3];
  const offsetValues = [-0.14, -0.12, -0.1, -0.08, -0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16, 0.18];

  for (const scale of scaleValues) {
    for (const offset of offsetValues) {
      const candidate = axis === 'x'
        ? { ...current, xScale: scale, xOffset: offset }
        : { ...current, yScale: scale, yOffset: offset };
      const score = scoreTransform(image, groups, bounds, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
  }

  return best;
}

function scoreTransform(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
  bounds: PixelBounds,
  transform: GridTransform,
): number {
  const scores = groups.flatMap((group) => group.candidates.map((candidate) => {
    const rect = toPixelRect(candidate.rect, bounds, transform);
    return isInsideBounds(rect, bounds) ? sampleDarkDensity(image, rect) : 0;
  })).sort((left, right) => left - right);

  if (scores.length === 0) {
    return 0;
  }

  // The marked option can be much darker than the pre-printed circles. Use
  // the middle half so registration is driven by the repeated form pattern.
  const start = Math.floor(scores.length * 0.25);
  const end = Math.max(start + 1, Math.ceil(scores.length * 0.75));
  return average(scores.slice(start, end));
}

function sampleDarkDensity(image: ImageAnalysisData, rect: PixelRect): number {
  const left = clamp(Math.floor(rect.left), 0, image.width - 1);
  const top = clamp(Math.floor(rect.top), 0, image.height - 1);
  const right = clamp(Math.ceil(rect.right), left + 1, image.width);
  const bottom = clamp(Math.ceil(rect.bottom), top + 1, image.height);
  const stride = 3;
  let dark = 0;
  let total = 0;

  for (let y = top; y < bottom; y += stride) {
    for (let x = left; x < right; x += stride) {
      if (image.pixels[y * image.width + x] < 150) {
        dark++;
      }
      total++;
    }
  }

  return total === 0 ? 0 : dark / total;
}

function toPixelRect(
  rect: { x: number; y: number; width: number; height: number },
  bounds: PixelBounds,
  transform: GridTransform,
): PixelRect {
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const centerX = bounds.left + (transform.xOffset + (rect.x + rect.width / 2) * transform.xScale) * baseWidth;
  const centerY = bounds.top + (transform.yOffset + (rect.y + rect.height / 2) * transform.yScale) * baseHeight;
  const width = Math.max(10, rect.width * baseWidth * transform.xScale * 0.9);
  const height = Math.max(10, rect.height * baseHeight * transform.yScale * 0.9);

  return {
    left: Math.round(centerX - width / 2),
    right: Math.round(centerX + width / 2),
    top: Math.round(centerY - height / 2),
    bottom: Math.round(centerY + height / 2),
  };
}

function isInsideBounds(rect: PixelRect, bounds: PixelBounds): boolean {
  return rect.left >= bounds.left &&
    rect.right <= bounds.right &&
    rect.top >= bounds.top &&
    rect.bottom <= bounds.bottom &&
    rect.right - rect.left >= 10 &&
    rect.bottom - rect.top >= 10;
}

function isRegistrationConfident(score: number, baselineScore: number, transform: GridTransform): boolean {
  const moved = Math.abs(transform.xScale - 1) + Math.abs(transform.xOffset) + Math.abs(transform.yScale - 1) + Math.abs(transform.yOffset);
  return score >= 0.045 && (moved < 0.02 || score >= baselineScore * 1.08);
}

function getGroups(allGroups: ChoiceGroup[], fields: string[]): ChoiceGroup[] {
  const groups = fields.map((field) => allGroups.find((group) => group.field === field));
  return groups.every((group): group is ChoiceGroup => Boolean(group)) ? groups : [];
}

function deriveCellBoundaries(centers: number[], fallbackSize: number): number[] {
  if (centers.length === 0) {
    return [];
  }

  if (centers.length === 1) {
    const halfSize = Math.max(fallbackSize * 1.6, 0.018);
    return [centers[0] - halfSize, centers[0] + halfSize];
  }

  const boundaries = [(centers[0] - (centers[1] - centers[0]) / 2)];
  for (let index = 1; index < centers.length; index++) {
    boundaries.push((centers[index - 1] + centers[index]) / 2);
  }
  boundaries.push(centers[centers.length - 1] + (centers[centers.length - 1] - centers[centers.length - 2]) / 2);
  return boundaries;
}

function matchExpectedLines(detected: number[], expected: number[], tolerance: number): number[] | null {
  if (detected.length < expected.length || expected.length < 2) {
    return null;
  }

  const sorted = [...detected].sort((a, b) => a - b);
  const matched: number[] = [];
  let previous = -Infinity;

  for (const expectedLine of expected) {
    const candidates = sorted.filter((line) => line > previous && Math.abs(line - expectedLine) <= tolerance);
    const nearest = candidates.sort((a, b) => Math.abs(a - expectedLine) - Math.abs(b - expectedLine))[0];
    if (nearest === undefined) {
      return null;
    }
    matched.push(nearest);
    previous = nearest;
  }

  return matched;
}

function hasConsistentGaps(actual: number[], expected: number[]): boolean {
  if (actual.length !== expected.length || actual.length < 2) {
    return false;
  }

  const actualTotal = actual[actual.length - 1] - actual[0];
  const expectedTotal = expected[expected.length - 1] - expected[0];
  if (actualTotal <= 0 || expectedTotal <= 0) {
    return false;
  }

  for (let index = 1; index < actual.length; index++) {
    const actualGap = (actual[index] - actual[index - 1]) / actualTotal;
    const expectedGap = (expected[index] - expected[index - 1]) / expectedTotal;
    if (Math.abs(actualGap - expectedGap) > 0.18) {
      return false;
    }
  }

  return true;
}

function buildCellCenterRect(left: number, right: number, top: number, bottom: number): PixelRect {
  const horizontalInset = (right - left) * 0.24;
  const verticalInset = (bottom - top) * 0.2;

  return {
    left: Math.round(left + horizontalInset),
    right: Math.round(right - horizontalInset),
    top: Math.round(top + verticalInset),
    bottom: Math.round(bottom - verticalInset),
  };
}

function groupLinePositions(values: number[]): number[] {
  const lines: number[] = [];
  let start: number | undefined;
  let previous = -1;

  for (const value of values) {
    if (start === undefined) {
      start = value;
      previous = value;
      continue;
    }

    if (value === previous + 1) {
      previous = value;
      continue;
    }

    lines.push((start + previous) / 2);
    start = value;
    previous = value;
  }

  if (start !== undefined) {
    lines.push((start + previous) / 2);
  }

  return lines;
}

function getBounds(image: ImageAnalysisData): PixelBounds {
  return image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
