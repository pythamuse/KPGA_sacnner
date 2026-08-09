import { del, get, list, put } from '@vercel/blob';
import {
  isSafeJobId,
  isUploadBatchReference,
  isUploadKind,
  type UploadBatchReference,
  type UploadKind,
} from '../uploadInventory';

const STORAGE_PREFIX = 'kpga-scan/jobs';
const LOCAL_MEMORY_UPLOADS = new Map<string, StoredUploadPage>();

export interface StoreUploadPageInput {
  jobId: string;
  type: UploadKind;
  batch: UploadBatchReference;
  pageNumber: number;
  data: Buffer;
  contentType: string;
}

export interface StoredUploadPage {
  pathname: string;
  data: Buffer;
  contentType: string;
}

export class UploadStorageError extends Error {
  constructor(
    readonly code: 'UPLOAD_STORAGE_NOT_CONFIGURED' | 'UPLOAD_PERSISTENCE_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'UploadStorageError';
  }
}

function usesLocalMemoryStore() {
  return process.env.NODE_ENV === 'test' || !process.env.VERCEL;
}

function assertPageInput(
  jobId: string,
  type: UploadKind,
  batch: UploadBatchReference,
  pageNumber: number,
) {
  if (!isSafeJobId(jobId) || !isUploadKind(type) || !isUploadBatchReference(batch)) {
    throw new UploadStorageError('UPLOAD_PERSISTENCE_ERROR', '업로드 저장 정보가 올바르지 않습니다.');
  }

  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > batch.expectedPageCount) {
    throw new UploadStorageError('UPLOAD_PERSISTENCE_ERROR', '업로드 페이지 번호가 올바르지 않습니다.');
  }
}

function buildUploadPrefix(jobId: string, type?: UploadKind, batch?: UploadBatchReference) {
  const parts = [STORAGE_PREFIX, jobId, 'uploads'];
  if (type) parts.push(type);
  if (batch) parts.push(batch.batchId);
  return parts.join('/');
}

export function getUploadPagePath(
  jobId: string,
  type: UploadKind,
  batch: UploadBatchReference,
  pageNumber: number,
) {
  assertPageInput(jobId, type, batch, pageNumber);
  return `${buildUploadPrefix(jobId, type, batch)}/page-${String(pageNumber).padStart(4, '0')}.jpg`;
}

export async function storeUploadPage(input: StoreUploadPageInput) {
  const pathname = getUploadPagePath(input.jobId, input.type, input.batch, input.pageNumber);

  if (usesLocalMemoryStore()) {
    LOCAL_MEMORY_UPLOADS.set(pathname, {
      pathname,
      data: Buffer.from(input.data),
      contentType: input.contentType || 'application/octet-stream',
    });
    return { pathname };
  }

  try {
    const result = await put(pathname, input.data, {
      access: 'private',
      allowOverwrite: true,
      contentType: input.contentType || 'application/octet-stream',
    });
    return { pathname: result.pathname };
  } catch (error) {
    throw toStorageError(error);
  }
}

export async function readUploadPage(
  jobId: string,
  type: UploadKind,
  batch: UploadBatchReference,
  pageNumber: number,
): Promise<StoredUploadPage | null> {
  const pathname = getUploadPagePath(jobId, type, batch, pageNumber);

  if (usesLocalMemoryStore()) {
    const page = LOCAL_MEMORY_UPLOADS.get(pathname);
    return page ? { ...page, data: Buffer.from(page.data) } : null;
  }

  try {
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return null;
    }

    return {
      pathname,
      data: Buffer.from(await new Response(result.stream).arrayBuffer()),
      contentType: result.blob.contentType,
    };
  } catch (error) {
    throw toStorageError(error);
  }
}

export async function deleteJobUploads(jobId: string) {
  if (!isSafeJobId(jobId)) {
    throw new UploadStorageError('UPLOAD_PERSISTENCE_ERROR', '작업 식별자가 올바르지 않습니다.');
  }

  const prefix = `${buildUploadPrefix(jobId)}/`;
  if (usesLocalMemoryStore()) {
    deleteLocalPrefix(prefix);
    return;
  }

  await deleteBlobPrefix(prefix);
}

export async function deleteUploadBatches(
  jobId: string,
  batches: Array<{ type: UploadKind; batch: UploadBatchReference }>,
) {
  await Promise.all(batches.map(({ type, batch }) => deleteUploadBatch(jobId, type, batch)));
}

export async function deleteUploadBatch(jobId: string, type: UploadKind, batch: UploadBatchReference) {
  assertPageInput(jobId, type, batch, 1);
  const prefix = `${buildUploadPrefix(jobId, type, batch)}/`;

  if (usesLocalMemoryStore()) {
    deleteLocalPrefix(prefix);
    return;
  }

  await deleteBlobPrefix(prefix);
}

export function resetUploadStoreForTests() {
  LOCAL_MEMORY_UPLOADS.clear();
}

function deleteLocalPrefix(prefix: string) {
  for (const pathname of Array.from(LOCAL_MEMORY_UPLOADS.keys())) {
    if (pathname.startsWith(prefix)) {
      LOCAL_MEMORY_UPLOADS.delete(pathname);
    }
  }
}

async function deleteBlobPrefix(prefix: string) {
  try {
    let cursor: string | undefined;
    do {
      const result = await list({ prefix, cursor, limit: 1000 });
      if (result.blobs.length > 0) {
        await del(result.blobs.map((blob) => blob.pathname));
      }
      cursor = result.cursor;
    } while (cursor);
  } catch (error) {
    throw toStorageError(error);
  }
}

function toStorageError(error: unknown): UploadStorageError {
  if (error instanceof UploadStorageError) {
    return error;
  }

  const message = error instanceof Error ? error.message : '알 수 없는 저장소 오류';
  if (/BLOB_READ_WRITE_TOKEN|Blob store|not configured|not found|no token|token.*missing|unauthori[sz]ed/i.test(message)) {
    return new UploadStorageError(
      'UPLOAD_STORAGE_NOT_CONFIGURED',
      '업로드 저장소가 설정되지 않았습니다. Vercel Blob 연결과 권한을 확인해주세요.',
    );
  }

  return new UploadStorageError(
    'UPLOAD_PERSISTENCE_ERROR',
    '업로드 파일을 영속 저장소에 안전하게 저장하지 못했습니다. 다시 업로드해주세요.',
  );
}
