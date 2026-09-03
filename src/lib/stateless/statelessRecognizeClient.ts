import type { FormTypeMismatch } from './formNotices';
import type { StatelessStudentOutcome, StatelessStudentPair } from './statelessSession';

/**
 * The stateless batch driver: one `POST /api/recognize/student` per student,
 * two in flight (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §5 risk 1).
 *
 * Two, not nineteen. Each request initializes its own OCR worker, so a wide
 * fan-out would pay tesseract's cold start on every instance it lands on; a
 * narrow pool lets the platform reuse instances while still overlapping the
 * wait. The paper never goes to Blob — the two JPEGs travel in the request
 * body and the route deletes its scratch copies before it answers.
 */

/** Concurrent requests. §5 risk 1: wide enough to overlap, narrow enough to reuse workers. */
export const STATELESS_CONCURRENCY = 2;

/**
 * Retries for one student, after the first attempt. A student is the whole
 * unit of failure here: its two images are still in memory, so a retry costs
 * one request and nothing else, and 18 recognized students are not thrown
 * away because the 19th request lost its instance.
 */
export const MAX_RETRIES_PER_STUDENT = 3;

const RETRY_BACKOFF_MS = 400;

/**
 * The batch route's whole-bundle refusal, raised from whichever student hit it.
 *
 * The batch path answered `400 FORM_TYPE_MISMATCH` for the entire request and
 * let the client re-run with `trustUploadedTypes`. That decision is about the
 * upload slots, not about one student, so it still has to stop the run: the
 * remaining students are abandoned and the caller asks the same question it
 * asked before.
 */
export class StatelessFormTypeMismatchError extends Error {
  constructor(message: string, readonly mismatches: FormTypeMismatch[]) {
    super(message);
    this.name = 'StatelessFormTypeMismatchError';
  }
}

export interface StatelessRecognizeOptions {
  jobId: string;
  pairs: StatelessStudentPair[];
  /** Set after the user chose to keep the upload slots despite a content mismatch. */
  trustUploadedTypes?: boolean;
  concurrency?: number;
  maxRetries?: number;
  /** Called after each student settles, for the "N/M" progress line. */
  onProgress?: (completed: number, total: number) => void;
  /** Injection seam for tests; the browser passes nothing. */
  fetchImpl?: typeof fetch;
  /** Injection seam for tests, so a retry path does not sleep. */
  delay?: (ms: number) => Promise<void>;
}

export async function recognizeStudentsStateless(
  options: StatelessRecognizeOptions,
): Promise<StatelessStudentOutcome[]> {
  const {
    pairs,
    concurrency = STATELESS_CONCURRENCY,
    onProgress,
  } = options;

  const outcomes: StatelessStudentOutcome[] = [];
  let cursor = 0;
  let completed = 0;
  let fatal: unknown = null;

  const worker = async () => {
    while (fatal === null) {
      const index = cursor;
      cursor += 1;
      if (index >= pairs.length) return;

      try {
        outcomes.push(await recognizeOneStudentWithRetries(pairs[index], options));
      } catch (error) {
        // Only the whole-run refusal reaches here; everything else has already
        // been turned into a failed outcome for that student alone.
        fatal = fatal ?? error;
        return;
      }

      completed += 1;
      onProgress?.(completed, pairs.length);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, pairs.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (fatal !== null) {
    throw fatal;
  }

  return outcomes;
}

async function recognizeOneStudentWithRetries(
  pair: StatelessStudentPair,
  options: StatelessRecognizeOptions,
): Promise<StatelessStudentOutcome> {
  const {
    maxRetries = MAX_RETRIES_PER_STUDENT,
    fetchImpl = fetch,
    delay = sleep,
  } = options;

  let lastMessage = '서버가 응답하지 않았습니다.';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await delay(RETRY_BACKOFF_MS * attempt);
    }

    let response: Response;
    try {
      response = await fetchImpl('/api/recognize/student', {
        method: 'POST',
        body: buildStudentFormData(pair, options),
      });
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      continue;
    }

    const body = await readResponseBody(response);

    if (response.ok) {
      if (body && typeof body === 'object' && 'student' in body) {
        return { ok: true, studentIndex: pair.studentIndex, student: (body as any).student };
      }
      lastMessage = '서버 응답에 학생 인식 결과가 없습니다.';
      continue;
    }

    const code = body && typeof body === 'object' ? (body as any).code : undefined;
    if (code === 'FORM_TYPE_MISMATCH') {
      throw new StatelessFormTypeMismatchError(
        (body as any).error || '업로드 칸과 이미지 내용이 다릅니다.',
        Array.isArray((body as any).mismatches) ? (body as any).mismatches : [],
      );
    }

    lastMessage = (body && typeof body === 'object' && typeof (body as any).error === 'string')
      ? (body as any).error
      : `서버가 ${response.status} 응답을 보냈습니다.`;

    // A rejected request is rejected the same way next time: only a server-side
    // or transport failure is worth another attempt.
    if (response.status < 500) {
      break;
    }
  }

  return {
    ok: false,
    studentIndex: pair.studentIndex,
    message: `${pair.studentIndex + 1}번 학생을 인식하지 못했습니다(${lastMessage}). 값 없이 검수 화면으로 넘겼습니다 — 원본을 보고 직접 입력하거나 이 학생만 다시 인식해주세요.`,
  };
}

function buildStudentFormData(
  pair: StatelessStudentPair,
  options: StatelessRecognizeOptions,
): FormData {
  const formData = new FormData();
  formData.append('cagi', pair.cagi.file, pair.cagi.filename);
  formData.append('satisfaction', pair.satisfaction.file, pair.satisfaction.filename);
  formData.append('jobId', options.jobId);
  formData.append('studentIndex', String(pair.studentIndex));
  if (options.trustUploadedTypes) {
    formData.append('trustUploadedTypes', '1');
  }
  // Same optional field `/api/upload` stored per page: its presence is the
  // photo-provenance flag, so a scanned page must keep sending nothing.
  if (pair.cagi.registration) {
    formData.append('cagiRegistration', JSON.stringify(pair.cagi.registration));
  }
  if (pair.satisfaction.registration) {
    formData.append('satisfactionRegistration', JSON.stringify(pair.satisfaction.registration));
  }
  return formData;
}

/** Never throws: an unparseable body becomes null and the caller reports the status. */
async function readResponseBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
