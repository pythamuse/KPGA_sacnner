import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { POST as recognizeBatchPOST } from '../src/app/api/recognize/route';
import { POST as recognizeStudentPOST } from '../src/app/api/recognize/student/route';
import { FORM_CLASSIFIER_POLICY_VERSION } from '../src/lib/recognition/classifyForm';
import { recognizeOneStudent } from '../src/lib/recognition/recognizeOneStudent';
import {
  createRecognitionOcrDeadlines,
  ROW_ANCHOR_BATCH_BUDGET_MS,
} from '../src/lib/recognition/ocrBudget';
import { resetUploadStoreForTests } from '../src/lib/storage/uploadStore';
import { createInventory, createTestBatch, uploadTestPage } from './helpers/uploadApi';

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
    // Round B appends the batch route's notices to the student's own warning
    // list. Every other field must still be exactly what the shared recognizer
    // built, and the recognizer's own warnings must survive underneath the
    // appended ones -- checked separately so a changed VALUE could not hide
    // inside `warnings`.
    const expected = JSON.parse(JSON.stringify(direct.student));
    expect({ ...body.student, warnings: expected.warnings }).toEqual(expected);
    expect(body.student.warnings.slice(0, expected.warnings.length)).toEqual(expected.warnings);
    expect(body.student.warnings.slice(expected.warnings.length)).toEqual([
      '선별검사지 1페이지의 조기개입 서비스 영역에서 이름 또는 연락처 입력 흔적이 감지되었습니다. 개인정보는 저장하지 않으며 원본을 확인한 뒤 검수를 진행해주세요.',
    ]);

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

/**
 * Round B moved two things off the batch route and onto the per-student route:
 * the upload-slot guard (`classifyForm`) and the early-intervention notices
 * (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §3). They are the only part of
 * `/api/recognize` that the stateless path could not simply not have — the
 * refusal protects the reviewer from a swapped stack, and the notices are the
 * only signal that a sheet carries a name or a phone number the product must
 * not store.
 *
 * Each test here runs BOTH routes over the SAME image bytes and compares what
 * they say. Not "the stateless route says something sensible": the same
 * sentence, the same code, the same page number. Filenames are made equal on
 * both sides for the same reason — the batch route names a page by its stored
 * position and the stateless route by what the client sent, so a difference
 * there would be about the fixture, not about the guard.
 *
 * A single-student batch is used throughout, because that is the only batch
 * size the two routes can be compared at: with more pages the batch route
 * folds its page numbers into one warning and the per-student route cannot.
 *
 * These live in THIS file rather than their own because the leak check above
 * lists every `kpga-student-*` directory in the OS temp dir: a second test file
 * calling this route in another worker puts its own in-flight scratch there and
 * the check reports a leak that is not one. Same file, same worker, one call at
 * a time.
 */

const CAGI_UPLOAD_NAME = 'cagi_page_0001.jpg';
const SATISFACTION_UPLOAD_NAME = 'satisfaction_page_0001.jpg';

afterEach(() => {
  resetUploadStoreForTests();
});

