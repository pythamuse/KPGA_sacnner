import {
  analyzeChoiceGroup,
  applyTemplateRegistrationFrame,
  createPageInkCalibration,
  getRegistrationBounds,
  hasUsableFormBounds,
  resolveFormBoundsStatus,
  loadImageAnalysisData,
  type CandidateMeasurement,
  type ChoiceGroupResult,
  type DecisionEvidence,
  type ImageAnalysisData,
  type PageInkCalibration,
  type PixelRect,
} from './markDensity';
import type {
  RecognitionCandidateMeasurement,
  RecognitionMeasurementsByField,
} from '../labelExport/types';
import type { SheetQualityAttachment } from './sheetQualityDisplay';
import { describeEvidence } from '../review/evidence';
import { BASELINE_ALIGNMENT_RADIUS } from './markDensityConstants';
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
  isAutomaticGridEligible,
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
import { recognizeDigitsInRegionDetailed, type DigitOcrOptions, type DigitOcrResult } from './ocrTextLines';
import { classifyDigit, type DigitClassification } from './mnist12';
import { buildFlattenedGeometryImage } from './illuminationFlatten';
import { loadBlankFormBaseline } from './templateBaseline';
import fs from 'fs/promises';

// Digit-classifier fallback for `basic.age` (Task/AGE_CLASSIFIER_BRIEF_2026-09-05.md).
// Opt-in via `AGE_DIGIT_CLASSIFIER === '1'` -- note the `=== '1'` convention,
// not `!== '0'`; CLAUDE.md section 2 documents both conventions coexisting in
// this repo, and this one is opt-in by design so the flag being unset (not
// just `=0`) must leave every byte of the output unchanged.
const AGE_DIGIT_CLASSIFIER_ENABLED = process.env.AGE_DIGIT_CLASSIFIER === '1';

export { isAutomaticGridEligible } from './tableGridDetection';

export type RecognitionCropSource = 'grid' | 'grid-candidate' | 'row' | 'row-fallback' | 'fixed';
export type RecognitionValueSource = 'auto' | 'manual' | 'confirmed' | 'blank_ok' | 'unresolved' | 'restored';

/**
 * A default offered to the reviewer on a field the scorer left blank.
 *
 * Display only. No value, confidence or blank count is derived from it: the
 * field stays empty and stays outstanding until a person picks something, and
 * picking the suggestion goes through the ordinary manual-change path so it is
 * labelled as a human's choice like any other. See `selectReviewSuggestion` for
 * the rule and the measurement that scoped it to a suggestion rather than an
 * automatic value.
 */
export interface RecognitionSuggestion {
  /** Position in the template's candidate list; matches `suggest=` in the trace. */
  candidateIndex: number;
  /** The option as the review control holds it, through the same mapping the candidate summary uses. */
  value: number | string;
}

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
    recognitionContested?: Record<string, boolean>;
    /**
     * Which option to offer as the reviewer's default on a field that was left
     * blank. Display only: no value, confidence or blank count is derived
     * from it anywhere. See `RecognitionSuggestion`.
     */
    recognitionSuggestion?: Record<string, RecognitionSuggestion>;
    recognitionDecisionTrace?: Record<string, string>;
    recognitionEvidence?: Record<string, DecisionEvidence>;
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
  recognitionContested?: Record<string, boolean>;
  recognitionSuggestion?: Record<string, RecognitionSuggestion>;
  recognitionDecisionTrace?: Record<string, string>;
  recognitionEvidence?: Record<string, DecisionEvidence>;
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

