import {
  analyzeChoiceGroup,
  applyTemplateRegistrationFrame,
  getRegistrationBounds,
  hasUsableFormBounds,
  loadImageAnalysisData,
  type ImageAnalysisData,
  type PixelRect,
} from './markDensity';
import { getTemplate, type ChoiceGroup } from './roiTemplates';
import {
  buildCagiRowDetection,
  buildSatisfactionRowDetection,
  type RowDetectionResult,
} from './tableRowDetection';
import {
  buildCagiGridDetection,
  buildSatisfactionGridDetection,
  type FieldRegistration,
  type GridDetectionResult,
} from './tableGridDetection';
import {
  matchBasicCheckboxes,
  normalizeBasicCheckboxRects,
  type BasicCheckboxGridDetection,
} from './basicCheckboxDetection';
import { recognizeDigitsInRegionDetailed } from './ocrTextLines';
import { loadBlankFormBaseline } from './templateBaseline';
import fs from 'fs/promises';

export type RecognitionCropSource = 'grid' | 'grid-candidate' | 'row' | 'row-fallback' | 'fixed';
export type RecognitionValueSource = 'auto' | 'manual' | 'unresolved';

export interface RecognitionDraft {
  source?: {
    cagiImageId?: string;
    satisfactionImageId?: string;
    cagiImageDataUrl?: string;
    satisfactionImageDataUrl?: string;
    cropDataUrls?: { [field: string]: string };
    cropDebugDataUrls?: { [field: string]: string };
    recognitionCropSource?: Record<string, RecognitionCropSource>;
    recognitionCropDiagnostic?: Record<string, string>;
    recognitionRegistration?: Record<string, FieldRegistration>;
    recognitionValueSource?: Record<string, RecognitionValueSource>;
    recognitionDecisionTrace?: Record<string, string>;
    recognitionManualEditedAt?: Record<string, string>;
  };
  basic: {
    age?: number;
    gender?: string;
    schoolType?: string;
    grade?: string;
  };
  cagi: {
    q01?: number;
    q02?: number;
    q03?: number;
    q04?: number;
    q05?: number;
    q06?: number;
    q07?: number;
    q08?: number;
    q09?: number;
    [key: string]: number | undefined;
  };
  satisfaction: {
    q01?: number;
    q02?: number;
    q03?: number;
    q04?: number;
    q05?: number;
    q06?: number;
    q07?: number;
    q08?: number;
    q09?: number;
    q10?: number;
    [key: string]: number | undefined;
  };
  confidence: {
    [key: string]: 'high' | 'medium' | 'low';
  };
  candidates?: {
    [key: string]: Array<{ value: number | string; score: number }>;
  };
  recognitionCropRects?: Record<string, PixelRect>;
  recognitionCandidateRects?: Record<string, PixelRect[]>;
  recognitionRejectedCandidateRects?: Record<string, PixelRect[]>;
  recognitionCropSource?: Record<string, RecognitionCropSource>;
  recognitionCropDiagnostic?: Record<string, string>;
  recognitionRegistration?: Record<string, FieldRegistration>;
  recognitionValueSource?: Record<string, RecognitionValueSource>;
  recognitionDecisionTrace?: Record<string, string>;
  warnings?: string[];
}

const RECOGNITION_FIELDS = [
  'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
  'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07', 'cagi.q08', 'cagi.q09',
  'satisfaction.q01', 'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06', 'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
] as const;

export interface RecognitionOptions {
  ocrDeadlineAt?: number;
  digitOcrDeadlineAt?: number;
}

