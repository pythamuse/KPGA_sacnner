import { describe, expect, it } from 'vitest';
import {
  parseAgeOcrText,
  parseTrustedAgeOcrText,
  recognizeDigitsInRegion,
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
