import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { getJobDir } from '../../../lib/excel/templateManager';
import { classifyForm, FORM_CLASSIFIER_POLICY_VERSION } from '../../../lib/recognition/classifyForm';
import { recognizeStudentForms } from '../../../lib/recognition/detectCheckmarks';
import { matchBatch } from '../../../lib/recognition/batchMatcher';
import { hasJobSession } from '../../../lib/storage/jobStore';
import { detectCagiEarlyIntervention } from '../../../lib/recognition/cagiEarlyIntervention';
import { buildSourcePreview } from '../../../lib/recognition/buildSourcePreview';

export function GET() {
  return NextResponse.json({
    service: 'recognize',
    recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
  });
}

export async function POST(req: Request) {
  try {
    const { jobId, trustUploadedTypes = false } = await req.json();

    if (!jobId) {
      return NextResponse.json({ error: '필수 파라미터(jobId)가 누락되었습니다.' }, { status: 400 });
    }

    if (!hasJobSession(jobId)) {
      return NextResponse.json({ error: '작업 세션이 존재하지 않습니다. 새 작업을 생성해주세요.' }, { status: 404 });
    }

    const jobDir = getJobDir(jobId);
    const uploadDir = path.join(jobDir, 'uploads');

    if (!fs.existsSync(uploadDir)) {
      return NextResponse.json({ error: '업로드된 파일이 존재하지 않습니다. 먼저 파일을 업로드해주세요.' }, { status: 404 });
    }

    // 1. 업로드된 모든 이미지 파일 목록 조회
    const allFiles = fs.readdirSync(uploadDir).filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    });

    if (allFiles.length === 0) {
      return NextResponse.json({ error: '인식할 이미지 파일이 없습니다.' }, { status: 400 });
    }

    // 2. 각 파일을 병렬로 분류 수행
    const cagiPaths: string[] = [];
    const satisfactionPaths: string[] = [];
    const typeMismatches: Array<{
      filename: string;
      uploadedAs: 'cagi' | 'satisfaction';
      detectedAs: 'cagi' | 'satisfaction';
    }> = [];
    const formTypeOverrideWarnings: string[] = [];
    const earlyInterventionFilenames = new Set<string>();
    const earlyInterventionContactFilenames = new Set<string>();

    await Promise.all(
      allFiles.map(async (filename) => {
        const filePath = path.join(uploadDir, filename);
        const formType = await classifyForm(filePath);
        const uploadedAs = getUploadedFormType(filename);
        const earlyIntervention = uploadedAs === 'cagi'
          ? await detectCagiEarlyIntervention(filePath)
          : { hasMarks: false, hasContactInformation: false };
        const hasEarlyInterventionMarks = earlyIntervention.hasMarks;

        if (hasEarlyInterventionMarks) {
          earlyInterventionFilenames.add(filename);
        }
        if (earlyIntervention.hasContactInformation) {
          earlyInterventionContactFilenames.add(filename);
        }

        const shouldKeepAsCagiWithNotice = uploadedAs === 'cagi' &&
          formType === 'satisfaction' &&
          (hasEarlyInterventionMarks || earlyIntervention.hasContactInformation);

        const hasFormTypeMismatch = Boolean(
          uploadedAs &&
          formType !== 'unknown' &&
          uploadedAs !== formType &&
          !shouldKeepAsCagiWithNotice,
        );

        if (hasFormTypeMismatch && !trustUploadedTypes) {
          typeMismatches.push({
            filename,
            uploadedAs: uploadedAs!,
            detectedAs: formType as 'cagi' | 'satisfaction',
          });
          return;
        }

        if (hasFormTypeMismatch && trustUploadedTypes) {
          formTypeOverrideWarnings.push(
            buildUploadedTypeOverrideWarning(filename, uploadedAs!, formType as 'cagi' | 'satisfaction'),
          );
        }

        const effectiveFormType = shouldKeepAsCagiWithNotice
          ? 'cagi'
          : hasFormTypeMismatch && trustUploadedTypes
            ? uploadedAs!
            : formType === 'unknown' && uploadedAs
              ? uploadedAs
              : formType;

        if (effectiveFormType === 'cagi') {
          cagiPaths.push(filePath);
        } else if (effectiveFormType === 'satisfaction') {
          satisfactionPaths.push(filePath);
        }
      })
    );

    const cagiCount = cagiPaths.length;
    const satisfactionCount = satisfactionPaths.length;
    const earlyInterventionWarnings = [
      ...buildEarlyInterventionWarnings(cagiPaths, earlyInterventionFilenames),
      ...buildEarlyInterventionContactWarnings(cagiPaths, earlyInterventionContactFilenames),
    ];

    if (typeMismatches.length > 0) {
      return NextResponse.json({
        error: buildFormTypeMismatchMessage(typeMismatches),
        code: 'FORM_TYPE_MISMATCH',
        recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
        mismatches: typeMismatches,
        canProceedWithUploadedTypes: true,
      }, { status: 400 });
    }

    // 3. 파일 장수 불일치 오류 핸들링
    if (cagiCount !== satisfactionCount) {
      return NextResponse.json({
        error: `업로드된 파일의 장수가 일치하지 않습니다. (선별검사지: ${cagiCount}장, 만족도조사: ${satisfactionCount}장). 누락된 사진이 없는지 확인해주세요.`,
        code: 'COUNT_MISMATCH',
        cagiCount,
        satisfactionCount,
        warnings: [...earlyInterventionWarnings, ...formTypeOverrideWarnings],
        recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
      }, { status: 400 });
    }

    if (cagiCount === 0) {
      return NextResponse.json({
        error: '인식된 유효한 양식 파일이 없습니다. 올바른 선별검사지 및 만족도 조사지 사진을 업로드했는지 확인해주세요.',
        code: 'EMPTY_FORMS'
      }, { status: 400 });
    }

    // 4. 자연수 정렬 기준으로 1대1 매핑
    let matchedPairs;
    try {
      matchedPairs = matchBatch(cagiPaths, satisfactionPaths);
    } catch (err: any) {
      return NextResponse.json({
        error: `파일 정렬 및 매칭 중 오류가 발생했습니다: ${err.message}`,
        code: 'MATCH_ERROR'
      }, { status: 400 });
    }

    // 5. 각 매칭 쌍에 대해 순차적(또는 병렬) 인식 수행 및 드래프트 일괄 리스트 구축
    const studentDrafts = [];
    const ocrDeadlineAt = Date.now() + 2_500;
    for (let i = 0; i < matchedPairs.length; i++) {
      const pair = matchedPairs[i];
      const draft = await recognizeStudentForms(pair.cagiPath, pair.satisfactionPath, { ocrDeadlineAt });
      const { recognitionCropRects, ...recognizedDraft } = draft;
      
      // 개별 드래프트 객체에 이미지 정보 주입
      const cagiImageId = path.basename(pair.cagiPath).split('.')[0];
      const satisfactionImageId = path.basename(pair.satisfactionPath).split('.')[0];
      const preview = await buildSourcePreview(pair.cagiPath, pair.satisfactionPath, recognitionCropRects);
      
      studentDrafts.push({
        ...recognizedDraft,
        // UI에서 저장 시 식별용으로 이미지 ID들을 source에 엮음
        source: {
          cagiImageId,
          satisfactionImageId,
          cagiImageDataUrl: preview.cagiImageDataUrl,
          satisfactionImageDataUrl: preview.satisfactionImageDataUrl,
          cropDataUrls: preview.cropDataUrls,
          cropDebugDataUrls: preview.cropDebugDataUrls
        }
      });
    }

    return NextResponse.json({
      studentDrafts,
      warnings: [...earlyInterventionWarnings, ...formTypeOverrideWarnings],
      recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
    });

  } catch (err: any) {
    return NextResponse.json(
      { error: `이미지 인식 일괄 처리 중 실패: ${err.message}` },
      { status: 500 }
    );
  }
}

