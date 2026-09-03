import type { RecognitionDraft } from '../recognition/detectCheckmarks';
import type { StackOrder } from '../recognition/batchMatcher';

/**
 * Client-side assembly for the stateless batch path
 * (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §3, round B).
 *
 * With the flag on, nobody on the server ever sees the whole batch: the client
 * pairs the rendered pages, calls `/api/recognize/student` once per student,
 * and builds the review session out of the answers. Both halves of that — the
 * pairing and the assembly — are pure functions here so they can be tested
 * without a browser, a server or a student's paper. The network half lives in
 * `statelessRecognizeClient.ts`.
 *
 * The flag is read once, at module scope. `NEXT_PUBLIC_*` is substituted at
 * build time, so server render and client hydration see the same literal.
 *
 * DEFAULT ON since 2026-09-03, when the round was judged: the per-student path
 * reproduced the batch path's values, sources and contested flags for all 19
 * students with no cell differing, and it makes no Blob call at all
 * (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md, the round B verdict).
 * `NEXT_PUBLIC_STATELESS_RECOGNIZE=0` puts the upload-then-batch path back --
 * but because the value is inlined at build time, changing it needs a rebuild,
 * not just an environment edit on a running deployment.
 */
export const STATELESS_RECOGNIZE_ENABLED = process.env.NEXT_PUBLIC_STATELESS_RECOGNIZE !== '0';

/** A rendered page held in memory instead of uploaded to Blob. */
export interface StatelessPage {
  file: File;
  /** 1-based position in its own stack, the number `/api/upload` would have stored. */
  page: number;
  filename: string;
  /** F1 capture meta, or null for scanned pages. Presence arms the photo-only refusals. */
  registration: unknown | null;
}

export interface StatelessStudentPair {
  studentIndex: number;
  cagi: StatelessPage;
  satisfaction: StatelessPage;
}

export type StatelessStudentOutcome =
  | { ok: true; studentIndex: number; student: RecognitionDraft }
  | { ok: false; studentIndex: number; message: string };

export class StatelessPageCountMismatchError extends Error {
  constructor(readonly cagiCount: number, readonly satisfactionCount: number) {
    super(`업로드된 양식별 인식 장수가 일치하지 않습니다. (선별검사지: ${cagiCount}장, 만족도조사: ${satisfactionCount}장)`);
    this.name = 'StatelessPageCountMismatchError';
  }
}

/**
 * The client-side twin of `matchBatch`.
 *
 * `matchBatch` sorts the scratch files written by `materializeUploadBatch`,
 * whose names are `<type>_page_<pageNumber padded to 4>.jpg` — so the batch
 * pairing is by stored PAGE NUMBER, not by the name the user's file had. This
 * sorts by the same page number, which is why the two paths pair the same
 * paper. Reversal is applied to the satisfaction stack only, at pairing time
 * and not to the page numbers themselves, exactly as `matchBatch` does.
 */
export function pairStatelessPages(
  cagiPages: StatelessPage[],
  satisfactionPages: StatelessPage[],
  satisfactionOrder: StackOrder = 'same',
): StatelessStudentPair[] {
  if (cagiPages.length !== satisfactionPages.length) {
    throw new StatelessPageCountMismatchError(cagiPages.length, satisfactionPages.length);
  }

  const byPage = (a: StatelessPage, b: StatelessPage) => a.page - b.page;
  const sortedCagi = [...cagiPages].sort(byPage);
  const sortedSatisfaction = [...satisfactionPages].sort(byPage);
  if (satisfactionOrder === 'reversed') {
    sortedSatisfaction.reverse();
  }

  return sortedCagi.map((cagi, studentIndex) => ({
    studentIndex,
    cagi,
    satisfaction: sortedSatisfaction[studentIndex],
  }));
}

/**
 * A student whose two sheets could not be recognized after every retry.
 *
 * Deliberately a draft with no recognized values rather than a hole in the
 * list: the review screen walks the students by position, and dropping one
 * would silently shift every student after it onto the wrong paper. The
 * reviewer sees an empty form carrying the reason, which is a visible failure
 * instead of an invisible misalignment. `source` carries the two image ids the
 * route would have used, so nothing downstream that keys on them sees an
 * `undefined` that could collide with another student's.
 */
export function buildFailedStudentDraft(studentIndex: number, message: string): RecognitionDraft {
  return {
    source: {
      cagiImageId: `cagi_page_${studentIndex}`,
      satisfactionImageId: `satisfaction_page_${studentIndex}`,
    },
    basic: {},
    cagi: {},
    satisfaction: {},
    confidence: {},
    warnings: [message],
  };
}

/**
 * Per-student answers -> the review session `/api/recognize` used to return.
 *
 * Outcomes may arrive in any order (two requests are in flight at a time), so
 * they are placed by `studentIndex`, never by arrival. The session-level
 * `warnings` list is the notices banner's input: every warning the route
 * attached to a student is repeated there, in student order, because the
 * banner is what the batch path showed and the review screen shows the same
 * text again on the student it belongs to.
 */
export function assembleStatelessSession(outcomes: StatelessStudentOutcome[]): {
  studentDrafts: RecognitionDraft[];
  warnings: string[];
} {
  const ordered = [...outcomes].sort((a, b) => a.studentIndex - b.studentIndex);
  const studentDrafts = ordered.map((outcome) => (
    outcome.ok
      ? outcome.student
      : buildFailedStudentDraft(outcome.studentIndex, outcome.message)
  ));

  const warnings = studentDrafts.flatMap((draft) => draft.warnings ?? []);

  return { studentDrafts, warnings };
}
