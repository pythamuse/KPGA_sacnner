import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getJobDir } from '../../../../lib/excel/templateManager';
import { hasJobSession } from '../../../../lib/storage/jobStore';
import { isSafeJobId, isUploadKind } from '../../../../lib/uploadInventory';
import {
  evaluateSheetQuality,
  isRegistrationMetaLike,
} from '../../../../lib/recognition/sheetQuality';

// Same allow-list as /api/uploads/crop — the two routes must resolve a stored
// image identically or a sheet could be judged on a different file than the
// one recognition will read.
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * Per-sheet quality verdict, callable right after an upload while the paper
 * is still in front of the user (spec F3.2). Read-only: it measures the
 * stored image and interprets the client's registration meta; it never
 * changes what recognition will later read.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '요청 본문이 올바르지 않습니다.' }, { status: 400 });
    }

    const { jobId, type, imageId, registration } = body as Record<string, unknown>;

    if (!isSafeJobId(jobId) || !isUploadKind(type)) {
      return NextResponse.json({ error: 'jobId, type이 올바르지 않습니다.' }, { status: 400 });
    }

    if (registration !== undefined && registration !== null && !isRegistrationMetaLike(registration)) {
      return NextResponse.json({ error: 'registration 메타 형식이 올바르지 않습니다.' }, { status: 400 });
    }

    if (!hasJobSession(jobId)) {
      return NextResponse.json({ error: '작업 세션이 존재하지 않습니다.' }, { status: 404 });
    }

    // imageId validation and file resolution mirror /api/uploads/crop
    // exactly: strict identifier alphabet, then a directory listing matched
    // on basename. The identifier never becomes a path segment on its own,
    // so a traversal payload cannot address anything outside the upload dir.
    if (typeof imageId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(imageId)) {
      return NextResponse.json({ error: '요청 식별자가 올바르지 않습니다.' }, { status: 400 });
    }

    const uploadDir = path.join(getJobDir(jobId), 'uploads');
    if (!fs.existsSync(uploadDir)) {
      return NextResponse.json({ error: '업로드 이미지가 없습니다.' }, { status: 404 });
    }

    const filename = fs.readdirSync(uploadDir).find((candidate) => {
      const ext = path.extname(candidate).toLowerCase();
      return path.basename(candidate, ext) === imageId && imageExtensions.has(ext);
    });

    if (!filename) {
      return NextResponse.json({ error: '이미지를 찾을 수 없습니다.' }, { status: 404 });
    }

    const verdict = await evaluateSheetQuality({
      imagePath: path.join(uploadDir, filename),
      formType: type,
      registration: registration ?? null,
    });

    return NextResponse.json(verdict);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '알 수 없는 오류';
    return NextResponse.json(
      { error: `시트 품질 판정 실패: ${message}` },
      { status: 500 },
    );
  }
}