function buildEarlyInterventionWarnings(cagiPaths: string[], markedFilenames: Set<string>): string[] {
  if (markedFilenames.size === 0) {
    return [];
  }

  const sortedCagiFilenames = [...cagiPaths]
    .map((filePath) => path.basename(filePath))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  const pageNumbers = sortedCagiFilenames
    .map((filename, index) => markedFilenames.has(filename) ? index + 1 : undefined)
    .filter((pageNumber): pageNumber is number => pageNumber !== undefined);

  if (pageNumbers.length === 0) {
    return [];
  }

  return [
    `선별검사지 ${formatPageNumbers(pageNumbers)}페이지에서 조기개입 서비스 표기 흔적이 감지되었습니다. 해당 영역은 엑셀 추출 대상에서 제외하고 선별검사지 문항만 인식했습니다.`
  ];
}

function formatPageNumbers(pageNumbers: number[]): string {
  return pageNumbers.join(', ');
}

function getUploadedFormType(filename: string): 'cagi' | 'satisfaction' | undefined {
  const lowerName = filename.toLowerCase();
  if (lowerName.startsWith('cagi_')) {
    return 'cagi';
  }
  if (lowerName.startsWith('satisfaction_')) {
    return 'satisfaction';
  }
  return undefined;
}

function buildFormTypeMismatchMessage(
  mismatches: Array<{ filename: string; uploadedAs: 'cagi' | 'satisfaction'; detectedAs: 'cagi' | 'satisfaction' }>,
): string {
  const first = mismatches[0];
  const uploadedLabel = first.uploadedAs === 'cagi' ? '선별검사지' : '만족도조사';
  const detectedLabel = first.detectedAs === 'cagi' ? '선별검사지' : '만족도조사';

  if (mismatches.length === 1) {
    return `${first.filename} 파일은 ${uploadedLabel} 칸에 업로드됐지만, 이미지 내용은 ${detectedLabel} 양식으로 보입니다. 올바른 칸에 다시 업로드해주세요.`;
  }

  return `업로드 칸과 이미지 내용이 다른 파일이 ${mismatches.length}개 있습니다. 첫 번째 문제 파일: ${first.filename} (${uploadedLabel} 칸, 실제 내용은 ${detectedLabel} 양식).`;
}

