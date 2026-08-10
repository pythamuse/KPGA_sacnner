import { type ImageAnalysisData, type PixelBounds, type PixelRect } from './markDensity';
import { cagiTemplate, satisfactionTemplate, type ChoiceGroup, type NormalizedRect } from './roiTemplates';
import { buildCagiBasicRowDetection, detectHorizontalLines } from './tableRowDetection';

export interface VerticalLine {
  x: number;
}

export type FieldCellOverrides = Record<string, PixelRect[]>;

interface TableGridSpec {
  groups: ChoiceGroup[];
}

const GRID_TEMPLATE_TOLERANCE_RATIO = 0.18;

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
  const basicRowDetection = buildCagiBasicRowDetection(image);
  const basicOverrides = buildBasicRowCellOverrides(image, basicGroups, basicRowDetection.overrides);
  const ageRegion = cagiTemplate.fieldRegions?.find((region) => region.field === 'basic.age');

  return {
    overrides: { ...result.overrides, ...basicOverrides },
    fieldRects: {
      ...result.fieldRects,
      ...mapGroupsToUnionRects(image, basicGroups),
      ...(ageRegion ? { [ageRegion.field]: toPixelRect(ageRegion.rect, getBounds(image)) } : {}),
    },
    registeredFields: result.registeredFields,
    ...((result.diagnostics || basicRowDetection.diagnostics) ? {
      diagnostics: { ...result.diagnostics, ...basicRowDetection.diagnostics },
    } : {}),
  };
}

function buildBasicRowCellOverrides(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
  rowOverrides: Record<string, { top: number; bottom: number }>,
): FieldCellOverrides {
  const bounds = getBounds(image);
  const baseWidth = bounds.right - bounds.left;

  return Object.fromEntries(groups.flatMap((group) => {
    const row = rowOverrides[group.field];
    if (!row) {
      return [];
    }

    const cells = group.candidates.map((candidate) => ({
      left: Math.round(bounds.left + candidate.rect.x * baseWidth),
      right: Math.round(bounds.left + (candidate.rect.x + candidate.rect.width) * baseWidth),
      top: row.top,
      bottom: row.bottom,
    }));
    return [[group.field, cells]] as Array<[string, PixelRect[]]>;
  }));
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
    fieldRects: result.fieldRects,
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
      fieldRects: { ...result.fieldRects, ...exact.fieldRects },
      registeredFields: result.registeredFields,
      ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    };
  }, { overrides: {}, fieldRects: {}, registeredFields: new Set() });
}

interface GridSpecDetectionResult {
  overrides: FieldCellOverrides;
  fieldRects: Record<string, PixelRect>;
  diagnostics?: Record<string, string>;
}

function buildGridOverrides(image: ImageAnalysisData, spec: TableGridSpec): GridSpecDetectionResult {
  const { groups } = spec;
  const firstGroup = groups[0];
  if (!firstGroup || groups.some((group) => group.candidates.length !== firstGroup.candidates.length)) {
    return { overrides: {}, fieldRects: {} };
  }

  const bounds = getBounds(image);
  const fallbackFieldRects = mapGroupsToTableRegionRects(image, groups);
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
  // The template supplies both the search anchor and the expected uneven gap
  // pattern. The latter is important because two-line questions create rows
  // that are intentionally taller than their neighbours.
  const xTolerance = Math.max(12, Math.round(baseWidth * 0.06));
  const yTolerance = Math.max(12, Math.round(baseHeight * 0.05));

  const verticalLines = detectVerticalLines(
    image,
    expectedY[0] - yTolerance,
    expectedY[expectedY.length - 1] + yTolerance,
    expectedX[0] - xTolerance,
    expectedX[expectedX.length - 1] + xTolerance,
  ).map((line) => line.x);
  const matchedColumns = matchTemplateLinePattern(verticalLines, expectedX);
  const horizontalSearchLeft = matchedColumns?.[0] ?? expectedX[0] - xTolerance;
  const horizontalSearchRight = matchedColumns?.[matchedColumns.length - 1]
    ?? expectedX[expectedX.length - 1] + xTolerance;
  const horizontalLines = detectHorizontalLines(
    image,
    expectedY[0] - yTolerance,
    expectedY[expectedY.length - 1] + yTolerance,
    horizontalSearchLeft,
    horizontalSearchRight,
    0.3,
  ).map((line) => line.y);

  const lineFailure = classifyGridLineFailure(
    horizontalLines.length,
    expectedY.length,
    verticalLines.length,
    expectedX.length,
  );
  if (lineFailure) {
    return {
      overrides: {},
      fieldRects: fallbackFieldRects,
      diagnostics: diagnosticsForGroups(groups, lineFailure),
    };
  }

  const matchedRows = matchTemplateLinePattern(horizontalLines, expectedY);
  const rowGapDeviation = getTemplateGapDeviation(matchedRows || horizontalLines, expectedY);
  const columnGapDeviation = getTemplateGapDeviation(matchedColumns || verticalLines, expectedX);
  if (!matchedRows || !matchedColumns) {
    return {
      overrides: {},
      fieldRects: fallbackFieldRects,
      diagnostics: diagnosticsForGroups(
        groups,
        formatGapMismatchDiagnostic(rowGapDeviation, columnGapDeviation),
      ),
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
      group.field === 'satisfaction.q01',
    ));

    if (candidates.some((rect) => rect.right - rect.left < 4 || rect.bottom - rect.top < 4)) {
      return {
        overrides: {},
        fieldRects: fallbackFieldRects,
        diagnostics: diagnosticsForGroups(groups, '격자: gap_mismatch (감지선 사이의 셀 크기 부족)'),
      };
    }

    overrides[group.field] = candidates;
  }

  return { overrides, fieldRects: fallbackFieldRects };
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

