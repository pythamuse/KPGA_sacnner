import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredJobs, clearJobUploads, deleteJobWorkspace, hasJobSession } from '../../../../lib/storage/jobStore';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const jobId = body.jobId as string | undefined;
    const scope = (body.scope as string | undefined) || 'uploads';

    if (!jobId && scope !== 'expired') {
      return NextResponse.json({ error: '?꾩닔 ?뚮씪誘명꽣(jobId)媛 ?꾨씫?섏뿀?듬땲??' }, { status: 400 });
    }

    if (scope === 'expired') {
      const removedJobIds = cleanupExpiredJobs();
      return NextResponse.json({ ok: true, removedJobIds });
    }

    if (!jobId || !hasJobSession(jobId)) {
      return NextResponse.json({ error: '?묒뾽 ?몄뀡??議댁옱?섏? ?딆뒿?덈떎.' }, { status: 404 });
    }

    if (scope === 'job') {
      deleteJobWorkspace(jobId);
      return NextResponse.json({ ok: true });
    }

    if (scope !== 'uploads') {
      return NextResponse.json({ error: '?뚯슜?섏? ?딅뒗 cleanup scope?낅땲??' }, { status: 400 });
    }

    clearJobUploads(jobId);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: `?묒뾽 ?뚯씪 ?뺣━ ?ㅽ뙣: ${err.message}` },
      { status: 500 }
    );
  }
}
