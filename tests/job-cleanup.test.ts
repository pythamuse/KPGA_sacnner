import { afterEach, describe, expect, it, vi } from 'vitest';
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

  /**
   * `BLOB_OPS_TRACE=1` prints one `[blob-op]` line per Vercel Blob call
   * (uploadStore.ts `traceBlobOp`), which is how the batch's advanced-operation
   * count gets measured instead of estimated
   * (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §4 step 1). The counter is
   * only meaningful if the local filesystem path — every test, and every
   * `npm run dev` — is silent, so a local run can never inflate the number the
   * deployed path is judged on.
   */
  it('does not reach the Vercel Blob API on the local filesystem path', async () => {
    const previousTraceFlag = process.env.BLOB_OPS_TRACE;
    process.env.BLOB_OPS_TRACE = '1';
    const infoLines: string[] = [];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      infoLines.push(args.map(String).join(' '));
    });

    try {
      const jobId = 'job_blob_ops_trace';
      const batch = createTestBatch();
      expect((await uploadTestPage(jobId, 'cagi', batch, 1, 'image', 'capture.jpg', 'image/jpeg')).status).toBe(200);

      const response = await cleanupPOST(new Request('http://localhost/api/jobs/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, scope: 'uploads' }),
      }) as any);
      expect(response.status).toBe(200);

      // Guards against a vacuous pass: the trace has to have been armed.
      expect(process.env.BLOB_OPS_TRACE).toBe('1');
      expect(infoLines.filter((line) => line.includes('[blob-op]'))).toEqual([]);
    } finally {
      infoSpy.mockRestore();
      if (previousTraceFlag === undefined) {
        delete process.env.BLOB_OPS_TRACE;
      } else {
        process.env.BLOB_OPS_TRACE = previousTraceFlag;
      }
    }
  });

  it('rejects unsafe job identifiers before accessing durable storage', async () => {
    const batch = createTestBatch();
    const response = await uploadTestPage('job/unsafe', 'cagi', batch, 1, 'image', 'capture.jpg', 'image/jpeg');
    expect(response.status).toBe(400);
  });
});
