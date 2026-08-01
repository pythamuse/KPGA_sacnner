import { NextRequest, NextResponse } from 'next/server';
import { FormTrack, initJobWorkspace } from '../../../lib/excel/templateManager';
import { createJobSession } from '../../../lib/storage/jobStore';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const track: FormTrack = body.track === 'adult' ? 'adult' : 'youth';

    const jobId = `job_${Date.now()}`;

    // 템플릿 복사 및 작업 폴더 준비 (트랙에 맞는 템플릿 쌍)
    initJobWorkspace(jobId, track);

    // 인메모리 세션 생성
    createJobSession(jobId, track);

    return NextResponse.json({ jobId, track });
  } catch (err: any) {
    return NextResponse.json(
      { error: `작업 세션 생성 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
