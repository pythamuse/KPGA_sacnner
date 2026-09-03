import { describe, expect, it } from 'vitest';

import {
  bulkConfirmableFields,
  contestedUnconfirmedFields,
  isSettledSource,
  unconfirmedMachineFields,
} from '../src/lib/review/settlement';
import type { RecognitionDraft } from '../src/lib/recognition/detectCheckmarks';

describe('review settlement sources', () => {
  it('settles only explicit reviewer decisions', () => {
    expect(isSettledSource('manual')).toBe(true);
    expect(isSettledSource('confirmed')).toBe(true);
    expect(isSettledSource('blank_ok')).toBe(true);
    expect(isSettledSource('auto')).toBe(false);
    expect(isSettledSource('restored')).toBe(false);
    expect(isSettledSource('unresolved')).toBe(false);
    expect(isSettledSource(undefined)).toBe(false);
  });

  it('finds only non-empty automatic and restored values', () => {
    const draft = {
      basic: { age: 14, gender: '여' },
      cagi: { q01: 0, q02: 1, q03: 2, q05: 0 },
      satisfaction: {},
      source: {
        recognitionValueSource: {
          'basic.age': 'auto',
          'basic.gender': 'restored',
          'cagi.q01': 'unresolved',
          'cagi.q02': 'manual',
          'cagi.q03': 'confirmed',
          'cagi.q04': 'blank_ok',
          'cagi.q05': 'auto',
          'satisfaction.q01': 'auto',
        },
      },
    } as unknown as RecognitionDraft;
    // q01 is unresolved without a value, q02/q03/q04 are explicit reviewer
    // outcomes, and satisfaction.q01 is an empty automatic field.
    (draft.satisfaction as Record<string, unknown>).q01 = '';

    expect(unconfirmedMachineFields(draft)).toEqual([
      'basic.age',
      'basic.gender',
      'cagi.q05',
    ]);
  });

  it('keeps only unconfirmed contested values, in review order', () => {
    const draft = {
      basic: { age: 14, gender: '여' },
      cagi: { q01: 0, q02: 1, q03: 2 },
      satisfaction: {},
      source: {
        recognitionValueSource: {
          'basic.age': 'auto',
          'basic.gender': 'restored',
          'cagi.q01': 'confirmed',
          'cagi.q02': 'auto',
          'cagi.q03': 'restored',
          'cagi.q04': 'auto',
        },
        recognitionContested: {
          'basic.age': true,
          'basic.gender': true,
          'cagi.q01': true,
          'cagi.q02': false,
          'cagi.q03': true,
          'cagi.q04': true,
        },
      },
    } as unknown as RecognitionDraft;

    expect(contestedUnconfirmedFields(draft)).toEqual([
      'basic.age',
      'basic.gender',
      'cagi.q03',
    ]);
  });

  it('bulk-confirms only high-confidence, non-contested machine values', () => {
    const draft = {
      basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
      cagi: { q01: 0, q02: 1, q03: 2 },
      satisfaction: { q01: 4 },
      confidence: {
        'basic.age': 'high',
        'basic.gender': 'high',
        'basic.schoolType': 'medium',
        'basic.grade': 'low',
        'cagi.q01': 'high',
        'cagi.q02': 'high',
        'cagi.q03': 'high',
        'cagi.q04': 'high',
        'satisfaction.q01': 'high',
      },
      source: {
        recognitionValueSource: {
          'basic.age': 'auto',
          'basic.gender': 'restored',
          'basic.schoolType': 'auto',
          'basic.grade': 'auto',
          'cagi.q01': 'auto',
          'cagi.q02': 'restored',
          'cagi.q03': 'auto',
          'cagi.q04': 'auto',
          'satisfaction.q01': 'auto',
        },
        recognitionContested: {
          'cagi.q01': true,
          'cagi.q02': false,
          'cagi.q03': false,
        },
      },
    } as unknown as RecognitionDraft;

    expect(bulkConfirmableFields(draft)).toEqual([
      'basic.age',
      'basic.gender',
      'cagi.q02',
      'cagi.q03',
      'satisfaction.q01',
    ]);
  });
});
