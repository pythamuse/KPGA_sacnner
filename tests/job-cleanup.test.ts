import { afterEach, describe, expect, it } from 'vitest';
import { POST as cleanupPOST } from '../src/app/api/jobs/cleanup/route';
import { readUploadPage, resetUploadStoreForTests } from '../src/lib/storage/uploadStore';
import { createTestBatch, uploadTestPage } from './helpers/uploadApi';

afterEach(() => {
  resetUploadStoreForTests();
});

describe('upload cleanup', () => {
  it('removes only the durable upload originals for a job', async () => {
    const jobId = 'job_cleanup_uploads';
    const batch = createTestBatch();
    expect((await uploadTestPage(jobId, 'cagi', batch, 1, 'image', 'capture.jpg', 'image/jpeg')).status).toBe(200);
    expect(await readUploadPage(jobId, 'cagi', batch, 1)).not.toBeNull();

    const response = await cleanupPOST(new Request('http://localhost/api/jobs/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, scope: 'uploads' }),
    }) as any);

    expect(response.status).toBe(200);
    expect(await readUploadPage(jobId, 'cagi', batch, 1)).toBeNull();
  });

  it('does not depend on in-memory job sessions for a valid upload identifier', async () => {
    const jobId = 'job_stateless_upload';
    const batch = createTestBatch();
    const response = await uploadTestPage(jobId, 'cagi', batch, 1, 'image', 'capture.jpg', 'image/jpeg');
    expect(response.status).toBe(200);
    expect(await readUploadPage(jobId, 'cagi', batch, 1)).not.toBeNull();
  });

  it('rejects unsafe job identifiers before accessing durable storage', async () => {
    const batch = createTestBatch();
    const response = await uploadTestPage('job/unsafe', 'cagi', batch, 1, 'image', 'capture.jpg', 'image/jpeg');
    expect(response.status).toBe(400);
  });
});