export async function recognizeStudentForms(
  cagiPath: string,
  satisfactionPath: string,
  options: RecognitionOptions = {},
): Promise<RecognitionDraft> {
  const draft = createEmptyDraft();
  const recognitionCropRects: Record<string, PixelRect> = {};
  const recognitionCandidateRects: Record<string, PixelRect[]> = {};
  const recognitionRejectedCandidateRects: Record<string, PixelRect[]> = {};
  const recognitionCropSource: Record<string, RecognitionCropSource> = {};
  const recognitionCropDiagnostic: Record<string, string> = {};
  const recognitionRegistration: Record<string, FieldRegistration> = {};
  const recognitionValueSource: Record<string, RecognitionValueSource> = {};
  const recognitionDecisionTrace: Record<string, string> = {};

  for (const field of RECOGNITION_FIELDS) {
    recognitionValueSource[field] = 'unresolved';
    recognitionDecisionTrace[field] = 'Automatic entry was not confirmed.';
  }

  try {
    const cagiTemplate = getTemplate('cagi');
    const [cagiImageData, cagiBaseline] = await Promise.all([
      loadImageAnalysisData(cagiPath),
      loadBlankFormBaseline('cagi'),
    ]);
    const cagiImage = applyTemplateRegistrationFrame(cagiImageData, cagiTemplate.registrationFrame);
    const cagiImageBuffer = await fs.readFile(cagiPath);
    const canAutoRecognizeCagi = hasUsableFormBounds(cagiImage);
    const cagiGridBaseDetection = buildCagiGridDetection(cagiImage);
    const basicGroups = cagiTemplate.choiceGroups.filter((group) => group.field.startsWith('basic.'));
    const basicCheckboxDetection = cagiBaseline?.basicCheckboxCandidateRects
      ? matchBasicCheckboxes(
        cagiImage,
        basicGroups,
        cagiBaseline.image,
        cagiBaseline.basicCheckboxCandidateRects,
      )
      : undefined;
    const cagiGridDetection = mergeBasicCheckboxDetection(
      cagiGridBaseDetection,
      basicGroups,
      basicCheckboxDetection,
      Boolean(cagiBaseline?.basicCheckboxCandidateRects),
    );
    const cagiGridOverrides = cagiGridDetection.overrides;

    // Start the small digit-only OCR before row detection initializes the
    // shared worker, otherwise this request can be skipped as "worker busy".
    const ageRect = cagiGridDetection.fieldRects['basic.age'];
    const templateAgeRect = cagiBaseline?.fieldRects['basic.age'];
    if (!canAutoRecognizeCagi) {
      recognitionDecisionTrace['basic.age'] =
        'Age: automatic entry blocked because the CAGI form boundary was not verified.';
    } else if (!ageRect) {
      recognitionDecisionTrace['basic.age'] =
        'Age: automatic entry blocked because the age-number box was not found.';
    } else {
      const ageResult = await recognizeDigitsInRegionDetailed(
        cagiImageBuffer,
        cagiImage.width,
        cagiImage.height,
        getAgeDigitsRect(ageRect),
        toDigitOcrOptions(options),
        cagiBaseline && templateAgeRect ? {
          image: cagiBaseline.image,
          rect: getAgeDigitsRect(templateAgeRect),
        } : undefined,
      );
      recognitionDecisionTrace['basic.age'] = ageResult.diagnostic;
      if (ageResult.value !== undefined) {
        draft.basic.age = ageResult.value;
        recognitionValueSource['basic.age'] = 'auto';
      }
    }

    const cagiRowDetection: RowDetectionResult = canAutoRecognizeCagi
      ? await buildCagiRowDetection(cagiImage, cagiImageBuffer, toOcrOptions(options))
      : { overrides: {} };
    const cagiRowOverrides = cagiRowDetection.overrides;

    if (!canAutoRecognizeCagi) {
      draft.warnings?.push('선별검사지의 종이 경계를 안정적으로 찾지 못해 자동 입력을 확정하지 않았습니다. 강조된 항목을 원본과 대조해 직접 확인해주세요.');
    }

    for (const group of cagiTemplate.choiceGroups) {
      const gridCells = cagiGridOverrides[group.field];
      const rowOverride = cagiRowOverrides[group.field];
      const registration = cagiGridDetection.registrations[group.field];
      const cropSource = resolveRecognitionCropSource(gridCells, rowOverride, registration);
      recognitionCropSource[group.field] = cropSource;
      const cropDiagnostic = resolveRecognitionCropDiagnostic(
        cropSource,
        registration?.diagnostic || cagiGridDetection.diagnostics?.[group.field],
        cagiRowDetection.diagnostics?.[group.field],
      );
      if (cropDiagnostic) {
        recognitionCropDiagnostic[group.field] = cropDiagnostic;
      }
      if (registration) {
        recognitionRegistration[group.field] = registration;
      }
      recognitionDecisionTrace[group.field] = getAutomaticDecisionTrace(
        group.field,
        canAutoRecognizeCagi,
        registration,
      );
      const directCheckboxGroup = basicGroups.includes(group);
      const scoringCells = directCheckboxGroup && isVerifiedGrid(registration) && gridCells
        ? normalizeBasicCheckboxRects(cagiImage, gridCells)
        : resolveScoringCells(cagiImage, group, gridCells, rowOverride, registration);
      const displayCells = scoringCells;
      recognitionCandidateRects[group.field] = displayCells;
      recognitionCropRects[group.field] = unionPixelRects(displayCells);
      if (gridCells && scoringCells !== gridCells) {
        recognitionRejectedCandidateRects[group.field] = gridCells;
      }

      // A candidate grid may contribute only its observed column positions to
      // a row fallback. It is still manual-only and remains visible as
      // rejected evidence in the debug overlay.
      const verifiedGridCells = isVerifiedGrid(registration) ? gridCells : undefined;
      const result = analyzeChoiceGroup(
        cagiImage,
        group,
        undefined,
        canAutoRecognizeCagi && Boolean(verifiedGridCells),
        scoringCells,
        requiresHighVisualConfidence(group.field),
        cagiBaseline ? {
          image: cagiBaseline.image,
          candidatePixelOverrides: cagiBaseline.basicCheckboxCandidateRects?.[group.field]
            || cagiBaseline.candidateRects[group.field],
        } : undefined,
      );
      draft.confidence[result.field] = result.confidence;
      draft.candidates![result.field] = mapRecognizedCandidates(result.field, result.candidates);
      const directCheckboxEvidence = directCheckboxGroup && cagiBaseline?.basicCheckboxCandidateRects?.[group.field]
        ? hasUniqueDirectCheckboxEvidence(
          cagiImage,
          cagiBaseline.image,
          group,
          scoringCells,
          cagiBaseline.basicCheckboxCandidateRects[group.field],
          result.value,
        )
        : true;

      // Medium confidence stays a suggestion only. Automatic values require a
      // verified grid and the stricter high-confidence mark evidence.
      if (result.value === undefined || result.confidence !== 'high' || !directCheckboxEvidence) {
        if (!directCheckboxEvidence) {
          recognitionDecisionTrace[result.field] =
            getRecognitionFieldLabel(result.field) + ': automatic entry deferred because direct checkbox ink evidence was absent or ambiguous.';
          continue;
        }
        if (canAutoRecognizeCagi && isVerifiedGrid(registration)) {
          recognitionDecisionTrace[result.field] =
            getRecognitionFieldLabel(result.field) + ': automatic entry deferred because high-confidence mark evidence was not found.';
        }
        continue;
      }

      if (result.field === 'basic.gender') {
        draft.basic.gender = String(result.value);
      } else if (result.field === 'basic.schoolType') {
        draft.basic.schoolType = mapRecognizedSchoolType(result.value);
      } else if (result.field === 'basic.grade') {
        draft.basic.grade = mapRecognizedGrade(result.value);
      } else if (result.field.startsWith('cagi.')) {
        const questionKey = result.field.replace('cagi.', '');
        draft.cagi[questionKey] = Number(result.value);
      }
      recognitionValueSource[result.field] = 'auto';
      recognitionDecisionTrace[result.field] =
        getRecognitionFieldLabel(result.field) + ': automatic entry completed from a verified grid and high-confidence mark evidence.';
    }

    for (const [field, rect] of Object.entries(cagiGridDetection.fieldRects)) {
      const registration = cagiGridDetection.registrations[field];
      if (registration) {
        recognitionRegistration[field] = registration;
        if (registration.diagnostic && !recognitionCropDiagnostic[field]) {
          recognitionCropDiagnostic[field] = registration.diagnostic;
        }
      }
      if (!recognitionCropRects[field] && recognitionCropSource[field] === 'fixed') {
        recognitionCropRects[field] = rect;
      }
      recognitionCropSource[field] = recognitionCropSource[field]
        || (registration?.source === 'row' ? 'row' : 'fixed');
      if (field !== 'basic.age' && recognitionValueSource[field] !== 'auto') {
        recognitionDecisionTrace[field] = getAutomaticDecisionTrace(
          field,
          canAutoRecognizeCagi,
          registration,
        );
      }
    }
  } catch {
    // 이미지 분석 실패 시 임의값을 넣지 않고 검수 화면에서 직접 입력하도록 낮은 신뢰도로 둔다.
  }

  try {
    const satisfactionTemplate = getTemplate('satisfaction');
    const [satisfactionImageData, satisfactionBaseline] = await Promise.all([
      loadImageAnalysisData(satisfactionPath),
      loadBlankFormBaseline('satisfaction'),
    ]);
    const satisfactionImage = applyTemplateRegistrationFrame(satisfactionImageData, satisfactionTemplate.registrationFrame);
    const satisfactionImageBuffer = await fs.readFile(satisfactionPath);
    const canAutoRecognizeSatisfaction = hasUsableFormBounds(satisfactionImage);
    const satisfactionRowDetection: RowDetectionResult = canAutoRecognizeSatisfaction
      ? await buildSatisfactionRowDetection(satisfactionImage, satisfactionImageBuffer, toOcrOptions(options))
      : { overrides: {} };
    const satisfactionRowOverrides = satisfactionRowDetection.overrides;
    const satisfactionGridDetection = buildSatisfactionGridDetection(satisfactionImage);
    const satisfactionGridOverrides = satisfactionGridDetection.overrides;

    if (!canAutoRecognizeSatisfaction) {
      draft.warnings?.push('만족도조사 이미지의 종이 경계를 안정적으로 찾지 못해 자동 입력을 확정하지 않았습니다. 강조된 항목을 원본과 대조해 직접 확인해주세요.');
    }

    for (const group of satisfactionTemplate.choiceGroups) {
      const gridCells = satisfactionGridOverrides[group.field];
      const rowOverride = satisfactionRowOverrides[group.field];
      const registration = satisfactionGridDetection.registrations[group.field];
      const cropSource = resolveRecognitionCropSource(gridCells, rowOverride, registration);
      recognitionCropSource[group.field] = cropSource;
      const cropDiagnostic = resolveRecognitionCropDiagnostic(
        cropSource,
        registration?.diagnostic || satisfactionGridDetection.diagnostics?.[group.field],
        satisfactionRowDetection.diagnostics?.[group.field],
      );
      if (cropDiagnostic) {
        recognitionCropDiagnostic[group.field] = cropDiagnostic;
      }
      if (registration) {
        recognitionRegistration[group.field] = registration;
      }
      recognitionDecisionTrace[group.field] = getAutomaticDecisionTrace(
        group.field,
        canAutoRecognizeSatisfaction,
        registration,
      );
      const scoringCells = resolveScoringCells(satisfactionImage, group, gridCells, rowOverride, registration);
      const displayCells = scoringCells;
      recognitionCandidateRects[group.field] = displayCells;
      recognitionCropRects[group.field] = unionPixelRects(displayCells);
      if (gridCells && scoringCells !== gridCells) {
        recognitionRejectedCandidateRects[group.field] = gridCells;
      }

      const verifiedGridCells = isVerifiedGrid(registration) ? gridCells : undefined;
      const result = analyzeChoiceGroup(
        satisfactionImage,
        group,
        undefined,
        canAutoRecognizeSatisfaction && Boolean(verifiedGridCells),
        scoringCells,
        requiresHighVisualConfidence(group.field),
        satisfactionBaseline ? {
          image: satisfactionBaseline.image,
          candidatePixelOverrides: satisfactionBaseline.candidateRects[group.field],
        } : undefined,
      );
      draft.confidence[result.field] = result.confidence;
      draft.candidates![result.field] = result.candidates;

      if (result.value === undefined || result.confidence !== 'high') {
        if (canAutoRecognizeSatisfaction && isVerifiedGrid(registration)) {
          recognitionDecisionTrace[result.field] =
            getRecognitionFieldLabel(result.field) + ': automatic entry deferred because high-confidence mark evidence was not found.';
        }
        continue;
      }

      const questionKey = result.field.replace('satisfaction.', '');
      draft.satisfaction[questionKey] = Number(result.value);
      recognitionValueSource[result.field] = 'auto';
      recognitionDecisionTrace[result.field] =
        getRecognitionFieldLabel(result.field) + ': automatic entry completed from a verified grid and high-confidence mark evidence.';
    }

    for (const [field, rect] of Object.entries(satisfactionGridDetection.fieldRects)) {
      const registration = satisfactionGridDetection.registrations[field];
      if (registration) {
        recognitionRegistration[field] = registration;
        if (registration.diagnostic && !recognitionCropDiagnostic[field]) {
          recognitionCropDiagnostic[field] = registration.diagnostic;
        }
      }
      if (!recognitionCropRects[field] && recognitionCropSource[field] === 'fixed') {
        recognitionCropRects[field] = rect;
      }
      recognitionCropSource[field] = recognitionCropSource[field]
        || (registration?.source === 'row' ? 'row' : 'fixed');
      if (recognitionValueSource[field] !== 'auto') {
        recognitionDecisionTrace[field] = getAutomaticDecisionTrace(
          field,
          canAutoRecognizeSatisfaction,
          registration,
        );
      }
    }
  } catch {
    // Keep satisfaction fields empty so the review screen can collect them manually.
  }

  if (Object.keys(recognitionCropRects).length > 0) {
    draft.recognitionCropRects = recognitionCropRects;
  }
  if (Object.keys(recognitionCandidateRects).length > 0) {
    draft.recognitionCandidateRects = recognitionCandidateRects;
  }
  if (Object.keys(recognitionRejectedCandidateRects).length > 0) {
    draft.recognitionRejectedCandidateRects = recognitionRejectedCandidateRects;
  }
  if (Object.keys(recognitionCropSource).length > 0) {
    draft.recognitionCropSource = recognitionCropSource;
  }
  if (Object.keys(recognitionCropDiagnostic).length > 0) {
    draft.recognitionCropDiagnostic = recognitionCropDiagnostic;
  }
  if (Object.keys(recognitionRegistration).length > 0) {
    draft.recognitionRegistration = recognitionRegistration;
  }
  draft.recognitionValueSource = recognitionValueSource;
  draft.recognitionDecisionTrace = recognitionDecisionTrace;

  return draft;
}