describe('stateless per-student route reproduces the batch route notices', () => {
  it('reports the same early-intervention notices for a sheet with marks and contact traces', async () => {
    const cagiBytes = await buildCagiSheetWithEarlyInterventionTraces();
    const satisfactionBytes = await fs.readFile(path.join(fixtureDir, 'satisfaction-blank.png'));

    const batch = await runBatch('job_notice_marks', cagiBytes, satisfactionBytes);
    expect(batch.status).toBe(200);

    const student = await runStudent(cagiBytes, satisfactionBytes);
    expect(student.status).toBe(200);

    // Both notices, both naming CAGI page 1 — the single student's own page.
    expect(batch.body.warnings).toHaveLength(2);
    expect(noticesFor(student.body, batch.body.warnings.length)).toEqual(batch.body.warnings);
  }, 180_000);

  it('reports the same contact-only notice for an unmarked sheet', async () => {
    const cagiBytes = await fs.readFile(path.join(fixtureDir, 'cagi-blank.png'));
    const satisfactionBytes = await fs.readFile(path.join(fixtureDir, 'satisfaction-blank.png'));

    const batch = await runBatch('job_notice_contact', cagiBytes, satisfactionBytes);
    expect(batch.status).toBe(200);

    const student = await runStudent(cagiBytes, satisfactionBytes);
    expect(student.status).toBe(200);

    expect(batch.body.warnings).toHaveLength(1);
    expect(noticesFor(student.body, batch.body.warnings.length)).toEqual(batch.body.warnings);
  }, 180_000);

  it('refuses a sheet whose content disagrees with its upload slot, the same way', async () => {
    // Satisfaction paper in the CAGI slot: the swap the guard exists for.
    const wrongSlotBytes = await fs.readFile(path.join(fixtureDir, 'satisfaction-blank.png'));

    const batch = await runBatch('job_notice_mismatch', wrongSlotBytes, wrongSlotBytes);
    const student = await runStudent(wrongSlotBytes, wrongSlotBytes);

    expect(batch.status).toBe(400);
    expect(student.status).toBe(400);
    expect(student.body).toMatchObject({
      code: 'FORM_TYPE_MISMATCH',
      canProceedWithUploadedTypes: true,
      recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
      mismatches: [{
        filename: CAGI_UPLOAD_NAME,
        uploadedAs: 'cagi',
        detectedAs: 'satisfaction',
      }],
    });
    expect(student.body.error).toBe(batch.body.error);
    expect(student.body.mismatches).toEqual(batch.body.mismatches);
  }, 180_000);

  it('carries the same override notice when the user keeps the upload slots', async () => {
    const wrongSlotBytes = await fs.readFile(path.join(fixtureDir, 'satisfaction-blank.png'));

    const batch = await runBatch('job_notice_override', wrongSlotBytes, wrongSlotBytes, true);
    const student = await runStudent(wrongSlotBytes, wrongSlotBytes, true);

    expect(batch.status).toBe(200);
    expect(student.status).toBe(200);
    expect(batch.body.warnings).toEqual([
      `${CAGI_UPLOAD_NAME}: 자동 인식 추정(만족도조사) 대신 선택한 업로드 칸(선별검사지)을 적용했습니다. 검수 화면에서 원본과 인식 결과를 확인해주세요.`,
    ]);
    expect(noticesFor(student.body, batch.body.warnings.length)).toEqual(batch.body.warnings);
  }, 180_000);
});

/**
 * The notices the route appended, separated from the recognizer's own warnings.
 *
 * The route appends rather than assigns, so whatever the recognizer wrote
 * about these values sits in front and the sheet-level notices are the tail.
 * `count` comes from the batch route's own list, which carries the notices and
 * nothing else, so the two are compared over the same span.
 */
function noticesFor(body: any, count: number): string[] {
  const warnings: string[] = body.student.warnings ?? [];
  return count === 0 ? [] : warnings.slice(-count);
}

async function runBatch(
  jobId: string,
  cagiBytes: Buffer,
  satisfactionBytes: Buffer,
  trustUploadedTypes = false,
) {
  const cagi = createTestBatch();
  const satisfaction = createTestBatch();
  await uploadTestPage(jobId, 'cagi', cagi, 1, cagiBytes, CAGI_UPLOAD_NAME, 'image/jpeg');
  await uploadTestPage(jobId, 'satisfaction', satisfaction, 1, satisfactionBytes, SATISFACTION_UPLOAD_NAME, 'image/jpeg');

  const response = await recognizeBatchPOST(new Request('http://localhost/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, inventory: createInventory(cagi, satisfaction), trustUploadedTypes }),
  }) as any);

  return { status: response.status, body: await response.json() };
}

async function runStudent(
  cagiBytes: Buffer,
  satisfactionBytes: Buffer,
  trustUploadedTypes = false,
) {
  const formData = new FormData();
  formData.append('jobId', 'job_notice_student');
  formData.append('studentIndex', '0');
  if (trustUploadedTypes) {
    formData.append('trustUploadedTypes', '1');
  }
  formData.append(
    'cagi',
    new File([new Uint8Array(cagiBytes)], CAGI_UPLOAD_NAME, { type: 'image/jpeg' }),
  );
  formData.append(
    'satisfaction',
    new File([new Uint8Array(satisfactionBytes)], SATISFACTION_UPLOAD_NAME, { type: 'image/jpeg' }),
  );

  const response = await recognizeStudentPOST(new Request('http://localhost/api/recognize/student', {
    method: 'POST',
    body: formData,
  }));

  return { status: response.status, body: await response.json() };
}

/**
 * The blank CAGI form with the early-intervention block filled in.
 *
 * A dark band across the block's row is enough for both detectors: the five
 * option cells read as marked and the two entry cells read as written in. What
 * matters for this test is only that the SAME bytes reach both routes.
 */
async function buildCagiSheetWithEarlyInterventionTraces(): Promise<Buffer> {
  const source = path.join(fixtureDir, 'cagi-blank.png');
  const { width = 0, height = 0 } = await sharp(source).metadata();
  const band = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect x="${Math.round(0.15 * width)}" y="${Math.round(0.68 * height)}"`
    + ` width="${Math.round(0.75 * width)}" height="${Math.round(0.03 * height)}" fill="#000"/></svg>`;

  return sharp(source)
    .composite([{ input: Buffer.from(band), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
