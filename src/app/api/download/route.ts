import { NextRequest, NextResponse } from 'next/server';
import { generateWorkbookPair } from '../../../lib/excel/generateWorkbookPair';
import { StudentData } from '../../../lib/validation/types';

export async function POST(req: NextRequest) {
  try {
    const { type, students: rawStudents } = await req.json();

    if (!type || !['cagi', 'satisfaction'].includes(type)) {
      return NextResponse.json({ error: '올바르지 않은 파라미터입니다.' }, { status: 400 });
    }

    const students: StudentData[] = Array.isArray(rawStudents) ? rawStudents : [];

    if (students.length === 0) {
      return NextResponse.json({ error: '저장된 학생 데이터가 없습니다. 학생 데이터를 먼저 저장해주세요.' }, { status: 400 });
    }

    // 이전 요청이 만든 작업 파일에 의존하지 않고, 원본 템플릿에서 학생 목록 전체를 다시 써서
    // 매번 새로 생성한다 (Vercel 서버리스 인스턴스 간 로컬 파일 미공유 문제 회피).
    const { cagiBuffer, satisfactionBuffer, verifyResult } = await generateWorkbookPair(students);

    if (!verifyResult.ok) {
      return NextResponse.json({
        error: '엑셀 생성 후 무결성 검증 실패',
        errors: verifyResult.errors.map(msg => ({ code: 'INTEGRITY_ERROR', message: msg }))
      }, { status: 500 });
    }

    const fileBuffer = type === 'cagi' ? cagiBuffer : satisfactionBuffer;
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = type === 'cagi'
      ? `도박예방교육_CAGI_${dateStr}.xlsx`
      : `도박예방교육_만족도_${dateStr}.xlsx`;

    const encodedFilename = encodeURIComponent(filename);

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedFilename}`
      }
    });

  } catch (err: any) {
    return NextResponse.json(
      { error: `다운로드 처리 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