function createEmptyDraft(): RecognitionDraft {
  const confidenceObj: { [key: string]: 'medium' | 'low' } = {};
  RECOGNITION_FIELDS.forEach(f => {
    confidenceObj[f] = f.startsWith('basic') ? 'medium' : 'low'; 
  });

  return {
    basic: {},
    cagi: {},
    satisfaction: {},
    confidence: confidenceObj,
    candidates: {},
    warnings: [],
  };
}

function toOcrOptions(options: RecognitionOptions): { deadlineAt?: number } | undefined {
  return options.ocrDeadlineAt === undefined
    ? undefined
    : { deadlineAt: options.ocrDeadlineAt };
}

function toDigitOcrOptions(options: RecognitionOptions): { deadlineAt?: number } | undefined {
  return options.digitOcrDeadlineAt === undefined
    ? undefined
    : { deadlineAt: options.digitOcrDeadlineAt };
}

function mapRecognizedSchoolType(value: number | string): string {
  const map: Record<string, string> = {
    elementary: '초등학교',
    middle: '중학교',
    high: '고등학교',
    outside: '학교외기관',
  };

  return map[String(value)] || String(value);
}

function mapRecognizedGrade(value: number | string): string {
  const map: Record<string, string> = {
    grade1: '1학년',
    grade2: '2학년',
    grade3: '3학년',
    grade4: '4학년',
    grade5: '5학년',
    grade6: '6학년',
  };

  return map[String(value)] || String(value);
}

