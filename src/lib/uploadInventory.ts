export type UploadKind = 'cagi' | 'satisfaction';

export interface UploadBatchReference {
  batchId: string;
  expectedPageCount: number;
}

export interface UploadInventory {
  cagi: UploadBatchReference | null;
  satisfaction: UploadBatchReference | null;
}

const SAFE_JOB_ID = /^job_[a-zA-Z0-9_-]+$/;
const SAFE_BATCH_ID = /^[a-zA-Z0-9_-]{8,128}$/;

export function isUploadKind(value: unknown): value is UploadKind {
  return value === 'cagi' || value === 'satisfaction';
}

export function isSafeJobId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_JOB_ID.test(value);
}

export function isUploadBatchReference(value: unknown): value is UploadBatchReference {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<UploadBatchReference>;
  return typeof candidate.batchId === 'string'
    && SAFE_BATCH_ID.test(candidate.batchId)
    && typeof candidate.expectedPageCount === 'number'
    && Number.isInteger(candidate.expectedPageCount)
    && candidate.expectedPageCount > 0
    && candidate.expectedPageCount <= 200;
}

export function isUploadInventory(value: unknown): value is UploadInventory {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<UploadInventory>;
  return (candidate.cagi === null || isUploadBatchReference(candidate.cagi))
    && (candidate.satisfaction === null || isUploadBatchReference(candidate.satisfaction));
}
