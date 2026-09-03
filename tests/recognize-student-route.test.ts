import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { POST as recognizeStudentPOST } from '../src/app/api/recognize/student/route';
import { recognizeOneStudent } from '../src/lib/recognition/recognizeOneStudent';
import {
  createRecognitionOcrDeadlines,
  ROW_ANCHOR_BATCH_BUDGET_MS,
} from '../src/lib/recognition/ocrBudget';

/**
 * The stateless per-student route (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md
 * §2): the two sheets arrive in the request body, never through Blob.
 *
 * The load-bearing claim is that the route is a transport, not a second
 * recognizer — the `student` it returns must be exactly what the shared
 * `recognizeOneStudent` produces for the same two images, data URLs included.
 * The batch route calls the same function, so this equality is what lets the
 * two paths be compared cell by cell later.
 */

const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'blank-form');
const cagiFixture = path.join(fixtureDir, 'cagi-blank.png');
const satisfactionFixture = path.join(fixtureDir, 'satisfaction-blank.png');

const JOB_ID = 'job_student_route_test';

async function buildRequest(fields: Record<string, string>, files: {
  cagi?: Buffer;
  satisfaction?: Buffer;
}) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  if (files.cagi) {
    formData.append('cagi', new File([new Uint8Array(files.cagi)], 'cagi.jpg', { type: 'image/jpeg' }));
  }
  if (files.satisfaction) {
    formData.append(
      'satisfaction',
      new File([new Uint8Array(files.satisfaction)], 'satisfaction.jpg', { type: 'image/jpeg' }),
    );
  }
  return new Request('http://localhost/api/recognize/student', { method: 'POST', body: formData });
}

async function listStudentScratchDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('kpga-student-'))
    .map((entry) => entry.name)
    .sort();
}

describe('POST /api/recognize/student', () => {
  it('returns the same student object the shared recognizer builds, and leaves no scratch behind', async () => {
    const cagiBytes = await fs.readFile(cagiFixture);
    const satisfactionBytes = await fs.readFile(satisfactionFixture);

    // (a) the shared function, called directly on a copy of the same bytes
    // under the same file names the route writes.
    const directDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpga-student-direct-'));
    let direct;
    try {
      const directCagiPath = path.join(directDir, 'cagi_page_0.jpg');
      const directSatisfactionPath = path.join(directDir, 'satisfaction_page_0.jpg');
      await fs.writeFile(directCagiPath, cagiBytes);
      await fs.writeFile(directSatisfactionPath, satisfactionBytes);
      direct = await recognizeOneStudent({
        cagiPath: directCagiPath,
        satisfactionPath: directSatisfactionPath,
        cagiRegistration: null,
        satisfactionRegistration: null,
        ocrDeadlines: createRecognitionOcrDeadlines(Date.now() + ROW_ANCHOR_BATCH_BUDGET_MS, 0),
        cagiImageId: 'cagi_page_0',
        satisfactionImageId: 'satisfaction_page_0',
      });
    } finally {
      await fs.rm(directDir, { recursive: true, force: true }).catch(() => undefined);
    }

    // (b) the route, given the same bytes as multipart.
    const before = await listStudentScratchDirs();
    const response = await recognizeStudentPOST(await buildRequest(
      { jobId: JOB_ID, studentIndex: '0' },
      { cagi: cagiBytes, satisfaction: satisfactionBytes },
    ));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.student.source.cagiImageId).toBe('cagi_page_0');
    expect(body.student.source.satisfactionImageId).toBe('satisfaction_page_0');
    expect(body.student.source.cagiImageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    // Server-only outlet: measurements never travel in the response.
    expect(body.student.recognitionMeasurements).toBeUndefined();
    expect(body.student).toEqual(JSON.parse(JSON.stringify(direct.student)));

    // (c) the request-scoped scratch directory is gone by the time the
    // response is in hand — not left for a later sweep.
    const after = await listStudentScratchDirs();
    expect(after).toEqual(before);
  }, 120_000);

  it('rejects a request that is missing a sheet', async () => {
    const cagiBytes = await fs.readFile(cagiFixture);
    const response = await recognizeStudentPOST(await buildRequest(
      { jobId: JOB_ID, studentIndex: '0' },
      { cagi: cagiBytes },
    ));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('MISSING_FIELDS');
  });

  it('rejects an unsafe job identifier before writing anything to disk', async () => {
    const before = await listStudentScratchDirs();
    const response = await recognizeStudentPOST(await buildRequest(
      { jobId: 'job/unsafe', studentIndex: '0' },
      { cagi: Buffer.from('cagi'), satisfaction: Buffer.from('satisfaction') },
    ));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('MISSING_FIELDS');
    expect(await listStudentScratchDirs()).toEqual(before);
  });

  it('rejects a missing or non-integer student index', async () => {
    const files = { cagi: Buffer.from('cagi'), satisfaction: Buffer.from('satisfaction') };
    const missing = await recognizeStudentPOST(await buildRequest({ jobId: JOB_ID }, files));
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('INVALID_STUDENT_INDEX');

    const fractional = await recognizeStudentPOST(await buildRequest(
      { jobId: JOB_ID, studentIndex: '1.5' },
      files,
    ));
    expect(fractional.status).toBe(400);
    expect((await fractional.json()).code).toBe('INVALID_STUDENT_INDEX');
  });

  it('rejects an empty sheet file rather than recognizing a zero-byte image', async () => {
    const response = await recognizeStudentPOST(await buildRequest(
      { jobId: JOB_ID, studentIndex: '0' },
      { cagi: Buffer.alloc(0), satisfaction: Buffer.from('satisfaction') },
    ));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('EMPTY_IMAGE');
  });

  it('rejects a body that is not multipart form data', async () => {
    const response = await recognizeStudentPOST(new Request('http://localhost/api/recognize/student', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: JOB_ID }),
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_FORM_DATA');
  });
});
