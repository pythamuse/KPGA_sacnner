import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { getJobDir } from '../../../lib/excel/templateManager';
import { classifyForm } from '../../../lib/recognition/classifyForm';
import { recognizeStudentForms } from '../../../lib/recognition/detectCheckmarks';
import { matchBatch } from '../../../lib/recognition/batchMatcher';
import { hasJobSession } from '../../../lib/storage/jobStore';

export async function POST(req: NextRequest) {
  try {
    const { jobId } = await req.json();

    if (!jobId) {
      return NextResponse.json({ error: '필수 파라미터(jobId)가 누락되었습니다.' }, { status: 400 });
    }

    if (!hasJobSession(jobId)) {
      return NextResponse.json({ error: '?묒뾽 ?몄뀡??議댁옱?섏? ?딆뒿?덈떎. ???묒뾽???앹꽦?댁＜?몄슂.' }, { status: 404 });
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

    await Promise.all(
      allFiles.map(async (filename) => {
        const filePath = path.join(uploadDir, filename);
        const formType = await classifyForm(filePath);
        const uploadedAs = getUploadedFormType(filename);

        if (uploadedAs && formType !== 'unknown' && uploadedAs !== formType) {
          typeMismatches.push({
            filename,
            uploadedAs,
            detectedAs: formType,
          });
          return;
        }

        if (formType === 'cagi') {
          cagiPaths.push(filePath);
        } else if (formType === 'satisfaction') {
          satisfactionPaths.push(filePath);
        }
      })
    );

    const cagiCount = cagiPaths.length;
    const satisfactionCount = satisfactionPaths.length;

    if (typeMismatches.length > 0) {
      return NextResponse.json({
        error: buildFormTypeMismatchMessage(typeMismatches),
        code: 'FORM_TYPE_MISMATCH',
        mismatches: typeMismatches,
      }, { status: 400 });
    }

    // 3. 파일 장수 불일치 오류 핸들링
    if (cagiCount !== satisfactionCount) {
      return NextResponse.json({
        error: `업로드된 파일의 장수가 일치하지 않습니다. (선별검사지: ${cagiCount}장, 만족도조사: ${satisfactionCount}장). 누락된 사진이 없는지 확인해주세요.`,
        code: 'COUNT_MISMATCH',
        cagiCount,
        satisfactionCount
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
    for (let i = 0; i < matchedPairs.length; i++) {
      const pair = matchedPairs[i];
      const draft = await recognizeStudentForms(pair.cagiPath, pair.satisfactionPath);
      
      // 개별 드래프트 객체에 이미지 정보 주입
      const cagiImageId = path.basename(pair.cagiPath).split('.')[0];
      const satisfactionImageId = path.basename(pair.satisfactionPath).split('.')[0];
      
      studentDrafts.push({
        ...draft,
        // UI에서 저장 시 식별용으로 이미지 ID들을 source에 엮음
        source: {
          cagiImageId,
          satisfactionImageId
        }
      });
    }

    return NextResponse.json({
      studentDrafts,
      warnings: []
    });

  } catch (err: any) {
    return NextResponse.json(
      { error: `이미지 인식 일괄 처리 중 실패: ${err.message}` },
      { status: 500 }
    );
  }
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
