import { describe, expect, it } from 'vitest';
import {
  assembleStatelessSession,
  pairStatelessPages,
  StatelessPageCountMismatchError,
  type StatelessPage,
  type StatelessStudentOutcome,
} from '../src/lib/stateless/statelessSession';
import {
  recognizeStudentsStateless,
  StatelessFormTypeMismatchError,
} from '../src/lib/stateless/statelessRecognizeClient';

/**
 * The client half of the stateless path
 * (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §3, round B).
 *
 * With the flag on, the client is what turns nineteen separate answers back
 * into one review session, so the two failures that only it can cause are the
 * ones tested here: a student landing at the wrong POSITION (which silently
 * pairs a reviewer with someone else's paper), and one student's failure
 * taking the other eighteen with it.
 */

const page = (name: string, index: number, registration: unknown = null): StatelessPage => ({
  file: new File([new Uint8Array([index])], name, { type: 'image/jpeg' }),
  page: index,
  filename: name,
  registration,
});

const cagiPages = [page('cagi_page_001.jpg', 1), page('cagi_page_002.jpg', 2), page('cagi_page_003.jpg', 3)];
const satisfactionPages = [
  page('satisfaction_page_001.jpg', 1),
  page('satisfaction_page_002.jpg', 2),
  page('satisfaction_page_003.jpg', 3),
];

describe('pairStatelessPages', () => {
  it('pairs by stored page number, not by arrival order', () => {
    const shuffled = [cagiPages[2], cagiPages[0], cagiPages[1]];
    const pairs = pairStatelessPages(shuffled, satisfactionPages, 'same');

    expect(pairs.map((pair) => [pair.studentIndex, pair.cagi.page, pair.satisfaction.page])).toEqual([
      [0, 1, 1],
      [1, 2, 2],
      [2, 3, 3],
    ]);
  });

  it('reverses only the satisfaction stack, exactly as matchBatch does', () => {
    const pairs = pairStatelessPages(cagiPages, satisfactionPages, 'reversed');

    expect(pairs.map((pair) => [pair.cagi.page, pair.satisfaction.page])).toEqual([
      [1, 3],
      [2, 2],
      [3, 1],
    ]);
  });

  it('refuses two stacks of different heights instead of pairing across the gap', () => {
    expect(() => pairStatelessPages(cagiPages, satisfactionPages.slice(0, 2)))
      .toThrow(StatelessPageCountMismatchError);
  });
});

describe('assembleStatelessSession', () => {
  it('places students by index however the answers arrived', () => {
    const outcomes: StatelessStudentOutcome[] = [
      { ok: true, studentIndex: 2, student: draftWithAge(16) },
      { ok: true, studentIndex: 0, student: draftWithAge(14) },
      { ok: true, studentIndex: 1, student: draftWithAge(15) },
    ];

    const session = assembleStatelessSession(outcomes);

    expect(session.studentDrafts.map((draft) => draft.basic.age)).toEqual([14, 15, 16]);
    expect(session.warnings).toEqual([]);
  });

  it('keeps a failed student in its own slot as an empty draft carrying the reason', () => {
    const session = assembleStatelessSession([
      { ok: true, studentIndex: 0, student: draftWithAge(14) },
      { ok: false, studentIndex: 1, message: '2번 학생을 인식하지 못했습니다.' },
      { ok: true, studentIndex: 2, student: draftWithAge(16) },
    ]);

    // The list is still three long and the third student is still third: a
    // dropped student would move everyone after it onto the wrong paper.
    expect(session.studentDrafts).toHaveLength(3);
    expect(session.studentDrafts[2].basic.age).toBe(16);
    expect(session.studentDrafts[1].basic).toEqual({});
    expect(session.studentDrafts[1].cagi).toEqual({});
    expect(session.studentDrafts[1].satisfaction).toEqual({});
    expect(session.studentDrafts[1].warnings).toEqual(['2번 학생을 인식하지 못했습니다.']);
    expect(session.warnings).toEqual(['2번 학생을 인식하지 못했습니다.']);
  });

  it('lists every student warning in student order for the notices banner', () => {
    const first = draftWithAge(14);
    first.warnings = ['첫 번째 안내'];
    const second = draftWithAge(15);
    second.warnings = ['두 번째 안내', '세 번째 안내'];

    const session = assembleStatelessSession([
      { ok: true, studentIndex: 1, student: second },
      { ok: true, studentIndex: 0, student: first },
    ]);

    expect(session.warnings).toEqual(['첫 번째 안내', '두 번째 안내', '세 번째 안내']);
  });
});