function buildEarlyInterventionContactWarnings(cagiPaths: string[], contactFilenames: Set<string>): string[] {
  const pageNumbers = getCagiPageNumbers(cagiPaths, contactFilenames);
  if (pageNumbers.length === 0) {
    return [];
  }

  return [
    `선별검사지 ${formatPageNumbers(pageNumbers)}페이지의 조기개입 서비스 영역에서 이름 및 연락처 입력 흔적이 감지되었습니다. 개인정보는 저장하지 않으며, 원본을 확인해 후속 절차를 진행하세요.`,
  ];
}

function getCagiPageNumbers(cagiPaths: string[], filenames: Set<string>): number[] {
  if (filenames.size === 0) {
    return [];
  }

  return [...cagiPaths]
    .map((filePath) => path.basename(filePath))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((filename, index) => filenames.has(filename) ? index + 1 : undefined)
    .filter((pageNumber): pageNumber is number => pageNumber !== undefined);
}

function buildUploadedTypeOverrideWarning(
  filename: string,
  uploadedAs: 'cagi' | 'satisfaction',
  detectedAs: 'cagi' | 'satisfaction',
): string {
  const uploadedLabel = uploadedAs === 'cagi' ? '선별검사지' : '만족도조사';
  const detectedLabel = detectedAs === 'cagi' ? '선별검사지' : '만족도조사';

  return `${filename}: 자동 양식 판정(${detectedLabel}) 대신 선택한 업로드 칸(${uploadedLabel})을 적용했습니다. 검수 화면에서 원본 이미지와 인식 결과를 확인하세요.`;
}