// Instrument only: counts how often the form-bounds gate is reached through
// a fallback (frame / legacy) rather than paper bounds. Audit finding B-1 --
// nobody has measured whether that path fires on real scans.
function traceBoundsGate(sheet: 'cagi' | 'satisfaction', image: ImageAnalysisData): void {
  if (!process.env.MARK_BOUNDS_TRACE) return;
  const status = resolveFormBoundsStatus(image);
  console.info(`[bounds-gate] sheet=${sheet} source=${image.contentBoundsSource ?? 'none'} confident=${image.contentBoundsConfident ? 1 : 0} usable=${status.usable ? 1 : 0} reason=${status.reason}`);
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
  const recognitionContested: Record<string, boolean> = {};
  const recognitionSuggestion: Record<string, RecognitionSuggestion> = {};
  const recognitionDecisionTrace: Record<string, string> = {};
  const recognitionEvidence: Record<string, DecisionEvidence> = {};
  const decisionEvidenceForTrace: Record<string, DecisionEvidence> = {};
  const recognitionMeasurements: RecognitionMeasurementsByField = {};
  // Instrumentation only: appended to the basic-information traces below so
  // the box placement can be read off real scans instead of inferred. Nothing
  // reads these strings back.
  const basicCheckboxMeasurement: Record<string, string> = {};

  for (const field of RECOGNITION_FIELDS) {
    recognitionValueSource[field] = 'unresolved';
    recognitionContested[field] = false;
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
    traceBoundsGate('cagi', cagiRegisteredImage);
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
        { photoProvenance: options.cagiPhotoProvenance ?? false },
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
    // Input class from the grid cells alone (row fallbacks are not known yet):
    // enough to tell a grayscale scanner from a 1-bit one for the age floor.
    const cagiPreCalibration = buildPageInkCalibration(
      cagiImage,
      cagiTemplate.choiceGroups,
      cagiGridOverrides,
      {},
      cagiGridDetection.registrations,
      cagiBaseline,
      basicGroups,
      options.cagiPhotoProvenance ?? false,
    );
    // Holds the age-OCR result (with stroke bitmaps, when exposed) for the
    // digit-classifier fallback that runs after the choice-group loop below,
    // once `basic.schoolType`/`basic.grade` are known.
    let ageOcrResult: DigitOcrResult | undefined;
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
        toDigitOcrOptions(options, cagiPreCalibration?.inputClass === 'grayscale-scan', AGE_DIGIT_CLASSIFIER_ENABLED),
        cagiBaseline && templateAgeRect ? {
          image: cagiBaseline.image,
          rect: getAgeDigitsRect(templateAgeRect),
        } : undefined,
      );
      ageOcrResult = ageResult;
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
    const cagiPageCalibration = buildPageInkCalibration(
      cagiImage,
      cagiTemplate.choiceGroups,
      cagiGridOverrides,
      cagiRowOverrides,
      cagiGridDetection.registrations,
      cagiBaseline,
      basicGroups,
      options.cagiPhotoProvenance ?? false,
    );

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

      // The affine-reconstructed row is valid registration geometry and is
      // used for scoring. Automatic entry is allowed only for a verified grid
      // with no row gap or one bounded interior gap; the recovered grid remains
      // visible as evidence even when that precondition is not met.
      const verifiedGridCells = isAutomaticGridEligible(registration) ? gridCells : undefined;
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
          pageCalibration: cagiPageCalibration,
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
      if (result.evidence && result.field.startsWith('cagi.')) {
        decisionEvidenceForTrace[result.field] = result.evidence;
        recognitionEvidence[result.field] = compactRecognitionEvidence(result.evidence);
      }
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
      recognitionContested[result.field] = result.contested && directCheckboxEvidence;
      // Present only on results that reached no high confidence, and those all
      // `continue` below without writing a value -- so a field that carries a
      // suggestion is always a field the reviewer finds empty. Nothing here
      // reads it back.
      if (result.suggestion) {
        recognitionSuggestion[result.field] = {
          candidateIndex: result.suggestion.candidateIndex,
          value: mapRecognizedCandidateValue(result.field, result.suggestion.value),
        };
      }
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
        if (canAutoRecognizeCagi && isAutomaticGridEligible(registration)) {
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
      recognitionDecisionTrace[result.field] = result.evidence
        ? describeEvidence(result.evidence, group.candidates.map((candidate) => String(candidate.value)))
        : getRecognitionFieldLabel(result.field) + ': automatic entry completed from a verified grid and high-confidence mark evidence.'
          + (recognitionContested[result.field] ? ' contested=1' : '');
    }

    // Digit-classifier fallback for `basic.age` (Task/AGE_CLASSIFIER_BRIEF_2026-09-05.md).
    // Runs only once `basic.schoolType`/`basic.grade` are known from the loop
    // above, and only where the tesseract path above did not already accept a
    // value -- it can fill a blank, never overrule an accepted read.
    if (AGE_DIGIT_CLASSIFIER_ENABLED) {
      const fallback = applyAgeDigitClassifierFallback({
        ageValueSource: recognitionValueSource['basic.age'],
        schoolTypeValueSource: recognitionValueSource['basic.schoolType'],
        schoolType: draft.basic.schoolType,
        gradeValueSource: recognitionValueSource['basic.grade'],
        grade: draft.basic.grade,
        strokes: ageOcrResult?.strokes,
        existingTrace: recognitionDecisionTrace['basic.age'],
      });
      if (fallback) {
        draft.basic.age = fallback.value;
        recognitionValueSource['basic.age'] = 'auto';
        recognitionDecisionTrace['basic.age'] = fallback.trace;
      }
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
    appendRecognitionEvidenceTraces(
      cagiTemplate.choiceGroups,
      decisionEvidenceForTrace,
      recognitionValueSource,
      recognitionDecisionTrace,
    );
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
    traceBoundsGate('satisfaction', satisfactionRegisteredImage);
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
    const satisfactionPageCalibration = buildPageInkCalibration(
      satisfactionImage,
      satisfactionTemplate.choiceGroups,
      satisfactionGridOverrides,
      satisfactionRowOverrides,
      satisfactionGridDetection.registrations,
      satisfactionBaseline,
      [],
      options.satisfactionPhotoProvenance ?? false,
    );

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

      const verifiedGridCells = isAutomaticGridEligible(registration) ? gridCells : undefined;
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
          pageCalibration: satisfactionPageCalibration,
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
      if (result.evidence && result.field.startsWith('satisfaction.')) {
        decisionEvidenceForTrace[result.field] = result.evidence;
        recognitionEvidence[result.field] = compactRecognitionEvidence(result.evidence);
      }
      draft.confidence[result.field] = result.confidence;
      recognitionContested[result.field] = result.contested;
      // See the CAGI loop: only non-high results carry one, and those leave the
      // field blank.
      if (result.suggestion) {
        recognitionSuggestion[result.field] = {
          candidateIndex: result.suggestion.candidateIndex,
          value: mapRecognizedCandidateValue(result.field, result.suggestion.value),
        };
      }
      draft.candidates![result.field] = result.candidates;

      if (result.value === undefined || result.confidence !== 'high') {
        if (canAutoRecognizeSatisfaction && isAutomaticGridEligible(registration)) {
          recognitionDecisionTrace[result.field] =
            getRecognitionFieldLabel(result.field) + ': automatic entry deferred because high-confidence mark evidence was not found.';
        }
        continue;
      }

      const questionKey = result.field.replace('satisfaction.', '');
      draft.satisfaction[questionKey] = Number(result.value);
      recognitionValueSource[result.field] = 'auto';
      recognitionDecisionTrace[result.field] = result.evidence
        ? describeEvidence(result.evidence, group.candidates.map((candidate) => String(candidate.value)))
        : getRecognitionFieldLabel(result.field) + ': automatic entry completed from a verified grid and high-confidence mark evidence.'
          + (result.contested ? ' contested=1' : '');
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
    appendRecognitionEvidenceTraces(
      satisfactionTemplate.choiceGroups,
      decisionEvidenceForTrace,
      recognitionValueSource,
      recognitionDecisionTrace,
    );
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
  draft.recognitionContested = recognitionContested;
  if (Object.keys(recognitionSuggestion).length > 0) {
    draft.recognitionSuggestion = recognitionSuggestion;
  }
  if (Object.keys(recognitionEvidence).length > 0) {
    draft.recognitionEvidence = recognitionEvidence;
  }
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
function toDigitOcrOptions(options: RecognitionOptions, grayscaleScan = false, exposeStrokes = false): DigitOcrOptions {
  return {
    deadlineAt: options.digitOcrDeadlineAt,
    photoProvenance: options.cagiPhotoProvenance ?? false,
    grayscaleScan,
    exposeStrokes,
  };
}

export interface AgeDigitClassifierInput {
  ageValueSource: RecognitionValueSource;
  schoolTypeValueSource: RecognitionValueSource;
  schoolType: string | undefined;
  gradeValueSource: RecognitionValueSource;
  grade: string | undefined;
  strokes: NonNullable<DigitOcrResult['strokes']> | undefined;
  /** The trace already recorded for `basic.age`, appended after this gate's own sentence. */
  existingTrace: string;
}

export interface AgeDigitClassifierAcceptance {
  value: number;
  trace: string;
}

/**
 * The digit-classifier fallback gate for `basic.age`
 * (Task/AGE_CLASSIFIER_BRIEF_2026-09-05.md), as a pure function so the gate
 * table (confidence below floor, wrong stroke count, out of range, grade or
 * school type unconfirmed, school type other than 중학교) can be tested
 * without a real image pipeline. `classify` defaults to the real
 * `classifyDigit` and is only overridden by tests.
 *
 * Every gate here only takes a value away: it never fires unless the
 * tesseract path above left `basic.age` unfilled (checked by the caller,
 * which does not call this at all when that path already accepted a value),
 * and no school type other than 중학교 gets an assumed age range -- that
 * range was measured only for 중학교 (brief §5) and does not generalise.
 */
export function applyAgeDigitClassifierFallback(
  input: AgeDigitClassifierInput,
  classify: (data: Uint8Array, width: number, height: number) => DigitClassification | null = classifyDigit,
): AgeDigitClassifierAcceptance | undefined {
  if (input.ageValueSource === 'auto') {
    return undefined;
  }

  const schoolTypeIsMiddleSchool = input.schoolTypeValueSource === 'auto'
    && input.schoolType === '중학교';
  const gradeMatch = input.gradeValueSource === 'auto'
    ? /^([1-6])학년$/.exec(String(input.grade))
    : null;
  const expectedRange = schoolTypeIsMiddleSchool && gradeMatch
    ? {
      grade: Number(gradeMatch[1]),
      lo: 12 + Number(gradeMatch[1]) - 1,
      hi: 12 + Number(gradeMatch[1]) + 1,
    }
    : undefined;
  if (!expectedRange) {
    return undefined;
  }

  const strokes = input.strokes;
  if (!strokes || strokes.length !== 2) {
    return undefined;
  }

  const tens = classify(strokes[0].data, strokes[0].width, strokes[0].height);
  const ones = classify(strokes[1].data, strokes[1].width, strokes[1].height);
  if (!tens || !ones) {
    return undefined;
  }

  const minConfidence = Math.min(tens.confidence, ones.confidence);
  const value = tens.digit * 10 + ones.digit;
  if (
    minConfidence < 0.95
    || value < 10 || value > 19
    || value < expectedRange.lo || value > expectedRange.hi
  ) {
    return undefined;
  }

  const trace = `Age OCR accepted ${value} [gate=digit-classifier]: the two strokes read as ${tens.digit} and ${ones.digit} `
    + `at confidence ${Math.round(tens.confidence * 100)}/${Math.round(ones.confidence * 100)} of 95 needed, `
    + `inside the ${expectedRange.lo}-${expectedRange.hi} range implied by 중학교 ${expectedRange.grade}학년. `
    + input.existingTrace;
  return { value, trace };
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

/**
 * The `MARK_SHAPE_TRACE` columns, if this run has them. Absent keys stay
 * absent -- see `CandidateMeasurement` in `markDensity.ts`.
 */
function pickShapeTrace(
  measurement: CandidateMeasurement | undefined,
): Partial<CandidateMeasurement> {
  if (!measurement) return {};
  const trace: Partial<CandidateMeasurement> = {};
  if (measurement.componentCount !== undefined) trace.componentCount = measurement.componentCount;
  if (measurement.component2Size !== undefined) trace.component2Size = measurement.component2Size;
  if (measurement.inkBboxFill !== undefined) trace.inkBboxFill = measurement.inkBboxFill;
  if (measurement.diagonalPos !== undefined) trace.diagonalPos = measurement.diagonalPos;
  if (measurement.diagonalNeg !== undefined) trace.diagonalNeg = measurement.diagonalNeg;
  if (measurement.crossingScore !== undefined) trace.crossingScore = measurement.crossingScore;
  if (measurement.spanX !== undefined) trace.spanX = measurement.spanX;
  if (measurement.spanY !== undefined) trace.spanY = measurement.spanY;
  return trace;
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
      // The MARK_SHAPE_TRACE fields, carried through only when the scorer
      // actually produced them. Picked out by name rather than spreading the
      // whole measurement, so nothing else the scorer ever adds reaches the
      // exported row by accident; with the variable unset none of these keys
      // exist and this row serializes exactly as it did before.
      ...pickShapeTrace(measurement),
      registrationStatus: registration?.status || 'failed' as RegistrationStatus,
      cropSource,
      pageInkRatio: image.pageInkRatio ?? 0,
      pageIsBinarySource: image.pageIsBinarySource ?? false,
      confidence: result.confidence,
      autoFilled: false,
    };
  });
}

