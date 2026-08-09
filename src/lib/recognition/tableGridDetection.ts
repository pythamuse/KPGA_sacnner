import { type ImageAnalysisData, type PixelBounds, type PixelRect } from './markDensity';
import { cagiTemplate, satisfactionTemplate, type ChoiceGroup, type NormalizedRect } from './roiTemplates';
import { detectHorizontalLines } from './tableRowDetection';

export interface VerticalLine {
  x: number;
}

export type FieldCellOverrides = Record<string, PixelRect[]>;

interface TableGridSpec {
  groups: ChoiceGroup[];
}

export interface GridDetectionResult {
  overrides: FieldCellOverrides;
  fieldRects: Record<string, PixelRect>;
  registeredFields: Set<string>;
  diagnostics?: Record<string, string>;
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
  const primaryGroups = getGroups(cagiTemplate.choiceGroups, [
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07',
  ]);
  const result = mergeGridDetection(image, [
    { groups: primaryGroups },
    { groups: getGroups(cagiTemplate.choiceGroups, ['cagi.q08', 'cagi.q09']) },
  ]);

  const basicGroups = getGroups(cagiTemplate.choiceGroups, [
    'basic.gender', 'basic.schoolType', 'basic.grade',
  ]);
  const ageRegion = cagiTemplate.fieldRegions?.find((region) => region.field === 'basic.age');

  return {
    overrides: result.overrides,
    fieldRects: {
      ...result.fieldRects,
      ...mapGroupsToUnionRects(image, basicGroups),
      ...(ageRegion ? { [ageRegion.field]: toPixelRect(ageRegion.rect, getBounds(image)) } : {}),
    },
    registeredFields: result.registeredFields,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
}

export function buildSatisfactionGridOverrides(image: ImageAnalysisData): FieldCellOverrides {
  return buildSatisfactionGridDetection(image).overrides;
}

export function buildSatisfactionGridDetection(image: ImageAnalysisData): GridDetectionResult {
  const q01Groups = getGroups(satisfactionTemplate.choiceGroups, ['satisfaction.q01']);
  const binaryGroups = getGroups(satisfactionTemplate.choiceGroups, [
      'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06',
  ]);
  const scaleGroups = getGroups(satisfactionTemplate.choiceGroups, [
      'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
  ]);
  const result = mergeGridDetection(image, [
    { groups: q01Groups },
    { groups: binaryGroups },
    { groups: scaleGroups },
  ]);

  return {
    overrides: result.overrides,
    fieldRects: {
      ...result.fieldRects,
      ...mapGroupsToUnionRects(image, q01Groups),
    },
    registeredFields: result.registeredFields,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
}

function mergeGridDetection(image: ImageAnalysisData, specs: TableGridSpec[]): GridDetectionResult {
  return specs.reduce<GridDetectionResult>((result, spec) => {
    const exact = buildGridOverrides(image, spec);
    const diagnostics = { ...result.diagnostics, ...exact.diagnostics };

    return {
      overrides: { ...result.overrides, ...exact.overrides },
      fieldRects: result.fieldRects,
      registeredFields: result.registeredFields,
      ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    };
  }, { overrides: {}, fieldRects: {}, registeredFields: new Set() });
}

interface GridSpecDetectionResult {
  overrides: FieldCellOverrides;
  diagnostics?: Record<string, string>;
}

function buildGridOverrides(image: ImageAnalysisData, spec: TableGridSpec): GridSpecDetectionResult {
  const { groups } = spec;
  const firstGroup = groups[0];
  if (!firstGroup || groups.some((group) => group.candidates.length !== firstGroup.candidates.length)) {
    return { overrides: {} };
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

  const lineFailure = classifyGridLineFailure(
    horizontalLines.length,
    expectedY.length,
    verticalLines.length,
    expectedX.length,
  );
  if (lineFailure) {
    return {
      overrides: {},
      diagnostics: diagnosticsForGroups(groups, lineFailure),
    };
  }

  const matchedRows = matchExpectedLines(horizontalLines, expectedY, yTolerance);
  const matchedColumns = matchExpectedLines(verticalLines, expectedX, xTolerance);
  if (!matchedRows || !matchedColumns || !hasConsistentGaps(matchedRows, expectedY) || !hasConsistentGaps(matchedColumns, expectedX)) {
    return {
      overrides: {},
      diagnostics: diagnosticsForGroups(groups, '격자: gap_mismatch (감지선 간격 패턴 불일치)'),
    };
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
      return {
        overrides: {},
        diagnostics: diagnosticsForGroups(groups, '격자: gap_mismatch (감지선 사이의 셀 크기 부족)'),
      };
    }

    overrides[group.field] = candidates;
  }

  return { overrides };
}

function classifyGridLineFailure(
  horizontalFound: number,
  horizontalRequired: number,
  verticalFound: number,
  verticalRequired: number,
): string | undefined {
  if (horizontalFound === 0 && verticalFound === 0) {
    return `격자: lines_undetected (가로선 0/${horizontalRequired}개, 세로선 0/${verticalRequired}개)`;
  }

  if (horizontalFound < horizontalRequired || verticalFound < verticalRequired) {
    return `격자: insufficient_lines (가로선 ${horizontalFound}/${horizontalRequired}개, 세로선 ${verticalFound}/${verticalRequired}개)`;
  }

  return undefined;
}

function diagnosticsForGroups(groups: ChoiceGroup[], diagnostic: string): Record<string, string> {
  return Object.fromEntries(groups.map((group) => [group.field, diagnostic]));
}

function mapGroupsToUnionRects(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
): Record<string, PixelRect> {
  const bounds = getBounds(image);
  return Object.fromEntries(groups.map((group) => {
    const cells = group.candidates.map((candidate) => toPixelRect(candidate.rect, bounds));
    return [group.field, {
      left: Math.min(...cells.map((cell) => cell.left)),
      top: Math.min(...cells.map((cell) => cell.top)),
      right: Math.max(...cells.map((cell) => cell.right)),
      bottom: Math.max(...cells.map((cell) => cell.bottom)),
    }];
  }));
}

function toPixelRect(
  rect: NormalizedRect,
  bounds: PixelBounds,
): PixelRect {
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const centerX = bounds.left + (rect.x + rect.width / 2) * baseWidth;
  const centerY = bounds.top + (rect.y + rect.height / 2) * baseHeight;
  const width = Math.max(10, rect.width * baseWidth * 0.9);
  const height = Math.max(10, rect.height * baseHeight * 0.9);

  return {
    left: Math.round(centerX - width / 2),
    right: Math.round(centerX + width / 2),
    top: Math.round(centerY - height / 2),
    bottom: Math.round(centerY + height / 2),
  };
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
    // A choice-marker box is smaller than its enclosing one-row table cell.
    // Using the old 1.6 multiplier caused the satisfaction Q1 search to span
    // both the header and the answer row.
    const halfSize = Math.max(fallbackSize * 0.75, 0.018);
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
  // Hand-drawn circles often surround the pre-printed option marker. Keep the
  // outer ring inside the measured cell while still excluding table rules.
  const horizontalInset = (right - left) * 0.13;
  const verticalInset = (bottom - top) * 0.16;

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
