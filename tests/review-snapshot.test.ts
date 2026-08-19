import { describe, expect, it } from 'vitest';

import {
  REVIEW_SNAPSHOT_VERSION,
  buildReviewSnapshot,
  describeSnapshot,
  isRestorableSnapshot,
  stripDraftImages,
} from '../src/lib/session/reviewSnapshot';
import type { RecognitionDraft } from '../src/lib/recognition/detectCheckmarks';
import type { StudentData } from '../src/lib/validation/types';

function makeDraft(): RecognitionDraft {
  return {
    basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
    cagi: { q01: 0, q02: 0 },
    satisfaction: { q01: 4, q02: 1 },
    confidence: { 'basic.gender': 'high', 'cagi.q01': 'high' },
    candidates: { 'basic.gender': [{ value: '여', score: 0.05 }] },
    source: {
      cagiImageId: 'cagi_page_001',
      satisfactionImageId: 'satisfaction_page_001',
      cagiImageDataUrl: 'data:image/jpeg;base64,AAAA',
      satisfactionImageDataUrl: 'data:image/jpeg;base64,BBBB',
      cropDataUrls: { 'basic.gender': 'data:image/png;base64,CCCC' },
      cropDebugDataUrls: { 'basic.gender': 'data:image/png;base64,DDDD' },
      recognitionCropSource: { 'basic.gender': 'grid' },
      recognitionCropDiagnostic: { 'basic.gender': 'grid candidate: gap rows 2%' },
      recognitionDecisionTrace: { 'basic.gender': 'Gender: automatic entry completed.' },
    },
  } as unknown as RecognitionDraft;
}

const student: StudentData = {
  studentIndex: 1,
  source: { cagiImageId: 'cagi_page_001', satisfactionImageId: 'satisfaction_page_001' },
  basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
  cagi: { q01: 0 } as StudentData['cagi'],
  satisfaction: { q01: 4 } as StudentData['satisfaction'],
  status: 'saved',
};

describe('review snapshot', () => {
  it('drops every rendered image but keeps the values a reviewer needs', () => {
    const slim = stripDraftImages(makeDraft());
    const source = slim.source as Record<string, unknown>;

    expect(source.cagiImageDataUrl).toBeUndefined();
    expect(source.satisfactionImageDataUrl).toBeUndefined();
    expect(source.cropDataUrls).toBeUndefined();
    expect(source.cropDebugDataUrls).toBeUndefined();

    expect(slim.basic).toEqual({ age: 14, gender: '여', schoolType: '중학교', grade: '2학년' });
    expect(slim.confidence).toEqual({ 'basic.gender': 'high', 'cagi.q01': 'high' });
    expect(source.recognitionCropSource).toEqual({ 'basic.gender': 'grid' });
    expect(source.recognitionDecisionTrace).toBeDefined();
    expect(source.cagiImageId).toBe('cagi_page_001');
  });

  it('never writes scanned responses into browser storage', () => {
    const snapshot = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'batch',
      students: [student],
      drafts: [makeDraft(), makeDraft()],
      currentDraftIndex: 1,
    });

    // The whole point of storing values only: a batch of drafts with images is
    // ~1.6MB per student and would both blow the storage quota and keep student
    // responses in the browser (Docs/00_PRD.md §10, §10-2).
    expect(JSON.stringify(snapshot)).not.toContain('data:image');
  });

  it('keeps enough to resume: job, mode, saved students, and position', () => {
    const snapshot = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'batch',
      students: [student],
      drafts: [makeDraft(), makeDraft()],
      currentDraftIndex: 1,
    });

    expect(snapshot.version).toBe(REVIEW_SNAPSHOT_VERSION);
    expect(snapshot.jobId).toBe('job-1');
    expect(snapshot.uploadMode).toBe('batch');
    expect(snapshot.students).toHaveLength(1);
    expect(snapshot.drafts).toHaveLength(2);
    expect(snapshot.currentDraftIndex).toBe(1);
    expect(isRestorableSnapshot(snapshot)).toBe(true);
  });

  it('refuses to offer a resume that carries no work', () => {
    const empty = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'sequential',
      students: [],
      drafts: null,
      currentDraftIndex: 0,
    });

    expect(isRestorableSnapshot(empty)).toBe(false);
    expect(isRestorableSnapshot(null)).toBe(false);
    expect(isRestorableSnapshot({ ...empty, version: 999, students: [student] })).toBe(false);
  });

  it('describes the recovery point so the user can tell which batch it is', () => {
    const snapshot = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'batch',
      students: [student, student],
      drafts: [makeDraft(), makeDraft(), makeDraft()],
      currentDraftIndex: 1,
    });

    expect(describeSnapshot(snapshot)).toBe('저장 완료 2명 · 검수 대기 3명 중 2번째');
  });
});
