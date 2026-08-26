import {
  getRegistrationBounds,
  type ImageAnalysisData,
  type PixelBounds,
  type PixelRect,
} from './markDensity';
import { cagiTemplate, satisfactionTemplate, type ChoiceGroup, type NormalizedRect } from './roiTemplates';
import { buildCagiBasicRowDetection, detectHorizontalLines, type RowDetectionResult } from './tableRowDetection';

export interface VerticalLine {
  x: number;
}

export type FieldCellOverrides = Record<string, PixelRect[]>;

interface TableGridSpec {
  id: string;
  groups: ChoiceGroup[];
  columnSearchToleranceRatio?: number;
  rowSearchToleranceRatio?: number;
  verticalLineDarkRatio?: number;
  horizontalLineDarkRatio?: number;
  darkThreshold?: number;
  maxUniformCandidateOffsetY?: number;
  independentRegistration?: boolean;
}

// A scan can preserve the form's row/column pattern while its outer paper
// bounds are translated or slightly skewed. Keep the search broad enough to
// collect that evidence; registration quality below decides whether it is safe
// to use for automatic scoring.
const GRID_TEMPLATE_TOLERANCE_RATIO = 0.35;
const GRID_MAX_GAP_DEVIATION = 0.08;
const GRID_MAX_LINE_RESIDUAL_RATIO = 0.06;
const GRID_MAX_CROSS_TABLE_OFFSET_DELTA = 0.035;
const GRID_MAX_CANDIDATE_CENTER_DEVIATION = 0.025;
const GRID_MAX_UNIFORM_CANDIDATE_OFFSET_X = 0.08;
const GRID_MAX_UNIFORM_CANDIDATE_OFFSET_Y = 0.02;
const GRID_MAX_CANDIDATE_CENTER_SPREAD = 0.012;
const GRID_MAX_INTRA_TABLE_OFFSET_DELTA = 0.02;
const GRID_MAX_RECOVERED_LINE_SCALE_DEVIATION = 0.15;
const DEFAULT_VERTICAL_LINE_DARK_RATIO = 0.32;
const DEFAULT_HORIZONTAL_LINE_DARK_RATIO = 0.3;
const DEFAULT_DARK_THRESHOLD = 200;
const LINE_SIGNAL_RADIUS_PX = 6;

export type RegistrationStatus = 'verified' | 'candidate' | 'failed';
export type RegistrationSource = 'grid' | 'row' | 'fixed';

/**
 * A grid may be detectable without being the intended response table. Keep the
 * evidence that made that distinction so the review screen can explain why a
 * crop was used only as a candidate.
 */
export interface FieldRegistration {
  tableId: string;
  source: RegistrationSource;
  status: RegistrationStatus;
  horizontalLines?: { found: number; expected: number };
  verticalLines?: { found: number; expected: number };
  inferredHorizontalLines?: { found: number; expected: number };
  inferredVerticalLines?: { found: number; expected: number };
  gapDeviation?: { rows: number; columns: number };
  /** Per-gap row deviations, so a reader can see which boundary drifts. */
  rowGapDeviations?: number[];
  residualRatio?: { rows: number; columns: number };
  offsetRatio?: { x: number; y: number };
  scale?: { x: number; y: number };
  candidateCenterDeviation?: { x: number; y: number };
  candidateCenterOffset?: { x: number; y: number };
  candidateCenterSpread?: { x: number; y: number };
  candidateCenterScale?: { x: number; y: number };
  candidateCenterResidualSpread?: { x: number; y: number };
  qualityScore?: number;
  independentRegistration?: boolean;
  diagnostic?: string;
}

export interface GridDetectionResult {
  overrides: FieldCellOverrides;
  fieldRects: Record<string, PixelRect>;
  registrations: Record<string, FieldRegistration>;
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
  minDarkRatio = DEFAULT_VERTICAL_LINE_DARK_RATIO,
  darkThreshold = DEFAULT_DARK_THRESHOLD,
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
    { id: 'cagi.primary', groups: primaryGroups },
    { id: 'cagi.late', groups: getGroups(cagiTemplate.choiceGroups, ['cagi.q08', 'cagi.q09']) },
  ]);

  const basicGroups = getGroups(cagiTemplate.choiceGroups, [
    'basic.gender', 'basic.schoolType', 'basic.grade',
  ]);
  const basicRowDetection = buildCagiBasicRowDetection(image);
  const basicOverrides = buildBasicRowCellOverrides(image, basicGroups, basicRowDetection);
  const basicRegistrations = buildBasicRowRegistrations(basicGroups, basicOverrides, basicRowDetection);
  const ageRegion = cagiTemplate.fieldRegions?.find((region) => region.field === 'basic.age');
  const ageRegistration = ageRegion ? {
    [ageRegion.field]: {
      tableId: 'cagi.basic.age',
      source: 'fixed' as const,
      status: 'candidate' as const,
      diagnostic: 'OCR region uses the measured template anchor; confirm the age value before saving.',
    },
  } : {};

  return {
    overrides: { ...result.overrides, ...basicOverrides },
    fieldRects: {
      ...result.fieldRects,
      ...mapGroupsToUnionRects(image, basicGroups),
      ...(ageRegion ? { [ageRegion.field]: toPixelRect(ageRegion.rect, getBounds(image)) } : {}),
    },
    registrations: { ...result.registrations, ...basicRegistrations, ...ageRegistration },
    ...((result.diagnostics || basicRowDetection.diagnostics || Object.keys(basicRegistrations).length > 0) ? {
      diagnostics: {
        ...result.diagnostics,
        ...basicRowDetection.diagnostics,
        ...Object.fromEntries(Object.entries(basicRegistrations)
          .filter(([, registration]) => registration.diagnostic)
          .map(([field, registration]) => [field, registration.diagnostic!])),
        ...Object.fromEntries(Object.entries(ageRegistration)
          .filter(([, registration]) => registration.diagnostic)
          .map(([field, registration]) => [field, registration.diagnostic!])),
      },
    } : {}),
  };
}

function buildBasicRowCellOverrides(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
  rowDetection: RowDetectionResult,
): FieldCellOverrides {
  const bounds = getBounds(image);
  const baseWidth = bounds.right - bounds.left;

  return Object.fromEntries(groups.flatMap((group) => {
    const candidateRows = rowDetection.candidateOverrides?.[group.field];
    const groupRow = rowDetection.overrides[group.field];
    const rows = candidateRows?.length === group.candidates.length
      ? candidateRows
      : group.field === 'basic.gender' && groupRow
        ? group.candidates.map(() => groupRow)
        : undefined;
    if (!rows) {
      return [];
    }

    const cells = group.candidates.map((candidate, index) => ({
      left: Math.round(bounds.left + candidate.rect.x * baseWidth),
      right: Math.round(bounds.left + (candidate.rect.x + candidate.rect.width) * baseWidth),
      top: rows[index].top,
      bottom: rows[index].bottom,
    }));
    const duplicate = findDuplicateCandidateRectPair(cells);
    if (duplicate) {
      return [];
    }
    return [[group.field, cells]] as Array<[string, PixelRect[]]>;
  }));
}

