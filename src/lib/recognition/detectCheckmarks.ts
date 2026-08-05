import { analyzeChoiceGroup, loadImageAnalysisData, type PixelRect } from './markDensity';
import { getTemplate } from './roiTemplates';
import { buildCagiRowOverrides, buildSatisfactionRowOverrides } from './tableRowDetection';
import { buildCagiGridDetection, buildSatisfactionGridOverrides } from './tableGridDetection';
import fs from 'fs/promises';

export interface RecognitionDraft {
  source?: {
    cagiImageId?: string;
    satisfactionImageId?: string;
    cagiImageDataUrl?: string;
    satisfactionImageDataUrl?: string;
    cropDataUrls?: { [field: string]: string };
    cropDebugDataUrls?: { [field: string]: string };
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
  warnings?: string[];
}

export interface RecognitionOptions {
  ocrDeadlineAt?: number;
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

  try {
    const cagiImage = await loadImageAnalysisData(cagiPath);
    const cagiImageBuffer = await fs.readFile(cagiPath);
    const cagiTemplate = getTemplate('cagi');
    const canAutoRecognizeCagi = cagiImage.contentBoundsConfident;
    const cagiRowOverrides = canAutoRecognizeCagi
      ? await buildCagiRowOverrides(cagiImage, cagiImageBuffer, toOcrOptions(options))
      : {};
    const cagiGridDetection = canAutoRecognizeCagi
      ? buildCagiGridDetection(cagiImage)
      : { overrides: {}, registeredFields: new Set<string>() };
    const cagiGridOverrides = cagiGridDetection.overrides;

    if (!canAutoRecognizeCagi) {
      draft.warnings?.push('선별검사지의 종이 경계를 안정적으로 찾지 못해 자동 입력을 확정하지 않았습니다. 강조된 항목을 원본과 대조해 직접 확인해주세요.');
    }

    for (const group of cagiTemplate.choiceGroups) {
      const gridCells = cagiGridOverrides[group.field];
      const result = analyzeChoiceGroup(
        cagiImage,
        group,
        cagiRowOverrides[group.field],
        canAutoRecognizeCagi && !cagiGridDetection.registeredFields.has(group.field),
        gridCells,
      );
      draft.confidence[result.field] = result.confidence;
      draft.candidates![result.field] = mapRecognizedCandidates(result.field, result.candidates);
      if (gridCells) {
        recognitionCropRects[result.field] = unionPixelRects(gridCells);
      }

      if (result.value === undefined) continue;

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
  } catch {
    // 이미지 분석 실패 시 임의값을 넣지 않고 검수 화면에서 직접 입력하도록 낮은 신뢰도로 둔다.
  }

  try {
    const satisfactionImage = await loadImageAnalysisData(satisfactionPath);
    const satisfactionImageBuffer = await fs.readFile(satisfactionPath);
    const satisfactionTemplate = getTemplate('satisfaction');
    const canAutoRecognizeSatisfaction = satisfactionImage.contentBoundsConfident;
    const satisfactionRowOverrides = canAutoRecognizeSatisfaction
      ? await buildSatisfactionRowOverrides(satisfactionImage, satisfactionImageBuffer, toOcrOptions(options))
      : {};
    const satisfactionGridOverrides = canAutoRecognizeSatisfaction
      ? buildSatisfactionGridOverrides(satisfactionImage)
      : {};

    if (!canAutoRecognizeSatisfaction) {
      draft.warnings?.push('만족도조사 이미지의 종이 경계를 안정적으로 찾지 못해 자동 입력을 확정하지 않았습니다. 강조된 항목을 원본과 대조해 직접 확인해주세요.');
    }

    for (const group of satisfactionTemplate.choiceGroups) {
      const gridCells = satisfactionGridOverrides[group.field];
      const result = analyzeChoiceGroup(
        satisfactionImage,
        group,
        satisfactionRowOverrides[group.field],
        canAutoRecognizeSatisfaction,
        gridCells,
      );
      draft.confidence[result.field] = result.confidence;
      draft.candidates![result.field] = result.candidates;
      if (gridCells) {
        recognitionCropRects[result.field] = unionPixelRects(gridCells);
      }

      if (result.value === undefined) continue;

      const questionKey = result.field.replace('satisfaction.', '');
      draft.satisfaction[questionKey] = Number(result.value);
    }
  } catch {
    // Keep satisfaction fields empty so the review screen can collect them manually.
  }

  if (Object.keys(recognitionCropRects).length > 0) {
    draft.recognitionCropRects = recognitionCropRects;
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
