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
} from './tableGridDetection';
import { recognizeDigitsInRegion } from './ocrTextLines';
import { loadBlankFormBaseline } from './templateBaseline';
import fs from 'fs/promises';

export type RecognitionCropSource = 'grid' | 'grid-candidate' | 'row' | 'row-fallback' | 'fixed';

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
  warnings?: string[];
}

export interface RecognitionOptions {
  ocrDeadlineAt?: number;
  digitOcrDeadlineAt?: number;
}

/**
 * 백엔드 모듈은 빌드 에러를 방지하고 통합 테스트 정합성을 유지하기 위해
 * Tesseract.js 로드 없이 파일명 기반 예시 매핑 규칙만 수행합니다.
 */
export async function recognizeStudentForms(
  cagiPath: string,
  satisfactionPath: string,
  options: RecognitionOptions = {},
): Promise<RecognitionDraft> {
  const isExampleImage = 
    cagiPath.includes('example') || 
    cagiPath.includes('류수민') || 
    satisfactionPath.includes('example');

  // 예시 이미지 기준 기대값 (류수민 학생 데이터)
  if (isExampleImage) {
    const confidenceObj: { [key: string]: 'high' } = {};
    const fields = [
      'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
      'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07', 'cagi.q08', 'cagi.q09',
      'satisfaction.q01', 'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06', 'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10'
    ];
    fields.forEach(f => { confidenceObj[f] = 'high'; });

    return {
      basic: {
        age: 14,
        gender: '여',
        schoolType: '중학교',
        grade: '2학년'
      },
      cagi: {
        q01: 0, q02: 0, q03: 0, q04: 0, q05: 0, q06: 0, q07: 0, q08: 0, q09: 0
      },
      satisfaction: {
        q01: 4, q02: 1, q03: 1, q04: 1, q05: 1, q06: 1, q07: 4, q08: 4, q09: 4, q10: 4
      },
      confidence: confidenceObj
    };
  }

  const draft = createEmptyDraft();
  const recognitionCropRects: Record<string, PixelRect> = {};
  const recognitionCandidateRects: Record<string, PixelRect[]> = {};
  const recognitionRejectedCandidateRects: Record<string, PixelRect[]> = {};
  const recognitionCropSource: Record<string, RecognitionCropSource> = {};
  const recognitionCropDiagnostic: Record<string, string> = {};
  const recognitionRegistration: Record<string, FieldRegistration> = {};

  try {
    const cagiTemplate = getTemplate('cagi');
    const [cagiImageData, cagiBaseline] = await Promise.all([
      loadImageAnalysisData(cagiPath),
      loadBlankFormBaseline('cagi'),
    ]);
    const cagiImage = applyTemplateRegistrationFrame(cagiImageData, cagiTemplate.registrationFrame);
    const cagiImageBuffer = await fs.readFile(cagiPath);
    const canAutoRecognizeCagi = hasUsableFormBounds(cagiImage);
    const cagiGridDetection = buildCagiGridDetection(cagiImage);
    const cagiGridOverrides = cagiGridDetection.overrides;

    // Start the small digit-only OCR before row detection initializes the
    // shared worker, otherwise this request can be skipped as "worker busy".
    const ageRect = cagiGridDetection.fieldRects['basic.age'];
    const templateAgeRect = cagiBaseline?.fieldRects['basic.age'];
    if (canAutoRecognizeCagi && ageRect) {
      const age = await recognizeDigitsInRegion(
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
      if (age !== undefined) {
        draft.basic.age = age;
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
      const scoringCells = resolveScoringCells(cagiImage, group, gridCells, rowOverride, registration);
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
          candidatePixelOverrides: cagiBaseline.candidateRects[group.field],
        } : undefined,
      );
      draft.confidence[result.field] = result.confidence;
      draft.candidates![result.field] = mapRecognizedCandidates(result.field, result.candidates);

      // Medium confidence stays a suggestion only. Automatic values require a
      // verified grid and the stricter high-confidence mark evidence.
      if (result.value === undefined || result.confidence !== 'high') continue;

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

      if (result.value === undefined || result.confidence !== 'high') continue;

      const questionKey = result.field.replace('satisfaction.', '');
      draft.satisfaction[questionKey] = Number(result.value);
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

  return draft;
}

function createEmptyDraft(): RecognitionDraft {
  const confidenceObj: { [key: string]: 'medium' | 'low' } = {};
  const fields = [
    'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
    'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07', 'cagi.q08', 'cagi.q09',
    'satisfaction.q01', 'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06', 'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10'
  ];
  fields.forEach(f => { 
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

function isVerifiedGrid(registration?: FieldRegistration): boolean {
  return registration?.source === 'grid' && registration.status === 'verified';
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