function buildBasicRowRegistrations(
  groups: ChoiceGroup[],
  overrides: FieldCellOverrides,
  rowDetection: RowDetectionResult,
): Record<string, FieldRegistration> {
  return Object.fromEntries(groups.map((group) => {
    const hasCandidateCells = Boolean(overrides[group.field]);
    const rowDiagnostic = rowDetection.diagnostics?.[group.field];
    return [group.field, {
      tableId: 'cagi.basic',
      source: hasCandidateCells ? 'row' : 'fixed',
      status: hasCandidateCells ? 'candidate' : 'failed',
      diagnostic: hasCandidateCells
        ? 'Row candidate found, but column geometry is not independently verified. Manual confirmation is required.'
        : rowDiagnostic || 'Response row could not be verified.',
    } satisfies FieldRegistration];
  }));
}

export interface DuplicateCandidateRectPair {
  firstIndex: number;
  secondIndex: number;
}

const DUPLICATE_RECT_TOLERANCE_PX = 2;

export function findDuplicateCandidateRectPair(
  cells: PixelRect[],
): DuplicateCandidateRectPair | undefined {
  for (let firstIndex = 0; firstIndex < cells.length - 1; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < cells.length; secondIndex++) {
      if (areNearlySameRect(cells[firstIndex], cells[secondIndex])) {
        return { firstIndex, secondIndex };
      }
    }
  }

  return undefined;
}

export function assertUniqueCandidateRects(field: string, cells: PixelRect[]): void {
  const duplicate = findDuplicateCandidateRectPair(cells);
  if (duplicate) {
    throw new Error(
      `${field}: duplicate candidate rectangles at indexes ${duplicate.firstIndex} and ${duplicate.secondIndex}`,
    );
  }
}

function areNearlySameRect(first: PixelRect, second: PixelRect): boolean {
  return (
    Math.abs(first.left - second.left) <= DUPLICATE_RECT_TOLERANCE_PX &&
    Math.abs(first.top - second.top) <= DUPLICATE_RECT_TOLERANCE_PX &&
    Math.abs(first.right - second.right) <= DUPLICATE_RECT_TOLERANCE_PX &&
    Math.abs(first.bottom - second.bottom) <= DUPLICATE_RECT_TOLERANCE_PX
  );
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
    { id: 'satisfaction.frequency', groups: q01Groups },
    { id: 'satisfaction.binary', groups: binaryGroups },
    {
      id: 'satisfaction.scale',
      groups: scaleGroups,
      // The lower five-point table has short, thin vertical rules in phone
      // photos. Detect it locally with a wider row search, then require its
      // own complete line pattern instead of borrowing the upper tables'
      // registration.
      rowSearchToleranceRatio: 0.1,
      verticalLineDarkRatio: 0.3,
      // The inner rules of this table are the thinnest on either form, and at
      // 0.3 some pages lose one or two of them entirely: on three real scans
      // the rules expected at y=943 and y=976 were absent from the detected
      // set, so the matcher substituted a rule 27-38px away and the resulting
      // gap pattern missed by 16-35%. It was never a selection problem -- the
      // real boundary simply was not there to select. At 0.2 every expected
      // rule is found and the worst residual drops to 6-8px, which is the
      // table's genuine downward shift on those pages and well inside the
      // uniform-translation allowance below.
      horizontalLineDarkRatio: 0.2,
      // At the default 200 threshold, the photographed paper texture merges
      // adjacent rules into one broad band. The darkest printed rules remain
      // distinct at 180 and preserve the actual five-by-four cell pattern.
      darkThreshold: 180,
      maxUniformCandidateOffsetY: 0.06,
      independentRegistration: true,
    },
  ]);

  return {
    overrides: result.overrides,
    fieldRects: result.fieldRects,
    registrations: result.registrations,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
}

function mergeGridDetection(image: ImageAnalysisData, specs: TableGridSpec[]): GridDetectionResult {
  const merged = specs.reduce<GridDetectionResult>((result, spec) => {
    const exact = buildGridOverrides(image, spec);
    const diagnostics = { ...result.diagnostics, ...exact.diagnostics };

    return {
      overrides: { ...result.overrides, ...exact.overrides },
      fieldRects: { ...result.fieldRects, ...exact.fieldRects },
      registrations: { ...result.registrations, ...exact.registrations },
      ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    };
  }, { overrides: {}, fieldRects: {}, registrations: {} });

  return applyCrossTableRegistrationCheck(merged);
}

interface GridSpecDetectionResult {
  overrides: FieldCellOverrides;
  fieldRects: Record<string, PixelRect>;
  registrations: Record<string, FieldRegistration>;
  diagnostics?: Record<string, string>;
}

