import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { initJobWorkspace } from '../../../lib/excel/templateManager';
import { createJobSession } from '../../../lib/storage/jobStore';

export async function POST() {
  try {
    // Millisecond timestamps can collide for simultaneous uploads or parallel tests.
    const jobId = `job_${Date.now()}_${randomUUID()}`;
    
    // 템플릿 복사 및 작업 폴더 준비
    initJobWorkspace(jobId);
    
    // 인메모리 세션 생성
    createJobSession(jobId);

    return NextResponse.json({ jobId });
  } catch (err: any) {
    return NextResponse.json(
      { error: `작업 세션 생성 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
