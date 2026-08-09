import { afterEach, describe, expect, it } from 'vitest';
import { POST as jobsPOST } from '../src/app/api/jobs/route';
import { POST as recognizePOST } from '../src/app/api/recognize/route';
import { readUploadPage, resetUploadStoreForTests } from '../src/lib/storage/uploadStore';
import { createInventory, createTestBatch, uploadTestPage } from './helpers/uploadApi';

const png1x1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x60,
  0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0xa5, 0xf7, 0xdf, 0x7d, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

afterEach(() => {
  resetUploadStoreForTests();
});

describe('upload and recognition integration', () => {
  it('creates a collision-resistant job identifier', async () => {
    const response = await jobsPOST();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobId).toMatch(/^job_[a-zA-Z0-9_-]+$/);
  });

  it('only acknowledges an upload after the page is persisted', async () => {
    const jobId = 'job_upload_persistence';
    const batch = createTestBatch();
    const first = await uploadTestPage(jobId, 'cagi', batch, 1, 'first-image', 'capture.jpg', 'image/jpeg');
    expect(first.status).toBe(200);

    const second = await uploadTestPage(jobId, 'cagi', batch, 1, 'second-image', 'capture.jpg', 'image/jpeg');
    expect(second.status).toBe(200);

    const stored = await readUploadPage(jobId, 'cagi', batch, 1);
    expect(stored?.data.toString()).toBe('second-image');
  });

  it('recognizes only a complete, declared upload inventory', async () => {
    const jobId = 'job_inventory_recognition';
    const cagi = createTestBatch();
    const satisfaction = createTestBatch();

    expect((await uploadTestPage(jobId, 'cagi', cagi, 1, png1x1)).status).toBe(200);
    expect((await uploadTestPage(jobId, 'satisfaction', satisfaction, 1, png1x1)).status).toBe(200);

    const response = await recognizePOST(new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, inventory: createInventory(cagi, satisfaction) }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.studentDrafts).toHaveLength(1);
    expect(body.studentDrafts[0].source.cagiImageDataUrl).toMatch(/^data:image\/jpeg;base64,/);

    // Successful recognition removes private originals after it has constructed the review payload.
    expect(await readUploadPage(jobId, 'cagi', cagi, 1)).toBeNull();
    expect(await readUploadPage(jobId, 'satisfaction', satisfaction, 1)).toBeNull();
  });

  it('returns an integrity error instead of a false page-count mismatch when a persisted page is missing', async () => {
    const jobId = 'job_integrity_failure';
    const cagi = createTestBatch(2);
    const satisfaction = createTestBatch(2);

    await uploadTestPage(jobId, 'cagi', cagi, 1, png1x1);
    await uploadTestPage(jobId, 'satisfaction', satisfaction, 1, png1x1);
    await uploadTestPage(jobId, 'satisfaction', satisfaction, 2, png1x1);

    const response = await recognizePOST(new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, inventory: createInventory(cagi, satisfaction) }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'UPLOAD_INTEGRITY_ERROR',
      expected: { cagi: 2, satisfaction: 2 },
      available: { cagi: [1], satisfaction: [1, 2] },
    });
  });
});
