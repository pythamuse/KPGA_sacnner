import fs from 'fs/promises';
import { rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { del, get, list, put } from '@vercel/blob';
import {
  isSafeJobId,
  isUploadBatchReference,
  isUploadKind,
  type UploadBatchReference,
  type UploadKind,
} from '../uploadInventory';

const STORAGE_PREFIX = 'kpga-scan/jobs';
const LOCAL_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  'kpga-scanner',
  'upload-store',
  createHash('sha256')
    .update(`${process.cwd()}|${process.env.NODE_ENV || 'development'}|${process.env.NODE_ENV === 'test' ? process.pid : ''}`)
    .digest('hex')
    .slice(0, 16),
);
const LOCAL_CONTENT_TYPE_SUFFIX = '.content-type';

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
    await storeLocalUploadPage(
      pathname,
      input.data,
      input.contentType || 'application/octet-stream',
    );
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
    return readLocalUploadPage(pathname);
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
    await deleteLocalPrefix(prefix);
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
    await deleteLocalPrefix(prefix);
    return;
  }

  await deleteBlobPrefix(prefix);
}

export function resetUploadStoreForTests() {
  if (usesLocalMemoryStore()) {
    rmSync(LOCAL_UPLOAD_ROOT, { recursive: true, force: true });
  }
}

async function storeLocalUploadPage(pathname: string, data: Buffer, contentType: string) {
  const filePath = getLocalUploadFilePath(pathname);
  const contentTypePath = `${filePath}${LOCAL_CONTENT_TYPE_SUFFIX}`;
  const tempSuffix = `.tmp-${randomUUID()}`;
  const tempFilePath = `${filePath}${tempSuffix}`;
  const tempContentTypePath = `${contentTypePath}${tempSuffix}`;

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tempFilePath, data);
    await fs.writeFile(tempContentTypePath, contentType, 'utf8');
    await fs.rename(tempFilePath, filePath);
    await fs.rename(tempContentTypePath, contentTypePath);
  } catch (error) {
    throw toStorageError(error);
  } finally {
    await Promise.all([
      fs.rm(tempFilePath, { force: true }).catch(() => undefined),
      fs.rm(tempContentTypePath, { force: true }).catch(() => undefined),
    ]);
  }
}

async function readLocalUploadPage(pathname: string): Promise<StoredUploadPage | null> {
  const filePath = getLocalUploadFilePath(pathname);
  const contentTypePath = `${filePath}${LOCAL_CONTENT_TYPE_SUFFIX}`;

  try {
    const [data, contentType] = await Promise.all([
      fs.readFile(filePath),
      fs.readFile(contentTypePath, 'utf8'),
    ]);
    return {
      pathname,
      data,
      contentType: contentType || 'application/octet-stream',
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw toStorageError(error);
  }
}

async function deleteLocalPrefix(prefix: string) {
  try {
    await fs.rm(getLocalUploadFilePath(prefix), { recursive: true, force: true });
  } catch (error) {
    throw toStorageError(error);
  }
}

function getLocalUploadFilePath(pathname: string) {
  return path.join(LOCAL_UPLOAD_ROOT, ...pathname.split('/'));
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
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