describe('recognizeStudentsStateless', () => {
  it('sends one request per student, never more than two at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];

    const outcomes = await recognizeStudentsStateless({
      jobId: 'job_stateless',
      pairs: pairStatelessPages(cagiPages, satisfactionPages),
      fetchImpl: (async (_url: any, init: any) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const studentIndex = Number((init.body as FormData).get('studentIndex'));
        seen.push(studentIndex);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return jsonResponse(200, { student: draftWithAge(10 + studentIndex) });
      }) as any,
    });

    expect(peak).toBe(2);
    expect(seen.sort()).toEqual([0, 1, 2]);
    expect(assembleStatelessSession(outcomes).studentDrafts.map((draft) => draft.basic.age))
      .toEqual([10, 11, 12]);
  });

  it('sends the capture meta only for a page that has it', async () => {
    const bodies: FormData[] = [];
    await recognizeStudentsStateless({
      jobId: 'job_stateless',
      pairs: pairStatelessPages(
        [page('cagi_page_001.jpg', 1, { method: 'orb', confidence: 0.9 })],
        [page('satisfaction_page_001.jpg', 1)],
      ),
      fetchImpl: (async (_url: any, init: any) => {
        bodies.push(init.body as FormData);
        return jsonResponse(200, { student: draftWithAge(14) });
      }) as any,
    });

    expect(bodies[0].get('cagiRegistration')).toBe('{"method":"orb","confidence":0.9}');
    expect(bodies[0].get('satisfactionRegistration')).toBeNull();
    expect(bodies[0].get('trustUploadedTypes')).toBeNull();
  });

  it('retries only the student that failed, and only while the server is at fault', async () => {
    const attempts = new Map<number, number>();

    const outcomes = await recognizeStudentsStateless({
      jobId: 'job_stateless',
      pairs: pairStatelessPages(cagiPages, satisfactionPages),
      delay: async () => undefined,
      fetchImpl: (async (_url: any, init: any) => {
        const studentIndex = Number((init.body as FormData).get('studentIndex'));
        const attempt = (attempts.get(studentIndex) ?? 0) + 1;
        attempts.set(studentIndex, attempt);
        if (studentIndex === 1 && attempt < 3) {
          return jsonResponse(500, { error: '인식 중 오류' });
        }
        return jsonResponse(200, { student: draftWithAge(10 + studentIndex) });
      }) as any,
    });

    expect(attempts.get(0)).toBe(1);
    expect(attempts.get(1)).toBe(3);
    expect(attempts.get(2)).toBe(1);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it('gives up on one student after its retries and completes the rest', async () => {
    const progress: number[] = [];

    const outcomes = await recognizeStudentsStateless({
      jobId: 'job_stateless',
      pairs: pairStatelessPages(cagiPages, satisfactionPages),
      delay: async () => undefined,
      onProgress: (completed) => progress.push(completed),
      fetchImpl: (async (_url: any, init: any) => {
        const studentIndex = Number((init.body as FormData).get('studentIndex'));
        if (studentIndex === 1) throw new Error('네트워크 연결이 끊겼습니다');
        return jsonResponse(200, { student: draftWithAge(10 + studentIndex) });
      }) as any,
    });

    const session = assembleStatelessSession(outcomes);
    expect(session.studentDrafts.map((draft) => draft.basic.age)).toEqual([10, undefined, 12]);
    expect(session.warnings).toHaveLength(1);
    expect(session.warnings[0]).toContain('2번 학생을 인식하지 못했습니다');
    expect(session.warnings[0]).toContain('네트워크 연결이 끊겼습니다');
    // Every student settled, the failed one included.
    expect(progress).toEqual([1, 2, 3]);
  });

  it('does not retry a request the server refused on its merits', async () => {
    let calls = 0;

    const outcomes = await recognizeStudentsStateless({
      jobId: 'job_stateless',
      pairs: pairStatelessPages([cagiPages[0]], [satisfactionPages[0]]),
      delay: async () => undefined,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(400, { error: '이미지 파일이 비어 있습니다.', code: 'EMPTY_IMAGE' });
      }) as any,
    });

    expect(calls).toBe(1);
    expect(outcomes[0].ok).toBe(false);
    expect((outcomes[0] as { message: string }).message).toContain('이미지 파일이 비어 있습니다.');
  });

  it('stops the whole run when the upload slots are refused', async () => {
    let calls = 0;

    await expect(recognizeStudentsStateless({
      jobId: 'job_stateless',
      pairs: pairStatelessPages(cagiPages, satisfactionPages),
      delay: async () => undefined,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse(400, {
          error: 'cagi_page_001.jpg 파일은 선별검사지 칸에 업로드되었지만, 이미지 내용은 만족도조사 양식으로 보입니다. 올바른 칸에 다시 업로드해주세요.',
          code: 'FORM_TYPE_MISMATCH',
          canProceedWithUploadedTypes: true,
          mismatches: [{ filename: 'cagi_page_001.jpg', uploadedAs: 'cagi', detectedAs: 'satisfaction' }],
        });
      }) as any,
    })).rejects.toBeInstanceOf(StatelessFormTypeMismatchError);

    // The slots are wrong for the whole stack, so the remaining students are
    // abandoned rather than recognized against paper the user has to re-sort.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('passes the trusted-slot decision through on the second run', async () => {
    const bodies: FormData[] = [];

    await recognizeStudentsStateless({
      jobId: 'job_stateless',
      pairs: pairStatelessPages([cagiPages[0]], [satisfactionPages[0]]),
      trustUploadedTypes: true,
      fetchImpl: (async (_url: any, init: any) => {
        bodies.push(init.body as FormData);
        return jsonResponse(200, { student: draftWithAge(14) });
      }) as any,
    });

    expect(bodies[0].get('trustUploadedTypes')).toBe('1');
  });
});

function draftWithAge(age: number) {
  return {
    basic: { age },
    cagi: {},
    satisfaction: {},
    confidence: {},
    warnings: [] as string[],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