function buildGridOverrides(image: ImageAnalysisData, spec: TableGridSpec): GridSpecDetectionResult {
  const { groups } = spec;
  const firstGroup = groups[0];
  if (!firstGroup || groups.some((group) => group.candidates.length !== firstGroup.candidates.length)) {
    return { overrides: {}, fieldRects: {}, registrations: {} };
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
  const verticalLineDarkRatio = spec.verticalLineDarkRatio ?? DEFAULT_VERTICAL_LINE_DARK_RATIO;
  const horizontalLineDarkRatio = spec.horizontalLineDarkRatio ?? DEFAULT_HORIZONTAL_LINE_DARK_RATIO;
  const darkThreshold = spec.darkThreshold ?? DEFAULT_DARK_THRESHOLD;
  // The template supplies both the search anchor and the expected uneven gap
  // pattern. The latter is important because two-line questions create rows
  // that are intentionally taller than their neighbours.
  const xTolerance = Math.max(12, Math.round(baseWidth * (spec.columnSearchToleranceRatio ?? 0.06)));
  const yTolerance = Math.max(12, Math.round(baseHeight * (spec.rowSearchToleranceRatio ?? 0.05)));
  const verticalLines = detectVerticalLines(
    image,
    expectedY[0] - yTolerance,
    expectedY[expectedY.length - 1] + yTolerance,
    expectedX[0] - xTolerance,
    expectedX[expectedX.length - 1] + xTolerance,
    verticalLineDarkRatio,
    darkThreshold,
  ).map((line) => line.x);
  const matchedColumns = matchTemplateLinePattern(verticalLines, expectedX);
  const partialColumnMatch = matchedColumns
    ? undefined
    : inferPartialTemplateLinePattern(
      verticalLines,
      expectedX,
      baseWidth,
      GRID_MAX_UNIFORM_CANDIDATE_OFFSET_X,
    );
  // Some scanner PDFs preserve the inner table rules but lose one printed
  // outer edge during rasterization. A partial match is only accepted below
  // when an affine reconstruction is locally consistent with every choice
  // center; it never replaces a complete measured line pattern by itself.
  const resolvedColumns = matchedColumns || partialColumnMatch?.lines;
  const horizontalSearchLeft = resolvedColumns?.[0] ?? expectedX[0] - xTolerance;
  const horizontalSearchRight = resolvedColumns?.[resolvedColumns.length - 1]
    ?? expectedX[expectedX.length - 1] + xTolerance;
  const horizontalLines = detectHorizontalLines(
    image,
    expectedY[0] - yTolerance,
    expectedY[expectedY.length - 1] + yTolerance,
    horizontalSearchLeft,
    horizontalSearchRight,
    horizontalLineDarkRatio,
    darkThreshold,
  ).map((line) => line.y);
  const matchedRows = matchTemplateLinePattern(horizontalLines, expectedY);
  const partialRowMatch = shouldRecoverPartialTemplateLinePattern(
    matchedRows,
    expectedY,
    baseHeight,
    horizontalLines.length,
  )
    ? inferPartialTemplateLinePattern(
      horizontalLines,
      expectedY,
      baseHeight,
      spec.maxUniformCandidateOffsetY ?? GRID_MAX_UNIFORM_CANDIDATE_OFFSET_Y,
    )
    : undefined;
  const resolvedRows = partialRowMatch?.lines || matchedRows;
  const verticalLineSignals = measureVerticalLineSignals(
    image,
    expectedY[0] - yTolerance,
    expectedY[expectedY.length - 1] + yTolerance,
    expectedX,
    darkThreshold,
    verticalLineDarkRatio,
    Math.max(LINE_SIGNAL_RADIUS_PX, Math.round(baseWidth * 0.01)),
  );
  const lineEvidence = describeLineEvidence(
    { detected: horizontalLines, selected: resolvedRows || horizontalLines, expected: expectedY },
    {
      detected: verticalLines,
      selected: resolvedColumns || verticalLines,
      expected: expectedX,
    },
  ) + describeVerticalLineSignals(verticalLineSignals);
  const lineEvidenceSuffix = horizontalLines.length > 0 || verticalLines.length > 0
    ? lineEvidence
    : '';

  const lineFailure = classifyGridLineFailure(
    horizontalLines.length,
    expectedY.length,
    verticalLines.length,
    expectedX.length,
    Boolean(resolvedRows),
    Boolean(resolvedColumns),
  );
  if (lineFailure) {
    return {
      overrides: {},
      fieldRects: fallbackFieldRects,
      registrations: registrationsForGroups(groups, spec.id, {
        source: 'fixed',
        status: 'failed',
        horizontalLines: { found: horizontalLines.length, expected: expectedY.length },
        verticalLines: { found: verticalLines.length, expected: expectedX.length },
        diagnostic: lineFailure + lineEvidenceSuffix,
      }),
      diagnostics: diagnosticsForGroups(groups, lineFailure + lineEvidenceSuffix),
    };
  }

  const rowGapDeviation = getTemplateGapDeviation(resolvedRows || horizontalLines, expectedY);
  const columnGapDeviation = getTemplateGapDeviation(resolvedColumns || verticalLines, expectedX);
  if (!resolvedRows || !resolvedColumns) {
    const diagnostic = formatGapMismatchDiagnostic(rowGapDeviation, columnGapDeviation);
    return {
      overrides: {},
      fieldRects: fallbackFieldRects,
      registrations: registrationsForGroups(groups, spec.id, {
        source: 'fixed',
        status: 'failed',
        horizontalLines: { found: horizontalLines.length, expected: expectedY.length },
        verticalLines: { found: verticalLines.length, expected: expectedX.length },
        diagnostic: diagnostic + lineEvidenceSuffix,
      }),
      diagnostics: diagnosticsForGroups(
        groups,
        diagnostic + lineEvidenceSuffix,
      ),
    };
  }

  // A false line can sit only a few pixels from another detected line. If that
  // creates a sliver cell, discard the ambiguous measured row pattern and
  // rebuild the table from its expected row geometry. The normal quality gate
  // below still decides whether the rebuilt grid is safe to score.
  const rowsForGrid = hasInvalidCellSize(groups, resolvedRows, resolvedColumns)
    && hasNearbyLinePair(horizontalLines)
    ? expectedY
    : resolvedRows;

  const overrides: FieldCellOverrides = {};
  for (let rowIndex = 0; rowIndex < groups.length; rowIndex++) {
    const group = groups[rowIndex];
    const top = rowsForGrid[rowIndex];
    const bottom = rowsForGrid[rowIndex + 1];
    const candidates = group.candidates.map((_, columnIndex) => buildCellCenterRect(
      resolvedColumns[columnIndex],
      resolvedColumns[columnIndex + 1],
      top,
      bottom,
      group.field === 'satisfaction.q01',
    ));

    if (candidates.some((rect) => rect.right - rect.left < 4 || rect.bottom - rect.top < 4)) {
      const diagnostic = 'grid: invalid_cell_size';
      return {
        overrides: {},
        fieldRects: fallbackFieldRects,
        registrations: registrationsForGroups(groups, spec.id, {
          source: 'fixed',
          status: 'failed',
          horizontalLines: { found: horizontalLines.length, expected: expectedY.length },
          verticalLines: { found: verticalLines.length, expected: expectedX.length },
          diagnostic,
        }),
        diagnostics: diagnosticsForGroups(groups, '격자: gap_mismatch (감지선 사이의 셀 크기 부족)'),
      };
    }

    if (findDuplicateCandidateRectPair(candidates)) {
      const diagnostic = 'grid: duplicate_candidate_rects';
      return {
        overrides: {},
        fieldRects: fallbackFieldRects,
        registrations: registrationsForGroups(groups, spec.id, {
          source: 'fixed',
          status: 'failed',
          horizontalLines: { found: horizontalLines.length, expected: expectedY.length },
          verticalLines: { found: verticalLines.length, expected: expectedX.length },
          diagnostic,
        }),
        diagnostics: diagnosticsForGroups(groups, 'grid: duplicate_candidate_rects'),
      };
    }

    overrides[group.field] = candidates;
  }

  const quality = calculateGridQuality(
    rowsForGrid,
    expectedY,
    resolvedColumns,
    expectedX,
    baseHeight,
    baseWidth,
    rowCenters.map((value) => bounds.top + value * baseHeight),
  );
  const registrations: Record<string, FieldRegistration> = Object.fromEntries(groups.map((group) => {
    const candidateCenter = getCandidateCenterQuality(group, overrides[group.field], bounds);
    const status: RegistrationStatus = isVerifiedGridQuality(
      quality,
      candidateCenter,
      spec.maxUniformCandidateOffsetY,
    ) ? 'verified' : 'candidate';
    const diagnostic = status === 'candidate'
      ? formatGridQualityDiagnostic(quality, candidateCenter, spec.maxUniformCandidateOffsetY) + lineEvidence
      : undefined;
    return [group.field, {
      tableId: spec.id,
      source: 'grid',
      status,
      horizontalLines: { found: horizontalLines.length, expected: expectedY.length },
      verticalLines: { found: verticalLines.length, expected: expectedX.length },
      ...(partialRowMatch ? {
        inferredHorizontalLines: {
          found: partialRowMatch.matchedCount,
          expected: expectedY.length,
        },
      } : {}),
      ...(partialColumnMatch ? {
        inferredVerticalLines: {
          found: partialColumnMatch.matchedCount,
          expected: expectedX.length,
        },
      } : {}),
      gapDeviation: { rows: quality.rowGapDeviation, columns: quality.columnGapDeviation },
      rowGapDeviations: quality.rowGapDeviations,
      residualRatio: { rows: quality.rowResidualRatio, columns: quality.columnResidualRatio },
      offsetRatio: { x: quality.columnOffsetRatio, y: quality.rowOffsetRatio },
      scale: { x: quality.columnScale, y: quality.rowScale },
      candidateCenterDeviation: { x: candidateCenter.maxX, y: candidateCenter.maxY },
      candidateCenterOffset: { x: candidateCenter.meanX, y: candidateCenter.meanY },
      candidateCenterSpread: { x: candidateCenter.spreadX, y: candidateCenter.spreadY },
      candidateCenterScale: { x: candidateCenter.scaleX, y: candidateCenter.scaleY },
      candidateCenterResidualSpread: { x: candidateCenter.residualSpreadX, y: candidateCenter.residualSpreadY },
      qualityScore: Math.max(quality.score, candidateCenter.maxX, candidateCenter.maxY),
      ...(spec.independentRegistration ? { independentRegistration: true } : {}),
      diagnostic,
    } satisfies FieldRegistration];
  }));
  const checkedRegistrations = applyIntraTableRegistrationCheck(registrations);
  const diagnostics = Object.fromEntries(Object.entries(checkedRegistrations)
    .filter(([, registration]) => registration.diagnostic)
    .map(([field, registration]) => [field, registration.diagnostic!]));

  return {
    overrides,
    fieldRects: fallbackFieldRects,
    registrations: checkedRegistrations,
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
  };
}

function applyIntraTableRegistrationCheck(
  registrations: Record<string, FieldRegistration>,
): Record<string, FieldRegistration> {
  const verified = Object.entries(registrations)
    .filter(([, registration]) => (
      registration.status === 'verified' &&
      registration.candidateCenterOffset
    ));
  if (verified.length < 2) {
    return registrations;
  }

  const xOffsets = verified.map(([, registration]) => registration.candidateCenterOffset!.x);
  const yOffsets = verified.map(([, registration]) => registration.candidateCenterOffset!.y);
  const xRange = Math.max(...xOffsets) - Math.min(...xOffsets);
  const yRange = Math.max(...yOffsets) - Math.min(...yOffsets);
  if (xRange <= GRID_MAX_INTRA_TABLE_OFFSET_DELTA && yRange <= GRID_MAX_INTRA_TABLE_OFFSET_DELTA) {
    return registrations;
  }

  return Object.fromEntries(Object.entries(registrations).map(([field, registration]) => {
    if (registration.status !== 'verified') {
      return [field, registration];
    }

    const diagnostic = `${formatGridQualityDiagnostic(
      registrationToQuality(registration),
      registrationToCandidateCenterQuality(registration),
    )}; table offset varies across rows (x ${Math.round(xRange * 100)}%, y ${Math.round(yRange * 100)}%)`;
    return [field, { ...registration, status: 'candidate' as const, diagnostic }];
  }));
}

interface GridQuality {
  rowGapDeviation: number;
  columnGapDeviation: number;
  /** Per-gap row deviations, so a diagnostic can name which boundary drifts. */
  rowGapDeviations: number[];
  rowResidualRatio: number;
  columnResidualRatio: number;
  rowOffsetRatio: number;
  columnOffsetRatio: number;
  rowScale: number;
  columnScale: number;
  score: number;
}

interface CandidateCenterQuality {
  maxX: number;
  maxY: number;
  meanX: number;
  meanY: number;
  spreadX: number;
  spreadY: number;
  scaleX: number;
  scaleY: number;
  residualSpreadX: number;
  residualSpreadY: number;
}

function calculateGridQuality(
  actualRows: number[],
  expectedRows: number[],
  actualColumns: number[],
  expectedColumns: number[],
  pageHeight: number,
  pageWidth: number,
  expectedRowCenters?: number[],
): GridQuality {
  const rowFit = getLineFit(actualRows, expectedRows, pageHeight);
  const columnFit = getLineFit(actualColumns, expectedColumns, pageWidth);
  const rowGapDeviations = getRowBandGapDeviations(actualRows, expectedRowCenters)
    ?? getNormalizedGapDeviations(actualRows, expectedRows)
    ?? [];
  const rowGapDeviation = rowGapDeviations.length > 0
    ? Math.max(...rowGapDeviations)
    : Number.POSITIVE_INFINITY;
  const columnGapDeviation = getRelativeGapDeviation(actualColumns, expectedColumns) ?? Number.POSITIVE_INFINITY;

  return {
    rowGapDeviation,
    columnGapDeviation,
    rowGapDeviations,
    rowResidualRatio: rowFit.residualRatio,
    columnResidualRatio: columnFit.residualRatio,
    rowOffsetRatio: rowFit.offsetRatio,
    columnOffsetRatio: columnFit.offsetRatio,
    rowScale: rowFit.scale,
    columnScale: columnFit.scale,
    score: Math.max(
      rowGapDeviation,
      columnGapDeviation,
      rowFit.residualRatio,
      columnFit.residualRatio,
    ),
  };
}

function getCandidateCenterQuality(
  group: ChoiceGroup,
  cells: PixelRect[],
  bounds: PixelBounds,
): CandidateCenterQuality {
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const deltas = group.candidates.map((candidate, index) => {
    const cell = cells[index];
    const actualX = ((cell.left + cell.right) / 2 - bounds.left) / baseWidth;
    const actualY = ((cell.top + cell.bottom) / 2 - bounds.top) / baseHeight;
    const expectedX = candidate.rect.x + candidate.rect.width / 2;
    const expectedY = candidate.rect.y + candidate.rect.height / 2;
    return { x: actualX - expectedX, y: actualY - expectedY };
  });

  const meanX = average(deltas.map((delta) => delta.x));
  const meanY = average(deltas.map((delta) => delta.y));

  // A scan can differ from the template by a small scale as well as a shift --
  // paper stretch and scanner feed both produce one. spreadX measures scatter
  // about the mean shift alone, so a pure scale difference registers there as
  // though every cell had wandered independently. Fit the scale the same way
  // getLineFit does for the rules, and report what scatter survives removing
  // it. Reported only; the gate below still judges on spreadX.
  const expectedX = group.candidates.map((candidate) => candidate.rect.x + candidate.rect.width / 2);
  const expectedY = group.candidates.map((candidate) => candidate.rect.y + candidate.rect.height / 2);
  const fitAxis = (expected: number[], values: number[], mean: number) => {
    const expectedMean = average(expected);
    const denominator = expected.reduce((sum, value) => sum + (value - expectedMean) ** 2, 0);
    if (denominator <= 0) {
      return { scale: 0, residualSpread: Math.max(...values.map((value) => Math.abs(value - mean))) };
    }
    const scale = expected.reduce(
      (sum, value, index) => sum + (value - expectedMean) * (values[index] - mean),
      0,
    ) / denominator;
    return {
      scale,
      residualSpread: Math.max(
        ...values.map((value, index) => Math.abs(value - (mean + scale * (expected[index] - expectedMean)))),
      ),
    };
  };
  const fitX = fitAxis(expectedX, deltas.map((delta) => delta.x), meanX);
  const fitY = fitAxis(expectedY, deltas.map((delta) => delta.y), meanY);

  return {
    maxX: Math.max(...deltas.map((delta) => Math.abs(delta.x))),
    maxY: Math.max(...deltas.map((delta) => Math.abs(delta.y))),
    meanX,
    meanY,
    spreadX: Math.max(...deltas.map((delta) => Math.abs(delta.x - meanX))),
    spreadY: Math.max(...deltas.map((delta) => Math.abs(delta.y - meanY))),
    scaleX: fitX.scale,
    scaleY: fitY.scale,
    residualSpreadX: fitX.residualSpread,
    residualSpreadY: fitY.residualSpread,
  };
}

function getLineFit(actual: number[], expected: number[], pageSize: number): {
  residualRatio: number;
  offsetRatio: number;
  scale: number;
} {
  const expectedMean = average(expected);
  const actualMean = average(actual);
  const denominator = expected.reduce((sum, value) => sum + (value - expectedMean) ** 2, 0);
  const numerator = expected.reduce(
    (sum, value, index) => sum + (value - expectedMean) * (actual[index] - actualMean),
    0,
  );
  const scale = denominator > 0 ? numerator / denominator : 1;
  const offset = actualMean - scale * expectedMean;
  const expectedSpan = Math.max(expected[expected.length - 1] - expected[0], 1);
  const residualRatio = Math.max(
    ...expected.map((value, index) => Math.abs(actual[index] - (scale * value + offset)) / expectedSpan),
  );

  return {
    residualRatio,
    offsetRatio: offset / Math.max(pageSize, 1),
    scale,
  };
}

function isVerifiedGridQuality(
  quality: GridQuality,
  candidateCenter: CandidateCenterQuality,
  maxUniformCandidateOffsetY = GRID_MAX_UNIFORM_CANDIDATE_OFFSET_Y,
): boolean {
  const anchoredToTemplate = (
    candidateCenter.maxX <= GRID_MAX_CANDIDATE_CENTER_DEVIATION &&
    candidateCenter.maxY <= GRID_MAX_CANDIDATE_CENTER_DEVIATION
  );
  // The source photo may have a different content-boundary crop than the
  // blank template. A consistent translation of every option cell is still a
  // valid local table registration, while a wrongly selected table produces
  // option-to-option or row-to-row drift.
  const uniformlyTranslated = (
    Math.abs(candidateCenter.meanX) <= GRID_MAX_UNIFORM_CANDIDATE_OFFSET_X &&
    Math.abs(candidateCenter.meanY) <= maxUniformCandidateOffsetY &&
    candidateCenter.spreadX <= GRID_MAX_CANDIDATE_CENTER_SPREAD &&
    candidateCenter.spreadY <= GRID_MAX_CANDIDATE_CENTER_SPREAD
  );

  return (
    quality.rowGapDeviation <= GRID_MAX_GAP_DEVIATION &&
    quality.columnGapDeviation <= GRID_MAX_GAP_DEVIATION &&
    quality.rowResidualRatio <= GRID_MAX_LINE_RESIDUAL_RATIO &&
    quality.columnResidualRatio <= GRID_MAX_LINE_RESIDUAL_RATIO &&
    (anchoredToTemplate || uniformlyTranslated)
  );
}

/**
 * Names the clause that refused and the limit it missed. The numbers were
 * already here, but with nothing to compare them against a reader could not
 * tell which of five conditions had answered, nor how close the others sat --
 * and a table can pass on five pages and refuse on the sixth purely because
 * one clause has no headroom to begin with.
 */
function describeFailingClauses(
  quality: GridQuality,
  candidateCenter?: CandidateCenterQuality,
  maxUniformCandidateOffsetY = GRID_MAX_UNIFORM_CANDIDATE_OFFSET_Y,
): string {
  const failing: string[] = [];
  const over = (name: string, value: number, limit: number) => {
    if (value > limit) failing.push(`${name} ${(value * 100).toFixed(1)}>${(limit * 100).toFixed(1)}`);
  };
  over('gapRows', quality.rowGapDeviation, GRID_MAX_GAP_DEVIATION);
  over('gapCols', quality.columnGapDeviation, GRID_MAX_GAP_DEVIATION);
  over('resRows', quality.rowResidualRatio, GRID_MAX_LINE_RESIDUAL_RATIO);
  over('resCols', quality.columnResidualRatio, GRID_MAX_LINE_RESIDUAL_RATIO);
  if (candidateCenter) {
    const anchored = candidateCenter.maxX <= GRID_MAX_CANDIDATE_CENTER_DEVIATION
      && candidateCenter.maxY <= GRID_MAX_CANDIDATE_CENTER_DEVIATION;
    const uniform = Math.abs(candidateCenter.meanX) <= GRID_MAX_UNIFORM_CANDIDATE_OFFSET_X
      && Math.abs(candidateCenter.meanY) <= maxUniformCandidateOffsetY
      && candidateCenter.spreadX <= GRID_MAX_CANDIDATE_CENTER_SPREAD
      && candidateCenter.spreadY <= GRID_MAX_CANDIDATE_CENTER_SPREAD;
    if (!anchored && !uniform) failing.push('center');
  }
  const gaps = quality.rowGapDeviations.length > 0
    ? ` rowGaps=${quality.rowGapDeviations.map((value) => (value * 100).toFixed(1)).join(',')}`
    : '';
  return ` [refused=${failing.join(',') || 'none'}${gaps}]`;
}

/**
 * Where the rules actually were, against where the template expected them.
 *
 * A boundary check can fail two ways that look identical in the numbers: the
 * rule was there and the matcher took a different one, or the rule was never
 * detected and the matcher had nothing else to take. On the committed blank
 * satisfaction form the binary table detects exactly three rules for its three
 * boundaries, so it has no alternative selection available at all -- one
 * missing rule and the refusal is forced. Distinguishing the two cases on a
 * real page needs the detected set, not just the residual it produced.
 *
 *   sel   selected rule minus expected boundary, in pixels, per boundary
 *   det   every rule detected in the search window, as pixels from the first
 *         expected boundary; a `sel` entry with no nearby `det` neighbour is a
 *         rule that was never found rather than one that lost a selection
 */
function describeLineEvidence(
  rows: { detected: number[]; selected: number[]; expected: number[] },
  columns: { detected: number[]; selected: number[]; expected: number[] },
): string {
  return ` [rows ${describeAxisEvidence(rows)}; cols ${describeAxisEvidence(columns)}]`;
}

function describeAxisEvidence(
  axis: { detected: number[]; selected: number[]; expected: number[] },
): string {
  const origin = axis.expected[0] ?? 0;
  const selected = axis.selected.length === axis.expected.length
    ? axis.selected.map((value, index) => Math.round(value - axis.expected[index])).join(',')
    : 'unresolved';
  const detected = axis.detected
    .slice(0, MAX_REPORTED_LINES)
    .map((value) => Math.round(value - origin))
    .join(',');
  const truncated = axis.detected.length > MAX_REPORTED_LINES ? `+${axis.detected.length - MAX_REPORTED_LINES}` : '';
  return `sel=${selected} det=${detected}${truncated}`;
}

interface VerticalLineSignalEvidence {
  darkThreshold: number;
  minimumDarkRatio: number;
  radius: number;
  samples: Array<{
    expected: number;
    atRatio: number;
    peakRatio: number;
    peakOffset: number;
  }>;
}

/**
 * Measures the signal that the current vertical-line detector would use at
 * each expected boundary. The exact-column ratio and a small local peak make
 * a refusal actionable: a peak below the active ratio limit supports a
 * sensitivity investigation, while a passing peak with a displaced detected
 * rule points to geometry or selection instead.
 */
function measureVerticalLineSignals(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  searchTop: number,
  searchBottom: number,
  expected: number[],
  darkThreshold: number,
  minimumDarkRatio: number,
  radius: number,
): VerticalLineSignalEvidence {
  const top = clamp(Math.floor(searchTop), 0, image.height - 1);
  const bottom = clamp(Math.ceil(searchBottom), top + 1, image.height);
  const height = bottom - top;
  const ratioAt = (x: number): number => {
    let darkCount = 0;
    for (let y = top; y < bottom; y++) {
      if (image.pixels[y * image.width + x] < darkThreshold) {
        darkCount++;
      }
    }
    return darkCount / height;
  };
  const samples = expected.map((expectedX) => {
    const centerX = clamp(Math.round(expectedX), 0, image.width - 1);
    const atRatio = ratioAt(centerX);
    let peakRatio = atRatio;
    let peakOffset = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const x = centerX + offset;
      if (x < 0 || x >= image.width) continue;
      const ratio = ratioAt(x);
      if (ratio > peakRatio || (ratio === peakRatio && Math.abs(offset) < Math.abs(peakOffset))) {
        peakRatio = ratio;
        peakOffset = offset;
      }
    }
    return { expected: expectedX, atRatio, peakRatio, peakOffset };
  });

  return { darkThreshold, minimumDarkRatio, radius, samples };
}

