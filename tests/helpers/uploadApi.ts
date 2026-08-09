import type { UploadBatchReference, UploadInventory, UploadKind } from '../../src/lib/uploadInventory';
import { POST as uploadPOST } from '../../src/app/api/upload/route';

export function createTestBatch(expectedPageCount = 1): UploadBatchReference {
  return {
    batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`,
    expectedPageCount,
  };
}

export function createInventory(
  cagi: UploadBatchReference,
  satisfaction: UploadBatchReference,
): UploadInventory {
  return { cagi, satisfaction };
}

export async function uploadTestPage(
  jobId: string,
  type: UploadKind,
  batch: UploadBatchReference,
  pageNumber: number,
  data: Buffer | string,
  filename = `${type}_page_${String(pageNumber).padStart(3, '0')}.png`,
  contentType = 'image/png',
) {
  const formData = new FormData();
  formData.append('jobId', jobId);
  formData.append('type', type);
  formData.append('batchId', batch.batchId);
  formData.append('expectedPageCount', String(batch.expectedPageCount));
  formData.append('pageNumber', String(pageNumber));
  const fileData: BlobPart = typeof data === 'string' ? data : new Uint8Array(Array.from(data));
  formData.append('file', new File([fileData], filename, { type: contentType }));

  return uploadPOST(new Request('http://localhost/api/upload', {
    method: 'POST',
    body: formData,
  }) as any);
}
