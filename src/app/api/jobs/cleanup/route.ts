import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredJobs, clearJobUploads, deleteJobWorkspace, hasJobSession } from '../../../../lib/storage/jobStore';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const jobId = body.jobId as string | undefined;
    const scope = (body.scope as string | undefined) || 'uploads';

    if (!jobId && scope !== 'expired') {
      return NextResponse.json({ error: '필수 파라미터(jobId)가 누락되었습니다.' }, { status: 400 });
    }

    if (scope === 'expired') {
      const removedJobIds = cleanupExpiredJobs();
      return NextResponse.json({ ok: true, removedJobIds });
    }

    if (!jobId || !hasJobSession(jobId)) {
      return NextResponse.json({ error: '작업 세션이 존재하지 않습니다.' }, { status: 404 });
    }

    if (scope === 'job') {
      deleteJobWorkspace(jobId);
      return NextResponse.json({ ok: true });
    }

    if (scope !== 'uploads') {
      return NextResponse.json({ error: '지원하지 않는 cleanup scope입니다.' }, { status: 400 });
    }

    clearJobUploads(jobId);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: `작업 파일 정리 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
