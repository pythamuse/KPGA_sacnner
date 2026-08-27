import {
  analyzeChoiceGroup,
  applyTemplateRegistrationFrame,
  getRegistrationBounds,
  hasUsableFormBounds,
  loadImageAnalysisData,
  type ChoiceGroupResult,
  type ImageAnalysisData,
  type PixelRect,
} from './markDensity';
import type {
  RecognitionCandidateMeasurement,
  RecognitionMeasurementsByField,
} from '../labelExport/types';
import type { SheetQualityAttachment } from './sheetQualityDisplay';
import { getTemplate, type ChoiceGroup } from './roiTemplates';
import {
  buildCagiRowDetection,
  buildSatisfactionRowDetection,
  type RowDetectionResult,
} from './tableRowDetection';
import {
  buildCagiGridDetection,
  buildSatisfactionGridDetection,
  completeOverrideOrNull,
  type FieldRegistration,
  type GridDetectionResult,
  type RegistrationStatus,
} from './tableGridDetection';
import {
  matchBasicCheckboxes,
  calculateCheckboxInteriorDifference,
  measureBasicCheckboxPlacement,
  normalizeBasicCheckboxRects,
  type BasicCheckboxGridDetection,
} from './basicCheckboxDetection';
import { recognizeDigitsInRegionDetailed, type DigitOcrOptions } from './ocrTextLines';
import { buildFlattenedGeometryImage } from './illuminationFlatten';
import { loadBlankFormBaseline } from './templateBaseline';
import fs from 'fs/promises';

