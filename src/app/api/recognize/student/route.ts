import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  createRecognitionOcrDeadlines,
  ROW_ANCHOR_BATCH_BUDGET_MS,
} from '../../../../lib/recognition/ocrBudget';
import { recognizeOneStudent } from '../../../../lib/recognition/recognizeOneStudent';
import {
  isRegistrationMetaLike,
  type RegistrationMetaLike,
} from '../../../../lib/recognition/sheetQuality';
import { storeRecognitionMeasurements } from '../../../../lib/labelExport/labelStore';
import { isSafeJobId } from '../../../../lib/uploadInventory';

/**
 * Stateless recognition of ONE student
 * (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §2).
 *
 * The two sheets arrive in the request body instead of through Blob: this
 * route never touches `uploadStore`, so a batch costs zero advanced Blob
 * operations. The images live only in a request-scoped temp directory that is
 * removed in `finally`, before the response is returned — nothing of the
 * student's answers stays on disk (PRD §10 / C5).
 *
 * Recognition itself is the batch route's code, called through
 * `recognizeOneStudent`, so the returned `student` is the same object the
 * batch response carries for that student.
 */
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Vercel's serverless request-body ceiling. Two page JPEGs are ~0.6MB
 * together (§4 of the plan), so this only ever fires on a malformed caller —
 * and it fires as a readable 400 instead of the platform's opaque 413.
 */
const MAX_STUDENT_REQUEST_BYTES = 4.5 * 1024 * 1024;

export async function POST(req: Request) {
  let scratchDir: string | null = null;

  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({
        error: '요청 형식이 올바르지 않습니다. 이미지 두 장을 multipart/form-data로 보내주세요.',
        code: 'INVALID_FORM_DATA',
      }, { status: 400 });
    }

    const cagiFile = formData.get('cagi');
    const satisfactionFile = formData.get('satisfaction');
    const jobId = formData.get('jobId');
    const studentIndexField = formData.get('studentIndex');

    if (!(cagiFile instanceof File) || !(satisfactionFile instanceof File) || !isSafeJobId(jobId)) {
      return NextResponse.json({
        error: '학생 1명 인식에 필요한 정보가 올바르지 않습니다. (선별검사지·만족도조사 이미지와 작업 식별자)',
        code: 'MISSING_FIELDS',
      }, { status: 400 });
    }

    const studentIndex = Number(studentIndexField);
    if (
      typeof studentIndexField !== 'string'
      || studentIndexField.length === 0
      || !Number.isInteger(studentIndex)
      || studentIndex < 0
    ) {
      return NextResponse.json({
        error: '학생 순번이 올바르지 않습니다.',
        code: 'INVALID_STUDENT_INDEX',
      }, { status: 400 });
    }

    if (cagiFile.size === 0 || satisfactionFile.size === 0) {
      return NextResponse.json({
        error: '이미지 파일이 비어 있습니다. 다시 전송해주세요.',
        code: 'EMPTY_IMAGE',
      }, { status: 400 });
    }

    if (cagiFile.size + satisfactionFile.size > MAX_STUDENT_REQUEST_BYTES) {
      return NextResponse.json({
        error: '전송한 이미지 용량이 한 요청의 상한을 넘었습니다. 더 낮은 배율로 다시 렌더링해주세요.',
        code: 'PAYLOAD_TOO_LARGE',
        limitBytes: MAX_STUDENT_REQUEST_BYTES,
        receivedBytes: cagiFile.size + satisfactionFile.size,
      }, { status: 400 });
    }

    // Optional F1 capture meta, exactly as /api/upload receives it. Its
    // presence — not its content — is what arms the photo-only refusals, so a
    // malformed value reads as absent rather than as a lie.
    const cagiRegistration = parseRegistrationField(formData.get('cagiRegistration'));
    const satisfactionRegistration = parseRegistrationField(formData.get('satisfactionRegistration'));

    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpga-student-'));
    const cagiImageId = `cagi_page_${studentIndex}`;
    const satisfactionImageId = `satisfaction_page_${studentIndex}`;
    const cagiPath = path.join(scratchDir, `${cagiImageId}.jpg`);
    const satisfactionPath = path.join(scratchDir, `${satisfactionImageId}.jpg`);
    await fs.writeFile(cagiPath, Buffer.from(await cagiFile.arrayBuffer()));
    await fs.writeFile(satisfactionPath, Buffer.from(await satisfactionFile.arrayBuffer()));

    const { student, measurements } = await recognizeOneStudent({
      cagiPath,
      satisfactionPath,
      cagiRegistration,
      satisfactionRegistration,
      // The row-OCR budget is per request here, and the per-student digit
      // budget still follows the batch rule: the caller's `studentIndex` says
      // whether this is the first sheet of a run (6s) or a later one (1s).
      ocrDeadlines: createRecognitionOcrDeadlines(Date.now() + ROW_ANCHOR_BATCH_BUDGET_MS, studentIndex),
      cagiImageId,
      satisfactionImageId,
    });

    // Local-only sidecar (skipped on Vercel), same as the batch route.
    // Never allowed to fail a recognized student.
    try {
      await storeRecognitionMeasurements({ jobId, studentIndex, cagiImageId, measurements });
    } catch (error) {
      console.error('Unable to store recognition measurements for student', studentIndex, error);
    }

    return NextResponse.json({ student });
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    return NextResponse.json({ error: `이미지 인식 결과 처리 중 실패: ${message}` }, { status: 500 });
  } finally {
    // Before the response is returned, not after: the review payload is
    // already data URLs in memory, so nothing downstream needs these files.
    if (scratchDir) {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Stringified RegistrationMeta from the client, or null if it is absent or malformed. */
function parseRegistrationField(value: FormDataEntryValue | null): RegistrationMetaLike | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  return isRegistrationMetaLike(parsed) ? parsed : null;
}
