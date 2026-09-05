import { describe, it, expect } from 'vitest';
import {
  applyAgeDigitClassifierFallback,
  type AgeDigitClassifierInput,
} from '../src/lib/recognition/detectCheckmarks';
import type { DigitClassification } from '../src/lib/recognition/mnist12';

/**
 * Gate table for the digit-classifier fallback (Task/AGE_CLASSIFIER_BRIEF_2026-09-05.md).
 *
 * `applyAgeDigitClassifierFallback` is a pure function, so every gate is
 * exercised here with a synthetic `DigitOcrResult.strokes` array (the
 * bitmaps are never read -- an injected stub classifier stands in for
 * `classifyDigit`) and fixed basic-info state, with no real image pipeline.
 */

const fakeStroke = (): { data: Uint8Array; width: number; height: number } => ({
  data: new Uint8Array(4),
  width: 2,
  height: 2,
});

function baseInput(overrides: Partial<AgeDigitClassifierInput> = {}): AgeDigitClassifierInput {
  return {
    ageValueSource: 'unresolved',
    schoolTypeValueSource: 'auto',
    schoolType: '중학교',
    gradeValueSource: 'auto',
    grade: '2학년', // N=2 -> expected range [13,15]
    strokes: [fakeStroke(), fakeStroke()],
    existingTrace: 'Age: automatic entry deferred because no reader agreed.',
    ...overrides,
  };
}

function stubClassifier(
  first: DigitClassification | null,
  second: DigitClassification | null,
): (data: Uint8Array, width: number, height: number) => DigitClassification | null {
  let call = 0;
  return () => {
    call += 1;
    return call === 1 ? first : second;
  };
}

const HIGH_CONF = (digit: number): DigitClassification => ({ digit, confidence: 0.99, margin: 0.9 });

describe('applyAgeDigitClassifierFallback gate table', () => {
  it('does not run at all when basic.age was already accepted', () => {
    const result = applyAgeDigitClassifierFallback(
      baseInput({ ageValueSource: 'auto' }),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(4)),
    );
    expect(result).toBeUndefined();
  });

  it('leaves the field alone when confidence is below the 0.95 floor', () => {
    const low = { digit: 1, confidence: 0.94, margin: 0.5 };
    const result = applyAgeDigitClassifierFallback(
      baseInput(),
      stubClassifier(low, HIGH_CONF(4)),
    );
    expect(result).toBeUndefined();
  });

  it('leaves the field alone when there are not exactly two strokes', () => {
    const result = applyAgeDigitClassifierFallback(
      baseInput({ strokes: [fakeStroke(), fakeStroke(), fakeStroke()] }),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(4)),
    );
    expect(result).toBeUndefined();
  });

  it('leaves the field alone when zero strokes were exposed', () => {
    const result = applyAgeDigitClassifierFallback(
      baseInput({ strokes: undefined }),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(4)),
    );
    expect(result).toBeUndefined();
  });

  it('leaves the field alone when the value falls outside the grade-implied range', () => {
    // grade2 -> expected [13,15]; 17 clears confidence but is out of range.
    const result = applyAgeDigitClassifierFallback(
      baseInput(),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(7)),
    );
    expect(result).toBeUndefined();
  });

  it('leaves the field alone when the grade is not auto-confirmed', () => {
    const result = applyAgeDigitClassifierFallback(
      baseInput({ gradeValueSource: 'unresolved' }),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(4)),
    );
    expect(result).toBeUndefined();
  });

  it('leaves the field alone when the school type is not auto-confirmed 중학교', () => {
    const result = applyAgeDigitClassifierFallback(
      baseInput({ schoolType: '고등학교' }),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(4)),
    );
    expect(result).toBeUndefined();

    const unresolvedSchoolType = applyAgeDigitClassifierFallback(
      baseInput({ schoolTypeValueSource: 'unresolved' }),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(4)),
    );
    expect(unresolvedSchoolType).toBeUndefined();
  });

  it('leaves the field alone when either digit fails to classify', () => {
    const result = applyAgeDigitClassifierFallback(
      baseInput(),
      stubClassifier(null, HIGH_CONF(4)),
    );
    expect(result).toBeUndefined();
  });

  it('fills the value and writes the expected trace when every gate passes', () => {
    // grade2 -> expected [13,15]; two strokes read 1 and 4 -> 14, in range.
    const result = applyAgeDigitClassifierFallback(
      baseInput(),
      stubClassifier(HIGH_CONF(1), HIGH_CONF(4)),
    );
    expect(result).toBeDefined();
    expect(result!.value).toBe(14);
    expect(result!.trace).toBe(
      'Age OCR accepted 14 [gate=digit-classifier]: the two strokes read as 1 and 4 '
      + 'at confidence 99/99 of 95 needed, '
      + 'inside the 13-15 range implied by 중학교 2학년. '
      + 'Age: automatic entry deferred because no reader agreed.',
    );
  });
});
