import type { RecognitionDraft } from '../recognition/detectCheckmarks';
import type { StudentData } from '../validation/types';

/**
 * A review batch is ~19 students and takes minutes of upload and recognition,
 * and any value the reviewer corrected by hand cannot be reproduced. Losing it
 * to a mis-clicked "검수 취소" or a refresh is the failure this snapshot exists
 * to prevent (Docs/00_PRD.md §10-2).
 *
 * Only values are stored. A full draft measures 1,602KB per student because of
 * the thumbnails and the 23 crop images in two variants -- 30MB for a batch,
 * far past what a browser will hold -- while the values, confidences, and
 * diagnostics come to 3KB, or 61KB for the batch. Dropping the images also
 * keeps scanned responses out of browser storage, which §10 requires.
 */
export const REVIEW_SNAPSHOT_VERSION = 2;
/** Points at the job whose snapshot the start screen should offer to resume. */
export const REVIEW_SNAPSHOT_POINTER_KEY = 'kpga.review.session.latest';
const SNAPSHOT_PREFIX = 'kpga.review.session.v2.';
const LEGACY_SNAPSHOT_KEY = 'kpga.review.session.v1';

export const snapshotKeyFor = (jobId: string) => `${SNAPSHOT_PREFIX}${jobId}`;

/**
 * Identifies the page that wrote a snapshot. One tab is the normal case, but
 * two tabs sharing a single key silently overwrote each other's batch, so a
 * writer that finds a newer snapshot from a different tab leaves it alone.
 */
const WRITER_ID = `w_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;

export type UploadModeValue = 'sequential' | 'batch';

export interface ReviewSnapshot {
  version: number;
  savedAt: number;
  writerId?: string;
  jobId: string;
  uploadMode: UploadModeValue;
  students: StudentData[];
  drafts: RecognitionDraft[];
  currentDraftIndex: number;
}

const IMAGE_SOURCE_KEYS = [
  'cagiImageDataUrl',
  'satisfactionImageDataUrl',
  'cropDataUrls',
  'cropDebugDataUrls',
] as const;

/**
 * Removes every rendered image from a draft while keeping the parts a reviewer
 * still needs: the recognized values, confidences, candidate scores, the crop
 * source badge, and the diagnostics that explain why a field was left blank.
 */
export function stripDraftImages(draft: RecognitionDraft): RecognitionDraft {
  const source = draft.source as Record<string, unknown> | undefined;
  if (!source) {
    return draft;
  }

  const slimSource: Record<string, unknown> = { ...source };
  for (const key of IMAGE_SOURCE_KEYS) {
    delete slimSource[key];
  }

  return { ...draft, source: slimSource } as RecognitionDraft;
}

export function stripStudentImages(student: StudentData): StudentData {
  const source = student.source as Record<string, unknown> | undefined;
  if (!source) return student;

  const slimSource: Record<string, unknown> = { ...source };
  for (const key of IMAGE_SOURCE_KEYS) {
    delete slimSource[key];
  }
  return { ...student, source: slimSource } as StudentData;
}

export function buildReviewSnapshot(input: {
  jobId: string;
  uploadMode: UploadModeValue;
  students: StudentData[];
  drafts: RecognitionDraft[] | null;
  currentDraftIndex: number;
}): ReviewSnapshot {
  return {
    version: REVIEW_SNAPSHOT_VERSION,
    savedAt: Date.now(),
    writerId: WRITER_ID,
    jobId: input.jobId,
    uploadMode: input.uploadMode,
    // Saved students are meant to be small, but a build that spread the review
    // draft into them once put 1.6MB of images in each. Strip them here too so
    // an existing session cannot quietly blow the storage quota.
    students: input.students.map(stripStudentImages),
    drafts: (input.drafts || []).map(stripDraftImages),
    currentDraftIndex: input.currentDraftIndex,
  };
}

export function isRestorableSnapshot(snapshot: ReviewSnapshot | null): snapshot is ReviewSnapshot {
  if (!snapshot || snapshot.version !== REVIEW_SNAPSHOT_VERSION || !snapshot.jobId) {
    return false;
  }
  return snapshot.students.length > 0 || snapshot.drafts.length > 0;
}

/**
 * True when the stored snapshot for this job was written by another page more
 * recently than ours. Overwriting it would discard that tab's review.
 */
export function isForeignerNewer(existing: ReviewSnapshot | null, incoming: ReviewSnapshot): boolean {
  return Boolean(
    existing
    && existing.writerId
    && existing.writerId !== incoming.writerId
    && existing.savedAt > incoming.savedAt,
  );
}

/**
 * Every call is guarded: private-browsing modes and full quotas throw on
 * localStorage access, and losing the ability to save a snapshot must never
 * take down the review screen itself.
 */
function readSnapshotAt(key: string): ReviewSnapshot | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReviewSnapshot;
    return isRestorableSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveReviewSnapshot(snapshot: ReviewSnapshot): boolean {
  try {
    const key = snapshotKeyFor(snapshot.jobId);
    if (isForeignerNewer(readSnapshotAt(key), snapshot)) {
      return false;
    }
    window.localStorage.setItem(key, JSON.stringify(snapshot));
    window.localStorage.setItem(REVIEW_SNAPSHOT_POINTER_KEY, snapshot.jobId);
    return true;
  } catch {
    return false;
  }
}

export function loadReviewSnapshot(): ReviewSnapshot | null {
  try {
    const jobId = window.localStorage.getItem(REVIEW_SNAPSHOT_POINTER_KEY);
    if (jobId) {
      const snapshot = readSnapshotAt(snapshotKeyFor(jobId));
      if (snapshot) return snapshot;
    }
    // A snapshot written before jobs had their own key.
    return readSnapshotAt(LEGACY_SNAPSHOT_KEY);
  } catch {
    return null;
  }
}

export function clearReviewSnapshot(jobId?: string): void {
  try {
    const target = jobId || window.localStorage.getItem(REVIEW_SNAPSHOT_POINTER_KEY);
    if (target) window.localStorage.removeItem(snapshotKeyFor(target));
    window.localStorage.removeItem(REVIEW_SNAPSHOT_POINTER_KEY);
    window.localStorage.removeItem(LEGACY_SNAPSHOT_KEY);
  } catch {
    // ignore
  }
}

export function describeSnapshot(snapshot: ReviewSnapshot): string {
  const saved = snapshot.students.length;
  const pending = snapshot.drafts.length;
  const position = pending > 0 ? Math.min(snapshot.currentDraftIndex + 1, pending) : 0;
  const parts = [`저장 완료 ${saved}명`];
  if (pending > 0) {
    parts.push(`검수 대기 ${pending}명 중 ${position}번째`);
  }
  return parts.join(' · ');
}
