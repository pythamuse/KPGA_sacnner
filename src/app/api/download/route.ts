import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getJobFiles } from '../../../lib/excel/templateManager';
import { getJobSession } from '../../../lib/storage/jobStore';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get('jobId');
    const type = searchParams.get('type'); // 'cagi' 또는 'satisfaction'

    if (!jobId || !type || !['cagi', 'satisfaction'].includes(type)) {
      return NextResponse.json({ error: '올바르지 않은 파라미터입니다.' }, { status: 400 });
    }

    const session = getJobSession(jobId);
    if (!session) {
      return NextResponse.json({ error: '유효하지 않은 작업 세션입니다.' }, { status: 404 });
    }

    if (session.students.length === 0) {
      return NextResponse.json({ error: '저장된 학생 데이터가 없습니다. 학생 데이터를 먼저 저장해주세요.' }, { status: 400 });
    }

    const files = getJobFiles(jobId);
    const filePath = type === 'cagi' ? files.cagiPath : files.satisfactionPath;

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: '작업 파일을 찾을 수 없습니다.' }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = type === 'cagi' 
      ? `도박예방교육_CAGI_${dateStr}.xlsx` 
      : `도박예방교육_만족도_${dateStr}.xlsx`;

    const encodedFilename = encodeURIComponent(filename);

    return new NextResponse(fileBuffer, {
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
