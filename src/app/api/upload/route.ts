import { NextRequest, NextResponse } from 'next/server';
import { isSafeJobId, isUploadBatchReference, isUploadKind } from '../../../lib/uploadInventory';
import { storeUploadPage, UploadStorageError } from '../../../lib/storage/uploadStore';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const jobId = formData.get('jobId');
    const type = formData.get('type');
    const batch = {
      batchId: formData.get('batchId'),
      expectedPageCount: Number(formData.get('expectedPageCount')),
    };
    const pageNumber = Number(formData.get('pageNumber'));

    if (!(file instanceof File) || !isSafeJobId(jobId) || !isUploadKind(type) || !isUploadBatchReference(batch)) {
      return NextResponse.json({ error: '필수 업로드 정보가 올바르지 않습니다.' }, { status: 400 });
    }

    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > batch.expectedPageCount) {
      return NextResponse.json({ error: '페이지 번호가 업로드 묶음 정보와 일치하지 않습니다.' }, { status: 400 });
    }

    const stored = await storeUploadPage({
      jobId,
      type,
      batch,
      pageNumber,
      data: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || 'application/octet-stream',
    });

    return NextResponse.json({
      imageId: stored.pathname,
      filename: `${type}_page_${String(pageNumber).padStart(3, '0')}.jpg`,
      pageNumber,
      expectedPageCount: batch.expectedPageCount,
    });
  } catch (err: unknown) {
    if (err instanceof UploadStorageError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 503 });
    }

    const message = err instanceof Error ? err.message : '알 수 없는 오류';
    return NextResponse.json({ error: `이미지 업로드 실패: ${message}` }, { status: 500 });
  }
}
