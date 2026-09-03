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

// vitest 기본 풀은 worker_threads라 워커가 프로세스를 공유한다. pid 만으로는 갈라지지 않아
// 세 테스트 파일이 한 루트를 쓰고, resetUploadStoreForTests 가 남의 업로드를 지운다.
const LOCAL_TEST_SCOPE =
  process.env.NODE_ENV === 'test'
    ? `${process.pid}-${process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? '0'}`
    : '';

const STORAGE_PREFIX = 'kpga-scan/jobs';
// Instrument only (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §4 step 1):
// BLOB_OPS_TRACE=1 logs every Vercel Blob call so a batch's advanced-operation
// count (put/list/del) can be measured instead of estimated.
function traceBlobOp(op: 'put' | 'list' | 'del', detail: string): void {
  if (process.env.BLOB_OPS_TRACE !== '1') return;
  console.info(`[blob-op] op=${op} ${detail}`);
}

const LOCAL_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  'kpga-scanner',
  'upload-store',
  createHash('sha256')
    .update(`${process.cwd()}|${process.env.NODE_ENV || 'development'}|${LOCAL_TEST_SCOPE}`)
    .digest('hex')
    .slice(0, 16),
);
const LOCAL_CONTENT_TYPE_SUFFIX = '.content-type';
/**
 * Capture metadata (spec F1.2 RegistrationMeta) rides beside its page as a
 * sibling blob rather than inside the JPEG, so the page bytes stay exactly
 * what was uploaded. The suffix keeps it under the same prefix the two
 * deletion paths sweep (see deleteJobUploads / deleteUploadBatch below), so a
 * cleaned-up job leaves no meta behind.
 */
const REGISTRATION_META_SUFFIX = '.registration.json';
const REGISTRATION_META_CONTENT_TYPE = 'application/json';

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

export interface StoreUploadPageMetaInput {
  jobId: string;
  type: UploadKind;
  batch: UploadBatchReference;
  pageNumber: number;
  /** Structure is the caller's business; this layer only serialises it. */
  registration: unknown;
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

export function getUploadPageMetaPath(
  jobId: string,
  type: UploadKind,
  batch: UploadBatchReference,
  pageNumber: number,
) {
  return `${getUploadPagePath(jobId, type, batch, pageNumber)}${REGISTRATION_META_SUFFIX}`;
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
    traceBlobOp('put', `pathname=${pathname}`);
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

/**
 * Persists the capture metadata for one uploaded page (spec F1.2).
 *
 * Addressed by exactly the key the page itself uses — (jobId, type, batch,
 * pageNumber) — so the meta can never drift onto a different physical sheet
 * than the bytes it describes.
 */
export async function storeUploadPageMeta(input: StoreUploadPageMetaInput) {
  const pathname = getUploadPageMetaPath(input.jobId, input.type, input.batch, input.pageNumber);
  const data = Buffer.from(JSON.stringify(input.registration ?? null), 'utf8');

  if (usesLocalMemoryStore()) {
    await storeLocalUploadPage(pathname, data, REGISTRATION_META_CONTENT_TYPE);
    return { pathname };
  }

  try {
    traceBlobOp('put', `pathname=${pathname}`);
    const result = await put(pathname, data, {
      access: 'private',
      allowOverwrite: true,
      contentType: REGISTRATION_META_CONTENT_TYPE,
    });
    return { pathname: result.pathname };
  } catch (error) {
    throw toStorageError(error);
  }
}

/**
 * Reads back capture metadata, or `null` when a page carries none.
 *
 * Absence is the normal case, not an error: scans, PDF batches and every
 * upload made before this existed have no meta, and the F3 evaluator reads
 * `null` as provenance-unknown ('good' / `no-registration-meta`). Unparseable
 * content reads as `null` too — a corrupt sidecar must not fail recognition.
 */
export async function readUploadPageMeta(
  jobId: string,
  type: UploadKind,
  batch: UploadBatchReference,
  pageNumber: number,
): Promise<unknown | null> {
  const pathname = getUploadPageMetaPath(jobId, type, batch, pageNumber);

  if (usesLocalMemoryStore()) {
    const stored = await readLocalUploadPage(pathname);
    return stored ? parseRegistrationMetaJson(stored.data) : null;
  }

  try {
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return null;
    }

    return parseRegistrationMetaJson(Buffer.from(await new Response(result.stream).arrayBuffer()));
  } catch (error) {
    // Deliberately not rethrown. A page with no sidecar is the normal case
    // (scans, PDF batches, every upload predating F1), and `get` on a missing
    // private blob raises rather than returning a 404 result. Failing here
    // would turn "no capture metadata" into a failed recognition.
    console.warn('Unable to read upload page registration meta', pathname, error);
    return null;
  }
}

function parseRegistrationMetaJson(data: Buffer): unknown | null {
  try {
    const parsed = JSON.parse(data.toString('utf8'));
    return parsed ?? null;
  } catch {
    return null;
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
    rmSync(LOCAL_UPLOAD_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
      traceBlobOp('list', `prefix=${prefix}`);
      const result = await list({ prefix, cursor, limit: 1000 });
      if (result.blobs.length > 0) {
        traceBlobOp('del', `count=${result.blobs.length}`);
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
