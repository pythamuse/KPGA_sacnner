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
  /**
   * Optional F1 capture meta, exactly as the client sends it: a stringified
   * value in the `registration` form field. Pass a raw string to exercise the
   * malformed-input path; anything else is JSON-stringified here.
   */
  registration?: unknown,
) {
  const formData = new FormData();
  formData.append('jobId', jobId);
  formData.append('type', type);
  formData.append('batchId', batch.batchId);
  formData.append('expectedPageCount', String(batch.expectedPageCount));
  formData.append('pageNumber', String(pageNumber));
  if (registration !== undefined) {
    formData.append(
      'registration',
      typeof registration === 'string' ? registration : JSON.stringify(registration),
    );
  }
  const fileData: BlobPart = typeof data === 'string' ? data : new Uint8Array(Array.from(data));
  formData.append('file', new File([fileData], filename, { type: contentType }));

  return uploadPOST(new Request('http://localhost/api/upload', {
    method: 'POST',
    body: formData,
  }) as any);
}