function mapGroupsToTableRegionRects(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
): Record<string, PixelRect> {
  const bounds = image.contentBoundsConfident ? getBounds(image) : {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
  const candidates = groups.flatMap((group) => group.candidates.map((candidate) => candidate.rect));
  if (candidates.length === 0) {
    return {};
  }

  const paddingX = 0.02;
  const paddingY = 0.02;
  const left = Math.max(0, Math.min(...candidates.map((candidate) => candidate.x)) - paddingX);
  const top = Math.max(0, Math.min(...candidates.map((candidate) => candidate.y)) - paddingY);
  const right = Math.min(1, Math.max(...candidates.map((candidate) => candidate.x + candidate.width)) + paddingX);
  const bottom = Math.min(1, Math.max(...candidates.map((candidate) => candidate.y + candidate.height)) + paddingY);
  const region = toPixelRegionRect({ x: left, y: top, width: right - left, height: bottom - top }, bounds);

  return Object.fromEntries(groups.map((group) => [group.field, region]));
}

function toPixelRegionRect(rect: NormalizedRect, bounds: PixelBounds): PixelRect {
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;

  return {
    left: Math.round(bounds.left + rect.x * baseWidth),
    top: Math.round(bounds.top + rect.y * baseHeight),
    right: Math.round(bounds.left + (rect.x + rect.width) * baseWidth),
    bottom: Math.round(bounds.top + (rect.y + rect.height) * baseHeight),
  };
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

function matchTemplateLinePattern(detected: number[], expected: number[]): number[] | null {
  if (detected.length < expected.length || expected.length < 2) {
    return null;
  }

  const sorted = [...detected].sort((a, b) => a - b);
  const expectedSpan = expected[expected.length - 1] - expected[0];
  const expectedCenter = (expected[0] + expected[expected.length - 1]) / 2;
  let best: number[] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  const visit = (start: number, selected: number[]) => {
    if (selected.length === expected.length) {
      const deviations = getNormalizedGapDeviations(selected, expected);
      if (!deviations) {
        return;
      }

      if (!deviations.every((deviation) => deviation <= GRID_TEMPLATE_TOLERANCE_RATIO)) {
        return;
      }

      const span = selected[selected.length - 1] - selected[0];
      const center = (selected[0] + selected[selected.length - 1]) / 2;
      const anchorScore = Math.abs(center - expectedCenter) / Math.max(expectedSpan, 1)
        + Math.abs(span - expectedSpan) / Math.max(expectedSpan, 1);
      const score = Math.max(...deviations) + anchorScore;
      if (score < bestScore) {
        best = [...selected];
        bestScore = score;
      }
      return;
    }

    const remaining = expected.length - selected.length;
    for (let index = start; index <= sorted.length - remaining; index++) {
      visit(index + 1, [...selected, sorted[index]]);
    }
  };

  visit(0, []);
  return best || null;
}

function formatGapMismatchDiagnostic(
  rowGapDeviation: number | null,
  columnGapDeviation: number | null,
): string {
  if (rowGapDeviation === null || columnGapDeviation === null) {
    return '격자: gap_mismatch (감지선 간격 패턴 불일치)';
  }

  const maxDeviation = Math.max(rowGapDeviation, columnGapDeviation);
  return `격자: gap_mismatch (감지선 간격 패턴 불일치; 최대 편차 ${Math.round(maxDeviation * 100)}% (허용 ${Math.round(GRID_TEMPLATE_TOLERANCE_RATIO * 100)}%))`;
}

function getTemplateGapDeviation(actual: number[] | null, expected: number[]): number | null {
  if (actual && actual.length === expected.length) {
    return getRelativeGapDeviation(actual, expected);
  }

  return actual ? getRelativeGapDeviation(actual, expected) : null;
}

function getRelativeGapDeviation(actual: number[], expected: number[]): number | null {
  const deviations = getNormalizedGapDeviations(actual, expected);
  return deviations ? Math.max(...deviations) : null;
}

function getNormalizedGapDeviations(actual: number[], expected: number[]): number[] | null {
  if (actual.length !== expected.length || actual.length < 2) {
    return null;
  }

  const actualGaps = getPositiveGaps(actual);
  const expectedGaps = getPositiveGaps(expected);
  if (!actualGaps || !expectedGaps) {
    return null;
  }

  const actualTotal = actual[actual.length - 1] - actual[0];
  const expectedTotal = expected[expected.length - 1] - expected[0];
  if (actualTotal <= 0 || expectedTotal <= 0) {
    return null;
  }

  return actualGaps.map((gap, index) =>
    Math.abs(gap / actualTotal - expectedGaps[index] / expectedTotal),
  );
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

function buildCellCenterRect(
  left: number,
  right: number,
  top: number,
  bottom: number,
  isSingleRowSensitiveField = false,
): PixelRect {
  // Hand-drawn circles often surround the pre-printed option marker. Keep the
  // outer ring inside the measured cell while still excluding table rules.
  const horizontalInset = (right - left) * (isSingleRowSensitiveField ? 0.24 : 0.13);
  const verticalInset = (bottom - top) * (isSingleRowSensitiveField ? 0.24 : 0.16);

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
