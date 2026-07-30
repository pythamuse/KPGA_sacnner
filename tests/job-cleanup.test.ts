import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getJobDir } from '../src/lib/excel/templateManager';
import { getJobSession } from '../src/lib/storage/jobStore';
import { POST as jobsPOST } from '../src/app/api/jobs/route';
import { POST as uploadPOST } from '../src/app/api/upload/route';
import { POST as recognizePOST } from '../src/app/api/recognize/route';
import { POST as cleanupPOST } from '../src/app/api/jobs/cleanup/route';

async function createJob() {
  const response = await jobsPOST();
  const body = await response.json();
  return body.jobId as string;
}

async function uploadImage(jobId: string, type: 'cagi' | 'satisfaction') {
  const formData = new FormData();
  formData.append('jobId', jobId);
  formData.append('type', type);
  formData.append('file', new File(['image'], `${type}.jpg`, { type: 'image/jpeg' }));

  const req = new Request('http://localhost/api/upload', {
    method: 'POST',
    body: formData,
  });

  return uploadPOST(req as any);
}

describe('?묒뾽 ?몄뀡 諛??낅줈???뚯씪 ?뺣━', () => {
  it('POST /api/jobs/cleanup?scope=uploads ???꾩옱 ?묒뾽???낅줈???뚯씪留??쒓굅', async () => {
    const jobId = await createJob();
    const jobDir = getJobDir(jobId);

    try {
      const uploadResponse = await uploadImage(jobId, 'cagi');
      expect(uploadResponse.status).toBe(200);

      const uploadDir = path.join(jobDir, 'uploads');
      expect(fs.existsSync(uploadDir)).toBe(true);
      expect(fs.readdirSync(uploadDir).some((filename) => filename.startsWith('cagi_'))).toBe(true);

      const req = new Request('http://localhost/api/jobs/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, scope: 'uploads' }),
      });
      const response = await cleanupPOST(req as any);
      expect(response.status).toBe(200);

      expect(fs.existsSync(uploadDir)).toBe(false);
      expect(fs.existsSync(jobDir)).toBe(true);
    } finally {
      if (fs.existsSync(jobDir)) {
        fs.rmSync(jobDir, { recursive: true, force: true });
      }
    }
  });

  it('?녿뒗 jobId濡??낅줈???먮뒗 ?몄떇???붿껌?섎㈃ 404瑜?諛섑솚', async () => {
    const uploadResponse = await uploadImage('job_missing', 'cagi');
    expect(uploadResponse.status).toBe(404);

    const recognizeReq = new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: 'job_missing' }),
    });
    const recognizeResponse = await recognizePOST(recognizeReq as any);
    expect(recognizeResponse.status).toBe(404);
  });

  it('Vercel 업로드 요청에서 메모리 세션이 없어도 유효한 jobId 작업공간을 복구한다', async () => {
    const jobId = `job_${Date.now()}999`;
    const jobDir = getJobDir(jobId);

    try {
      const uploadResponse = await uploadImage(jobId, 'cagi');
      expect(uploadResponse.status).toBe(200);

      const uploadDir = path.join(jobDir, 'uploads');
      expect(fs.existsSync(path.join(jobDir, 'session.json'))).toBe(true);
      expect(fs.existsSync(uploadDir)).toBe(true);
      expect(fs.readdirSync(uploadDir).some((filename) => filename.startsWith('cagi_'))).toBe(true);
    } finally {
      if (fs.existsSync(jobDir)) {
        fs.rmSync(jobDir, { recursive: true, force: true });
      }
    }
  });

  it('POST /api/jobs/cleanup?scope=expired ???뚮옒???묒뾽 ?몄뀡怨??뚯씪???쒓굅', async () => {
    const jobId = await createJob();
    const jobDir = getJobDir(jobId);
    const session = getJobSession(jobId);
    expect(session).toBeDefined();

    session!.createdAt = Date.now() - 25 * 60 * 60 * 1000;

    const req = new Request('http://localhost/api/jobs/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'expired' }),
    });
    const response = await cleanupPOST(req as any);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.removedJobIds).toContain(jobId);
    expect(getJobSession(jobId)).toBeUndefined();
    expect(fs.existsSync(jobDir)).toBe(false);
  });
});
