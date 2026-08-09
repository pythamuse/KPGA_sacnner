import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredJobs, clearJobUploads, deleteJobWorkspace, hasJobSession } from '../../../../lib/storage/jobStore';
import { deleteJobUploads, UploadStorageError } from '../../../../lib/storage/uploadStore';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const jobId = body.jobId as string | undefined;
    const scope = (body.scope as string | undefined) || 'uploads';

    if (!jobId && scope !== 'expired') {
      return NextResponse.json({ error: '정리할 작업 식별자(jobId)가 필요합니다.' }, { status: 400 });
    }

    if (scope === 'expired') {
      // Legacy development workspaces only. Blob uploads are removed after recognition or explicit reset.
      return NextResponse.json({ ok: true, removedJobIds: cleanupExpiredJobs() });
    }

    if (scope === 'job') {
      await deleteJobUploads(jobId!);
      if (hasJobSession(jobId!)) {
        deleteJobWorkspace(jobId!);
      }
      return NextResponse.json({ ok: true });
    }

    if (scope !== 'uploads') {
      return NextResponse.json({ error: '지원하지 않는 cleanup scope입니다.' }, { status: 400 });
    }

    await deleteJobUploads(jobId!);
    if (hasJobSession(jobId!)) {
      clearJobUploads(jobId!);
    }
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    if (err instanceof UploadStorageError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 503 });
    }

    const message = err instanceof Error ? err.message : '알 수 없는 오류';
    return NextResponse.json({ error: `작업 정리 중 오류: ${message}` }, { status: 500 });
  }
}
