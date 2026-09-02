import { describe, expect, it } from 'vitest';

import { describeCropSource } from '../src/components/RecognitionReview';
import type { RecognitionDraft } from '../src/lib/recognition/detectCheckmarks';

const makeDraft = (source: Record<string, unknown>): RecognitionDraft => ({
  basic: {},
  cagi: {},
  satisfaction: {},
  confidence: {},
  source,
} as unknown as RecognitionDraft);

describe('review crop source description', () => {
  it('describes provenance even when the crop URL and candidates are missing', () => {
    const draft = makeDraft({
      recognitionCropSource: { 'cagi.q01': 'grid' },
      recognitionRegistration: {
        'cagi.q01': { status: 'verified' },
      },
    });

    expect(describeCropSource(draft, 'cagi.q01')).toEqual({
      sourceLabel: '격자 검증 완료',
      registrationLabel: '좌표 검증',
      registrationStatus: 'verified',
    });
  });

  it('keeps the same description when crop and candidate data are present', () => {
    const draft = makeDraft({
      cropDataUrls: { 'satisfaction.q01': 'data:image/png;base64,crop' },
      recognitionCropSource: { 'satisfaction.q01': 'row-fallback' },
      recognitionRegistration: {
        'satisfaction.q01': { status: 'candidate' },
      },
    });
    draft.candidates = {
      'satisfaction.q01': [{ value: 1, score: 0.8 }],
    };

    expect(describeCropSource(draft, 'satisfaction.q01')).toEqual({
      sourceLabel: '격자 후보 -> 행 폴백',
      registrationLabel: '좌표 후보',
      registrationStatus: 'candidate',
    });
  });

  it('returns null when the crop source is absent', () => {
    const draft = makeDraft({
      recognitionRegistration: {
        'cagi.q01': { status: 'verified' },
      },
    });

    expect(describeCropSource(draft, 'cagi.q01')).toBeNull();
  });
});