function mapRecognizedCandidates(
  field: string,
  candidates: Array<{ value: number | string; score: number }>,
): Array<{ value: number | string; score: number }> {
  if (field === 'basic.schoolType') {
    return candidates.map((candidate) => ({
      ...candidate,
      value: mapRecognizedSchoolType(candidate.value),
    }));
  }

  if (field === 'basic.grade') {
    return candidates.map((candidate) => ({
      ...candidate,
      value: mapRecognizedGrade(candidate.value),
    }));
  }

  return candidates;
}

function unionPixelRects(rects: PixelRect[]): PixelRect {
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

export function getAgeDigitsRect(rect: PixelRect): PixelRect {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;

  // The template field is the measured number box itself. Keep only a small
  // inset to exclude its rules without cutting off either handwritten digit.
  return {
    left: Math.round(rect.left + width * 0.06),
    right: Math.round(rect.left + width * 0.94),
    top: Math.round(rect.top + height * 0.12),
    bottom: Math.round(rect.top + height * 0.88),
  };
}

export function resolveRecognitionCropSource(
  gridCells?: PixelRect[],
  rowOverride?: { top: number; bottom: number },
  registration?: FieldRegistration,
): RecognitionCropSource {
  if (isVerifiedGrid(registration) && gridCells) return 'grid';
  if (rowOverride) return gridCells ? 'row-fallback' : 'row';
  return 'fixed';
}

export function resolveRecognitionCropDiagnostic(
  source: RecognitionCropSource,
  gridDiagnostic?: string,
  rowDiagnostic?: string,
): string | undefined {
  if (source === 'grid') return gridDiagnostic;
  if (source === 'row-fallback') {
    const details = [gridDiagnostic, rowDiagnostic].filter((diagnostic): diagnostic is string => Boolean(diagnostic));
    return details.length > 0
      ? `Grid candidate rejected; row fallback used. ${details.join('; ')}`
      : 'Grid candidate rejected; row fallback used.';
  }
  if (source === 'row') return rowDiagnostic || gridDiagnostic;

  const details = [gridDiagnostic, rowDiagnostic].filter((diagnostic): diagnostic is string => Boolean(diagnostic));
  if (details.length === 0) return undefined;
  return source === 'fixed'
    ? `Grid candidate rejected; measured template coordinates used. ${details.join('; ')}`
    : details.join('; ');
}

function getAutomaticDecisionTrace(
  field: string,
  formBoundaryVerified: boolean,
  registration?: FieldRegistration,
): string {
  const label = getRecognitionFieldLabel(field);
  if (!formBoundaryVerified) {
    return label + ': automatic entry blocked because the form boundary was not verified.';
  }
  if (!isVerifiedGrid(registration)) {
    return label + ': automatic entry blocked because ' + (registration?.diagnostic || 'the answer grid was not independently verified') + '.';
  }
  return label + ': automatic entry is awaiting high-confidence mark evidence.';
}

function getRecognitionFieldLabel(field: string): string {
  if (field === 'basic.gender') return 'Gender';
  if (field === 'basic.schoolType') return 'School type';
  if (field === 'basic.grade') return 'Grade';
  if (field === 'basic.age') return 'Age';
  if (/^satisfaction\.q(07|08|09|10)$/.test(field)) return 'Satisfaction questions 7-10';
  return field;
}

function isVerifiedGrid(registration?: FieldRegistration): boolean {
  return registration?.source === 'grid' && registration.status === 'verified';
}

function mergeBasicCheckboxDetection(
  base: GridDetectionResult,
  groups: ChoiceGroup[],
  detection: BasicCheckboxGridDetection | undefined,
  baselineAvailable: boolean,
): GridDetectionResult {
  if (!baselineAvailable) {
    return base;
  }

  if (!detection) {
    const diagnostic = 'Checkbox geometry did not match the complete 12-box baseline; manual confirmation is required.';
    const registrations = Object.fromEntries(groups.map((group) => [group.field, {
      tableId: 'cagi.basic.checkbox',
      source: 'fixed' as const,
      status: 'failed' as const,
      diagnostic,
    } satisfies FieldRegistration]));
    return {
      ...base,
      registrations: { ...base.registrations, ...registrations },
      diagnostics: {
        ...base.diagnostics,
        ...Object.fromEntries(groups.map((group) => [group.field, diagnostic])),
      },
    };
  }

  const registrations = Object.fromEntries(groups.map((group) => [group.field, {
    tableId: 'cagi.basic.checkbox',
    source: 'grid' as const,
    status: 'verified' as const,
    independentRegistration: true,
    diagnostic: detection.diagnostic,
  } satisfies FieldRegistration]));
  const fieldRects = Object.fromEntries(Object.entries(detection.overrides).map(([field, cells]) => [
    field,
    unionPixelRects(cells),
  ]));

  return {
    ...base,
    overrides: { ...base.overrides, ...detection.overrides },
    fieldRects: { ...base.fieldRects, ...fieldRects },
    registrations: { ...base.registrations, ...registrations },
    diagnostics: {
      ...base.diagnostics,
      ...Object.fromEntries(groups.map((group) => [group.field, detection.diagnostic])),
    },
  };
}

/**
 * Still requires that exactly one option box carry a mark, which is what stops
 * a form answered twice from being filled in automatically. What changed is
 * what counts as a mark: "the box holds ink" cannot tell a hand mark from the
 * box's own printed border, so on a real raster both options read as inked and
 * every basic-information field fell to manual entry.
 */
function hasUniqueDirectCheckboxEvidence(
  image: ImageAnalysisData,
  baselineImage: ImageAnalysisData,
  group: ChoiceGroup,
  actualRects: PixelRect[],
  baselineRects: PixelRect[],
  value: number | string | undefined,
): boolean {
  if (value === undefined || actualRects.length !== group.candidates.length || baselineRects.length !== group.candidates.length) {
    return false;
  }
  // The blank form's boxes are raw connected components, so their widths and
  // heights vary by a pixel or two. Restoring the canonical box shape puts the
  // two windows over the same part of the same printed box.
  const blankRects = normalizeBasicCheckboxRects(baselineImage, baselineRects);
  const markedIndexes = actualRects
    .map((rect, index) => hasHandDrawnCheckboxMark(image, rect, baselineImage, blankRects[index]) ? index : -1)
    .filter((index) => index >= 0);
  const valueIndex = group.candidates.findIndex((candidate) => candidate.value === value);
  return markedIndexes.length === 1 && markedIndexes[0] === valueIndex;
}

/**
 * How far outside the box the comparison window reaches, as a fraction of the
 * box. Wide enough that the printed box is still inside the window when the
 * detector's centre is off by a pixel or two, narrow enough to exclude the
 * neighbouring option and its printed label.
 */
const CHECKBOX_WINDOW_MARGIN = 0.25;
/**
 * Cells across that window. At the raster the browser uploads a basic-info box
 * is about 12px, so this is close to one cell per pixel; every other constant
 * here is a fraction of the box, which keeps the test the same shape at any
 * upload resolution.
 */
const CHECKBOX_SAMPLE_CELLS = 18;
/** Registration freedom, in cells, between the scan and the blank form. */
const CHECKBOX_ALIGNMENT_CELLS = 2;
/** Slack around printed ink that absorbs the sub-pixel part of that registration. */
const CHECKBOX_PRINT_DILATION = 1;
/** Anti-aliasing and scanner-noise band, matching the scorer's own tolerance. */
const CHECKBOX_INK_TOLERANCE = 0.08;
/** A stroke has to cover this fraction of the box's area to count as a mark. */
const CHECKBOX_MARK_AREA_RATIO = 0.07;
/** ...and to span this fraction of the box in both directions. */
const CHECKBOX_MARK_EXTENT_RATIO = 0.25;

/**
 * True when the box holds ink that the blank form does not have there: a
 * connected stroke, clear of the printed outline, that runs across the box in
 * both directions.
 *
 * A check drawn inside an empty printed box necessarily leaves ink where the
 * blank form had none, which is the property this relies on. It is not shared
 * by the circles drawn around printed words elsewhere on these forms, so this
 * test stays where that asymmetry holds — the direct checkbox path.
 *
 * The border cannot impersonate that. Registration error moves the printed
 * outline by a fraction of a pixel, which survives as a sliver one or two
 * cells thick lying along the outline; excluding ink next to printed ink drops
 * most of it, and what is left cannot span the box in both directions.
 */
function hasHandDrawnCheckboxMark(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
): boolean {
  const cells = CHECKBOX_SAMPLE_CELLS;
  const search = CHECKBOX_ALIGNMENT_CELLS;
  const blankCells = cells + 2 * search;
  // The blank window carries the search range as extra margin so that every
  // offset has a counterpart, and both windows keep the same cell pitch.
  const blankMargin = CHECKBOX_WINDOW_MARGIN
    + (search / cells) * (1 + 2 * CHECKBOX_WINDOW_MARGIN);
  const actual = sampleCheckboxWindow(image, inflateRect(actualRect, CHECKBOX_WINDOW_MARGIN), cells);
  const blank = sampleCheckboxWindowDarkest(baseline, inflateRect(baselineRect, blankMargin), blankCells);

  // Scanners shift the paper's overall brightness. Read the reference off the
  // same physical extent in both windows, or the wider blank window reads as
  // lighter paper and the comparison drifts.
  const blankCore = new Float32Array(cells * cells);
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      blankCore[y * cells + x] = blank[(y + search) * blankCells + (x + search)];
    }
  }
  const brightnessOffset = brightPercentile(blankCore) - brightPercentile(actual);

  let bestX = search;
  let bestY = search;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let offsetY = 0; offsetY <= 2 * search; offsetY += 1) {
    for (let offsetX = 0; offsetX <= 2 * search; offsetX += 1) {
      let cost = 0;
      for (let y = 0; y < cells; y += 1) {
        for (let x = 0; x < cells; x += 1) {
          const actualInk = inkDarkness(actual[y * cells + x] + brightnessOffset);
          const blankInk = inkDarkness(blank[(y + offsetY) * blankCells + (x + offsetX)]);
          cost += Math.abs(actualInk - blankInk);
        }
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestX = offsetX;
        bestY = offsetY;
      }
    }
  }

  const residual = new Uint8Array(cells * cells);
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const blankX = x + bestX;
      const blankY = y + bestY;
      if (isNearPrintedInk(blank, blankCells, blankX, blankY)) continue;
      const actualInk = inkDarkness(actual[y * cells + x] + brightnessOffset);
      const blankInk = inkDarkness(blank[blankY * blankCells + blankX]);
      if (actualInk - blankInk > CHECKBOX_INK_TOLERANCE) {
        residual[y * cells + x] = 1;
      }
    }
  }

  const boxCells = cells / (1 + 2 * CHECKBOX_WINDOW_MARGIN);
  const minimumArea = Math.max(1, Math.round(CHECKBOX_MARK_AREA_RATIO * boxCells * boxCells));
  const minimumExtent = Math.max(1, Math.round(CHECKBOX_MARK_EXTENT_RATIO * boxCells));
  return hasStrokeComponent(residual, cells, minimumArea, minimumExtent);
}

