import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { hasJobSession } from '../../../../lib/storage/jobStore';
import { readUploadPage } from '../../../../lib/storage/uploadStore';
import {
  isSafeJobId,
  isUploadBatchReference,
  isUploadKind,
} from '../../../../lib/uploadInventory';
import {
  evaluateSheetQuality,
  isRegistrationMetaLike,
} from '../../../../lib/recognition/sheetQuality';

/**
 * Per-sheet quality verdict, callable right after an upload while the paper
 * is still in front of the user (spec F3.2).
 *
 * Addressing: the SAME (jobId, type, batch, pageNumber) key that /api/upload
 * stored the page under and /api/recognize will read it back with. The first
 * version of this route mirrored /api/uploads/crop's jobDir/uploads lookup
 * instead -- a directory the live upload flow never writes, and an imageId
 * alphabet the store's slash-bearing pathnames can never pass. Judging quality
 * on any path other than the recognition read path invites the two to disagree
 * about which bytes a sheet even is.
 *
 * Read-only: it measures the stored image and interprets the client's
 * registration meta; it never changes what recognition will later read.
 */
export async function POST(req: NextRequest) {
  let scratchDir: string | null = null;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: '요청 본문이 올바르지 않습니다.' }, { status: 400 });
    }

    const { jobId, type, batch, pageNumber, registration } = body as Record<string, unknown>;

    if (!isSafeJobId(jobId) || !isUploadKind(type) || !isUploadBatchReference(batch)) {
      return NextResponse.json({ error: 'jobId, type, batch가 올바르지 않습니다.' }, { status: 400 });
    }

    const page = Number(pageNumber);
    if (!Number.isInteger(page) || page < 1 || page > batch.expectedPageCount) {
      return NextResponse.json({ error: '페이지 번호가 업로드 묶음 정보와 일치하지 않습니다.' }, { status: 400 });
    }

    if (registration !== undefined && registration !== null && !isRegistrationMetaLike(registration)) {
      return NextResponse.json({ error: 'registration 메타 형식이 올바르지 않습니다.' }, { status: 400 });
    }

    if (!hasJobSession(jobId)) {
      return NextResponse.json({ error: '작업 세션이 존재하지 않습니다.' }, { status: 404 });
    }

    const stored = await readUploadPage(jobId, type, batch, page);
    if (!stored) {
      return NextResponse.json({ error: '이미지를 찾을 수 없습니다.' }, { status: 404 });
    }

    // Request-scoped scratch only -- the evaluator takes a file path, and the
    // stored original stays wherever the upload store keeps it.
    scratchDir = path.join(os.tmpdir(), 'kpga-scanner', 'quality', randomUUID());
    await fs.mkdir(scratchDir, { recursive: true });
    const imagePath = path.join(scratchDir, `${type}_page_${String(page).padStart(4, '0')}.jpg`);
    await fs.writeFile(imagePath, stored.data);

    const verdict = await evaluateSheetQuality({
      imagePath,
      formType: type,
      registration: (registration as never) ?? null,
    });

    return NextResponse.json(verdict);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '알 수 없는 오류';
    return NextResponse.json(
      { error: `시트 품질 판정 실패: ${message}` },
      { status: 500 },
    );
  } finally {
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
