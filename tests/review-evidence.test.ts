import { describe, expect, it } from 'vitest';
import path from 'path';

import type { DecisionEvidence } from '../src/lib/recognition/markDensity';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { describeEvidence, refusalLabel, remarkCause } from '../src/lib/review/evidence';

const thresholds = { score: 0.021, gap: 0.004, contrast: 1.25 };

function evidence(overrides: Partial<DecisionEvidence> = {}): DecisionEvidence {
  return {
    outcome: 'auto',
    winner: { index: 0, score: 0.071 },
    runnerUp: { index: 2, score: 0.03 },
    relativeContrast: 2.366,
    thresholds,
    refused: [],
    offset: { x: 0.02, y: 0 },
    contested: false,
    ...overrides,
  };
}

describe('review evidence serialization', () => {
  it('describes an automatic value with ranked scores, contrast, and offset', () => {
    expect(describeEvidence(evidence(), ['0', '1', '2'],)).toBe(
      "1위 '0' 7.1% · 2위 '2' 3.0% · 여유 2.4× · 자리 편차 0.02",
    );
  });

  it('describes a contested value as two marked boxes', () => {
    expect(describeEvidence(evidence({
      outcome: 'contested',
      winner: { index: 1, score: 0.17 },
      runnerUp: { index: 0, score: 0.06 },
      relativeContrast: undefined,
      offset: undefined,
      contested: true,
    }), ['남', '여'])).toBe(
      "경합 — 1위 '여' 17% · 2위 '남' 6% (두 칸 모두 표시 흔적)",
    );
  });

  it('describes a refused value with the measured values beside thresholds', () => {
    expect(describeEvidence(evidence({
      outcome: 'refused',
      winner: { index: 0, score: 0.015 },
      runnerUp: undefined,
      gap: 0.002,
      relativeContrast: undefined,
      offset: undefined,
      refused: ['absolute-floor', 'gap'],
    }), ['0', '1', '2'])).toBe(
      '보류 — 잉크가 옅음(0.015 < 0.021) · 1·2위 차이 부족(0.002 < 0.004)',
    );
  });

  it('uses the constant photo floor when compact transport omitted thresholds', () => {
    const compactEvidence = {
      outcome: 'refused',
      winner: { index: 0, score: 0.032 },
      refused: ['photo-binary-floor'],
      contested: false,
    } as DecisionEvidence;
    expect(describeEvidence(compactEvidence, ['0'])).toBe('보류 — 사진 이진 판정 미달(0.032 < 0.042)');
  });

  it('keeps the recognition evidence sidecar within the per-field snapshot budget', async () => {
    const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'blank-form');
    const draft = await recognizeStudentForms(
      path.join(fixtureDir, 'cagi-blank.png'),
      path.join(fixtureDir, 'satisfaction-blank.png'),
      { ocrDeadlineAt: Date.now() },
    );
    const sizes = Object.entries(draft.recognitionEvidence || {}).map(([field, item]) => ({
      field,
      bytes: Buffer.byteLength(JSON.stringify(item), 'utf8'),
    }));
    console.info('recognition evidence bytes', JSON.stringify(sizes));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes.map((item) => item.bytes))).toBeLessThanOrEqual(160);
  }, 20_000);
});

describe('review evidence refusal labels', () => {
  const labels: Array<[string, string]> = [
    ['absolute-floor', '잉크가 옅음'],
    ['gap', '1·2위 차이 부족'],
    ['mark-shape', '표시 모양이 불규칙'],
    ['relative-contrast', '빈 양식 대비 부족'],
    ['ink-invariant', '빈 양식보다 옅음(잡음 가능)'],
    ['band-structure', '줄무늬 구조'],
    ['photo-binary-floor', '사진 이진 판정 미달'],
    ['photo-binary-refused', '사진 이진 판정 미달'],
    ['rescued:1.80', '구제됨(1.80)'],
    ['medium-floor', '중간 신뢰 경로 미달'],
    ['medium-gap', '중간 신뢰 경로 미달'],
  ];

  it.each(labels)('maps %s', (token, label) => {
    expect(refusalLabel(token)).toBe(label);
  });
});

describe('review evidence remark causes', () => {
  it('classifies faint, offset, and shape causes independently', () => {
    expect(remarkCause(evidence({
      outcome: 'refused',
      refused: ['absolute-floor', 'mark-shape'],
      offset: { x: 1, y: 0 },
      shape: { componentRatio: 0.1, diagonalRatio: 0.1 },
    }))).toEqual(['faint', 'offset', 'shape']);
  });

  it('does not flag exact shape thresholds or sub-sample offsets', () => {
    expect(remarkCause(evidence({
      refused: [],
      offset: { x: 0.999, y: -0.5 },
      shape: { componentRatio: 0.2, diagonalRatio: 0.2 },
    }))).toEqual([]);
  });

  it('recognizes invariant and photo-floor faintness but not binary refusal alone', () => {
    expect(remarkCause(evidence({ refused: ['ink-invariant'] }))).toContain('faint');
    expect(remarkCause(evidence({ refused: ['photo-binary-floor'] }))).toContain('faint');
    expect(remarkCause(evidence({ refused: ['photo-binary-refused'] }))).toEqual([]);
  });
});
