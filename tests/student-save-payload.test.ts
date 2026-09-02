import { describe, expect, it } from 'vitest';

import { stripDraftImages } from '../src/lib/session/reviewSnapshot';
import type { RecognitionDraft } from '../src/lib/recognition/detectCheckmarks';

/**
 * The save request resends the whole saved list every time, so anything that
 * only the review screen needs must never enter that list. It did once: the
 * route spread the draft into the saved student, the client kept it, and the
 * seventh student pushed the request past the platform body limit and came back
 * as plain "Request Entity Too Large".
 * See Task/STUDENT_SAVE_PAYLOAD_GROWTH_AND_NON_JSON_RESPONSE_2026-08-12.md.
 */
function makeFatDraft(): RecognitionDraft {
  const bigImage = 'data:image/png;base64,' + 'A'.repeat(60_000);
  const crops: Record<string, string> = {};
  for (let i = 0; i < 23; i += 1) crops[`field.${i}`] = bigImage;

  return {
    basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
    cagi: { q01: 0 },
    satisfaction: { q01: 4 },
    source: {
      cagiImageId: 'cagi_page_0001',
      satisfactionImageId: 'satisfaction_page_0001',
      recognitionValueSource: { 'basic.age': 'confirmed' },
      cagiImageDataUrl: bigImage,
      satisfactionImageDataUrl: bigImage,
      cropDataUrls: crops,
      cropDebugDataUrls: crops,
    },
  } as unknown as RecognitionDraft;
}

describe('student save payload', () => {
  it('keeps a batch of saved students far below the request body limit', () => {
    const slim = stripDraftImages(makeFatDraft());
    const nineteen = JSON.stringify({ jobId: 'job_x', students: Array.from({ length: 19 }, () => slim) });

    // Vercel rejects request bodies over 4.5MB with a non-JSON 413.
    expect(nineteen.length).toBeLessThan(1_000_000);
    expect(nineteen).not.toContain('data:image');
  });

  it('shows how large the same batch would be if drafts were sent whole', () => {
    const fat = JSON.stringify({ jobId: 'job_x', students: Array.from({ length: 7 }, () => makeFatDraft()) });

    // Seven students was where the real batch failed.
    expect(fat.length).toBeGreaterThan(4_500_000);
  });

  it('preserves the identifiers and values the save contract needs', () => {
    const slim = stripDraftImages(makeFatDraft());
    const source = slim.source as Record<string, unknown>;

    expect(source.cagiImageId).toBe('cagi_page_0001');
    expect(source.satisfactionImageId).toBe('satisfaction_page_0001');
    expect(source.recognitionValueSource).toEqual({ 'basic.age': 'confirmed' });
    expect(slim.basic).toEqual({ age: 14, gender: '여', schoolType: '중학교', grade: '2학년' });
    expect(slim.satisfaction).toEqual({ q01: 4 });
  });
});
