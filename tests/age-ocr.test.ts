import { describe, expect, it } from 'vitest';
import {
  AGE_OCR_MIN_CONFIDENCE,
  applyPhotoAgeConfidenceGate,
  parseAgeOcrText,
  parseTrustedAgeOcrText,
  recognizeDigitsInRegion,
  recognizeDigitsInRegionDetailed,
  type DigitOcrResult,
} from '../src/lib/recognition/ocrTextLines';
import path from 'path';
import { getAgeDigitsRect, recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { cagiTemplate } from '../src/lib/recognition/roiTemplates';

const blankFormDir = path.join(process.cwd(), 'tests', 'fixtures', 'blank-form');

describe('age OCR validation', () => {
  it('accepts only one- or two-digit integer ages from 1 through 20', () => {
    expect(parseAgeOcrText('1')).toBe(1);
    expect(parseAgeOcrText(' 20\n')).toBe(20);
    expect(parseAgeOcrText('0')).toBeUndefined();
    expect(parseAgeOcrText('21')).toBeUndefined();
    expect(parseAgeOcrText('123')).toBeUndefined();
    expect(parseAgeOcrText('1.4')).toBeUndefined();
    expect(parseAgeOcrText('14세')).toBeUndefined();
    expect(parseAgeOcrText('-1')).toBeUndefined();
    expect(parseAgeOcrText('')).toBeUndefined();
    expect(parseAgeOcrText(null)).toBeUndefined();
  });

  it('does not write a low-confidence handwritten age into the review draft', () => {
    expect(parseTrustedAgeOcrText('19', 55)).toBeUndefined();
    expect(parseTrustedAgeOcrText('14', 60)).toBe(14);
    expect(parseTrustedAgeOcrText('21', 99)).toBeUndefined();
  });

  it('returns empty when the shared OCR deadline has expired', async () => {
    const age = await recognizeDigitsInRegion(
      Buffer.from('not-an-image'),
      100,
      100,
      { left: 10, top: 10, right: 90, bottom: 90 },
      { deadlineAt: Date.now() - 1 },
    );

    expect(age).toBeUndefined();
  });

  it('records the reason when the per-student age OCR deadline has expired', async () => {
    const result = await recognizeDigitsInRegionDetailed(
      Buffer.from('not-an-image'),
      100,
      100,
      { left: 10, top: 10, right: 90, bottom: 90 },
      { deadlineAt: Date.now() - 1 },
    );

    expect(result.value).toBeUndefined();
    expect(result.status).toBe('deadline_exhausted');
    expect(result.diagnostic).toContain('deadline');
  });

  it('keeps both handwritten digits inside the measured age-number box', () => {
    expect(getAgeDigitsRect({ left: 100, top: 200, right: 300, bottom: 260 })).toEqual({
      left: 112,
      right: 288,
      top: 207,
      bottom: 253,
    });
  });

  it('anchors the age field to the blank form number box rather than the "세" suffix', () => {
    expect(cagiTemplate.fieldRegions?.find((region) => region.field === 'basic.age')?.rect).toEqual({
      x: 0.716,
      y: 0.162,
      width: 0.11,
      height: 0.023,
    });
  });

  it('leaves age empty on the committed blank form when OCR has a live budget', async () => {
    const draft = await recognizeStudentForms(
      path.join(blankFormDir, 'cagi-blank.png'),
      path.join(blankFormDir, 'satisfaction-blank.png'),
      { ocrDeadlineAt: Date.now() + 6_000 },
    );

    expect(draft.basic.age).toBeUndefined();
    expect(draft.confidence['basic.age']).toBe('medium');
  }, 10_000);
});

/**
 * The refusal is exercised through the pure decision function rather than by
 * mocking tesseract: this suite drives the real engine on fixture crops, and a
 * crop that reliably reads at a chosen confidence is not something a synthetic
 * image can promise. `applyPhotoAgeConfidenceGate` is the whole decision, so
 * driving it directly tests the rule rather than a stand-in for the reader.
 *
 * Thresholds are read from `AGE_OCR_MIN_CONFIDENCE` instead of written out, so
 * the central calibration can move the constant without editing these tests.
 */
describe('age OCR photo-provenance confidence refusal', () => {
  const acceptedRead = (confidence?: number): DigitOcrResult => ({
    value: 15,
    status: 'accepted',
    ...(confidence === undefined ? {} : { confidence }),
    diagnostic: 'Age OCR accepted 15 [gate=readers-agreed]: best confidence x of 60 needed.',
  });

  it('leaves a low-confidence photo read blank instead of writing a wrong age', () => {
    const result = applyPhotoAgeConfidenceGate(acceptedRead(AGE_OCR_MIN_CONFIDENCE - 1), true);

    expect(result.value).toBeUndefined();
    expect(result.status).toBe('photo_confidence_refused');
    expect(result.confidence).toBe(AGE_OCR_MIN_CONFIDENCE - 1);
    expect(result.diagnostic).toContain('gate=photo-confidence');
  });

  it('still fills a photo read that clears the photo floor', () => {
    const read = acceptedRead(AGE_OCR_MIN_CONFIDENCE);

    expect(applyPhotoAgeConfidenceGate(read, true)).toBe(read);
  });

  it('leaves the scan path untouched at any confidence', () => {
    const low = acceptedRead(AGE_OCR_MIN_CONFIDENCE - 1);
    const veryLow = acceptedRead(0);

    // Identity, not equality: on a sheet without photo provenance this gate
    // hands back the object it was given, so nothing about a scan can change.
    expect(applyPhotoAgeConfidenceGate(low, false)).toBe(low);
    expect(applyPhotoAgeConfidenceGate(veryLow, false)).toBe(veryLow);
  });

  it('refuses an accepted photo read that arrived without a confidence figure', () => {
    const result = applyPhotoAgeConfidenceGate(acceptedRead(undefined), true);

    expect(result.value).toBeUndefined();
    expect(result.status).toBe('photo_confidence_refused');
    expect(result.diagnostic).toContain('no confidence figure');
  });

  it('never turns a refusal into a filled value', () => {
    const rejected: DigitOcrResult = {
      status: 'parse_or_confidence_rejected',
      confidence: 99,
      diagnostic: 'Age OCR rejected [gate=readers-disagreed]: the two readings were different numbers.',
    };

    expect(applyPhotoAgeConfidenceGate(rejected, true)).toBe(rejected);
    expect(applyPhotoAgeConfidenceGate(rejected, false)).toBe(rejected);
  });
});

describe('age OCR confidence recording', () => {
  it('records a machine-readable confidence on a path that never reached a reader', async () => {
    const result = await recognizeDigitsInRegionDetailed(
      Buffer.from('not-an-image'),
      100,
      100,
      { left: 10, top: 10, right: 90, bottom: 90 },
      { deadlineAt: Date.now() - 1, photoProvenance: true },
    );

    expect(result.diagnostic).toContain('[ageOcrConfidence=none photo=yes accepted=false]');
  });

  it('marks the scan path as such so calibration can separate the two sets', async () => {
    const result = await recognizeDigitsInRegionDetailed(
      Buffer.from('not-an-image'),
      100,
      100,
      { left: 10, top: 10, right: 90, bottom: 90 },
      { deadlineAt: Date.now() - 1 },
    );

    expect(result.diagnostic).toContain('[ageOcrConfidence=none photo=no accepted=false]');
  });

  it('threads photo provenance from the recognition entry point into the age trace', async () => {
    const draft = await recognizeStudentForms(
      path.join(blankFormDir, 'cagi-blank.png'),
      path.join(blankFormDir, 'satisfaction-blank.png'),
      { ocrDeadlineAt: Date.now() + 6_000, cagiPhotoProvenance: true },
    );

    expect(draft.basic.age).toBeUndefined();
    expect(draft.recognitionDecisionTrace?.['basic.age']).toContain('photo=yes');
  }, 10_000);
});