export type RecognitionCropSource = 'grid' | 'grid-candidate' | 'row' | 'row-fallback' | 'fixed';
export type RecognitionValueSource = 'auto' | 'manual' | 'confirmed' | 'blank_ok' | 'unresolved' | 'restored';

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
  /** Server-only outlet; `/api/recognize` removes it before returning JSON. */
  recognitionMeasurements?: RecognitionMeasurementsByField;
  /**
   * Per-sheet capture verdicts attached by `/api/recognize` (spec F3.2).
   * Review-screen display only — it never reaches a recognized value, and
   * `/api/students` rebuilds the saved student from an explicit whitelist, so
   * it is dropped at save. Absent on drafts made before F3 existed.
   */
  sheetQuality?: SheetQualityAttachment;
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
  /** The sheet went through F1 capture correction (stored registration meta). Enables photo-only refusals. */
  cagiPhotoProvenance?: boolean;
  satisfactionPhotoProvenance?: boolean;
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
  const recognitionMeasurements: RecognitionMeasurementsByField = {};
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
    const cagiRegisteredImage = applyTemplateRegistrationFrame(cagiImageData, cagiTemplate.registrationFrame);
    const cagiImageBuffer = await fs.readFile(cagiPath);
    const canAutoRecognizeCagi = hasUsableFormBounds(cagiRegisteredImage);
    const cagiGridStream = await selectGridDetectionStream(
      cagiRegisteredImage,
      buildCagiGridDetection,
      options.cagiPhotoProvenance ?? false,
    );
    if (cagiGridStream.note) {
      recognitionCropDiagnostic[GRID_STREAM_DIAGNOSTIC_KEY.cagi] = cagiGridStream.note;
    }
    // Grid geometry may have come from the flattened copy; every ink
    // measurement below reads this, and this is always the raw image.
    const cagiImage = cagiGridStream.scoringImage;
    const cagiGridBaseDetection = cagiGridStream.detection;
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
      // Read once, through the completeness guard, so the crop source, the
      // scoring geometry and the automatic-value precondition below all see
      // the same discarded/kept decision.
      const detectedGridCells = cagiGridOverrides[group.field];
      const gridCells = completeOverrideOrNull(detectedGridCells, group.candidates.length) ?? undefined;
      const rowOverride = cagiRowOverrides[group.field];
      const registration = cagiGridDetection.registrations[group.field];
      const cropSource = resolveRecognitionCropSource(gridCells, rowOverride, registration);
      recognitionCropSource[group.field] = cropSource;
      const cropDiagnostic = resolveRecognitionCropDiagnostic(
        cropSource,
        describeIncompleteGridOverride(detectedGridCells, gridCells, group)
          || registration?.diagnostic
          || cagiGridDetection.diagnostics?.[group.field],
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
      // `detectedGridCells`, not `gridCells`: a set discarded for being
      // incomplete is still evidence worth drawing in the debug overlay.
      if (detectedGridCells && scoringCells !== detectedGridCells) {
        recognitionRejectedCandidateRects[group.field] = detectedGridCells;
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
        options.cagiPhotoProvenance ?? false,
      );
      recognitionMeasurements[result.field] = buildCandidateMeasurements(
        result,
        group,
        registration,
        cropSource,
        cagiImage,
      );
      draft.confidence[result.field] = result.confidence;
      draft.candidates![result.field] = mapRecognizedCandidates(result.field, result.candidates);
      const checkboxEvidence = directCheckboxGroup && cagiBaseline?.basicCheckboxCandidateRects?.[group.field]
        ? evaluateDirectCheckboxEvidence(
          cagiImage,
          cagiBaseline.image,
          group,
          scoringCells,
          cagiBaseline.basicCheckboxCandidateRects[group.field],
          result.value,
        )
        : undefined;
      const directCheckboxEvidence = checkboxEvidence ? checkboxEvidence.accepted : true;
      if (directCheckboxGroup) {
        basicCheckboxMeasurement[group.field] = [
          basicCheckboxMeasurement[group.field],
          describeBasicCheckboxDecision(group, result, checkboxEvidence),
        ].filter(Boolean).join(' ');
      }

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
    const satisfactionRegisteredImage = applyTemplateRegistrationFrame(satisfactionImageData, satisfactionTemplate.registrationFrame);
    const satisfactionImageBuffer = await fs.readFile(satisfactionPath);
    const canAutoRecognizeSatisfaction = hasUsableFormBounds(satisfactionRegisteredImage);
    // Row detection stays ahead of the stream selection: it owns the shared
    // OCR worker and runs against a deadline, so the flatten must not be
    // inserted in front of it.
    const satisfactionRowDetection: RowDetectionResult = canAutoRecognizeSatisfaction
      ? await buildSatisfactionRowDetection(satisfactionRegisteredImage, satisfactionImageBuffer, toOcrOptions(options))
      : { overrides: {} };
    const satisfactionRowOverrides = satisfactionRowDetection.overrides;
    const satisfactionGridStream = await selectGridDetectionStream(
      satisfactionRegisteredImage,
      buildSatisfactionGridDetection,
      options.satisfactionPhotoProvenance ?? false,
    );
    if (satisfactionGridStream.note) {
      recognitionCropDiagnostic[GRID_STREAM_DIAGNOSTIC_KEY.satisfaction] = satisfactionGridStream.note;
    }
    // See the CAGI block: geometry may be flattened, ink scoring never is.
    const satisfactionImage = satisfactionGridStream.scoringImage;
    const satisfactionGridDetection = satisfactionGridStream.detection;
    const satisfactionGridOverrides = satisfactionGridDetection.overrides;

    if (!canAutoRecognizeSatisfaction) {
      draft.warnings?.push('만족도조사 이미지의 종이 경계를 안정적으로 찾지 못해 자동 입력을 확정하지 않았습니다. 강조된 항목을 원본과 대조해 직접 확인해주세요.');
    }

    for (const group of satisfactionTemplate.choiceGroups) {
      // Same single guarded read as the CAGI loop above.
      const detectedGridCells = satisfactionGridOverrides[group.field];
      const gridCells = completeOverrideOrNull(detectedGridCells, group.candidates.length) ?? undefined;
      const rowOverride = satisfactionRowOverrides[group.field];
      const registration = satisfactionGridDetection.registrations[group.field];
      const cropSource = resolveRecognitionCropSource(gridCells, rowOverride, registration);
      recognitionCropSource[group.field] = cropSource;
      const cropDiagnostic = resolveRecognitionCropDiagnostic(
        cropSource,
        describeIncompleteGridOverride(detectedGridCells, gridCells, group)
          || registration?.diagnostic
          || satisfactionGridDetection.diagnostics?.[group.field],
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
      // `detectedGridCells`, not `gridCells`: see the CAGI loop above.
      if (detectedGridCells && scoringCells !== detectedGridCells) {
        recognitionRejectedCandidateRects[group.field] = detectedGridCells;
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
        options.satisfactionPhotoProvenance ?? false,
      );
      recognitionMeasurements[result.field] = buildCandidateMeasurements(
        result,
        group,
        registration,
        cropSource,
        satisfactionImage,
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
  if (Object.keys(recognitionMeasurements).length > 0) {
    draft.recognitionMeasurements = Object.fromEntries(
      Object.entries(recognitionMeasurements).map(([field, measurements]) => [
        field,
        measurements.map((measurement) => ({
          ...measurement,
          autoFilled: recognitionValueSource[field] === 'auto',
        })),
      ]),
    );
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

// `basic.age` is read from the CAGI sheet, so the CAGI flag is the one that
// arms the photo-only confidence refusal. An options object is now always
// produced: `deadlineAt: undefined` takes the same branch as no options at
// all, so a caller that passed no deadline keeps the full digit-OCR budget.
function toDigitOcrOptions(options: RecognitionOptions): DigitOcrOptions {
  return {
    deadlineAt: options.digitOcrDeadlineAt,
    photoProvenance: options.cagiPhotoProvenance ?? false,
  };
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

function mapRecognizedCandidateValue(field: string, value: number | string): number | string {
  if (field === 'basic.schoolType') return mapRecognizedSchoolType(value);
  if (field === 'basic.grade') return mapRecognizedGrade(value);
  return value;
}

function buildCandidateMeasurements(
  result: ChoiceGroupResult,
  group: ChoiceGroup,
  registration: FieldRegistration | undefined,
  cropSource: RecognitionCropSource,
  image: Pick<ImageAnalysisData, 'pageInkRatio' | 'pageIsBinarySource'>,
): RecognitionCandidateMeasurement[] {
  const measuredByIndex = new Map(
    (result.candidateMeasurements || []).map((measurement) => [measurement.candidateIndex, measurement]),
  );

  return group.candidates.map((candidate, candidateIndex) => {
    const measurement = measuredByIndex.get(candidateIndex);
    const scored = result.candidates.find((entry) => entry.value === candidate.value);
    return {
      field: result.field,
      candidateValue: mapRecognizedCandidateValue(result.field, candidate.value),
      candidateIndex,
      score: measurement?.score ?? scored?.score ?? 0,
      actualInk: measurement?.actualInk ?? null,
      baselineInk: measurement?.baselineInk ?? null,
      brightnessOffset: measurement?.brightnessOffset ?? null,
      alignX: measurement?.alignX ?? null,
      alignY: measurement?.alignY ?? null,
      largestComponentSize: measurement?.largestComponentSize ?? null,
      largestComponentRatio: measurement?.largestComponentRatio ?? null,
      diagonalRatio: measurement?.diagonalRatio ?? null,
      registrationStatus: registration?.status || 'failed' as RegistrationStatus,
      cropSource,
      pageInkRatio: image.pageInkRatio ?? 0,
      pageIsBinarySource: image.pageIsBinarySource ?? false,
      confidence: result.confidence,
      autoFilled: false,
    };
  });
}

function mapRecognizedCandidates(
  field: string,
  candidates: Array<{ value: number | string; score: number }>,
): Array<{ value: number | string; score: number }> {
  return candidates.map((candidate) => ({
    ...candidate,
    value: mapRecognizedCandidateValue(field, candidate.value),
  }));
}

function unionPixelRects(rects: PixelRect[]): PixelRect {
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

/**
 * Where the per-sheet grid-stream note is filed in `recognitionCropDiagnostic`.
 *
 * The record is otherwise keyed by recognition field. These two keys are not
 * fields, so the review screen — which only ever looks a field up by name —
 * never renders them, while central measurement reading the draft can
 * attribute a change to the stream that produced the geometry. Only written
 * for photo-provenance sheets, so a scan's draft is unchanged down to the
 * key set.
 */
export const GRID_STREAM_DIAGNOSTIC_KEY = {
  cagi: 'sheet.cagi',
  satisfaction: 'sheet.satisfaction',
} as const;

export interface GridStreamDependencies {
  /**
   * Seam. Production passes nothing and gets the sharp-backed flattener; the
   * unit tests pass a stub so "was flatten computed at all?" is observable
   * without reaching into the module graph.
   */
  buildFlattenedImage?: (image: ImageAnalysisData) => Promise<ImageAnalysisData>;
}

export interface GridStreamSelection {
  /** The chosen geometry. Rects only — the pixels it was measured on do not travel with it. */
  detection: GridDetectionResult;
  /**
   * The image every downstream ink measurement must read: always the raw
   * object that came in. Returned rather than assumed so that "geometry may
   * be flattened, scoring never is" is a checkable postcondition of this
   * function instead of a comment at the call site.
   */
  scoringImage: ImageAnalysisData;
  stream: 'raw' | 'flattened';
  /** `grid-stream: flattened(9->13)`. Absent when no flattening was attempted. */
  note?: string;
}

/**
 * Two-stream geometry (spec §9.2 row V-C).
 *
 * On a photographed sheet, run grid detection on the raw pixels and on an
 * illumination-flattened copy, and keep whichever resolved more fields. On the
 * 19 ORB-registered photo sheets, flattening raised the total from 102 fields
 * to 131 but *hurt* six pages (9->2, 11->4, ...), so neither stream wins
 * globally and the choice has to be made per sheet
 * (Task/EXTERNAL_ADOPTION_PLAN_2026-08-27.md §3.4).
 *
 * A tie keeps the raw stream: equal evidence is not a reason to move off the
 * pixels the scorer reads.
 *
 * Scans (`photoProvenance === false`) take exactly the call they took before
 * this function existed — one raw detection, no flatten computed, no note
 * recorded — so the scan measurement cannot move.
 */
export async function selectGridDetectionStream(
  image: ImageAnalysisData,
  buildDetection: (candidate: ImageAnalysisData) => GridDetectionResult,
  photoProvenance: boolean,
  dependencies: GridStreamDependencies = {},
): Promise<GridStreamSelection> {
  // Outside the try below on purpose: a raw-stream failure has to keep
  // propagating to the caller's existing handler exactly as it did before.
  const rawDetection = buildDetection(image);

  if (!photoProvenance) {
    return { detection: rawDetection, scoringImage: image, stream: 'raw' };
  }

  const rawFields = countGridFields(rawDetection);
  const buildFlattenedImage = dependencies.buildFlattenedImage || buildFlattenedGeometryImage;
  let flattenedDetection: GridDetectionResult;
  try {
    flattenedDetection = buildDetection(await buildFlattenedImage(image));
  } catch {
    // The second stream is an addition. If it cannot be computed, the sheet
    // gets the geometry it would have had anyway.
    return {
      detection: rawDetection,
      scoringImage: image,
      stream: 'raw',
      note: `grid-stream: raw(${rawFields}->failed)`,
    };
  }

  const flattenedFields = countGridFields(flattenedDetection);
  const useFlattened = flattenedFields > rawFields;

  return {
    detection: useFlattened ? flattenedDetection : rawDetection,
    scoringImage: image,
    stream: useFlattened ? 'flattened' : 'raw',
    note: `grid-stream: ${useFlattened ? 'flattened' : 'raw'}(${rawFields}->${flattenedFields})`,
  };
}

function countGridFields(detection: GridDetectionResult): number {
  return Object.keys(detection.overrides).length;
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

/**
 * Bookkeeping for the completeness guard: says so, in the reviewer's crop
 * diagnostic, when a grid override was thrown away for holding the wrong
 * number of cells. Returns undefined when nothing was discarded, so the
 * existing registration/grid diagnostics keep their place.
 */
function describeIncompleteGridOverride(
  detectedGridCells: PixelRect[] | undefined,
  keptGridCells: PixelRect[] | undefined,
  group: ChoiceGroup,
): string | undefined {
  if (!detectedGridCells || keptGridCells) {
    return undefined;
  }

  return `Grid override discarded: it holds ${detectedGridCells.length} candidate cells for a `
    + `${group.candidates.length}-choice question, so the measured template coordinates were used instead.`;
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

/**
 * Which half of the decision refused, and on the numbers each half saw.
 *
 * The scorer and this gate do not measure the same thing: the scorer weighs
 * the whole box at 36x28 samples with its own alignment search and shape
 * test, the gate weighs only the inset interior at 8x8 with neither. They can
 * therefore name different boxes, or the scorer can name none at all -- and
 * until now all of that reached the reviewer as one sentence about ink
 * evidence being "absent or ambiguous", including when the ink was neither.
 *
 *   pick  the option the scorer named, 1-based, or 0 when it named none
 *   conf  the confidence it named it with
 *   gate  which clause of the evidence check answered: ok, no-value (the
 *         scorer offered nothing to confirm), named-box-empty (it named a box
 *         with no ink), runner-up-inked, not-dominant, mismatched-cells
 *   scr   the scorer's own score per option, times 1000, against the gate's
 *         sig= above -- a pick that disagrees with the ink shows up as the
 *         two lists peaking on different options
 */
function describeBasicCheckboxDecision(
  group: ChoiceGroup,
  result: ChoiceGroupResult,
  evidence: DirectCheckboxEvidence | undefined,
): string {
  const scores = group.candidates.map((candidate) => {
    const scored = result.candidates.find((entry) => entry.value === candidate.value);
    return Math.round((scored?.score || 0) * 1000);
  });
  const pick = result.value === undefined
    ? 0
    : group.candidates.findIndex((candidate) => candidate.value === result.value) + 1;
  return `[pick=${pick} conf=${result.confidence.charAt(0)}`
    + ` gate=${evidence ? evidence.reason : 'not-applied'}`
    + ` scr=${scores.join(',')}]`;
}

/**
 * How far the named box must outweigh the heaviest other box. With the
 * runner-up already held near zero below, this is what refuses a page where
 * the winner is barely above the noise it is being compared with.
 */
const CHECKBOX_DOMINANCE_RATIO = 4;

/**
 * The most ink any other box may carry and still be dismissed as print rather
 * than an answer. This is the number that keeps a form somebody marked twice
 * out of the system, so it belongs below the faintest mark this project has
 * measured, not merely below a typical one.
 *
 * A ratio cannot carry that on its own: two real marks give a large ratio
 * whenever one is heavier than the other, so dominance alone would auto-fill
 * a doubly-marked form. Bounding the runner-up in absolute terms is what
 * makes a second mark disqualifying however light it is relative to the
 * first.
 */
const CHECKBOX_RUNNER_UP_SIGNAL = 0.025;

type DirectCheckboxRefusal =
  | 'ok'
  | 'no-value'
  | 'mismatched-cells'
  | 'named-box-empty'
  | 'runner-up-inked'
  | 'not-dominant';

interface DirectCheckboxEvidence {
  accepted: boolean;
  reason: DirectCheckboxRefusal;
  signals: number[];
  valueIndex: number;
}

/**
 * Confirms the box the scorer named, on the ink the page actually carries.
 *
 * It used to require that box to be the only one holding any ink at all. A
 * correctly placed window still sees a little of its own printed border, so a
 * single surviving pixel of print on any other option refused the field --
 * one measured page had a mark outweighing its runner-up eleven and a half
 * times and was held for manual entry.
 *
 * So the rule is dominance instead of exclusivity: the named box must carry
 * ink, must outweigh every other box by `CHECKBOX_DOMINANCE_RATIO`, and no
 * other box may carry more than `CHECKBOX_RUNNER_UP_SIGNAL`. Both conditions
 * are needed and they refuse different things -- see the constants above.
 *
 * This is strictly weaker than the rule it replaces: a field that passed
 * before had every other box at exactly zero, which satisfies both conditions
 * outright. Nothing that fills today can stop filling because of this.
 */
function evaluateDirectCheckboxEvidence(
  image: ImageAnalysisData,
  baselineImage: ImageAnalysisData,
  group: ChoiceGroup,
  actualRects: PixelRect[],
  baselineRects: PixelRect[],
  value: number | string | undefined,
): DirectCheckboxEvidence {
  const empty = { accepted: false, signals: [] as number[], valueIndex: -1 };
  if (actualRects.length !== group.candidates.length || baselineRects.length !== group.candidates.length) {
    return { ...empty, reason: 'mismatched-cells' };
  }
  const signals = actualRects.map((rect, index) => calculateCheckboxInteriorDifference(
    image,
    rect,
    baselineImage,
    baselineRects[index],
  ));
  // Reported even when there is nothing to confirm, so the trace can tell a
  // scorer that named no box apart from ink that contradicted the one it did.
  const valueIndex = value === undefined
    ? -1
    : group.candidates.findIndex((candidate) => candidate.value === value);
  if (valueIndex < 0) {
    return { accepted: false, reason: 'no-value', signals, valueIndex };
  }

  const named = signals[valueIndex];
  const runnerUp = Math.max(0, ...signals.filter((_, index) => index !== valueIndex));
  if (named <= 0) {
    return { accepted: false, reason: 'named-box-empty', signals, valueIndex };
  }
  if (runnerUp > CHECKBOX_RUNNER_UP_SIGNAL) {
    return { accepted: false, reason: 'runner-up-inked', signals, valueIndex };
  }
  if (named < CHECKBOX_DOMINANCE_RATIO * runnerUp) {
    return { accepted: false, reason: 'not-dominant', signals, valueIndex };
  }
  return { accepted: true, reason: 'ok', signals, valueIndex };
}

/**
 * Keeps score calculation, inline ROI, and the debug overlay on the same
 * geometry. A rejected grid is evidence only; a detected response row is a
 * better fallback than returning to the full-page normalized template.
 *
 * A grid cell set that does not cover the group's choices one-for-one is
 * treated here as no grid at all -- see `completeOverrideOrNull`.
 */
export function resolveScoringCells(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  group: ChoiceGroup,
  gridCells?: PixelRect[],
  rowOverride?: { top: number; bottom: number },
  registration?: FieldRegistration,
): PixelRect[] {
  const completeGridCells = completeOverrideOrNull(gridCells, group.candidates.length);
  if (isVerifiedGrid(registration) && completeGridCells) return completeGridCells;
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
