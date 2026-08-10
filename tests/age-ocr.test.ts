import { describe, expect, it } from 'vitest';
import { parseAgeOcrText, recognizeDigitsInRegion } from '../src/lib/recognition/ocrTextLines';
import path from 'path';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';

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

  it('leaves age empty on the committed blank form when OCR has a live budget', async () => {
    const draft = await recognizeStudentForms(
      path.join(blankFormDir, 'cagi-blank.png'),
      path.join(blankFormDir, 'satisfaction-blank.png'),
      { ocrDeadlineAt: Date.now() + 2_500 },
    );

    expect(draft.basic.age).toBeUndefined();
    expect(draft.confidence['basic.age']).toBe('medium');
  }, 10_000);
});
