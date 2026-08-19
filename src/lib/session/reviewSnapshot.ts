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
export const REVIEW_SNAPSHOT_KEY = 'kpga.review.session.v1';
export const REVIEW_SNAPSHOT_VERSION = 1;

export type UploadModeValue = 'sequential' | 'batch';

export interface ReviewSnapshot {
  version: number;
  savedAt: number;
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
    jobId: input.jobId,
    uploadMode: input.uploadMode,
    students: input.students,
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
 * Every call is guarded: private-browsing modes and full quotas throw on
 * localStorage access, and losing the ability to save a snapshot must never
 * take down the review screen itself.
 */
export function saveReviewSnapshot(snapshot: ReviewSnapshot): boolean {
  try {
    window.localStorage.setItem(REVIEW_SNAPSHOT_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function loadReviewSnapshot(): ReviewSnapshot | null {
  try {
    const raw = window.localStorage.getItem(REVIEW_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReviewSnapshot;
    return isRestorableSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearReviewSnapshot(): void {
  try {
    window.localStorage.removeItem(REVIEW_SNAPSHOT_KEY);
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
