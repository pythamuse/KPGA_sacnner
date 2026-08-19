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
  calculateCheckboxInteriorDifference,
  measureBasicCheckboxPlacement,
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
  // Instrumentation only: appended to the basic-information traces below so
  // the box placement can be read off real scans instead of inferred. Nothing
  // reads these strings back.
  const basicCheckboxMeasurement: Record<string, string> = {};

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
      if (directCheckboxGroup) {
        basicCheckboxMeasurement[group.field] = describeBasicCheckboxPlacement(
          cagiImage,
          scoringCells,
          gridCells,
          cagiBaseline?.image,
          cagiBaseline?.basicCheckboxCandidateRects?.[group.field],
          isVerifiedGrid(registration),
          basicCheckboxDetection?.corrections?.[group.field],
        );
      }
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

    // Appended last: the loop above rewrites the trace of every field that was
    // not filled in automatically, which is exactly the set being measured.
    for (const [field, measurement] of Object.entries(basicCheckboxMeasurement)) {
      recognitionDecisionTrace[field] = [recognitionDecisionTrace[field], measurement]
        .filter(Boolean)
        .join(' ');
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
 * Instrumentation for the basic-information gate. Emits, per option box and in
 * digits only, where the scoring window was placed and what the printed box
 * under it looks like, so the placement can be measured on real scans rather
 * than inferred from a downscaled blank asset.
 *
 *   match whether the page's twelve boxes matched the blank form's, which is
 *         what decides whether these windows came from checkbox geometry at
 *         all; when it is 0 the window is a template rectangle and `off` is
 *         measuring against a box it was never placed from
 *   ref   the blank form's own box for this option, in blank-form pixels; a
 *         size short of its neighbours means the reference component itself
 *         was clipped
 *   off   detected box centre minus the blank form's reference centre, in
 *         page pixels: the offset the matcher applied to this box
 *   ink   dark-ink centroid inside the window, from the window's own centre
 *   ext   how far connected dark ink continues past the left, right, top and
 *         bottom edges of the window
 *   core  share of the window's dark pixels lying in its central half; a
 *         window sitting on its box carries the printed outline on the rim,
 *         a window off its box has that outline running through the middle
 *   dark  dark pixels inside the window, so a share of almost nothing reads
 *         as such
 *   fix   how far this window was moved to agree with the layout the other
 *         eleven boxes fit; 0 where the match was believed as found. `off` is
 *         reported after that move, so a large `fix` beside a small `off` is
 *         a window that was thrown and put back
 *   sig   the residual the gate's own predicate measured, times 1000
 *
 * Nothing here changes a decision, and it carries no answer, only geometry.
 */
function describeBasicCheckboxPlacement(
  image: ImageAnalysisData,
  scoringCells: PixelRect[],
  detectedCells: PixelRect[] | undefined,
  baselineImage: ImageAnalysisData | undefined,
  baselineRects: PixelRect[] | undefined,
  matched: boolean,
  corrections: number[] | undefined,
): string {
  if (!baselineImage || !baselineRects || baselineRects.length !== scoringCells.length) {
    return `[match=${matched ? 1 : 0} win=none]`;
  }
  const bounds = getRegistrationBounds(image);
  const baselineBounds = getRegistrationBounds(baselineImage);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const baselineWidth = baselineBounds.right - baselineBounds.left;
  const baselineHeight = baselineBounds.bottom - baselineBounds.top;
  const window = scoringCells[0];

  const boxes = scoringCells.map((cell, index) => {
    const placement = measureBasicCheckboxPlacement(image, cell);
    const signal = calculateCheckboxInteriorDifference(image, cell, baselineImage, baselineRects[index]);
    const detected = detectedCells?.length === scoringCells.length ? detectedCells[index] : cell;
    const reference = baselineRects[index];
    const offsetX = width * (
      ((detected.left + detected.right) / 2 - bounds.left) / width
      - ((reference.left + reference.right) / 2 - baselineBounds.left) / baselineWidth
    );
    const offsetY = height * (
      ((detected.top + detected.bottom) / 2 - bounds.top) / height
      - ((reference.top + reference.bottom) / 2 - baselineBounds.top) / baselineHeight
    );
    return `#${index + 1} ref=${reference.right - reference.left}x${reference.bottom - reference.top}`
      + ` off=${round1(offsetX)},${round1(offsetY)}`
      + ` ink=${round1(placement.inkX)},${round1(placement.inkY)}`
      + ` ext=${placement.extendLeft},${placement.extendRight},${placement.extendTop},${placement.extendBottom}`
      + ` core=${placement.corePercent} dark=${placement.darkCount}`
      + ` fix=${round1(corrections?.[index] || 0)}`
      + ` sig=${Math.round(signal * 1000)}`;
  });

  return `[match=${matched ? 1 : 0}`
    + ` win=${window.right - window.left}x${window.bottom - window.top}`
    + ` ${boxes.join(' ')}]`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

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
  const signals = actualRects.map((rect, index) => calculateCheckboxInteriorDifference(
    image,
    rect,
    baselineImage,
    baselineRects[index],
  ));
  const markedIndexes = signals
    .map((signal, index) => signal > 0 ? index : -1)
    .filter((index) => index >= 0);
  const valueIndex = group.candidates.findIndex((candidate) => candidate.value === value);
  return markedIndexes.length === 1 && markedIndexes[0] === valueIndex;
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
