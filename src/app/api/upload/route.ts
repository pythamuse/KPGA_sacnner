import { NextRequest, NextResponse } from 'next/server';
import { isSafeJobId, isUploadBatchReference, isUploadKind } from '../../../lib/uploadInventory';
import {
  storeUploadPage,
  storeUploadPageMeta,
  UploadStorageError,
} from '../../../lib/storage/uploadStore';
import { isRegistrationMetaLike } from '../../../lib/recognition/sheetQuality';

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

    // F1 capture metadata (spec F1.2), best-effort and strictly after the page
    // bytes are safe. It is optional by design: the PDF/scan path has none, and
    // a page that arrives without it must still upload. An unparseable or
    // structurally wrong value stores nothing rather than storing a lie the
    // review screen would later present as a verdict.
    const registration = parseRegistrationField(formData.get('registration'));
    if (registration) {
      try {
        await storeUploadPageMeta({ jobId, type, batch, pageNumber, registration });
      } catch (metaError) {
        console.error('Unable to store upload page registration meta', metaError);
      }
    }

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

/** Stringified RegistrationMeta from the client, or null if it is absent or malformed. */
function parseRegistrationField(value: FormDataEntryValue | null): unknown | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  return isRegistrationMetaLike(parsed) ? parsed : null;
}