function describeVerticalLineSignals(signal: VerticalLineSignalEvidence): string {
  const origin = signal.samples[0]?.expected ?? 0;
  const samples = signal.samples.map((sample) => {
    const expected = Math.round(sample.expected - origin);
    const offset = sample.peakOffset >= 0 ? '+' + sample.peakOffset : String(sample.peakOffset);
    return expected + ':' + (sample.atRatio * 100).toFixed(1)
      + '/' + (sample.peakRatio * 100).toFixed(1) + '@' + offset;
  }).join(',');
  return ' signal(t=' + signal.darkThreshold
    + ',min=' + (signal.minimumDarkRatio * 100).toFixed(1)
    + '%,radius=' + signal.radius + 'px; at/peak@offset ' + samples + ')';
}

/** Keeps a diagnostic readable on a page whose tables detect many rules. */
const MAX_REPORTED_LINES = 16;

function formatGridQualityDiagnostic(
  quality: GridQuality,
  candidateCenter?: CandidateCenterQuality,
  maxUniformCandidateOffsetY?: number,
): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const signedPercent = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`;
  const centerDiagnostic = candidateCenter
    ? `; choice center delta x ${percent(candidateCenter.maxX)}, y ${percent(candidateCenter.maxY)}; offset x ${signedPercent(candidateCenter.meanX)}, y ${signedPercent(candidateCenter.meanY)}; spread x ${percent(candidateCenter.spreadX)}, y ${percent(candidateCenter.spreadY)}`
    : '';
  return `grid candidate: gap rows ${percent(quality.rowGapDeviation)}, columns ${percent(quality.columnGapDeviation)}; residual rows ${percent(quality.rowResidualRatio)}, columns ${percent(quality.columnResidualRatio)}${centerDiagnostic}`
    + describeFailingClauses(quality, candidateCenter, maxUniformCandidateOffsetY);
}

function registrationsForGroups(
  groups: ChoiceGroup[],
  tableId: string,
  registration: Omit<FieldRegistration, 'tableId'>,
): Record<string, FieldRegistration> {
  return Object.fromEntries(groups.map((group) => [group.field, {
    tableId,
    ...registration,
  }]));
}

function applyCrossTableRegistrationCheck(result: GridDetectionResult): GridDetectionResult {
  const representatives = new Map<string, FieldRegistration>();
  for (const registration of Object.values(result.registrations)) {
    if (
      registration.source === 'grid'
      && registration.status === 'verified'
      && registration.candidateCenterOffset
      && !registration.independentRegistration
    ) {
      representatives.set(registration.tableId, registration);
    }
  }

  const tableRegistrations = Array.from(representatives.values());
  if (tableRegistrations.length < 2) {
    return result;
  }

  const suspiciousTableIds = new Set<string>();
  if (tableRegistrations.length === 2) {
    const [first, second] = tableRegistrations;
    const delta = getOffsetDelta(first, second);
    if (delta > GRID_MAX_CROSS_TABLE_OFFSET_DELTA) {
      const firstScore = first.qualityScore ?? Number.POSITIVE_INFINITY;
      const secondScore = second.qualityScore ?? Number.POSITIVE_INFINITY;
      suspiciousTableIds.add(firstScore <= secondScore ? second.tableId : first.tableId);
    }
  } else {
    const medianX = median(tableRegistrations.map((registration) => registration.candidateCenterOffset!.x));
    const medianY = median(tableRegistrations.map((registration) => registration.candidateCenterOffset!.y));
    for (const registration of tableRegistrations) {
      const delta = Math.max(
        Math.abs(registration.candidateCenterOffset!.x - medianX),
        Math.abs(registration.candidateCenterOffset!.y - medianY),
      );
      if (delta > GRID_MAX_CROSS_TABLE_OFFSET_DELTA) {
        suspiciousTableIds.add(registration.tableId);
      }
    }
  }

  if (suspiciousTableIds.size === 0) {
    return result;
  }

  const registrations: Record<string, FieldRegistration> = {};
  const diagnostics = { ...result.diagnostics };
  for (const [field, registration] of Object.entries(result.registrations)) {
    if (!suspiciousTableIds.has(registration.tableId) || registration.status !== 'verified') {
      registrations[field] = registration;
      continue;
    }

    const diagnostic = `${formatGridQualityDiagnostic(registrationToQuality(registration), registrationToCandidateCenterQuality(registration))}; cross-table offset mismatch`;
    registrations[field] = { ...registration, status: 'candidate', diagnostic };
    diagnostics[field] = diagnostic;
  }

  return {
    ...result,
    registrations,
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
  };
}

function registrationToQuality(registration: FieldRegistration): GridQuality {
  return {
    rowGapDeviation: registration.gapDeviation?.rows ?? 1,
    columnGapDeviation: registration.gapDeviation?.columns ?? 1,
    rowGapDeviations: [],
    rowResidualRatio: registration.residualRatio?.rows ?? 1,
    columnResidualRatio: registration.residualRatio?.columns ?? 1,
    rowOffsetRatio: registration.offsetRatio?.y ?? 0,
    columnOffsetRatio: registration.offsetRatio?.x ?? 0,
    rowScale: registration.scale?.y ?? 1,
    columnScale: registration.scale?.x ?? 1,
    score: registration.qualityScore ?? 1,
  };
}

function registrationToCandidateCenterQuality(registration: FieldRegistration): CandidateCenterQuality {
  return {
    maxX: registration.candidateCenterDeviation?.x ?? 1,
    maxY: registration.candidateCenterDeviation?.y ?? 1,
    meanX: registration.candidateCenterOffset?.x ?? 0,
    meanY: registration.candidateCenterOffset?.y ?? 0,
    spreadX: registration.candidateCenterSpread?.x ?? 1,
    spreadY: registration.candidateCenterSpread?.y ?? 1,
    scaleX: registration.candidateCenterScale?.x ?? 0,
    scaleY: registration.candidateCenterScale?.y ?? 0,
    residualSpreadX: registration.candidateCenterResidualSpread?.x ?? 1,
    residualSpreadY: registration.candidateCenterResidualSpread?.y ?? 1,
  };
}

function getOffsetDelta(first: FieldRegistration, second: FieldRegistration): number {
  return Math.max(
    Math.abs(first.candidateCenterOffset!.x - second.candidateCenterOffset!.x),
    Math.abs(first.candidateCenterOffset!.y - second.candidateCenterOffset!.y),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function classifyGridLineFailure(
  horizontalFound: number,
  horizontalRequired: number,
  verticalFound: number,
  verticalRequired: number,
  hasRecoveredHorizontalPattern = false,
  hasRecoveredVerticalPattern = false,
): string | undefined {
  if (horizontalFound === 0 && verticalFound === 0) {
    return `격자: lines_undetected (가로선 0/${horizontalRequired}개, 세로선 0/${verticalRequired}개)`;
  }

  if (
    (horizontalFound < horizontalRequired && !hasRecoveredHorizontalPattern)
    || (verticalFound < verticalRequired && !hasRecoveredVerticalPattern)
  ) {
    return `격자: insufficient_lines (가로선 ${horizontalFound}/${horizontalRequired}개, 세로선 ${verticalFound}/${verticalRequired}개)`;
  }

  return undefined;
}

interface PartialTemplateLinePattern {
  lines: number[];
  matchedCount: number;
  residualRatio: number;
}

/**
 * Reconstructs a missing table rule from measured rules. A complete grid
 * remains the default. This fallback deliberately needs at least two measured
 * lines, a near-unity scale, a bounded translation, and later also passes
 * candidate-center verification before it can score marks.
 */
function inferPartialTemplateLinePattern(
  detected: number[],
  expected: number[],
  pageSize: number,
  maxOffsetRatio: number,
): PartialTemplateLinePattern | null {
  if (detected.length < 2 || expected.length < 3) {
    return null;
  }

  const sortedDetected = [...detected].sort((first, second) => first - second);
  const expectedSpan = Math.max(expected[expected.length - 1] - expected[0], 1);
  // A page-relative tolerance is far too wide for a short two-row table: it
  // can turn a nearby description divider into a missing row separator. Keep
  // the tolerance proportional to the table's own span, with a small floor
  // for rasterization noise.
  const lineTolerance = Math.max(3, Math.min(pageSize * 0.012, expectedSpan * 0.18));
  const minimumMatchedLines = Math.max(2, expected.length - 2);
  let best: (PartialTemplateLinePattern & { score: number; offsetRatio: number }) | undefined;

  for (let detectedStart = 0; detectedStart < sortedDetected.length - 1; detectedStart++) {
    for (let detectedEnd = detectedStart + 1; detectedEnd < sortedDetected.length; detectedEnd++) {
      const measuredSpan = sortedDetected[detectedEnd] - sortedDetected[detectedStart];
      if (measuredSpan <= 0) continue;

      for (let expectedStart = 0; expectedStart < expected.length - 1; expectedStart++) {
        for (let expectedEnd = expectedStart + 1; expectedEnd < expected.length; expectedEnd++) {
          const templateSpan = expected[expectedEnd] - expected[expectedStart];
          if (templateSpan <= 0) continue;

          const scale = measuredSpan / templateSpan;
          if (
            scale < 1 - GRID_MAX_RECOVERED_LINE_SCALE_DEVIATION
            || scale > 1 + GRID_MAX_RECOVERED_LINE_SCALE_DEVIATION
          ) continue;

          const offset = sortedDetected[detectedStart] - scale * expected[expectedStart];
          const offsetRatio = Math.abs(offset) / Math.max(pageSize, 1);
          if (offsetRatio > maxOffsetRatio) continue;

          const lines = expected.map((line) => scale * line + offset);
          const match = matchTransformedLines(lines, sortedDetected, lineTolerance);
          if (match.count < minimumMatchedLines) continue;

          const residualRatio = match.totalDeviation / Math.max(match.count * expectedSpan, 1);
          const score = match.count * 10 - residualRatio * 100 - offsetRatio;
          if (!best || score > best.score) {
            best = {
              lines,
              matchedCount: match.count,
              residualRatio,
              score,
              offsetRatio,
            };
          }
        }
      }
    }
  }

  return best ? {
    lines: best.lines,
    matchedCount: best.matchedCount,
    residualRatio: best.residualRatio,
  } : null;
}

function shouldRecoverPartialTemplateLinePattern(
  completeMatch: number[] | null,
  expected: number[],
  pageSize: number,
  detectedCount: number,
): boolean {
  if (!completeMatch) {
    return true;
  }

  // With a large table, an equal-or-greater number of observed rules means a
  // complete-but-wrong grid must stay a review candidate. The only exception
  // is a short two-row table: one printed header rule can look like a row
  // separator while the true internal separator is too faint to detect.
  if (detectedCount >= expected.length && expected.length > 3) {
    return false;
  }

  const gapDeviation = getTemplateGapDeviation(completeMatch, expected);
  const fit = getLineFit(completeMatch, expected, pageSize);
  return (
    gapDeviation === null
    || gapDeviation > GRID_MAX_GAP_DEVIATION
    || fit.residualRatio > GRID_MAX_LINE_RESIDUAL_RATIO
    || Math.abs(fit.scale - 1) > GRID_MAX_RECOVERED_LINE_SCALE_DEVIATION
  );
}

function matchTransformedLines(
  transformed: number[],
  detected: number[],
  tolerance: number,
): { count: number; totalDeviation: number } {
  const remaining = new Set(detected.map((_, index) => index));
  let count = 0;
  let totalDeviation = 0;

  for (const expectedLine of transformed) {
    let closestIndex: number | undefined;
    let closestDeviation = Number.POSITIVE_INFINITY;
    // Keep this as Set#forEach rather than `for...of Set`: the project emits
    // an ES5-compatible server bundle without downlevelIteration.
    remaining.forEach((index) => {
      const deviation = Math.abs(detected[index] - expectedLine);
      if (deviation < closestDeviation) {
        closestIndex = index;
        closestDeviation = deviation;
      }
    });

    if (closestIndex !== undefined && closestDeviation <= tolerance) {
      remaining.delete(closestIndex);
      count++;
      totalDeviation += closestDeviation;
    }
  }

  return { count, totalDeviation };
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
  const bounds = getBounds(image);
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

/**
 * Ceiling on the choose-k-from-n search below.
 *
 * The search has no pruning: the tolerance test needs the whole selection,
 * because each gap is normalised by the span of the selection itself, so a
 * prefix cannot be rejected. That is fine while the detector returns about as
 * many lines as the template expects, which is what a scan gives. A photo does
 * not: perspective breaks each printed rule into pieces and the surface behind
 * the sheet contributes its own, and C(n, k) then runs away. One real photo
 * (cagi-p3) did not come back in four minutes -- in production that is a
 * request that never answers, not a page that reads badly.
 *
 * Exceeding the ceiling reports no match, which is the same outcome the search
 * already produces when nothing fits, and drops the field to row detection or
 * the fixed template. Set far above what a real scan needs: the measured
 * satisfaction and CAGI pages settle in the low thousands of visits.
 */
const TEMPLATE_LINE_MATCH_BUDGET = 200_000;

function matchTemplateLinePattern(detected: number[], expected: number[]): number[] | null {
  if (detected.length < expected.length || expected.length < 2) {
    return null;
  }

  const sorted = [...detected].sort((a, b) => a - b);
  const expectedSpan = expected[expected.length - 1] - expected[0];
  const expectedCenter = (expected[0] + expected[expected.length - 1]) / 2;
  let best: number[] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  let visits = 0;
  let exhausted = false;

  const visit = (start: number, selected: number[]) => {
    if (exhausted) {
      return;
    }
    if (visits >= TEMPLATE_LINE_MATCH_BUDGET) {
      exhausted = true;
      return;
    }
    visits += 1;
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
  // A partial sweep has not seen every candidate, so whatever it happened to
  // score best is not the best match. Report no match rather than a lucky one.
  if (exhausted) {
    return null;
  }
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

/**
 * Compares where the detected row bands are centred against where the template
 * says each row's options sit.
 *
 * The template asserts option centres, not printed rules; `deriveCellBoundaries`
 * reconstructs the rules by halving the distance between neighbouring centres,
 * which is exact only while neighbouring rows are the same height. Two-line
 * questions make them different heights, and then the reconstruction is wrong
 * even for interior boundaries. On the committed blank satisfaction form the
 * printed bands of the binary table measure 39, 66, 38, 39 and 38px where that
 * reconstruction implies 52, 52, 45, 38 and 38 -- so comparing gap shares
 * between reconstructed boundaries charges the table 6.9% of deviation with no
 * scan involved at all, 87% of the allowance, and `cagi.primary` 5.6% for the
 * same reason. Whatever a real page then contributes lands on top of that.
 *
 * The band centres are the quantity the template actually asserts, and every
 * centre on that same form is within a pixel of its printed band: comparing
 * those, on the same page and the same detected rules, gives 0.2%.
 *
 * Below three centres this carries no information -- two centres are a single
 * gap, whose share of itself is always one -- so the boundary comparison stays
 * in use there rather than leaving those tables unchecked.
 */
function getRowBandGapDeviations(
  boundaries: number[],
  expectedCenters?: number[],
): number[] | null {
  if (!expectedCenters || expectedCenters.length < 3 || boundaries.length !== expectedCenters.length + 1) {
    return null;
  }
  const actualCenters = expectedCenters.map((_, index) => (boundaries[index] + boundaries[index + 1]) / 2);
  return getNormalizedGapDeviations(actualCenters, expectedCenters);
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

function hasInvalidCellSize(
  groups: ChoiceGroup[],
  rows: number[],
  columns: number[],
): boolean {
  return groups.some((group, rowIndex) => {
    const top = rows[rowIndex];
    const bottom = rows[rowIndex + 1];
    if (top === undefined || bottom === undefined) return true;

    const cells = group.candidates.map((_, columnIndex) => buildCellCenterRect(
      columns[columnIndex],
      columns[columnIndex + 1],
      top,
      bottom,
    ));
    return cells.some((cell) => cell.right - cell.left < 4 || cell.bottom - cell.top < 4);
  });
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

function hasNearbyLinePair(values: number[], maximumGap = 4): boolean {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted.some((value, index) => index > 0 && value - sorted[index - 1] < maximumGap);
}

function getBounds(image: ImageAnalysisData): PixelBounds {
  return getRegistrationBounds(image);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