function isNearPrintedInk(
  blank: Float32Array,
  blankCells: number,
  x: number,
  y: number,
): boolean {
  for (let offsetY = -CHECKBOX_PRINT_DILATION; offsetY <= CHECKBOX_PRINT_DILATION; offsetY += 1) {
    for (let offsetX = -CHECKBOX_PRINT_DILATION; offsetX <= CHECKBOX_PRINT_DILATION; offsetX += 1) {
      const sampleY = y + offsetY;
      const sampleX = x + offsetX;
      if (sampleY < 0 || sampleX < 0 || sampleY >= blankCells || sampleX >= blankCells) continue;
      if (inkDarkness(blank[sampleY * blankCells + sampleX]) > CHECKBOX_INK_TOLERANCE) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A pen stroke is connected and runs across the box; what a mis-registered
 * printed edge leaves behind is a line one or two cells thick, and what the
 * codec leaves behind is a speck. Both tests have to hold.
 */
function hasStrokeComponent(
  residual: Uint8Array,
  cells: number,
  minimumArea: number,
  minimumExtent: number,
): boolean {
  const visited = new Uint8Array(residual.length);
  for (let start = 0; start < residual.length; start += 1) {
    if (!residual[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let size = 0;
    let minX = cells;
    let maxX = -1;
    let minY = cells;
    let maxY = -1;
    while (queue.length > 0) {
      const current = queue.pop()!;
      const currentX = current % cells;
      const currentY = Math.floor(current / cells);
      size += 1;
      minX = Math.min(minX, currentX);
      maxX = Math.max(maxX, currentX);
      minY = Math.min(minY, currentY);
      maxY = Math.max(maxY, currentY);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighborX = currentX + offsetX;
          const neighborY = currentY + offsetY;
          if (neighborX < 0 || neighborY < 0 || neighborX >= cells || neighborY >= cells) continue;
          const neighbor = neighborY * cells + neighborX;
          if (visited[neighbor] || !residual[neighbor]) continue;
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    if (
      size >= minimumArea
      && maxX - minX + 1 >= minimumExtent
      && maxY - minY + 1 >= minimumExtent
    ) {
      return true;
    }
  }
  return false;
}

function inflateRect(rect: PixelRect, ratio: number): PixelRect {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  return {
    left: rect.left - width * ratio,
    top: rect.top - height * ratio,
    right: rect.right + width * ratio,
    bottom: rect.bottom + height * ratio,
  };
}

/** Nearest source pixel, as everywhere else in the mark path. */
function sampleCheckboxWindow(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  rect: PixelRect,
  cells: number,
): Float32Array {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const samples = new Float32Array(cells * cells);
  for (let y = 0; y < cells; y += 1) {
    const sourceY = clampPixel(Math.round(rect.top + ((y + 0.5) / cells) * height - 0.5), 0, image.height - 1);
    for (let x = 0; x < cells; x += 1) {
      const sourceX = clampPixel(Math.round(rect.left + ((x + 0.5) / cells) * width - 0.5), 0, image.width - 1);
      samples[y * cells + x] = image.pixels[sourceY * image.width + sourceX];
    }
  }
  return samples;
}

/**
 * The committed blank form is rendered at roughly twice the raster the browser
 * uploads, so a single nearest-point sample can fall between two printed
 * strokes and report paper where the scan shows a broad grey line. Keeping the
 * darkest source pixel under each cell means no printed stroke can go missing
 * from the reference and then be counted as a hand mark.
 */
function sampleCheckboxWindowDarkest(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  rect: PixelRect,
  cells: number,
): Float32Array {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const samples = new Float32Array(cells * cells);
  for (let y = 0; y < cells; y += 1) {
    const top = Math.round(rect.top + (y / cells) * height);
    const bottom = Math.max(top + 1, Math.round(rect.top + ((y + 1) / cells) * height));
    for (let x = 0; x < cells; x += 1) {
      const left = Math.round(rect.left + (x / cells) * width);
      const right = Math.max(left + 1, Math.round(rect.left + ((x + 1) / cells) * width));
      let darkest = 255;
      for (let sourceY = top; sourceY < bottom; sourceY += 1) {
        if (sourceY < 0 || sourceY >= image.height) continue;
        for (let sourceX = left; sourceX < right; sourceX += 1) {
          if (sourceX < 0 || sourceX >= image.width) continue;
          const value = image.pixels[sourceY * image.width + sourceX];
          if (value < darkest) darkest = value;
        }
      }
      samples[y * cells + x] = darkest;
    }
  }
  return samples;
}

function inkDarkness(value: number): number {
  return Math.max(0, Math.min(1, (178 - value) / 178));
}

/** Paper brightness reference, taken above any plausible ink coverage. */
function brightPercentile(values: Float32Array): number {
  const sorted = Array.from(values).sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * 0.9)))];
}

/**
 * Keeps score calculation, inline ROI, and the debug overlay on the same
 * geometry. A rejected grid is evidence only; a detected response row is a
 * better fallback than returning to the full-page normalized template.
 */
export function resolveScoringCells(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  group: ChoiceGroup,
  gridCells?: PixelRect[],
  rowOverride?: { top: number; bottom: number },
  registration?: FieldRegistration,
): PixelRect[] {
  if (isVerifiedGrid(registration) && gridCells) return gridCells;
  if (rowOverride) return buildRowFallbackCandidateRects(image, group, rowOverride);
  return buildFixedTemplateCandidateRects(image, group);
}

export function buildRowFallbackCandidateRects(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  group: ChoiceGroup,
  rowOverride: { top: number; bottom: number },
): PixelRect[] {
  const bounds = getRegistrationBounds(image);
  const baseWidth = bounds.right - bounds.left;
  const rowHeight = Math.max(rowOverride.bottom - rowOverride.top, 1);
  const verticalInset = Math.min(Math.max(1, Math.round(rowHeight * 0.15)), Math.floor(rowHeight / 3));
  const top = rowOverride.top + verticalInset;
  const bottom = Math.max(top + 1, rowOverride.bottom - verticalInset);
  return group.candidates.map((candidate, index) => ({
    left: clampPixel(Math.round(bounds.left + candidate.rect.x * baseWidth), 0, image.width - 1),
    right: clampPixel(Math.round(bounds.left + (candidate.rect.x + candidate.rect.width) * baseWidth), 1, image.width),
    top: clampPixel(top, 0, image.height - 1),
    bottom: clampPixel(bottom, 1, image.height),
  })).map((rect) => ({
    ...rect,
    right: Math.max(rect.left + 1, rect.right),
    bottom: Math.max(rect.top + 1, rect.bottom),
  }));
}

export function buildFixedTemplateCandidateRects(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  group: ChoiceGroup,
): PixelRect[] {
  const bounds = getRegistrationBounds(image);
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;

  return group.candidates.map((candidate) => ({
    left: clampPixel(Math.round(bounds.left + candidate.rect.x * baseWidth), 0, image.width - 1),
    right: clampPixel(Math.round(bounds.left + (candidate.rect.x + candidate.rect.width) * baseWidth), 1, image.width),
    top: clampPixel(Math.round(bounds.top + candidate.rect.y * baseHeight), 0, image.height - 1),
    bottom: clampPixel(Math.round(bounds.top + (candidate.rect.y + candidate.rect.height) * baseHeight), 1, image.height),
  })).map((rect) => ({
    ...rect,
    right: Math.max(rect.left + 1, rect.right),
    bottom: Math.max(rect.top + 1, rect.bottom),
  }));
}

function clampPixel(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function requiresHighVisualConfidence(field: string): boolean {
  return new Set([
    'cagi.q04',
    'cagi.q05',
    'cagi.q08',
    'satisfaction.q01',
    'satisfaction.q07',
    'satisfaction.q08',
    'satisfaction.q09',
    'satisfaction.q10',
  ]).has(field);
}