/**
 * Keep the review payload small. The scorer result retains the full thresholds
 * for probes and tests; the browser-side serializer knows the same constants,
 * so the repeated threshold object does not need to be copied into every
 * student snapshot field.
 */
function compactRecognitionEvidence(evidence: DecisionEvidence): DecisionEvidence {
  const compact: DecisionEvidence = {
    ...evidence,
    refused: [...evidence.refused],
  };
  // Keep the scorer's public type complete while omitting the repeated object
  // from JSON. `describeEvidence` falls back to the shared constants after
  // the response is parsed in the browser.
  Object.defineProperty(compact, 'thresholds', {
    value: undefined,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  if (compact.refused.length === 0) {
    Object.defineProperty(compact, 'refused', {
      value: [],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (compact.relativeContrast !== undefined && !Number.isFinite(compact.relativeContrast)) {
    delete compact.relativeContrast;
  }

  if (compact.outcome === 'refused') {
    delete compact.runnerUp;
    const refused = compact.refused || [];
    if (!refused.includes('gap')) delete compact.gap;
    if (!refused.includes('relative-contrast')) delete compact.relativeContrast;
    // A shape object is useful on its own; when several gates fail, the token
    // still preserves the cause while omitting this optional object keeps the
    // evidence field within the storage budget.
    if (!refused.includes('mark-shape') || refused.length > 1) delete compact.shape;
    if (
      compact.offset
      && Math.abs(compact.offset.x) < BASELINE_ALIGNMENT_RADIUS
      && Math.abs(compact.offset.y) < BASELINE_ALIGNMENT_RADIUS
    ) {
      delete compact.offset;
    }
  } else {
    // Auto and contested lines use the ranking plus relative contrast. Gap and
    // shape are only needed when they are the reason for a refusal.
    delete compact.gap;
    delete compact.shape;
    if (compact.outcome === 'auto' && compact.relativeContrast === undefined) {
      delete compact.runnerUp;
    }
    if (
      compact.offset
      && compact.offset.x === 0
      && compact.offset.y === 0
    ) {
      delete compact.offset;
    }
    if (
      compact.outcome === 'contested'
      && compact.offset
      && Math.abs(compact.offset.x) < BASELINE_ALIGNMENT_RADIUS
      && Math.abs(compact.offset.y) < BASELINE_ALIGNMENT_RADIUS
    ) {
      delete compact.offset;
    }
  }

  return compact;
}

function appendRecognitionEvidenceTraces(
  groups: ChoiceGroup[],
  evidenceByField: Record<string, DecisionEvidence>,
  valueSourceByField: Record<string, RecognitionValueSource>,
  traceByField: Record<string, string>,
): void {
  for (const group of groups) {
    const evidence = evidenceByField[group.field];
    if (!evidence || valueSourceByField[group.field] === 'auto') continue;
    const description = describeEvidence(
      evidence,
      group.candidates.map((candidate) => String(candidate.value)),
    );
    traceByField[group.field] = [traceByField[group.field], description]
      .filter(Boolean)
      .join(' ');
  }
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

/**
 * Collects the exact candidate geometry the recognition loop will score on one
 * page, paired with the committed baseline geometry by group/index. The
 * scorer uses this only for the opt-in grayscale page calibration; the normal
 * group loop continues to own all recognition decisions.
 *
 * Exported (2026-09-05, Task/CYCLE3_AGE_OCR_PROBE_AGENT_REPORT_2026-09-05.md)
 * so a probe can replay the exact call `recognizeStudentForms` makes instead
 * of reimplementing it. Visibility only -- nothing about what this function
 * does or when it is called from the product path changed.
 */
export function buildPageInkCalibration(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
  gridOverrides: Record<string, PixelRect[]>,
  rowOverrides: Record<string, { top: number; bottom: number }>,
  registrations: Record<string, FieldRegistration>,
  baseline: {
    image: ImageAnalysisData;
    candidateRects: Record<string, PixelRect[]>;
    basicCheckboxCandidateRects?: Record<string, PixelRect[]>;
  } | undefined,
  basicGroups: ChoiceGroup[] = [],
  photoProvenance = false,
): PageInkCalibration | undefined {
  if (!baseline) return undefined;

  const pageRects: PixelRect[] = [];
  const baselineRects: PixelRect[] = [];
  for (const group of groups) {
    const detectedGridCells = gridOverrides[group.field];
    const gridCells = completeOverrideOrNull(detectedGridCells, group.candidates.length) ?? undefined;
    const registration = registrations[group.field];
    const directCheckboxGroup = basicGroups.includes(group);
    const scoringCells = directCheckboxGroup && isVerifiedGrid(registration) && gridCells
      ? normalizeBasicCheckboxRects(image, gridCells)
      : resolveScoringCells(image, group, gridCells, rowOverrides[group.field], registration);
    const matchingBaselineRects = directCheckboxGroup
      ? baseline.basicCheckboxCandidateRects?.[group.field]
        || baseline.candidateRects[group.field]
      : baseline.candidateRects[group.field];

    if (
      scoringCells.length !== group.candidates.length
      || !matchingBaselineRects
      || matchingBaselineRects.length !== group.candidates.length
    ) {
      continue;
    }
    pageRects.push(...scoringCells);
    baselineRects.push(...matchingBaselineRects);
  }

  return createPageInkCalibration(
    image,
    pageRects,
    baseline.image,
    baselineRects,
    photoProvenance,
  );
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
  if (!isAutomaticGridEligible(registration)) {
    return label + ': automatic entry blocked because the horizontal grid geometry was affine-reconstructed without an independent row measurement.';
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

/**
 * Exported (2026-09-05, Task/CYCLE3_AGE_OCR_PROBE_AGENT_REPORT_2026-09-05.md)
 * for the same reason as `buildPageInkCalibration` above -- a probe replaying
 * the CAGI grid-detection call order needs this exact function, not a copy of
 * it. Visibility only.
 */
export function mergeBasicCheckboxDetection(
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
  // Section B follow-up (CHECKBOX_RUNNERUP_CORE): only present when the
  // switch is explicitly turned on ('1') -- omitted otherwise (it is off
  // by default, see the rejection note above isRunnerUpCoreEnabled), so
  // this trace stays byte identical to before cycle 4 in that case.
  const runnerUpCoreNote = evidence?.runnerUpCore !== undefined
    ? ` runnerUpCore=${Math.round(evidence.runnerUpCore * 1000)}`
    : '';
  return `[pick=${pick} conf=${result.confidence.charAt(0)}`
    + ` gate=${evidence ? evidence.reason : 'not-applied'}`
    + ` scr=${scores.join(',')}${runnerUpCoreNote}]`;
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

// CHECKBOX_RUNNERUP_CORE (opt-in, off by default since 2026-09-05 --
// Task/IMPROVEMENT_CYCLES_2026-09-05.md cycle 4). Measured on the browser
// 19-student run: it recovered nothing new but let student 1's basic.grade
// fill 1학년 where the key says 2학년 -- the true mark sat inside the runner-up
// box's outer 25% ring, exactly the ring this inset excludes, so the real
// answer's ink dropped under CHECKBOX_RUNNER_UP_SIGNAL and the wrong box won.
// That is the falsification case the cycle 4 order named up front, so the
// switch defaults off (unset or any value other than exactly '1' keeps
// today's full-window runner-up signal, byte-identical to before cycle 4);
// only CHECKBOX_RUNNERUP_CORE=1 turns the inset window on.
function isRunnerUpCoreEnabled(): boolean {
  return process.env.CHECKBOX_RUNNERUP_CORE === '1';
}

/**
 * The inner 50%x50% of a window -- inset 25% per side -- the same "core"
 * region `measureBasicCheckboxPlacement` (basicCheckboxDetection.ts) already
 * defines for its own `corePercent` measurement. A window that only slightly
 * overlaps the printed box's outline sees that border ink at its rim; this
 * keeps the runner-up comparison below away from that rim.
 */
function coreWindow(rect: PixelRect): PixelRect {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  return {
    left: rect.left + width * 0.25,
    right: rect.right - width * 0.25,
    top: rect.top + height * 0.25,
    bottom: rect.bottom - height * 0.25,
  };
}

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
  /** Section B follow-up (CHECKBOX_RUNNERUP_CORE): the runner-up figure
   * actually compared against, once past the no-value/named-box-empty
   * checks. Undefined when the switch is off or evaluation stopped before
   * a runner-up figure was needed. */
  runnerUpCore?: number;
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
  if (named <= 0) {
    return { accepted: false, reason: 'named-box-empty', signals, valueIndex };
  }

  // Section B follow-up (CHECKBOX_RUNNERUP_CORE): the runner-up checks below
  // used to read the same full-window signal as `named`. A window that only
  // slightly overlaps the printed box's outline sees that border ink at its
  // rim as if it were inside the box (cycle 4 order, "확정된 사실" #2). The
  // runner-up candidates only -- never the named box -- are re-measured on
  // their inner 50%x50% core instead, which the border rim sits outside of.
  const runnerUp = isRunnerUpCoreEnabled()
    ? Math.max(0, ...actualRects.map((rect, index) => (
      index === valueIndex
        ? -Infinity
        : calculateCheckboxInteriorDifference(image, coreWindow(rect), baselineImage, coreWindow(baselineRects[index]))
    )))
    : Math.max(0, ...signals.filter((_, index) => index !== valueIndex));
  const runnerUpCore = isRunnerUpCoreEnabled() ? runnerUp : undefined;

  if (runnerUp > CHECKBOX_RUNNER_UP_SIGNAL) {
    return { accepted: false, reason: 'runner-up-inked', signals, valueIndex, runnerUpCore };
  }
  if (named < CHECKBOX_DOMINANCE_RATIO * runnerUp) {
    return { accepted: false, reason: 'not-dominant', signals, valueIndex, runnerUpCore };
  }
  return { accepted: true, reason: 'ok', signals, valueIndex, runnerUpCore };
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
  // A recovered horizontal rule remains complete grid geometry for scoring;
  // missing rows never demote the registration to candidate.
  if (isVerifiedGrid(registration) && completeGridCells) {
    return completeGridCells;
  }
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

/**
 * Read-only handle onto module-private functions, for
 * `tests/checkboxRunnerUpCore.test.ts` (cycle 4's CHECKBOX_RUNNERUP_CORE
 * addition) only -- same convention as basicCheckboxDetection.ts's own
 * `__probe`. No behaviour change: this adds a reference to the same
 * functions the module already calls, nothing more.
 */
export const __probe = {
  evaluateDirectCheckboxEvidence,
  coreWindow,
  isRunnerUpCoreEnabled,
};
